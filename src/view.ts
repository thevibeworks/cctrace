import { readdirSync, existsSync, statSync, writeFileSync } from "fs";
import { join, basename, resolve } from "path";
import { renderSnapshot, verifySnapshot, type PageMeta } from "./ui";
import { parseTraceText, readTraceText, isTraceFile, type TraceParseStats } from "./history";
import { CCTRACE_VERSION } from "./version";
import { extractSessionId } from "./summarize";
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

function htmlSibling(tracePath: string): string {
  return tracePath.replace(/\.jsonl(\.zst|\.gz)?$/, "") + ".html";
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
  // 1. Explicit file path.
  if (existsSync(target) && statSync(target).isFile()) {
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const pairs = parseTraceText(readTraceText(target), stats);
    if (!pairs.length) throw new ViewError(`${target} has no trace pairs`);
    return {
      pairs,
      htmlPath: htmlSibling(resolve(target)),
      sources: [basename(target)],
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
    for (const path of traces) {
      let text: string;
      try { text = readTraceText(path); } catch { continue; }
      if (!text.includes(target)) continue; // cheap pre-check before parse
      for (const pair of scanTraceTextPrefix(text, target)) {
        if (pair.id && seen.has(pair.id)) continue;
        if (pair.id) seen.add(pair.id);
        merged.push(pair);
        sources.add(basename(path));
      }
    }
    if (merged.length) {
      merged.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
      const safe = target.replace(/[^0-9a-zA-Z-]/g, "").slice(0, 16);
      return {
        pairs: merged,
        htmlPath: join(logDir, `session-${safe}.html`),
        sources: [...sources],
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
  const html = renderSnapshot(result.pairs, { ...meta, version: CCTRACE_VERSION });
  const problem = verifySnapshot(html, result.pairs.length);
  if (problem) result.warnings.push(`snapshot self-check failed: ${problem}`);
  writeFileSync(result.htmlPath, html);
  return result;
}
