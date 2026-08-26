import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync, copyFileSync, unlinkSync, rmdirSync } from "fs";
import { join, basename, dirname, resolve } from "path";
import { isTraceFile } from "./history";
import { zstdFile, zstdDecodedBytes } from "./storage";
import { instancesDir, STALE_MS, type InstanceInfo } from "./instances";

// The trace store: <data-dir>/traces/<project-key>/ — one dir per project
// cwd, shared by every container that shares the data dir. Design and the
// rules every reader/writer follows: docs/design/store.md. This module owns
// the layout (paths, keys, the project marker), legacy-dir detection, the
// store listing and `cctrace adopt`; the exit-time compression lives with
// the other housekeeping in storage.ts.

export const STORE_DIRNAME = "traces";
export const PROJECT_MARKER = "project.json";
export const LEGACY_DIRNAME = ".cctrace";

export function storeRoot(dataDir: string): string {
  return join(dataDir, STORE_DIRNAME);
}

/**
 * Claude Code's own project-dir convention (~/.claude/projects/-Users-...):
 * the absolute path with every byte outside [A-Za-z0-9-] replaced by "-".
 * Lossy on purpose (readable, no hashing) — project.json holds the truth.
 */
export function projectKey(projectPath: string): string {
  return resolve(projectPath).replace(/[^A-Za-z0-9-]/g, "-");
}

export function projectTraceDir(dataDir: string, projectPath: string): string {
  return join(storeRoot(dataDir), projectKey(projectPath));
}

/** Create the project's store dir (0700, like the CA dir — traces are
 * sensitive) and stamp the marker once. Idempotent; never throws for a
 * marker that can't be written (the dir is what matters). */
export function ensureProjectDir(dataDir: string, projectPath: string): string {
  const dir = projectTraceDir(dataDir, projectPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, PROJECT_MARKER);
  if (!existsSync(marker)) {
    try { writeFileSync(marker, JSON.stringify({ path: resolve(projectPath) }) + "\n"); } catch { /* best-effort */ }
  }
  return dir;
}

/** The project path a store dir belongs to: the marker, else null. */
export function projectPathOf(dir: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, PROJECT_MARKER), "utf8"));
    return typeof j?.path === "string" && j.path ? j.path : null;
  } catch {
    return null;
  }
}

/** True when a dir holds at least one trace file (raw or archived). */
export function hasTraces(dir: string): boolean {
  try {
    return readdirSync(dir).some(isTraceFile);
  } catch {
    return false;
  }
}

/** The project's pre-0.41 `./.cctrace` when it still holds traces. */
export function legacyLocalDir(cwd: string): string | null {
  const dir = join(cwd, LEGACY_DIRNAME);
  return hasTraces(dir) ? dir : null;
}

export interface TraceDirs {
  /** Where this run writes (and where housekeeping acts). */
  writeDir: string;
  /** Where continuity readers look: writeDir first, then a legacy dir. */
  readDirs: string[];
  /** The legacy `./.cctrace` still holding traces, when there is one and
   * the store is in charge — the startup notice + `adopt` hint. */
  legacy: string | null;
}

/**
 * Resolve the dirs for a run/view in `cwd`. An explicit --dir is absolute:
 * write there, read only there, no legacy anything (the user named the
 * dir; second-guessing it would be a lie). Otherwise the store dir for the
 * project, with the legacy dir as an extra READ source so upgrade day
 * loses no continuity.
 */
export function resolveTraceDirs(opts: { dataDir: string; cwd: string; dirFlag?: string }): TraceDirs {
  if (opts.dirFlag) {
    const d = resolve(opts.dirFlag);
    return { writeDir: d, readDirs: [d], legacy: null };
  }
  const writeDir = projectTraceDir(opts.dataDir, opts.cwd);
  const legacy = legacyLocalDir(opts.cwd);
  return { writeDir, readDirs: legacy ? [writeDir, legacy] : [writeDir], legacy };
}

export interface StoreProject {
  dir: string;
  key: string;
  /** From the marker; null for a dir someone made by hand. */
  projectPath: string | null;
  traces: number;
  /** Plain .jsonl files — live runs or leftovers `compress` would archive. */
  raw: number;
  bytes: number;
  newestMs: number;
}

/** Every project dir in the store, biggest first. */
export function listStoreProjects(dataDir: string): StoreProject[] {
  const root = storeRoot(dataDir);
  let keys: string[];
  try { keys = readdirSync(root); } catch { return []; }
  const out: StoreProject[] = [];
  for (const key of keys) {
    const dir = join(root, key);
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch { continue; }
    let traces = 0, raw = 0, bytes = 0, newestMs = 0;
    for (const n of names) {
      if (!isTraceFile(n)) continue;
      let st;
      try { st = statSync(join(dir, n)); } catch { continue; }
      traces++;
      if (n.endsWith(".jsonl")) raw++;
      bytes += st.size;
      if (st.mtimeMs > newestMs) newestMs = st.mtimeMs;
    }
    out.push({ dir, key, projectPath: projectPathOf(dir), traces, raw, bytes, newestMs });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// ---- adopt: move legacy ./.cctrace dirs into the store ----

export interface AdoptMove {
  from: string;
  to: string;
  name: string;
  size: number;
  /** `from` as another host names it (--rebase): the path the registry
   * recorded, so live matching and re-pointing see the same file. */
  alias?: string;
  /** --zst: a plain .jsonl lands as `to` (= <name>.zst), streamed +
   * decode-verified, instead of being copied byte for byte. */
  archive?: boolean;
}

export interface AdoptDirPlan {
  legacyDir: string;
  projectPath: string;
  targetDir: string;
  moves: AdoptMove[];
  /** Files left behind and why (live run, name already in the store). */
  skipped: { name: string; reason: string }[];
  bytes: number;
}

export interface AdoptPlan {
  /** --copy: sources stay (a migration that keeps the originals). */
  copy: boolean;
  dirs: AdoptDirPlan[];
  /** Candidate dirs that don't exist or hold no traces here. */
  absent: string[];
  bytes: number;
  files: number;
}

/** What `adopt` moves: traces, their archives, and .html snapshots
 * (regenerable, but leaving them strands the legacy dir). */
function isAdoptable(name: string): boolean {
  return isTraceFile(name) || name.endsWith(".html");
}

/**
 * Legacy dirs the registry knows about: dirname of every tombstone/live
 * logFile that ends in /.cctrace and resolves here. Tombstones expire after
 * 30 days, so this is "recent projects" — --scan covers the rest.
 */
export function registryLegacyDirs(dataDir: string): string[] {
  const dir = instancesDir(dataDir);
  const out = new Set<string>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let info: InstanceInfo;
    try { info = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!info.logFile) continue;
    const d = dirname(info.logFile);
    if (basename(d) === LEGACY_DIRNAME) out.add(d);
  }
  return [...out].sort();
}

const SCAN_SKIP = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", "target", "dist", "build", ".cache", ".Trash", "Library"]);

/** Walk `root` for `.cctrace/` dirs, depth-capped and skipping the usual
 * heavy trees. Only dirs holding traces count. */
export function scanLegacyDirs(root: string, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: import("fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (e.name === LEGACY_DIRNAME) {
        if (hasTraces(path)) out.push(path);
        continue;
      }
      if (depth >= maxDepth || SCAN_SKIP.has(e.name)) continue;
      walk(path, depth + 1);
    }
  };
  walk(resolve(root), 0);
  return out.sort();
}

/** A path prefix swap: legacy dirs mounted here under FROM belong to
 * projects that live at TO on the host that traced them. */
export interface Rebase {
  from: string;
  to: string;
}

/** Parse `FROM=TO`; null when either side is empty. */
export function parseRebase(spec: string): Rebase | null {
  const i = spec.indexOf("=");
  if (i <= 0 || i === spec.length - 1) return null;
  return { from: resolve(spec.slice(0, i)), to: resolve(spec.slice(i + 1)) };
}

/** `path` with the rebase applied when it sits under `from`; else itself. */
export function rebasePath(path: string, rebase?: Rebase | null): string {
  if (!rebase) return path;
  const p = resolve(path);
  if (p === rebase.from) return rebase.to;
  return p.startsWith(rebase.from + "/") ? join(rebase.to, p.slice(rebase.from.length + 1)) : p;
}

/**
 * Plan moving each legacy dir's files into its project's store dir. A dir
 * argument may be the project dir or its .cctrace; both resolve. Live
 * files — claimed by a heartbeat-fresh registry entry, or written in the
 * last two minutes — stay put; so does anything whose name already exists
 * in the target (a re-run after a partial adopt: never overwrite).
 *
 * `rebase` handles legacy dirs mounted from another machine (a container
 * seeing the host's ~/wrk under ./mounts): the project path — hence the
 * store key and marker — is what the ORIGINATING host calls it, and the
 * registry's live check compares that same path, so a live host run's
 * file is recognised (a shared data dir records host-side paths).
 */
export async function planAdopt(
  dataDir: string,
  candidates: string[],
  opts: { nowMs?: number; liveFiles?: Set<string>; rebase?: Rebase | null; copy?: boolean; archive?: boolean } = {},
): Promise<AdoptPlan> {
  const now = opts.nowMs ?? Date.now();
  const live = opts.liveFiles ?? liveLogFiles(dataDir, now);
  const rebase = opts.rebase ?? null;
  const dirs: AdoptDirPlan[] = [];
  const absent: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const abs = resolve(c);
    const legacyDir = basename(abs) === LEGACY_DIRNAME ? abs : join(abs, LEGACY_DIRNAME);
    if (seen.has(legacyDir)) continue;
    seen.add(legacyDir);
    if (!existsSync(legacyDir)) { absent.push(legacyDir); continue; }
    const projectPath = rebasePath(dirname(legacyDir), rebase);
    const targetDir = projectTraceDir(dataDir, projectPath);
    const moves: AdoptMove[] = [];
    const skipped: AdoptDirPlan["skipped"] = [];
    let names: string[] = [];
    try { names = readdirSync(legacyDir); } catch { absent.push(legacyDir); continue; }
    for (const name of names.sort()) {
      if (!isAdoptable(name)) continue;
      const from = join(legacyDir, name);
      let st;
      try { st = statSync(from); } catch { continue; }
      if (!st.isFile()) continue;
      const alias = rebase ? rebasePath(from, rebase) : undefined;
      if (live.has(from) || (alias && live.has(alias))) { skipped.push({ name, reason: "live run" }); continue; }
      if (name.endsWith(".jsonl") && now - st.mtimeMs < 2 * 60_000) { skipped.push({ name, reason: "written in the last 2 min" }); continue; }
      // A name already in the store (a session continued after the upgrade
      // has a store-side session-<sid8> archive; a re-run after a partial
      // adopt) is never overwritten: the legacy copy moves in under a
      // `.legacyN` suffix, still a trace file every reader merges by sid.
      // --zst: a plain trace arrives archived (its own name + .zst); an
      // archive or .html arrives as-is. Empty traces have nothing to archive.
      // An archived mirror (--copy --zst) is traces only: .html snapshots
      // are regenerable (view --html) and would be the bulk of it.
      if (opts.copy && opts.archive && name.endsWith(".html")) { skipped.push({ name, reason: "regenerable snapshot" }); continue; }
      const archive = !!opts.archive && name.endsWith(".jsonl") && st.size > 0;
      const wanted = archive ? name + ".zst" : name;
      // A copy is a re-runnable mirror: what the store already holds under
      // this name (plain or archived) is done, not a collision.
      if (opts.copy && (existsSync(join(targetDir, wanted)) || existsSync(join(targetDir, name)) || existsSync(join(targetDir, name + ".zst")))) {
        skipped.push({ name, reason: "already in the store" });
        continue;
      }
      // A move meeting its own archive (a mirror built earlier with --copy
      // --zst, or the store's exit-time archive of this very run): when
      // the archive decodes to exactly this file's size it IS this file —
      // the plain twin has nothing to add and is not moved in as a
      // .legacyN duplicate. A size mismatch is a real collision (the plain
      // file grew after the archive) and takes the .legacyN path as before.
      if (!opts.copy && name.endsWith(".jsonl") && st.size > 0) {
        const archived = join(targetDir, name + ".zst");
        if (existsSync(archived)) {
          let decoded = -1;
          try { decoded = await zstdDecodedBytes(archived); } catch { /* unreadable archive: collide, don't assume */ }
          if (decoded === st.size) { skipped.push({ name, reason: "already archived in the store" }); continue; }
        }
      }
      const move: AdoptMove = { from, to: freeName(targetDir, wanted), name, size: st.size };
      if (alias && alias !== from) move.alias = alias;
      if (archive) move.archive = true;
      moves.push(move);
    }
    if (!moves.length && !skipped.length) { absent.push(legacyDir); continue; }
    dirs.push({ legacyDir, projectPath, targetDir, moves, skipped, bytes: moves.reduce((s, m) => s + m.size, 0) });
  }
  return { copy: !!opts.copy, dirs, absent, bytes: dirs.reduce((s, d) => s + d.bytes, 0), files: dirs.reduce((s, d) => s + d.moves.length, 0) };
}

/** `name` in `dir` if free, else `<stem>.legacy1<ext>`, `.legacy2`, ... —
 * the trace/archive extension stays last so it still reads as a trace. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const m = /^(.*?)(\.jsonl(?:\.zst|\.gz)?|\.html)$/.exec(name);
  const stem = m ? m[1]! : name;
  const ext = m ? m[2]! : "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${stem}.legacy${n}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * logFiles of heartbeat-fresh registry entries (a live run's sink) — as
 * recorded, AND as they resolve through THIS side's store dir for the
 * entry's project: a run in another container names the same trace under
 * its own $HOME (`/Users/eric/.local/share/...` vs `/home/deva/...`), and
 * a sweep here must recognise it as live all the same.
 */
export function liveLogFiles(dataDir: string, nowMs = Date.now()): Set<string> {
  const dir = instancesDir(dataDir);
  const out = new Set<string>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      if (nowMs - statSync(path).mtimeMs > STALE_MS) continue;
      const info: InstanceInfo = JSON.parse(readFileSync(path, "utf8"));
      if (info.endedAt || !info.logFile) continue;
      out.add(resolve(info.logFile));
      if (info.projectPath) out.add(join(projectTraceDir(dataDir, info.projectPath), basename(info.logFile)));
    } catch { /* skip */ }
  }
  return out;
}

// ---- exit-seal jobs ----
//
// A finishing run hands its housekeeping (archive, merge, sweep) to a
// detached helper through a job file in the data dir root,
// `seal-<run>-<ts>.json` (cli.ts `sealTrace` / `runSeal`). The helper
// heartbeats the job's mtime while it works and unlinks it when done, so a
// job nobody has touched for SEAL_JOB_IDLE_MS is one whose helper died —
// the terminal or container the run lived in went away first (measured
// 2026-08-26: 56 of 58 jobs in a real data dir, 33 GB of traces left
// plain). The next live run re-spawns them; `cctrace compress` finishes
// them inline.

export const SEAL_JOB_IDLE_MS = 10 * 60_000;
export const isSealJob = (name: string) => /^seal-.*\.json$/.test(name);

/** Seal jobs in `dataDir` idle for `idleMs` or longer — orphaned helpers. */
export function staleSealJobs(dataDir: string, nowMs = Date.now(), idleMs = SEAL_JOB_IDLE_MS): string[] {
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    if (!isSealJob(n)) continue;
    const path = join(dataDir, n);
    try { const st = statSync(path); if (st.isFile() && nowMs - st.mtimeMs >= idleMs) out.push(path); } catch { /* gone */ }
  }
  return out.sort();
}

export interface AdoptResult {
  moved: AdoptMove[];
  /** Bytes the moved files occupy at the target (== bytes unless archived). */
  storedBytes: number;
  skipped: { name: string; reason: string }[];
  /** Legacy dirs removed because nothing was left in them. */
  removedDirs: string[];
  /** Registry entries whose logFile was re-pointed at the store. */
  repointed: number;
  bytes: number;
}

/**
 * Apply an adopt plan. Same-filesystem = rename; EXDEV = copy, verify the
 * byte count, then unlink. An archived move streams the plain trace to
 * .zst and decode-verifies it (byte count + frame checksums) before the
 * source goes; --copy leaves the source either way. Re-stats before each
 * move — a file that changed since the plan is a live sink and stays.
 * Registry entries naming a moved file are re-pointed (best-effort;
 * findTraceCarrier's store fallback covers the ones this misses, e.g.
 * tombstones written on another host).
 */
export async function applyAdopt(dataDir: string, plan: AdoptPlan, onProgress?: (m: AdoptMove, i: number, n: number) => void): Promise<AdoptResult> {
  const moved: AdoptMove[] = [];
  const skipped: AdoptResult["skipped"] = [];
  const removedDirs: string[] = [];
  const movedByFrom = new Map<string, string>();
  let storedBytes = 0;
  let i = 0;
  for (const d of plan.dirs) {
    ensureProjectDir(dataDir, d.projectPath);
    for (const m of d.moves) {
      onProgress?.(m, ++i, plan.files);
      try {
        if (statSync(m.from).size !== m.size) { skipped.push({ name: m.name, reason: "changed since plan" }); continue; }
        if (existsSync(m.to)) { skipped.push({ name: m.name, reason: "target appeared since plan" }); continue; }
        if (m.archive) storedBytes += await archiveFile(m.from, m.to, m.size, plan.copy);
        else { moveFile(m.from, m.to, m.size, plan.copy); storedBytes += m.size; }
        moved.push(m);
        movedByFrom.set(m.from, m.to);
        if (m.alias) movedByFrom.set(m.alias, m.to);
      } catch (err) {
        skipped.push({ name: m.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // Leave the legacy dir only when it is truly empty — a stray file the
    // user put there is theirs.
    if (!plan.copy) {
      try {
        if (readdirSync(d.legacyDir).length === 0) { rmdirSync(d.legacyDir); removedDirs.push(d.legacyDir); }
      } catch { /* keep */ }
    }
  }
  const repointed = movedByFrom.size ? repointRegistry(dataDir, movedByFrom) : 0;
  return { moved, storedBytes, skipped, removedDirs, repointed, bytes: moved.reduce((s, m) => s + m.size, 0) };
}

function moveFile(from: string, to: string, size: number, copy: boolean) {
  if (!copy) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
  }
  const tmp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, tmp);
  if (statSync(tmp).size !== size) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error("copy size mismatch");
  }
  renameSync(tmp, to);
  if (!copy) unlinkSync(from);
}

/** Stream `from` to the .zst at `to`; the source is unlinked only after the
 * archive decodes back to exactly `size` bytes. Returns the archive size. */
async function archiveFile(from: string, to: string, size: number, copy: boolean): Promise<number> {
  const tmp = `${to}.${process.pid}.tmp`;
  let out: number;
  try {
    out = await zstdFile(from, tmp);
    if ((await zstdDecodedBytes(tmp)) !== size) throw new Error("archive did not decode to the source size");
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  renameSync(tmp, to);
  if (!copy) unlinkSync(from);
  return out;
}

/** Rewrite registry entries whose logFile is a key of `moved`. */
export function repointRegistry(dataDir: string, moved: Map<string, string>): number {
  const dir = instancesDir(dataDir);
  let n = 0;
  let files: string[];
  try { files = readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, "utf8");
      const info: InstanceInfo = JSON.parse(raw);
      const to = info.logFile ? moved.get(resolve(info.logFile)) : undefined;
      if (!to) continue;
      info.logFile = to;
      // tmp + rename: a reader mid-write sees a torn entry and readEntries
      // deletes what it can't parse — a tombstone must never die that way.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(info, null, 2) + "\n");
      renameSync(tmp, path);
      n++;
    } catch { /* best-effort */ }
  }
  return n;
}
