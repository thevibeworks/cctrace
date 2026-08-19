import { readFileSync, writeFileSync, renameSync } from "fs";
import { join, basename } from "path";
import { projectTraceDir } from "./store";
import { buildSession, loopTurns, turnSnippet, mainThread, continuationSummaryTurn } from "./session";
import { extractSessionId } from "./summarize";
import { readTracePairs, listTraceEntries, TAIL_BYTES, type TraceDirArg } from "./history";
import type { TracePair } from "./types";

// `cctrace title` — the DATA layer for naming sessions. cctrace does not
// call a model: it extracts each session's SPINE (the human's real prompts
// and the agent's final responses per working loop, main chat threads only
// — no tool calls, no tool results, no sub-agent threads) into a capped,
// front/back-weighted digest, and it stores + serves the titles a namer
// hands back. The namer is the `cctrace-title` agent skill, which fans the
// digests out across Claude Code subagents and writes each result back with
// `cctrace title set`. Titles live per project store dir in titles.json
// keyed by session id (or "file:<name>" when the trace carries none) and
// surface in the dashboard, `history`, the view picker and the trace header.

export const TITLES_FILE = "titles.json";
/** Digest budget in characters — a few thousand tokens for the namer. */
export const DIGEST_CHARS = 12_000;

export interface TitleEntry {
  title: string;
  /** Who named it (a model id, or "" when unspecified). */
  model?: string;
  /** ISO time the title was recorded. */
  at?: string;
  /** Trace file the digest came from. */
  source?: string;
}
export type Titles = Record<string, TitleEntry>;

export function readTitles(dir: string): Titles {
  try {
    const j = JSON.parse(readFileSync(join(dir, TITLES_FILE), "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Atomic rewrite (tmp + rename) — a reader mid-write never sees a torn file. */
export function writeTitles(dir: string, titles: Titles): void {
  const path = join(dir, TITLES_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(titles, null, 1) + "\n");
  renameSync(tmp, path);
}

/** Record one session's title (atomic). The namer (`cctrace title set`)
 * calls this; `at` is stamped, `nowIso` is passed so callers stay pure. */
export function setTitle(dir: string, key: string, title: string, meta: { model?: string; source?: string; nowIso?: string } = {}): void {
  const titles = readTitles(dir);
  titles[key] = { title, ...(meta.model ? { model: meta.model } : {}), at: meta.nowIso, ...(meta.source ? { source: meta.source } : {}) };
  writeTitles(dir, titles);
}

/** The key a session's title is stored under. */
export function titleKey(sessionId: string | undefined | null, traceBase: string): string {
  return sessionId ? sessionId : `file:${traceBase.replace(/\.jsonl(\.zst|\.gz)?$/, "")}`;
}

/** The stored title for a run/trace: by session id first, then by file. */
export function titleFor(dir: string, sessionId: string | undefined | null, traceBase?: string): string {
  const t = readTitles(dir);
  if (sessionId && t[sessionId]) return t[sessionId]!.title;
  if (traceBase) {
    const k = titleKey(null, traceBase);
    if (t[k]) return t[k]!.title;
  }
  return "";
}

/** One prompt/answer exchange of the spine. */
export interface DigestLoop {
  user: string;
  final: string;
}

/**
 * The spine of a session's main thread(s): per working loop, the human's
 * prompt and the agent's final text. Sub-agent threads (kind "agent") and
 * utilities (quota probe, the CLI's own title generation) are skipped;
 * tool_use/tool_result blocks never appear because only text blocks are
 * read (turnSnippet), and mid-loop assistant steps are not the final.
 */
export function sessionSpine(pairs: TracePair[], wire?: any): { sid: string; loops: DigestLoop[] }[] {
  const session = buildSession(pairs, wire);
  const out: { sid: string; loops: DigestLoop[] }[] = [];
  const chats = (session.threads || []).filter((t: any) => t.kind === "chat").sort((a: any, b: any) => (a.firstAt || 0) - (b.firstAt || 0));
  for (const t of chats) {
    const vis = (t.turns || []).filter((x: any) => !x.toolResultsOnly);
    const loops: DigestLoop[] = [];
    for (const loop of loopTurns(vis)) {
      // A loop headed by an automated notification or a continuation
      // summary has no human words — its final answer still counts.
      const headHuman = loop.head != null && !loop.headInjected && !continuationSummaryTurn(vis[loop.head].blocks);
      const user = headHuman ? turnSnippet(vis[loop.head].blocks) : "";
      const final = loop.final != null ? turnSnippet(vis[loop.final].blocks) : "";
      if (!user && !final) continue;
      loops.push({ user, final });
    }
    if (loops.length) out.push({ sid: t.sessionId || "", loops });
  }
  return out;
}

/**
 * Render loops to the model's input within `maxChars`: every loop when it
 * fits, else the first and last loops with a gap marker (what was asked
 * for + where it ended). Each side of a loop is clipped so one pasted
 * file cannot eat the budget.
 */
export function renderDigest(loops: DigestLoop[], maxChars = DIGEST_CHARS): string {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);
  const one = (l: DigestLoop, i: number) => {
    const parts = [];
    if (l.user) parts.push(`[${i + 1}] USER: ${clip(l.user.trim(), 700)}`);
    if (l.final) parts.push(`[${i + 1}] AGENT: ${clip(l.final.trim(), 500)}`);
    return parts.join("\n");
  };
  const all = loops.map(one);
  const total = all.reduce((n, s) => n + s.length + 2, 0);
  if (total <= maxChars) return all.join("\n\n");
  const head: string[] = [];
  const tail: string[] = [];
  let used = 40;
  let i = 0, j = all.length - 1;
  // Alternate front/back until the budget is spent — both ends matter.
  while (i <= j && used < maxChars) {
    if (used + all[i]!.length + 2 > maxChars) break;
    head.push(all[i]!); used += all[i]!.length + 2; i++;
    if (i > j) break;
    if (used + all[j]!.length + 2 > maxChars) break;
    tail.unshift(all[j]!); used += all[j]!.length + 2; j--;
  }
  const skipped = j - i + 1;
  return head.join("\n\n") + (skipped > 0 ? `\n\n[… ${skipped} exchange${skipped > 1 ? "s" : ""} omitted …]\n\n` : "\n\n") + tail.join("\n\n");
}

/** Post-process a model reply into a title: first line, unquoted, capped. */
export function cleanTitle(raw: string): string {
  let s = (raw || "").trim().split("\n").find((l) => l.trim()) || "";
  s = s.replace(/^["'“”`*#\s-]+|["'“”`*\s.]+$/g, "").trim();
  if (s.length > 100) s = s.slice(0, 97).trimEnd() + "…";
  return s;
}

export interface TitleJob {
  key: string;
  sid: string;
  source: string;
  digest: string;
  loops: number;
}

/**
 * Plan: which sessions in `dirs` need a title. Reads each trace (tail
 * budget — the newest request re-sends the whole conversation, so the
 * spine survives), one job per session id (the file with the most loops
 * wins), skipping keys titles.json already has unless `force`.
 */
export async function planTitles(dirs: TraceDirArg, storeDir: string, wire: any, opts: { force?: boolean; onlyFile?: string } = {}): Promise<{ jobs: TitleJob[]; skipped: number }> {
  const have = readTitles(storeDir);
  const jobs = new Map<string, TitleJob>();
  let skipped = 0;
  const entries = listTraceEntries(dirs).filter((e) => !opts.onlyFile || e.path === opts.onlyFile || e.name === opts.onlyFile);
  for (const e of entries) {
    let pairs: TracePair[];
    try { pairs = (await readTracePairs(e.path, { tailBytes: TAIL_BYTES })).pairs; } catch { continue; }
    if (!pairs.length) continue;
    const spines = sessionSpine(pairs, wire);
    if (!spines.length) {
      // No chat thread at all (a bootstrap-only trace): nothing to name.
      continue;
    }
    for (const s of spines) {
      const key = titleKey(s.sid || firstSid(pairs, wire), e.name);
      if (!opts.force && have[key]) { skipped++; continue; }
      const prev = jobs.get(key);
      if (prev && prev.loops >= s.loops.length) continue;
      jobs.set(key, { key, sid: s.sid, source: e.name, digest: renderDigest(s.loops), loops: s.loops.length });
    }
  }
  return { jobs: [...jobs.values()], skipped };
}

function firstSid(pairs: TracePair[], wire: any): string {
  for (const p of pairs) { const s = extractSessionId(p, wire); if (s) return s; }
  return "";
}

/** A per-call cached lookup of titles for registry runs: the run's project
 * store dir's titles.json, by session id, then by trace file name. */
export function titleLookup(dataDir: string): (run: { projectPath?: string; sessionId?: string; logFile?: string }) => string {
  const cache = new Map<string, Titles>();
  return (run) => {
    if (!run.projectPath) return "";
    const dir = projectTraceDir(dataDir, run.projectPath);
    let t = cache.get(dir);
    if (!t) { t = readTitles(dir); cache.set(dir, t); }
    if (run.sessionId && t[run.sessionId]) return t[run.sessionId]!.title;
    if (run.logFile) { const k = titleKey(null, basename(run.logFile)); if (t[k]) return t[k]!.title; }
    return "";
  };
}

/** For callers holding pairs already (the view header): the main thread's
 * session id, to look its title up. */
export function mainSessionId(pairs: TracePair[], wire?: any): string {
  const t = mainThread(buildSession(pairs, wire).threads);
  return (t && t.sessionId) || firstSid(pairs, wire);
}
