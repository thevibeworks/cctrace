import { readdirSync, statSync, writeFileSync, unlinkSync, existsSync, readFileSync, renameSync } from "fs";
import { join, basename } from "path";
import { gzipSync } from "zlib";
import { readTraceText, isTraceFile, parseTraceText } from "./history";
import { extractSessionId } from "./summarize";
import type { TracePair } from "./types";

// Storage housekeeping for the log dir, shared by the clean/merge/compress
// subcommands. Each operation is a pure-ish plan() (survey, no writes) plus an
// apply() (mutates, returns what it did) so the CLI can dry-run then confirm.
//
// Data-safety invariants every apply() upholds:
//   - never delete anything whose content isn't fully held elsewhere
//   - re-stat before every unlink — a live capture may have appended pairs
//     between plan and apply, and those exist nowhere else
//   - never shrink an output: merge/compress union with an existing
//     session-*.jsonl / .gz instead of overwriting it

export interface FileEntry {
  path: string;
  name: string;
  size: number;
}

function entry(path: string): FileEntry {
  return { path, name: basename(path), size: statSync(path).size };
}

function ls(logDir: string): string[] {
  try {
    return readdirSync(logDir).map((f) => join(logDir, f));
  } catch {
    return [];
  }
}

export function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const u = ["KB", "MB", "GB"];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

// Pair ids are `${Date.now()}_${per-run ordinal}`, so two runs can mint the
// same id. Keying on id + both timestamps still collapses true re-reads of
// one pair while distinct pairs that happen to share an id survive.
function pairKey(p: TracePair): string {
  return `${p.id || ""}|${p.request?.timestamp || 0}|${p.response?.timestamp || 0}`;
}

// tmp + rename so a torn write never leaves a half-written file where a later
// run (or this run's --prune) expects a complete one.
function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function serialize(pairs: TracePair[]): string {
  return pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";
}

const byTimestamp = (a: TracePair, b: TracePair) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0);

// ---- clean: drop regenerable .html snapshots and 0-byte aborted traces ----

export interface CleanPlan {
  htmls: FileEntry[];
  empties: FileEntry[];
  /** .html files with no source trace left to rebuild from — never deleted. */
  kept: FileEntry[];
  bytes: number;
}

export function planClean(logDir: string): CleanPlan {
  const htmls: FileEntry[] = [];
  const empties: FileEntry[] = [];
  const kept: FileEntry[] = [];
  for (const path of ls(logDir)) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    if (path.endsWith(".html")) {
      // "Regenerable" is checked, not assumed: an .html is only disposable
      // while a sibling .jsonl(.gz) exists for `cctrace view` to rebuild from.
      const stem = path.slice(0, -".html".length);
      const e = { path, name: basename(path), size: st.size };
      if (existsSync(stem + ".jsonl") || existsSync(stem + ".jsonl.gz")) htmls.push(e);
      else kept.push(e);
    } else if (path.endsWith(".jsonl") && st.size === 0) {
      empties.push({ path, name: basename(path), size: 0 });
    }
  }
  const bytes = [...htmls, ...empties].reduce((s, f) => s + f.size, 0);
  return { htmls, empties, kept, bytes };
}

export function applyClean(plan: CleanPlan): { removed: string[]; skipped: string[]; bytes: number } {
  const removed: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const f of plan.htmls) {
    try { unlinkSync(f.path); removed.push(f.name); bytes += f.size; } catch { skipped.push(f.name); }
  }
  for (const f of plan.empties) {
    // Re-stat: a 0-byte file at plan time may be a live run's sink that has
    // since received pairs. (Deleting a still-empty live sink is harmless —
    // appendFileSync is path-based, so the run recreates it on next append.)
    try {
      if (statSync(f.path).size !== 0) { skipped.push(f.name); continue; }
      unlinkSync(f.path);
      removed.push(f.name);
    } catch { /* already gone */ }
  }
  return { removed, skipped, bytes };
}

// ---- merge: consolidate each session's pairs into one deduped .jsonl ----

export interface MergeSession {
  id: string;
  shortId: string;
  outName: string;
  outPath: string;
  sources: string[];
  pairCount: number;
  dupes: number;
  /** Pairs carried over from a previous merge's output (sources may be pruned). */
  existing: number;
  pairs: TracePair[];
}

export interface MergePlan {
  sessions: MergeSession[];
  /** Pairs with no session id (OAuth/usage/telemetry), left in place. */
  unattributable: number;
  /** Trace files that would be fully consumed by a merged output (prune-able). */
  subsumed: FileEntry[];
}

export function planMerge(logDir: string): MergePlan {
  const bySession = new Map<string, { pairs: Map<string, TracePair>; sources: Set<string>; dupes: number }>();
  const fileSessionPairs = new Map<string, { total: number; attributed: number }>();
  let unattributable = 0;

  for (const path of ls(logDir)) {
    if (!isTraceFile(path)) continue;
    if (basename(path).startsWith("session-")) continue; // our own output is an input below, never a source
    let pairs: TracePair[];
    try { pairs = parseTraceText(readTraceText(path)); } catch { continue; }
    const name = basename(path);
    const stat = { total: pairs.length, attributed: 0 };
    for (const p of pairs) {
      const sid = extractSessionId(p);
      if (!sid) { unattributable++; continue; }
      stat.attributed++;
      let g = bySession.get(sid);
      if (!g) { g = { pairs: new Map(), sources: new Set(), dupes: 0 }; bySession.set(sid, g); }
      g.sources.add(name);
      const key = pairKey(p);
      if (g.pairs.has(key)) g.dupes++;
      else g.pairs.set(key, p);
    }
    fileSessionPairs.set(name, stat);
  }

  // 8 hex chars of the id names the output; extend on the (unlikely) prefix
  // collision so two sessions can never claim — and clobber — the same file.
  const ids = [...bySession.keys()];
  const shortFor = (id: string): string => {
    let n = 8;
    while (n < id.length && ids.some((o) => o !== id && o.slice(0, n) === id.slice(0, n))) n++;
    return id.slice(0, n);
  };

  const sessions: MergeSession[] = [];
  for (const [id, g] of bySession) {
    const shortId = shortFor(id);
    const outPath = join(logDir, `session-${shortId}.jsonl`);
    // A previous merge's output is an INPUT: --prune may have deleted its
    // sources, so union with it — a re-run can only grow the merged file,
    // never shrink it back to whatever the current sources happen to hold.
    let existing = 0;
    for (const prev of [outPath, `${outPath}.gz`]) {
      if (!existsSync(prev)) continue;
      let prevPairs: TracePair[];
      try { prevPairs = parseTraceText(readTraceText(prev)); } catch { continue; }
      for (const p of prevPairs) {
        const key = pairKey(p);
        if (!g.pairs.has(key)) { g.pairs.set(key, p); existing++; }
      }
    }
    const pairs = [...g.pairs.values()].sort(byTimestamp);
    sessions.push({
      id, shortId,
      outName: `session-${shortId}.jsonl`,
      outPath,
      sources: [...g.sources].sort(),
      pairCount: pairs.length,
      dupes: g.dupes,
      existing,
      pairs,
    });
  }
  sessions.sort((a, b) => (b.pairCount - a.pairCount));

  // A source is prune-able only if every one of its pairs was attributed to a
  // session (nothing unique would be lost). Utility traces never qualify.
  const subsumed: FileEntry[] = [];
  for (const [name, stat] of fileSessionPairs) {
    if (stat.total > 0 && stat.attributed === stat.total) {
      const path = join(logDir, name);
      try { subsumed.push(entry(path)); } catch { /* skip */ }
    }
  }
  return { sessions, unattributable, subsumed };
}

export function applyMerge(plan: MergePlan, opts: { prune: boolean }): { written: string[]; pruned: string[]; skipped: string[]; bytes: number } {
  const written: string[] = [];
  for (const s of plan.sessions) {
    writeAtomic(s.outPath, serialize(s.pairs));
    written.push(s.outName);
  }
  const pruned: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  if (opts.prune) {
    const outputs = new Set(plan.sessions.map((s) => s.outName));
    for (const f of plan.subsumed) {
      if (outputs.has(f.name)) continue; // never delete a file we just wrote
      // Re-stat: a live capture may have appended pairs since the plan read
      // this file — those are in no merged output, so the file must survive.
      try {
        if (statSync(f.path).size !== f.size) { skipped.push(f.name); continue; }
        unlinkSync(f.path);
        pruned.push(f.name);
        bytes += f.size;
      } catch { /* already gone */ }
    }
  }
  return { written, pruned, skipped, bytes };
}

// ---- compress: gzip -9 archive .jsonl traces for backup ----

export interface CompressEntry extends FileEntry {
  mtimeMs: number;
}

export interface CompressPlan {
  files: CompressEntry[];
  bytes: number;
}

/** Plan gzip of raw .jsonl traces (skips already-.gz), optional age filter. */
export function planCompress(logDir: string, nowMs: number, olderThanDays?: number): CompressPlan {
  const files: CompressEntry[] = [];
  for (const path of ls(logDir)) {
    if (!path.endsWith(".jsonl")) continue; // .jsonl.gz already archived
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (olderThanDays != null && nowMs - st.mtimeMs < olderThanDays * 86400_000) continue;
    files.push({ path, name: basename(path), size: st.size, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => b.size - a.size);
  return { files, bytes: files.reduce((s, f) => s + f.size, 0) };
}

export function applyCompress(plan: CompressPlan, opts: { keepJsonl: boolean }): { archived: { name: string; before: number; after: number }[]; skipped: string[]; before: number; after: number } {
  const archived: { name: string; before: number; after: number }[] = [];
  const skipped: string[] = [];
  let before = 0, after = 0;
  for (const f of plan.files) {
    // Re-stat: skip anything that changed since the plan (a live capture).
    let st;
    try { st = statSync(f.path); } catch { skipped.push(f.name); continue; }
    if (st.size !== f.size) { skipped.push(f.name); continue; }
    let raw: Buffer;
    try { raw = readFileSync(f.path); } catch { skipped.push(f.name); continue; }
    const outPath = `${f.path}.gz`;
    let gz: Buffer;
    if (existsSync(outPath)) {
      // An archive already exists (the trace file was recreated after an
      // earlier compress, e.g. by a live run or --log NAME reuse): union with
      // it instead of overwriting — an archive never loses pairs it holds.
      try {
        const merged = new Map<string, TracePair>();
        for (const p of parseTraceText(readTraceText(outPath))) merged.set(pairKey(p), p);
        for (const p of parseTraceText(raw.toString("utf8"))) merged.set(pairKey(p), p);
        gz = gzipSync(serialize([...merged.values()].sort(byTimestamp)), { level: 9 });
      } catch { skipped.push(f.name); continue; }
    } else {
      gz = gzipSync(raw, { level: 9 }); // verbatim bytes — archives stay exact
    }
    writeAtomic(outPath, gz);
    if (!opts.keepJsonl) {
      // Only unlink what we actually archived: if the file grew between the
      // read and now, keep it — the next compress unions the tail in.
      try { if (statSync(f.path).size === f.size) unlinkSync(f.path); } catch { /* keep */ }
    }
    archived.push({ name: f.name, before: f.size, after: gz.length });
    before += f.size;
    after += gz.length;
  }
  return { archived, skipped, before, after };
}
