import { readdirSync, existsSync, statSync, writeFileSync } from "fs";
import { join, basename, resolve } from "path";
import { renderSnapshot } from "./ui";
import { parseTraceText, readTraceText, isTraceFile } from "./history";
import { extractSessionId } from "./summarize";
import type { TracePair } from "./types";

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
  return tracePath.replace(/\.jsonl(\.gz)?$/, "") + ".html";
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
    const pairs = parseTraceText(readTraceText(target));
    if (!pairs.length) throw new ViewError(`${target} has no trace pairs`);
    return { pairs, htmlPath: htmlSibling(resolve(target)), sources: [basename(target)], matchedBy: "file" };
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
      };
    }
  }

  // 3. Filename fragment (e.g. a timestamp) — unambiguous single match wins.
  const byName = traces.filter((p) => basename(p).includes(target));
  if (byName.length === 1) {
    const pairs = parseTraceText(readTraceText(byName[0]));
    if (!pairs.length) throw new ViewError(`${basename(byName[0])} has no trace pairs`);
    return { pairs, htmlPath: htmlSibling(byName[0]), sources: [basename(byName[0])], matchedBy: "filename" };
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
    const sid = extractSessionId(pair);
    if (sid && sid.startsWith(prefix)) out.push(pair);
  }
  return out;
}

/** Resolve, render, and write the snapshot .html. Returns the ViewResult. */
export function writeView(target: string, logDir: string): ViewResult {
  const result = resolveView(target, logDir);
  writeFileSync(result.htmlPath, renderSnapshot(result.pairs));
  return result;
}
