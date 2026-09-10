import { readdirSync, readFileSync, statSync, createReadStream } from "fs";
import { join, basename, resolve } from "path";
import { gunzipSync, zstdDecompressSync, createGunzip, createZstdDecompress } from "zlib";
import { StringDecoder } from "string_decoder";
import { extractSessionId } from "./summarize";
import { wireTables } from "./clients";
import type { TracePair } from "./types";

const WIRE = wireTables();

/** Read a trace file whole, transparently decompressing a `.zst`/`.gz`
 * archive — for the rewrite commands that hold a trace as pairs anyway
 * (merge/purge/compact). Readers use the streaming `readTracePairs` below.
 * The zstd side is node:zlib, the same codec that wrote the frame (our
 * streamed frames carry no content-size header). */
export function readTraceText(path: string): string {
  const buf = readFileSync(path);
  if (path.endsWith(".zst")) return zstdDecompressSync(buf).toString("utf8");
  if (path.endsWith(".gz")) return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
}

// ---- streaming readers ----
//
// A trace is a log: multi-GB per session is normal, and at rest it is a
// single zstd frame that only decodes front to back. readTraceText holds
// the whole decoded file as one string — past ~2 GB that is not even
// representable (ERR_STRING_TOO_LONG), and well before that a `view` of a
// big trace was an OOM. Everything that opens traces for reading — view,
// continuity merges, the picker's peek — streams instead: decode chunk by
// chunk, split lines, keep only what the caller asked for. Readers that
// need "the trace" keep its NEWEST lines within a byte budget (it's a log —
// the latest is what you open for) and say how much they left behind.

/** Stream a trace file's lines — plain, .zst or .gz — never holding the
 * file. Break out early and the streams are torn down. */
export async function* traceLines(path: string): AsyncGenerator<string> {
  const src = createReadStream(path, { highWaterMark: 1 << 20 });
  const stream = path.endsWith(".zst")
    ? src.pipe(createZstdDecompress({ chunkSize: 1 << 20 }))
    : path.endsWith(".gz")
      ? src.pipe(createGunzip({ chunkSize: 1 << 20 }))
      : src;
  // pipe() does not forward read errors to the decoder — surface them.
  if (stream !== src) src.on("error", (err) => stream.destroy(err));
  const decoder = new StringDecoder("utf8");
  let rest = "";
  try {
    for await (const chunk of stream) {
      rest += decoder.write(chunk as Buffer);
      let start = 0;
      let nl: number;
      while ((nl = rest.indexOf("\n", start)) !== -1) {
        yield rest.slice(start, nl);
        start = nl + 1;
      }
      rest = start ? rest.slice(start) : rest;
    }
    rest += decoder.end();
    if (rest) yield rest;
  } finally {
    src.destroy();
    if (stream !== src) stream.destroy();
  }
}

/** Default byte budget of decoded trace lines a reader keeps: the newest
 * 256 MB. A typical session trace fits whole; a multi-GB one opens to its
 * latest quarter-gigabyte instead of not opening. */
export const TAIL_BYTES = 256 * 1024 * 1024;

export interface ReadTraceOpts {
  /** Only lines containing at least one of these substrings are considered
   * (a wire session id is always a verbatim substring of its pair's line). */
  needles?: string[];
  /** Keep only pairs this accepts (parsed before budgeting). */
  filter?: (pair: TracePair) => boolean;
  /** Keep the newest lines whose bytes fit; Infinity = all. Default TAIL_BYTES. */
  tailBytes?: number;
  stats?: TraceParseStats;
  /**
   * Called with each kept pair as it is parsed, BEFORE it is charged to the
   * budget. This is where a reader that folds (the live server's request-body
   * fold) does its work: setting it makes the read hold pairs, not lines, and
   * delays each pair's charge by one arrival — the request that supersedes a
   * body arrives next, so the ring charges what is still HELD instead of what
   * the line weighed.
   */
  onKeep?: (pair: TracePair) => void;
  /** The budget charge for a kept pair; default its raw line bytes. */
  weigh?: (pair: TracePair, bytes: number) => number;
  /** A pair the budget dropped from the head — the reader's cue to forget it. */
  onDrop?: (pair: TracePair) => void;
}

export interface ReadTraceResult {
  pairs: TracePair[];
  /** Lines that fit the budget but were dropped from the head by it. */
  dropped: number;
  /** Decoded bytes of the lines kept. */
  keptBytes: number;
  /** Decoded bytes of every candidate line seen (post-needle, pre-budget). */
  seenBytes: number;
}

/**
 * The usable pairs of a trace, streamed. Damaged lines are counted in
 * `stats` (over the lines that were parsed — with a budget, that is the
 * tail). Memory is bounded by the budget: raw lines ride in a ring, the
 * head falls off as the tail grows, and only the survivors are parsed.
 */
export async function readTracePairs(path: string, opts: ReadTraceOpts = {}): Promise<ReadTraceResult> {
  const budget = opts.tailBytes ?? TAIL_BYTES;
  const needles = opts.needles;
  // Raw lines ride the ring unparsed so the head can fall off the budget
  // without ever being parsed. A FILTERED read has already paid that parse
  // to decide — it keeps the object instead of the line, which both halves
  // the parsing and lowers the peak: the old ring re-parsed its survivors
  // at the end, holding strings and pairs at once. At 332 KB a line that
  // was most of a 2.4 GB read (issue #106). A read with onKeep keeps pairs
  // for the same reason: the hook folds them as they arrive, so the peak is
  // what the reader HOLDS, not what the tail weighed on disk.
  const ring: (string | TracePair)[] = [];
  const lens: number[] = [];
  let head = 0;
  let keptBytes = 0;
  let seenBytes = 0;
  let dropped = 0;
  const parseUsable = (line: string): TracePair | null => {
    let pair: unknown;
    try {
      pair = JSON.parse(line);
    } catch {
      if (opts.stats) opts.stats.torn++;
      return null;
    }
    if (!isUsablePair(pair)) {
      if (opts.stats) opts.stats.invalid++;
      return null;
    }
    return pair;
  };
  const keep = (held: string | TracePair, bytes: number) => {
    ring.push(held);
    const size = opts.weigh && typeof held !== "string" ? opts.weigh(held, bytes) : bytes;
    lens.push(size);
    keptBytes += size;
    while (keptBytes > budget && head < ring.length - 1) {
      keptBytes -= lens[head]!;
      const gone = ring[head]!;
      ring[head] = "";
      head++;
      dropped++;
      if (opts.onDrop && typeof gone !== "string") opts.onDrop(gone);
    }
    if (head > 4096) { ring.splice(0, head); lens.splice(0, head); head = 0; }
  };
  // With onKeep the newest pair is held back one arrival: its successor is
  // what folds it, and only then is its charge the truth (see ReadTraceOpts).
  let pending: { pair: TracePair; bytes: number } | null = null;
  for await (const line of traceLines(path)) {
    if (!line.trim()) continue;
    if (needles && !needles.some((n) => line.includes(n))) continue;
    let held: string | TracePair = line;
    if (opts.filter || opts.onKeep) {
      const pair = parseUsable(line);
      if (!pair || (opts.filter && !opts.filter(pair))) continue;
      held = pair; // parsed once, kept parsed
    }
    seenBytes += line.length + 1; // + its newline
    if (opts.onKeep && typeof held !== "string") {
      opts.onKeep(held);
      if (pending) keep(pending.pair, pending.bytes);
      pending = { pair: held, bytes: line.length };
      continue;
    }
    keep(held, line.length);
  }
  if (pending) keep(pending.pair, pending.bytes);
  const pairs: TracePair[] = [];
  const stats = opts.filter || opts.onKeep ? undefined : opts.stats; // those lines were already counted
  for (let i = head; i < ring.length; i++) {
    const held = ring[i]!;
    ring[i] = "";
    if (typeof held !== "string") {
      pairs.push(held);
      continue;
    }
    let pair: unknown;
    try {
      pair = JSON.parse(held);
    } catch {
      if (stats) stats.torn++;
      continue;
    }
    if (!isUsablePair(pair)) {
      if (stats) stats.invalid++;
      continue;
    }
    pairs.push(pair);
  }
  return { pairs, dropped, keptBytes, seenBytes };
}

/** A trace file this run should consider: raw or archived .jsonl. */
export function isTraceFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".jsonl.zst") || name.endsWith(".jsonl.gz");
}

// Cross-run session continuity. Claude Code's --continue/--resume re-sends the
// whole conversation, so the session VIEW already reconstructs old turns — but
// their wire requests (usage, duration, links) live in earlier trace files.
// This module finds those pairs by exact session_id match and hands them to
// the live server / snapshot, marked pair.prior = "<source file>".

/** Parse a .jsonl trace, keeping pairs whose session_id is in wanted. Pure. */
export function scanTraceText(text: string, wanted: Set<string>): TracePair[] {
  const out: TracePair[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let pair: TracePair;
    try {
      pair = JSON.parse(line);
    } catch {
      continue; // torn tail line from a killed run
    }
    if (wanted.has(extractSessionId(pair, WIRE))) out.push(pair);
  }
  return out;
}

/** Per-file damage tally from parseTraceText, for user-facing warnings. */
export interface TraceParseStats {
  /** Non-empty lines that were not valid JSON (torn tail from a killed run). */
  torn: number;
  /** Lines that parsed but are not a usable pair (no request object/url). */
  invalid: number;
}

/** A parsed line is renderable iff it carries a request with a url. */
function isUsablePair(p: unknown): p is TracePair {
  const r = (p as TracePair | null)?.request;
  return !!r && typeof r === "object" && typeof r.url === "string";
}

/**
 * All usable pairs of a .jsonl trace. Damaged lines — torn JSON from a killed
 * run, or structurally broken objects — are skipped, never rendered; pass
 * stats to count them so callers can warn instead of failing silently.
 */
export function parseTraceText(text: string, stats?: TraceParseStats): TracePair[] {
  const out: TracePair[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let pair: unknown;
    try {
      pair = JSON.parse(line);
    } catch {
      if (stats) stats.torn++;
      continue;
    }
    if (!isUsablePair(pair)) {
      if (stats) stats.invalid++;
      continue;
    }
    out.push(pair);
  }
  return out;
}

/** One or more dirs to read traces from — the store dir first, then a
 * legacy ./.cctrace still holding traces (docs/design/store.md). */
export type TraceDirArg = string | string[];

/** Every trace file across the given dir(s), as {dir, name} — first dir
 * first, so a caller that wants "the primary dir" takes index 0. */
export function listTraceEntries(dirs: TraceDirArg): { dir: string; name: string; path: string }[] {
  const out: { dir: string; name: string; path: string }[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    let names: string[];
    try { names = readdirSync(dir).filter(isTraceFile); } catch { continue; }
    for (const name of names) out.push({ dir, name, path: join(dir, name) });
  }
  return out;
}

/** What a caller that folds as it reads hands the reader (see ReadTraceOpts). */
export interface PriorFoldHooks {
  onKeep?: (pair: TracePair) => void;
  weigh?: (pair: TracePair, bytes: number) => number;
  onDrop?: (pair: TracePair) => void;
}

/**
 * Scan the dir(s) for prior traces holding pairs of the given sessions. The
 * current run's own file is excluded; a cheap substring pre-check skips
 * files that can't match before any JSON parsing.
 *
 * `hooks` lets a live server fold each pair as it lands instead of after the
 * whole tail is parsed — the difference between holding a session's raw
 * history and holding the page it renders as.
 */
export async function loadPriorPairs(logDir: TraceDirArg, excludeFile: string, sessionIds: Set<string>, tailBytes = TAIL_BYTES, hooks: PriorFoldHooks = {}): Promise<TracePair[]> {
  if (!sessionIds.size) return [];
  const excludeAbs = resolve(excludeFile);
  const out: TracePair[] = [];
  const seenIds = new Set<string>();
  const needles = [...sessionIds];
  // After a `merge`, a pair exists in both its trace-*.jsonl and the
  // session-*.jsonl output — deduped HERE, as the line is decided, so a
  // duplicate never reaches the fold hook or the budget either.
  const inSet = (p: TracePair) => {
    if (!sessionIds.has(extractSessionId(p, WIRE))) return false;
    if (!p.id) return true;
    if (seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    return true;
  };
  // Newest file first with one shared budget: when a session's history is
  // bigger than we are willing to hold, it is the OLDEST turns that go.
  let remaining = tailBytes;
  for (const { name: f, path } of newestFirst(listTraceEntries(logDir))) {
    if (resolve(path) === excludeAbs) continue;
    if (remaining <= 0) break;
    let read: ReadTraceResult;
    try {
      read = await readTracePairs(path, { needles, filter: inSet, tailBytes: remaining, ...hooks });
    } catch {
      continue;
    }
    remaining -= read.keptBytes;
    for (const pair of read.pairs) {
      pair.prior = f;
      out.push(pair);
    }
  }
  out.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return out;
}

/** Trace entries newest mtime first (a raced-away file sorts last). */
function newestFirst<T extends { path: string }>(entries: T[]): T[] {
  return entries
    .map((e) => { try { return { e, m: statSync(e.path).mtimeMs }; } catch { return { e, m: -1 }; } })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.e);
}

/**
 * The most recent session id in logDir's newest prior trace — the best guess
 * for what `claude --continue` is about to resume. Files are tried newest
 * mtime first; within a file the LAST pair carrying a session id wins (a
 * file can hold several sessions). Wrong guesses are cheap: the caller
 * treats this as speculative and reconciles on the first live request.
 */
export async function newestPriorSessionId(logDir: TraceDirArg, excludeFile: string): Promise<{ sid: string; file: string } | null> {
  const excludeAbs = resolve(excludeFile || "");
  for (const f of newestFirst(listTraceEntries(logDir))) {
    if (resolve(f.path) === excludeAbs) continue;
    // Only the file's tail is parsed: the newest few MB of lines, walked
    // backwards. A guess is speculative anyway — the first live request
    // confirms or evicts it.
    let read: ReadTraceResult;
    try {
      read = await readTracePairs(f.path, { tailBytes: 4 * 1024 * 1024 });
    } catch {
      continue;
    }
    for (let i = read.pairs.length - 1; i >= 0; i--) {
      const sid = extractSessionId(read.pairs[i], WIRE);
      if (sid) return { sid, file: f.name };
    }
  }
  return null;
}

/** Load explicitly named trace files (--with), all pairs, marked prior. */
export async function loadTraceFiles(paths: string[]): Promise<TracePair[]> {
  const out: TracePair[] = [];
  for (const p of paths) {
    let read: ReadTraceResult;
    try {
      read = await readTracePairs(p, { tailBytes: Infinity });
    } catch (err) {
      console.error(`[cctrace] --with ${p}: ${(err as Error).message}`);
      continue;
    }
    for (const pair of read.pairs) {
      pair.prior = basename(p);
      out.push(pair);
    }
  }
  out.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return out;
}
