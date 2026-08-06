import { readdirSync, statSync, writeFileSync, appendFileSync, unlinkSync, existsSync, readFileSync, renameSync } from "fs";
import { join, basename } from "path";
import { gzipSync } from "zlib";
import { readTraceText, isTraceFile, parseTraceText, type TraceParseStats } from "./history";
import { extractSessionId } from "./summarize";
import { wireTables } from "./clients";
import type { TracePair } from "./types";

const WIRE = wireTables();

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
      if (existsSync(stem + ".jsonl") || existsSync(stem + ".jsonl.zst") || existsSync(stem + ".jsonl.gz")) htmls.push(e);
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
  /** Pairs with no session id (OAuth/usage/telemetry), left in place. Under a
   * scoped plan only candidate files are parsed, so this counts those alone. */
  unattributable: number;
  /** Trace files that would be fully consumed by a merged output (prune-able). */
  subsumed: FileEntry[];
  /** Sessions left unmerged because an existing output couldn't be fully read
   * — writing over it could shrink it, the one thing merge must never do. */
  blocked: { outName: string; reason: string }[];
}

/** Progress event for the slow phases of merge — the CLI decides what to print. */
export interface MergeProgress {
  phase: "scan" | "read" | "write";
  name: string;
  bytes?: number;
  pairs?: number;
}

export interface MergeScope {
  /** Merge only these sessions (the exit auto-merge scopes to the run's own). */
  sessionIds?: Set<string>;
  /** Skip a session that lives in one file with no previously merged output —
   * there is nothing to consolidate, so leave its trace untouched. */
  fragmentedOnly?: boolean;
  /** Called before each slow step (file scan/parse) so a big merge stays
   * visible instead of looking stuck at exit. */
  onProgress?: (ev: MergeProgress) => void;
}

export function planMerge(logDir: string, scope: MergeScope = {}): MergePlan {
  const bySession = new Map<string, { pairs: Map<string, TracePair>; sources: Set<string>; dupes: number }>();
  const fileSessionPairs = new Map<string, { total: number; attributed: number; sids: Set<string> }>();
  const progress = scope.onProgress ?? (() => {});
  let unattributable = 0;

  let sources = ls(logDir).filter((p) => isTraceFile(p) && !basename(p).startsWith("session-")); // our own output is an input below, never a source

  // Scoped plans (the exit auto-merge) pre-scan by SUBSTRING before parsing
  // anything: a wire session id is always a verbatim substring of its pair's
  // JSON line, so a file whose text never mentions a target id cannot hold a
  // pair this plan would keep. Two wins over parse-everything: unrelated
  // traces in a big log dir are never JSON-parsed at all, and fragmentedOnly
  // can conclude "nothing to consolidate" — the common fresh-single-file
  // exit — without parsing even this run's own (possibly huge) trace.
  // Substring hits over-count (an id quoted inside some response body makes
  // a file a candidate), which is safe: the parse below re-derives the real
  // attribution; under-counting is impossible.
  if (scope.sessionIds && scope.sessionIds.size) {
    const hitFiles: string[] = [];
    const hitCount = new Map<string, number>();
    for (const path of sources) {
      let st;
      try { st = statSync(path); } catch { continue; }
      progress({ phase: "scan", name: basename(path), bytes: st.size });
      let text: string;
      try { text = readTraceText(path); } catch { continue; }
      let hit = false;
      for (const sid of scope.sessionIds) {
        if (!text.includes(sid)) continue;
        hit = true;
        hitCount.set(sid, (hitCount.get(sid) || 0) + 1);
      }
      if (hit) hitFiles.push(path);
    }
    if (scope.fragmentedOnly) {
      // A prior output makes a single-source session still worth merging
      // (the union grows it); its name starts with the sid's 8-hex prefix
      // whatever collision-extension the writer used.
      const names = ls(logDir).map((p) => basename(p));
      const priorFor = (sid: string) => names.some((n) => n.lastIndexOf(`session-${sid.slice(0, 8)}`, 0) === 0);
      if (![...scope.sessionIds].some((sid) => (hitCount.get(sid) || 0) >= 2 || priorFor(sid))) {
        return { sessions: [], unattributable: 0, subsumed: [], blocked: [] };
      }
    }
    sources = hitFiles;
  }

  for (const path of sources) {
    let size = 0;
    try { size = statSync(path).size; } catch { /* report 0 */ }
    progress({ phase: "read", name: basename(path), bytes: size });
    let pairs: TracePair[];
    const damage: TraceParseStats = { torn: 0, invalid: 0 };
    try { pairs = parseTraceText(readTraceText(path), damage); } catch { continue; }
    const name = basename(path);
    const stat = { total: pairs.length, attributed: 0, sids: new Set<string>(), damaged: damage.torn + damage.invalid };
    for (const p of pairs) {
      const sid = extractSessionId(p, WIRE);
      if (!sid) { unattributable++; continue; }
      stat.attributed++;
      stat.sids.add(sid);
      let g = bySession.get(sid);
      if (!g) { g = { pairs: new Map(), sources: new Set(), dupes: 0 }; bySession.set(sid, g); }
      // Out of scope: the id still registers (output naming must dodge its
      // prefix, prune safety must see it) but its pairs are never held — a
      // scoped merge shouldn't carry every other session in the dir.
      if (scope.sessionIds && !scope.sessionIds.has(sid)) continue;
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
  const blocked: MergePlan["blocked"] = [];
  for (const [id, g] of bySession) {
    if (scope.sessionIds && !scope.sessionIds.has(id)) continue;
    const shortId = shortFor(id);
    const outPath = join(logDir, `session-${shortId}.jsonl`);
    const priors = [outPath, `${outPath}.zst`, `${outPath}.gz`].filter(existsSync);
    if (scope.fragmentedOnly && g.sources.size < 2 && !priors.length) continue;
    // A previous merge's output is an INPUT: --prune may have deleted its
    // sources, so union with it — a re-run can only grow the merged file,
    // never shrink it back to whatever the current sources happen to hold.
    // A prior we can't fully read blocks the whole session: applyMerge would
    // replace outPath with only what we could see — merge must never shrink.
    let existing = 0;
    let priorDamage: string | null = null;
    for (const prev of priors) {
      let prevPairs: TracePair[];
      const pd: TraceParseStats = { torn: 0, invalid: 0 };
      try { prevPairs = parseTraceText(readTraceText(prev), pd); } catch { priorDamage = `${basename(prev)} is unreadable`; break; }
      if (pd.torn + pd.invalid > 0) { priorDamage = `${basename(prev)} holds ${pd.torn + pd.invalid} damaged line(s)`; break; }
      for (const p of prevPairs) {
        const key = pairKey(p);
        if (!g.pairs.has(key)) { g.pairs.set(key, p); existing++; }
      }
    }
    if (priorDamage) { blocked.push({ outName: `session-${shortId}.jsonl`, reason: priorDamage }); continue; }
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

  // A source is prune-able only if every one of its pairs lands in a session
  // this plan actually WRITES (nothing unique would be lost). Utility traces
  // never qualify — and under a scoped plan neither does a file holding a
  // session we're not merging: those pairs would exist in no output. A file
  // with damaged lines (torn tail from a killed run) never qualifies either:
  // the parser skipped those bytes, so no output holds them.
  const written = new Set(sessions.map((s) => s.id));
  const subsumed: FileEntry[] = [];
  for (const [name, stat] of fileSessionPairs) {
    if (stat.total > 0 && stat.damaged === 0 && stat.attributed === stat.total && [...stat.sids].every((id) => written.has(id))) {
      const path = join(logDir, name);
      try { subsumed.push(entry(path)); } catch { /* skip */ }
    }
  }
  return { sessions, unattributable, subsumed, blocked };
}

// Serialize + write pairs in bounded chunks: one giant join() of a multi-GB
// session doubled peak memory and stalled visibly; 8MB appends keep the write
// incremental. Still tmp + rename — a torn write never lands on the real name.
function writePairsAtomic(path: string, pairs: TracePair[]) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, "");
  const CHUNK = 8 * 1024 * 1024;
  let buf: string[] = [];
  let len = 0;
  for (const p of pairs) {
    const line = JSON.stringify(p) + "\n";
    buf.push(line);
    len += line.length;
    if (len >= CHUNK) {
      appendFileSync(tmp, buf.join(""));
      buf = [];
      len = 0;
    }
  }
  if (buf.length) appendFileSync(tmp, buf.join(""));
  renameSync(tmp, path);
}

export function applyMerge(plan: MergePlan, opts: { prune: boolean; onProgress?: (ev: MergeProgress) => void }): { written: string[]; pruned: string[]; skipped: string[]; bytes: number } {
  const written: string[] = [];
  for (const s of plan.sessions) {
    opts.onProgress?.({ phase: "write", name: s.outName, pairs: s.pairCount });
    writePairsAtomic(s.outPath, s.pairs);
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

// ---- compress: zstd archive .jsonl traces for backup ----
//
// Codec: Bun's built-in zstd at level 19. Traces are dominated by re-sent
// conversation prefixes — long-range redundancy far beyond gzip's 32KB
// window. Single-shot zstd windows the whole input, so it sees every
// repeated prefix: measured on a real 375MB session trace, gzip -9 got 2.8x
// while zstd-19 got 63x (5.7MB), byte-identical round trip, 6.7s. The codec
// ships inside the Bun runtime (and thus the compiled binary) — no external
// dependency, nothing to fall back from. Legacy .jsonl.gz archives written
// by older versions stay readable everywhere and are upgraded to .zst here.

const zstd = (data: Uint8Array | string): Buffer =>
  Buffer.from(Bun.zstdCompressSync(typeof data === "string" ? Buffer.from(data) : data, { level: 19 }));

export interface CompressEntry extends FileEntry {
  mtimeMs: number;
}

export interface CompressPlan {
  files: CompressEntry[];
  /** Legacy .jsonl.gz archives to re-encode as .zst (13-20x smaller). */
  upgrades: FileEntry[];
  bytes: number;
}

/** Plan archiving raw .jsonl traces + upgrading legacy .gz, age-filterable. */
export function planCompress(logDir: string, nowMs: number, olderThanDays?: number): CompressPlan {
  const files: CompressEntry[] = [];
  const upgrades: FileEntry[] = [];
  for (const path of ls(logDir)) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (path.endsWith(".jsonl.gz")) {
      // Legacy archive: re-encode regardless of age — it's already cold data.
      upgrades.push({ path, name: basename(path), size: st.size });
      continue;
    }
    if (!path.endsWith(".jsonl")) continue; // .jsonl.zst already archived
    if (olderThanDays != null && nowMs - st.mtimeMs < olderThanDays * 86400_000) continue;
    files.push({ path, name: basename(path), size: st.size, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => b.size - a.size);
  return { files, upgrades, bytes: files.reduce((s, f) => s + f.size, 0) };
}

/**
 * Archive to `<name>.jsonl.zst`. If an archive already exists (the trace file
 * was recreated after an earlier compress, or a legacy .gz holds pairs),
 * union with it instead of overwriting — an archive never loses pairs.
 */
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
    const outPath = `${f.path}.zst`;
    const legacyGz = `${f.path}.gz`;
    let out: Buffer;
    const priors = [outPath, legacyGz].filter(existsSync);
    if (priors.length) {
      try {
        const merged = new Map<string, TracePair>();
        for (const prev of priors) {
          for (const p of parseTraceText(readTraceText(prev))) merged.set(pairKey(p), p);
        }
        for (const p of parseTraceText(raw.toString("utf8"))) merged.set(pairKey(p), p);
        out = zstd(serialize([...merged.values()].sort(byTimestamp)));
      } catch { skipped.push(f.name); continue; }
    } else {
      out = zstd(raw); // verbatim bytes — archives stay exact
    }
    writeAtomic(outPath, out);
    // The legacy .gz's pairs are now unioned into the .zst — drop it.
    if (priors.includes(legacyGz)) { try { unlinkSync(legacyGz); } catch { /* keep */ } }
    if (!opts.keepJsonl) {
      // Only unlink what we actually archived: if the file grew between the
      // read and now, keep it — the next compress unions the tail in.
      try { if (statSync(f.path).size === f.size) unlinkSync(f.path); } catch { /* keep */ }
    }
    archived.push({ name: f.name, before: f.size, after: out.length });
    before += f.size;
    after += out.length;
  }

  for (const f of plan.upgrades) {
    // A sibling .jsonl handled above already unioned + removed this .gz.
    if (!existsSync(f.path)) continue;
    let st;
    try { st = statSync(f.path); } catch { skipped.push(f.name); continue; }
    if (st.size !== f.size) { skipped.push(f.name); continue; }
    const outPath = f.path.replace(/\.gz$/, ".zst");
    let out: Buffer;
    try {
      if (existsSync(outPath)) {
        const merged = new Map<string, TracePair>();
        for (const p of parseTraceText(readTraceText(outPath))) merged.set(pairKey(p), p);
        for (const p of parseTraceText(readTraceText(f.path))) merged.set(pairKey(p), p);
        out = zstd(serialize([...merged.values()].sort(byTimestamp)));
      } else {
        out = zstd(readTraceText(f.path)); // same lines, better codec
      }
    } catch { skipped.push(f.name); continue; }
    writeAtomic(outPath, out);
    try { unlinkSync(f.path); } catch { /* keep */ }
    archived.push({ name: f.name, before: f.size, after: out.length });
    before += f.size;
    after += out.length;
  }

  return { archived, skipped, before, after };
}

// ---- purge: drop whole categories of pairs from saved traces ----
//
// Honesty note baked into the CLI output: on a real 375MB session trace,
// messages are 87% of the bytes (re-sent conversation context), telemetry 9%.
// Purging the default set (telemetry + count_tokens) removes ~45% of ROWS —
// less list noise, faster rendering — but frees only ~9% of DISK. The space
// tool is `cctrace compress` (63x); purge is the row/noise tool.

export interface PurgeFile extends FileEntry {
  /** Pairs that stay. */
  kept: number;
  /** Pairs to drop, tallied by category. */
  dropped: Record<string, number>;
  droppedCount: number;
  /** Raw .jsonl bytes the dropped lines occupy (pre-compression). */
  droppedBytes: number;
  /** Every pair matched the drop set — the whole file goes. */
  empty: boolean;
}

export interface PurgePlan {
  files: PurgeFile[];
  dropped: Record<string, number>;
  droppedCount: number;
  droppedBytes: number;
  keptCount: number;
}

/**
 * Plan dropping pairs whose category is in `drop`. Works line-by-line so
 * kept lines survive byte-identical; a line that doesn't parse (torn tail
 * from a killed run) is never a purge target — purge only removes what it
 * can positively categorize.
 */
export function planPurge(logDir: string, drop: Set<string>, categorize: (url: string, client?: string) => string): PurgePlan {
  const files: PurgeFile[] = [];
  const totals: Record<string, number> = {};
  let droppedCount = 0, droppedBytes = 0, keptCount = 0;

  for (const path of ls(logDir)) {
    if (!isTraceFile(path)) continue;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    let text: string;
    try { text = readTraceText(path); } catch { continue; }

    const dropped: Record<string, number> = {};
    let kept = 0, dCount = 0, dBytes = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const cat = lineCategory(line, categorize);
      if (cat !== null && drop.has(cat)) {
        dropped[cat] = (dropped[cat] || 0) + 1;
        dCount++;
        dBytes += line.length + 1;
      } else {
        kept++;
      }
    }
    if (dCount === 0) continue;
    files.push({
      path, name: basename(path), size: st.size,
      kept, dropped, droppedCount: dCount, droppedBytes: dBytes,
      empty: kept === 0,
    });
    for (const [c, n] of Object.entries(dropped)) totals[c] = (totals[c] || 0) + n;
    droppedCount += dCount;
    droppedBytes += dBytes;
    keptCount += kept;
  }

  files.sort((a, b) => b.droppedBytes - a.droppedBytes);
  return { files, dropped: totals, droppedCount, droppedBytes, keptCount };
}

/** Category of one trace line, or null when it isn't a categorizable pair. */
function lineCategory(line: string, categorize: (url: string, client?: string) => string): string | null {
  let pair: TracePair;
  try { pair = JSON.parse(line); } catch { return null; }
  const url = pair?.request?.url;
  if (typeof url !== "string") return null;
  return categorize(url, pair.client);
}

export function applyPurge(plan: PurgePlan, categorize: (url: string, client?: string) => string, drop: Set<string>): { rewritten: string[]; removed: string[]; skipped: string[]; bytes: number } {
  const rewritten: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;

  for (const f of plan.files) {
    // Re-stat: a live capture may have appended since the plan — replan
    // rather than judge lines the plan never saw.
    let st;
    try { st = statSync(f.path); } catch { skipped.push(f.name); continue; }
    if (st.size !== f.size) { skipped.push(f.name); continue; }
    let text: string;
    try { text = readTraceText(f.path); } catch { skipped.push(f.name); continue; }

    const keptLines: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const cat = lineCategory(line, categorize);
      if (cat !== null && drop.has(cat)) continue;
      keptLines.push(line);
    }

    if (keptLines.length === 0) {
      try { unlinkSync(f.path); removed.push(f.name); bytes += f.size; } catch { skipped.push(f.name); }
      continue;
    }
    const out = keptLines.join("\n") + "\n";
    // Preserve the file's own format: archives stay archives.
    if (f.path.endsWith(".zst")) writeAtomic(f.path, zstd(out));
    else if (f.path.endsWith(".gz")) writeAtomic(f.path, gzipSync(out, { level: 9 }));
    else writeAtomic(f.path, out);
    let after = 0;
    try { after = statSync(f.path).size; } catch { /* report 0 */ }
    rewritten.push(f.name);
    bytes += Math.max(0, f.size - after);
  }
  return { rewritten, removed, skipped, bytes };
}

// ---- purge by pair id: the web UI's select-to-purge ----

export interface IdPurgeResult {
  /** Files rewritten without the purged pairs (basenames). */
  rewritten: string[];
  /** Files removed because nothing was left in them (basenames). */
  removed: string[];
  /** Files that could not be rewritten — unreadable, or changed mid-flight
   * by a writer we don't own (basenames). Their pairs stay on disk. */
  skipped: string[];
  droppedCount: number;
}

/**
 * Remove named pairs from trace files. The privacy tool behind the web UI's
 * select-to-purge — same discipline as applyPurge: atomic rewrites, archives
 * stay archives, unparseable (torn) lines are preserved untouched, a file
 * left empty is deleted. Files without any named pair are never rewritten.
 * A file that changes size between read and write (a live capture we don't
 * own appending) is skipped, not truncated — the caller reports it.
 */
export function purgePairsById(paths: string[], ids: Set<string>): IdPurgeResult {
  const rewritten: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  let droppedCount = 0;
  for (const path of [...new Set(paths)]) {
    let before: number;
    let text: string;
    try {
      before = statSync(path).size;
      text = readTraceText(path);
    } catch {
      skipped.push(basename(path));
      continue;
    }
    const kept: string[] = [];
    let dropped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let id: unknown;
      try {
        id = (JSON.parse(line) as TracePair | null)?.id;
      } catch {
        kept.push(line); // torn tail line — never a purge target
        continue;
      }
      if (typeof id === "string" && ids.has(id)) { dropped++; continue; }
      kept.push(line);
    }
    if (!dropped) continue;
    try {
      if (statSync(path).size !== before) { skipped.push(basename(path)); continue; }
      if (!kept.length) {
        unlinkSync(path);
        removed.push(basename(path));
      } else {
        const out = kept.join("\n") + "\n";
        if (path.endsWith(".zst")) writeAtomic(path, zstd(out));
        else if (path.endsWith(".gz")) writeAtomic(path, gzipSync(out, { level: 9 }));
        else writeAtomic(path, out);
        rewritten.push(basename(path));
      }
      droppedCount += dropped;
    } catch {
      skipped.push(basename(path));
    }
  }
  return { rewritten, removed, skipped, droppedCount };
}
