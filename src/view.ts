import { readdirSync, existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname, relative, resolve } from "path";
import { renderSnapshot, verifySnapshot, type PageMeta } from "./ui";
import { parseTraceText, readTraceText, isTraceFile, type TraceParseStats } from "./history";
import { CCTRACE_VERSION } from "./version";
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
}

export class ViewError extends Error {}

function listTraces(logDir: string): string[] {
  try {
    return readdirSync(logDir)
      .filter(isTraceFile)
      .map((f) => join(logDir, f));
  } catch {
    return [];
  }
}

export interface TraceInfo {
  path: string;
  base: string;
  size: number;
  mtimeMs: number;
}

/** Every trace in the log dir, newest first — the `cctrace view` picker. */
export function listTraceInfos(logDir: string): TraceInfo[] {
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
export function peekTrace(path: string, maxBytes = 8 << 20): TracePeek {
  let text: string;
  try {
    if (/\.(zst|gz)$/.test(path)) {
      if (statSync(path).size > 8 * 1024 * 1024) return {};
      text = readTraceText(path);
    } else {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = readSync(fd, buf, 0, maxBytes, 0);
        text = buf.toString("utf8", 0, n);
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return {};
  }
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // bounded read tore the last line
  const out: TracePeek = {};
  let parsed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // Telemetry/bootstrap pairs open most traces; the first real messages
    // pair can sit hundreds of cheap lines in, so the cap is generous —
    // the byte bound above is what keeps this instant.
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
  return out;
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
export function resolveView(target: string, logDir: string): ViewResult {
  // 0. "latest" — the newest trace in the log dir, no name gymnastics.
  if (target === "latest") {
    const newest = listTraceInfos(logDir)[0];
    if (!newest) throw new ViewError(`no .jsonl traces in ${logDir}`);
    target = newest.path;
  }

  // 1. Explicit file path.
  if (existsSync(target) && statSync(target).isFile()) {
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const pairs = parseTraceText(readTraceText(target), stats);
    if (!pairs.length) throw new ViewError(`${target} has no trace pairs`);
    return {
      pairs,
      htmlPath: htmlSibling(resolve(target)),
      sources: [basename(target)],
      sourcePaths: [resolve(target)],
      matchedBy: "file",
      warnings: damageWarnings(basename(target), stats),
    };
  }

  const traces = listTraces(logDir);
  if (!traces.length) {
    throw new ViewError(`no .jsonl traces in ${logDir} (and "${target}" is not a file)`);
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
    for (const path of traces) {
      let text: string;
      try { text = readTraceText(path); } catch { continue; }
      if (!text.includes(target)) continue; // cheap pre-check before parse
      for (const pair of scanTraceTextPrefix(text, target)) {
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
        htmlPath: join(logDir, `session-${safe}.html`),
        sources: [...sources],
        sourcePaths: [...sourcePaths],
        matchedBy: "session",
        warnings: [],
      };
    }
  }

  // 3. Filename fragment (e.g. a timestamp) — unambiguous single match wins.
  const byName = traces.filter((p) => basename(p).includes(target));
  if (byName.length === 1) {
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const pairs = parseTraceText(readTraceText(byName[0]), stats);
    if (!pairs.length) throw new ViewError(`${basename(byName[0])} has no trace pairs`);
    return {
      pairs,
      htmlPath: htmlSibling(byName[0]),
      sources: [basename(byName[0])],
      sourcePaths: [resolve(byName[0]!)],
      matchedBy: "filename",
      warnings: damageWarnings(basename(byName[0]), stats),
    };
  }

  if (byName.length > 1) {
    throw new ViewError(
      `"${target}" matches ${byName.length} traces — be more specific:\n` +
        byName.map((p) => `  ${basename(p)}`).join("\n"),
    );
  }
  throw new ViewError(
    `no trace matches "${target}" in ${logDir}\n` +
      `  recent traces:\n` +
      traces.slice(-6).map((p) => `  ${basename(p)}`).join("\n"),
  );
}

/** Pairs whose session id starts with prefix (short ids work like git's). */
function scanTraceTextPrefix(text: string, prefix: string): TracePair[] {
  const out: TracePair[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let pair: TracePair;
    try { pair = JSON.parse(line); } catch { continue; }
    const sid = extractSessionId(pair, WIRE);
    if (sid && sid.startsWith(prefix)) out.push(pair);
  }
  return out;
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
export function writeView(target: string, logDir: string, meta: PageMeta = {}): ViewResult {
  const result = resolveView(target, logDir);
  const traceFile = basename(result.sources[0] || target);
  // Same header identity a served view gets: project = the log dir's parent
  // when it's a standard ./.cctrace, and the trace's project-relative path
  // for the title's click-to-copy.
  const viewDir = resolve(logDir);
  const projectRoot = basename(viewDir) === ".cctrace" ? dirname(viewDir) : viewDir;
  const rel = relative(projectRoot, join(viewDir, traceFile));
  const html = renderSnapshot(result.pairs, {
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
