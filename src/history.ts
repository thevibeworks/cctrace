import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename, resolve } from "path";
import { gunzipSync } from "zlib";
import { extractSessionId } from "./summarize";
import { wireTables } from "./clients";
import type { TracePair } from "./types";

const WIRE = wireTables();

/** Read a trace file, transparently decompressing a `.zst`/`.gz` archive. */
export function readTraceText(path: string): string {
  const buf = readFileSync(path);
  if (path.endsWith(".zst")) return Buffer.from(Bun.zstdDecompressSync(buf)).toString("utf8");
  if (path.endsWith(".gz")) return gunzipSync(buf).toString("utf8");
  return buf.toString("utf8");
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

/**
 * Scan logDir for prior traces holding pairs of the given sessions. The
 * current run's own file is excluded; a cheap substring pre-check skips
 * files that can't match before any JSON parsing.
 */
export function loadPriorPairs(logDir: string, excludeFile: string, sessionIds: Set<string>): TracePair[] {
  if (!sessionIds.size || !existsSync(logDir)) return [];
  const excludeAbs = resolve(excludeFile);
  const out: TracePair[] = [];
  const seenIds = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(logDir).filter(isTraceFile);
  } catch {
    return [];
  }
  for (const f of files) {
    const path = join(logDir, f);
    if (resolve(path) === excludeAbs) continue;
    let text: string;
    try {
      text = readTraceText(path);
    } catch {
      continue;
    }
    let mayMatch = false;
    for (const id of sessionIds) if (text.includes(id)) { mayMatch = true; break; }
    if (!mayMatch) continue;
    for (const pair of scanTraceText(text, sessionIds)) {
      // After a `merge`, a pair exists in both its trace-*.jsonl and the
      // session-*.jsonl output — dedupe across files or snapshots render
      // every prior turn twice.
      if (pair.id) {
        if (seenIds.has(pair.id)) continue;
        seenIds.add(pair.id);
      }
      pair.prior = f;
      out.push(pair);
    }
  }
  out.sort((a, b) => (a.request?.timestamp || 0) - (b.request?.timestamp || 0));
  return out;
}

/**
 * The most recent session id in logDir's newest prior trace — the best guess
 * for what `claude --continue` is about to resume. Files are tried newest
 * mtime first; within a file the LAST pair carrying a session id wins (a
 * file can hold several sessions). Wrong guesses are cheap: the caller
 * treats this as speculative and reconciles on the first live request.
 */
export function newestPriorSessionId(logDir: string, excludeFile: string): { sid: string; file: string } | null {
  if (!existsSync(logDir)) return null;
  const excludeAbs = resolve(excludeFile || "");
  let files: { name: string; mtime: number }[];
  try {
    files = readdirSync(logDir)
      .filter(isTraceFile)
      .map((name) => {
        try {
          return { name, mtime: statSync(join(logDir, name)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is { name: string; mtime: number } => !!f)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const f of files) {
    const path = join(logDir, f.name);
    if (resolve(path) === excludeAbs) continue;
    let text: string;
    try {
      text = readTraceText(path);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const sid = extractSessionId(JSON.parse(line), WIRE);
        if (sid) return { sid, file: f.name };
      } catch {
        // torn tail line of a live file — keep walking up
      }
    }
  }
  return null;
}

/** Load explicitly named trace files (--with), all pairs, marked prior. */
export function loadTraceFiles(paths: string[]): TracePair[] {
  const out: TracePair[] = [];
  for (const p of paths) {
    let text: string;
    try {
      text = readTraceText(p);
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
