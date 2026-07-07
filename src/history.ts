import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename, resolve } from "path";
import { extractSessionId } from "./summarize";
import type { TracePair } from "./types";

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
    if (wanted.has(extractSessionId(pair))) out.push(pair);
  }
  return out;
}

/** All pairs of a .jsonl trace (for --with force-merge). */
export function parseTraceText(text: string): TracePair[] {
  const out: TracePair[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * Scan logDir for prior traces holding pairs of the given sessions. The
 * current run's own file is excluded; a cheap substring pre-check skips
 * files that can't match before any JSON parsing.
 */
export function loadPriorPairs(logDir: string, excludeFile: string, sessionIds: Set<string>): TracePair[] {
  if (!sessionIds.size || !existsSync(logDir)) return [];
  const excludeAbs = resolve(excludeFile);
  const out: TracePair[] = [];
  let files: string[];
  try {
    files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const f of files) {
    const path = join(logDir, f);
    if (resolve(path) === excludeAbs) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    let mayMatch = false;
    for (const id of sessionIds) if (text.includes(id)) { mayMatch = true; break; }
    if (!mayMatch) continue;
    for (const pair of scanTraceText(text, sessionIds)) {
      pair.prior = f;
      out.push(pair);
    }
  }
  out.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return out;
}

/** Load explicitly named trace files (--with), all pairs, marked prior. */
export function loadTraceFiles(paths: string[]): TracePair[] {
  const out: TracePair[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (err) {
      console.error(`[cctrace] --with ${p}: ${(err as Error).message}`);
      continue;
    }
    for (const pair of parseTraceText(text)) {
      pair.prior = basename(p);
      out.push(pair);
    }
  }
  out.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return out;
}
