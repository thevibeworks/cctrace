import { existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname, relative, resolve } from "path";
import { renderSnapshot, verifySnapshot, type PageMeta } from "./ui";
import { readTracePairs, traceLines, listTraceEntries, TAIL_BYTES, type TraceParseStats, type TraceDirArg, type ReadTraceResult } from "./history";
import { titleFor, mainSessionId } from "./title";
import { CCTRACE_VERSION } from "./version";
import { sliceWindow, pairEndMs } from "./replay";
import { extractSessionId } from "./summarize";
import { firstPromptOfPair } from "./session";
import { wireTables } from "./clients";
import type { TracePair } from "./types";

const WIRE = wireTables();

// `cctrace view <target>` — rebuild a snapshot .html from an existing trace,
// no proxy and no Claude spawn. Target is one of, tried in order:
//   - a path to a .jsonl trace file            -> render that file
//   - a Claude Code session id (or prefix)     -> merge every trace holding it
//   - a filename fragment of a trace in --dir  -> render the matching file
// Pure resolution + fs reads live here so cli.ts just prints and opens.

export interface ViewResult {
  pairs: TracePair[];
  htmlPath: string;
  /** Trace files that contributed pairs, basename only. */
  sources: string[];
  /** The same files as absolute paths — what select-to-purge rewrites. */
  sourcePaths: string[];
  matchedBy: "file" | "session" | "filename";
  /** Non-fatal problems worth telling the user about (damaged lines, ...). */
  warnings: string[];
  /** Set when the tail budget left older pairs behind: how many lines and
   * how many decoded bytes were skipped, so the caller can say so. */
  truncated?: { droppedLines: number; droppedBytes: number; keptBytes: number; olderFiles?: number };
  /** Decoded .jsonl bytes the sources hold for this view (every line seen
   * while streaming, budget or not) — the trace's real size, which an
   * archived source's file size understates 30-180x. */
  decodedBytes: number;
}

export interface ViewOpts {
  /** Newest decoded bytes to keep (default TAIL_BYTES); Infinity = --full. */
  tailBytes?: number;
}

export class ViewError extends Error {}

/** Trace paths across the dir(s) — the store dir first, then a legacy
 * ./.cctrace when the caller passes one (docs/design/store.md). */
function listTraces(logDir: TraceDirArg): string[] {
  return listTraceEntries(logDir).map((e) => e.path);
}

const primaryDir = (logDir: TraceDirArg): string => (Array.isArray(logDir) ? logDir[0] ?? "." : logDir);
const describeDirs = (logDir: TraceDirArg): string => (Array.isArray(logDir) ? logDir.join(", ") : logDir);

export interface TraceInfo {
  path: string;
  base: string;
  size: number;
  mtimeMs: number;
}

/** Every trace in the dir(s), newest first — the `cctrace view` picker. */
export function listTraceInfos(logDir: TraceDirArg): TraceInfo[] {
  const out: TraceInfo[] = [];
  for (const path of listTraces(logDir)) {
    try {
      const st = statSync(path);
      out.push({ path, base: basename(path), size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // raced away between readdir and stat — skip
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function htmlSibling(tracePath: string): string {
  return tracePath.replace(/\.jsonl(\.zst|\.gz)?$/, "") + ".html";
}

/**
 * Where a tombstone's trace actually lives NOW. A registry logFile stops
 * resolving for benign local reasons — `compress` renamed it to .zst/.gz,
 * a later run's auto-merge absorbed it into session-<sid8>.jsonl and
 * pruned the source, or `adopt` moved it into the store (storeDir: the
 * project's dir under <data-dir>/traces, tried last by the same names) —
 * so callers must not conclude "gone" from one stat. Returns the first
 * candidate that exists, or null when the trace truly isn't reachable here
 * (deleted, or written by another container/host and never adopted).
 */
export function findTraceCarrier(
  logFile: string,
  sessionId?: string,
  storeDir?: string,
): { path: string; bytes: number } | null {
  const forms = (stem: string) => [stem, `${stem}.zst`, `${stem}.gz`];
  const candidates: string[] = [];
  const dirs = [dirname(logFile)];
  if (storeDir && resolve(storeDir) !== resolve(dirname(logFile))) dirs.push(storeDir);
  const plain = basename(logFile).replace(/\.(zst|gz)$/, "");
  for (const dir of dirs) {
    candidates.push(...forms(join(dir, plain)));
    if (sessionId) candidates.push(...forms(join(dir, `session-${sessionId.slice(0, 8)}.jsonl`)));
  }
  for (const path of candidates) {
    try {
      const st = statSync(path);
      if (st.isFile()) return { path, bytes: st.size };
    } catch {}
  }
  return null;
}

export interface TracePeek {
  client?: string;
  sessionId?: string;
  prompt?: string;
}

/**
 * Bounded identity read for the picker — who/what a trace is, without
 * reading it. Plain .jsonl reads only its head bytes (a first line can be
 * megabytes, so the tail of the read is dropped as torn); compressed
 * archives decompress only when small. Registry entries are the primary
 * identity source (stamped at capture time, 0.25+); this is the fallback
 * for traces that predate them.
 */
export async function peekTrace(path: string, maxBytes = 8 << 20): Promise<TracePeek> {
  const out: TracePeek = {};
  let parsed = 0;
  let seen = 0;
  try {
    // Streamed head: the first lines of the decoded trace, stopped at the
    // byte bound — an archive decodes only that far.
    for await (const line of traceLines(path)) {
      seen += line.length + 1;
      if (seen > maxBytes) break;
      if (!line.trim()) continue;
      // Telemetry/bootstrap pairs open most traces; the first real messages
      // pair can sit hundreds of cheap lines in, so the cap is generous —
      // the byte bound is what keeps this instant.
      if (++parsed > 400) break;
      let pair: TracePair;
      try { pair = JSON.parse(line); } catch { continue; }
      if (!out.client && pair.client) out.client = pair.client;
      if (!out.sessionId) out.sessionId = extractSessionId(pair, WIRE) || undefined;
      if (!out.prompt) {
        const p = firstPromptOfPair(pair);
        if (p) out.prompt = p.slice(0, 120);
      }
      if (out.client && out.sessionId && out.prompt) break;
    }
  } catch {
    // unreadable: identity stays empty
  }
  return out;
}

/**
 * `view --tail`: follow a live trace file like tail -f. The capture run
 * appends one JSON line per pair from its own process; this view server
 * polls the file (fs.watch is unreliable across bind mounts — the deva
 * reality this exists for: a sibling container shares the .jsonl but not
 * the capture's port) and hands every COMPLETE new line to onPairs. A
 * torn tail line (capture mid-write) stays buffered until its newline
 * arrives. Compressed archives can't grow — callers reject them.
 * Returns a stop() handle.
 */
export function followTrace(
  path: string,
  startOffset: number,
  onPairs: (pairs: TracePair[]) => void,
  intervalMs = 700,
): { stop: () => void } {
  let offset = startOffset;
  let remainder = "";
  const tick = () => {
    let size = 0;
    try { size = statSync(path).size; } catch { return; }
    if (size < offset) { offset = 0; remainder = ""; } // truncated/rewritten (purge) — rescan, dedup is the server's job
    if (size === offset) return;
    let text = "";
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        text = buf.toString("utf8", 0, n);
        offset += n;
      } finally {
        closeSync(fd);
      }
    } catch { return; }
    const lines = (remainder + text).split("\n");
    remainder = lines.pop() || "";
    const out: TracePair[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const pair = JSON.parse(line);
        if (pair && pair.request) out.push(pair);
      } catch { /* torn or damaged line — skip, the file view already warns */ }
    }
    if (out.length) onPairs(out);
  };
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/**
 * `--slice a..b`: narrow a trace to the pairs whose response completed
 * between the two named pairs' ends (inclusive) — the CLI face of the
 * UI's slice deep link (#/session/<key>/@a..b; copy the a..b part).
 * Throws ViewError on a malformed spec or unknown ids.
 */
export function applySlice(pairs: TracePair[], spec: string): TracePair[] {
  const m = /^(.+?)\.\.(.+)$/.exec(spec);
  if (!m) throw new ViewError(`--slice wants <pair-id>..<pair-id> (the @a..b from a slice deep link), got "${spec}"`);
  const pa = pairs.find((p) => p.id === m[1]);
  const pb = pairs.find((p) => p.id === m[2]);
  if (!pa || !pb) throw new ViewError(`--slice: pair id "${!pa ? m[1] : m[2]}" not found in this trace`);
  return sliceWindow(pairs, pairEndMs(pa), pairEndMs(pb));
}

function isSessionIdish(s: string): boolean {
  // Claude Code session ids are UUIDs; accept a hex/hyphen prefix of one.
  return /^[0-9a-fA-F][0-9a-fA-F-]{3,}$/.test(s);
}

/**
 * Resolve a view target to the pairs to render and where the .html should go.
 * Does not write anything — see writeView. Throws ViewError with a helpful
 * message (including nearby traces) when nothing matches.
 */
export async function resolveView(target: string, logDir: TraceDirArg, opts: ViewOpts = {}): Promise<ViewResult> {
  const tailBytes = opts.tailBytes ?? TAIL_BYTES;
  // A whole-file read, budgeted: the newest `tailBytes` of decoded lines.
  const readOne = async (path: string, stats: TraceParseStats) => {
    const read = await readTracePairs(path, { tailBytes, stats });
    return { pairs: read.pairs, truncated: truncationOf(read), decodedBytes: read.seenBytes };
  };
  // 0. "latest" — the newest trace in the log dir, no name gymnastics.
  if (target === "latest") {
    const newest = listTraceInfos(logDir)[0];
    if (!newest) throw new ViewError(`no .jsonl traces in ${describeDirs(logDir)}`);
    target = newest.path;
  }

  // 1. Explicit file path. A path cctrace itself printed (`Log:`, the
  //    header copy value, CCTRACE_TRACE_FILE) names the plain .jsonl, which
  //    goes to rest as .zst at exit — so a missing plain path tries its
  //    archive forms before anything else, and a path with a dir component
  //    that still doesn't resolve falls through as its basename fragment.
  if (!existsSync(target)) {
    const archived = [`${target}.zst`, `${target}.gz`].find((p) => existsSync(p) && statSync(p).isFile());
    if (archived) target = archived;
    else if (target.includes("/") && /\.jsonl(\.zst|\.gz)?$/.test(target)) target = basename(target).replace(/\.jsonl(\.zst|\.gz)?$/, "");
  }
  if (existsSync(target) && statSync(target).isFile()) {
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const { pairs, truncated, decodedBytes } = await readOne(target, stats);
    if (!pairs.length) throw new ViewError(`${target} has no trace pairs`);
    return {
      pairs,
      htmlPath: htmlSibling(resolve(target)),
      sources: [basename(target)],
      sourcePaths: [resolve(target)],
      matchedBy: "file",
      warnings: damageWarnings(basename(target), stats),
      truncated,
      decodedBytes,
    };
  }

  const traces = listTraces(logDir);
  if (!traces.length) {
    throw new ViewError(`no .jsonl traces in ${describeDirs(logDir)} (and "${target}" is not a file)`);
  }

  // 2. Session id (or prefix): merge every trace that carries it, deduped by
  //    pair id, timestamp-sorted — the same continuity a live --continue gets.
  //    This must run BEFORE filename matching: after a merge, the id is a
  //    substring of session-<id>.jsonl's own name, and matching that single
  //    file would silently drop every newer unmerged trace of the session.
  if (isSessionIdish(target)) {
    const merged: TracePair[] = [];
    const seen = new Set<string>();
    const sources = new Set<string>();
    const sourcePaths = new Set<string>();
    const hasPrefix = (p: TracePair) => { const sid = extractSessionId(p, WIRE); return !!sid && sid.startsWith(target); };
    // One budget across the session's files, newest first: the newest
    // turns are what a view opens for, so the oldest files fall off.
    let remaining = tailBytes;
    let droppedLines = 0, droppedBytes = 0, keptBytes = 0, olderFiles = 0, decodedBytes = 0;
    for (const path of newestFirst(traces)) {
      if (remaining <= 0) {
        // Budget spent on newer files: an older file's every line is older
        // than what was already left out — count it (it may or may not hold
        // this session; the notice says "not scanned"), don't read it.
        try { if (existsSync(path)) olderFiles++; } catch {}
        continue;
      }
      let read: ReadTraceResult;
      try { read = await readTracePairs(path, { needles: [target], filter: hasPrefix, tailBytes: remaining }); } catch { continue; }
      if (!read.pairs.length && !read.dropped) continue;
      // Once a file was cut, everything older is out too.
      remaining = read.dropped ? 0 : remaining - read.keptBytes;
      keptBytes += read.keptBytes;
      decodedBytes += read.seenBytes;
      droppedLines += read.dropped;
      droppedBytes += read.seenBytes - read.keptBytes;
      for (const pair of read.pairs) {
        if (pair.id && seen.has(pair.id)) continue;
        if (pair.id) seen.add(pair.id);
        merged.push(pair);
        sources.add(basename(path));
        sourcePaths.add(resolve(path));
      }
    }
    if (merged.length) {
      merged.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
      const safe = target.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 16);
      return {
        pairs: merged,
        htmlPath: join(primaryDir(logDir), `session-${safe}.html`),
        sources: [...sources],
        sourcePaths: [...sourcePaths],
        matchedBy: "session",
        warnings: [],
        truncated: droppedLines || olderFiles ? { droppedLines, droppedBytes, keptBytes, olderFiles } : undefined,
        decodedBytes,
      };
    }
  }

  // 3. Filename fragment (e.g. a timestamp) — unambiguous single match wins.
  const byName = traces.filter((p) => basename(p).includes(target));
  if (byName.length === 1) {
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const { pairs, truncated, decodedBytes } = await readOne(byName[0]!, stats);
    if (!pairs.length) throw new ViewError(`${basename(byName[0])} has no trace pairs`);
    return {
      pairs,
      htmlPath: htmlSibling(byName[0]),
      sources: [basename(byName[0])],
      sourcePaths: [resolve(byName[0]!)],
      matchedBy: "filename",
      warnings: damageWarnings(basename(byName[0]), stats),
      truncated,
      decodedBytes,
    };
  }

  if (byName.length > 1) {
    throw new ViewError(
      `"${target}" matches ${byName.length} traces — be more specific:\n` +
        byName.map((p) => `  ${basename(p)}`).join("\n"),
    );
  }
  throw new ViewError(
    `no trace matches "${target}" in ${describeDirs(logDir)}\n` +
      `  recent traces:\n` +
      traces.slice(-6).map((p) => `  ${basename(p)}`).join("\n"),
  );
}

/** The two sizes a page shows: the trace (decoded bytes) and, when the
 * sources are archives, what they occupy on disk. */
export function traceSizes(result: ViewResult): { traceBytes: number; traceDiskBytes?: number } {
  let disk = 0;
  for (const p of result.sourcePaths) { try { disk += statSync(p).size; } catch {} }
  // Plain sources: the file IS the trace (decodedBytes counts UTF-16 units,
  // an approximation). Archived sources: the decoded count is the trace.
  const archived = result.sourcePaths.some((p) => /\.(zst|gz)$/.test(p));
  if (!archived || result.decodedBytes <= 0) return { traceBytes: disk };
  return { traceBytes: result.decodedBytes, traceDiskBytes: disk };
}

function truncationOf(read: ReadTraceResult): ViewResult["truncated"] {
  return read.dropped ? { droppedLines: read.dropped, droppedBytes: read.seenBytes - read.keptBytes, keptBytes: read.keptBytes } : undefined;
}

/** Trace paths newest mtime first. */
function newestFirst(paths: string[]): string[] {
  return paths
    .map((p) => { try { return { p, m: statSync(p).mtimeMs }; } catch { return { p, m: -1 }; } })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

/** The one-line notice for a budgeted view: what was left out and how to
 * get it. Empty when nothing was. */
export function truncationNotice(r: ViewResult): string {
  if (!r.truncated) return "";
  const mb = (n: number) => `${Math.max(1, Math.round(n / (1024 * 1024)))} MB`;
  const t = r.truncated;
  const older = t.olderFiles ? `; ${t.olderFiles} older trace file${t.olderFiles > 1 ? "s" : ""} not scanned` : "";
  return `showing the newest ${r.pairs.length} pairs (${mb(t.keptBytes)} of ${mb(t.keptBytes + t.droppedBytes)} decoded; ${t.droppedLines} older lines left out${older}) — --full loads everything`;
}

function damageWarnings(file: string, stats: TraceParseStats): string[] {
  const out: string[] = [];
  if (stats.torn) out.push(`${file}: skipped ${stats.torn} torn line${stats.torn > 1 ? "s" : ""} (not valid JSON)`);
  if (stats.invalid) out.push(`${file}: skipped ${stats.invalid} broken pair${stats.invalid > 1 ? "s" : ""} (no request/url)`);
  return out;
}

/**
 * Resolve, render, self-check, and write the snapshot .html. A failed
 * self-check (embedded payload no longer round-trips) is reported as a
 * warning, not a throw — a partially usable snapshot beats none.
 */
export async function writeView(target: string, logDir: TraceDirArg, meta: PageMeta = {}, opts: { slice?: string; projectPath?: string; tailBytes?: number } = {}): Promise<ViewResult> {
  const result = await resolveView(target, logDir, { tailBytes: opts.tailBytes });
  if (opts.slice) result.pairs = applySlice(result.pairs, opts.slice);
  const traceFile = basename(result.sources[0] || target);
  // Same header identity a served view gets: the project the caller
  // resolved (store marker / cwd), else the log dir's parent when it's a
  // legacy ./.cctrace; the trace's project-relative path for the title's
  // click-to-copy — absolute when it lives outside the project (the store).
  const viewDir = resolve(primaryDir(logDir));
  const projectRoot = opts.projectPath ?? (basename(viewDir) === ".cctrace" ? dirname(viewDir) : viewDir);
  const rel = relative(projectRoot, join(viewDir, traceFile));
  const { traceBytes, traceDiskBytes } = traceSizes(result);
  const html = renderSnapshot(result.pairs, {
    traceBytes,
    traceDiskBytes,
    sessionTitle: titleFor(result.sourcePaths[0] ? dirname(result.sourcePaths[0]) : viewDir, mainSessionId(result.pairs), traceFile) || undefined,
    project: basename(projectRoot),
    projectPath: projectRoot,
    traceRelPath: rel && !rel.startsWith("..") ? rel : join(viewDir, traceFile),
    ...meta,
    traceFile,
    version: CCTRACE_VERSION,
  });
  const problem = verifySnapshot(html, result.pairs.length);
  if (problem) result.warnings.push(`snapshot self-check failed: ${problem}`);
  writeFileSync(result.htmlPath, html);
  return result;
}
