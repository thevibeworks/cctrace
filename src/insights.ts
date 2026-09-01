import { extractCallInfo, extractUsageInfo, extractSessionId } from "./summarize";
import { categorizeUrl } from "./categorize";
import { stepCost } from "./cost";
import type { InstanceInfo } from "./instances";
import type { TracePair } from "./types";
import type { ClientWire } from "./clients";

type WireTables = Record<string, ClientWire>;

// `cctrace insights` — the DATA layer for windowed usage questions ("how is
// prompt caching going this week", "where did the cost go", "which session
// is the heavy one"). Same division of labor as `cctrace title` (0.43):
// cctrace computes wire facts and estimates, the cctrace-insights skill
// reasons over them. Two paths, both folded here as pure functions:
//
//  - runs   — the registry's tombstone stats (pairs/tokens/est cost, stamped
//             once at exit): instant, no trace reads, but no cache split and
//             no quota history.
//  - scan   — every in-window trace streamed line by line: cache read/write/
//             uncached per day and per model, per-session weight, the quota
//             percentages the client polled. The truth is the wire; the scan
//             is the price of it.
//
// Every dollar is an estimate from catalog rates and lives under `est`;
// token counts and quota percentages are wire facts.

export interface InsightsWindow {
  sinceMs: number;
  untilMs: number;
  spec: string;
}

/** "7d" / "24h" / "90m" -> a window ending now. Throws on nonsense. */
export function parseWindow(spec: string, nowMs = Date.now()): InsightsWindow {
  const m = /^(\d+)([dhm])$/.exec(spec.trim());
  if (!m) throw new Error(`bad --since "${spec}" — use like 7d, 24h, 90m`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2] === "d" ? 24 * 60 * 60 * 1000 : m[2] === "h" ? 60 * 60 * 1000 : 60 * 1000;
  return { sinceMs: nowMs - n * unit, untilMs: nowMs, spec: spec.trim() };
}

/** A run overlaps the window when it was alive inside it. */
export function runInWindow(run: InstanceInfo, w: InsightsWindow): boolean {
  const start = Date.parse(run.startedAt || "") || 0;
  const end = run.endedAt ? Date.parse(run.endedAt) || start : w.untilMs;
  return start <= w.untilMs && end >= w.sinceMs;
}

const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface RunBucket {
  runs: number;
  pairs: number;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
}

const emptyRunBucket = (): RunBucket => ({ runs: 0, pairs: 0, messages: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0 });

export interface RunsFold {
  total: number;
  live: number;
  /** Runs whose tombstone carries exit stats — the others contribute only
   * their existence (killed runs, pre-0.35 tombstones). */
  withStats: number;
  byDay: Record<string, RunBucket>;
  byProject: Record<string, RunBucket>;
  byClient: Record<string, RunBucket>;
  top: Array<{
    id: string;
    sessionId?: string;
    project?: string;
    client?: string;
    startedAt?: string;
    endedAt?: string;
    wallMs: number;
    live: boolean;
    title?: string;
    firstPrompt?: string;
    pairs?: number;
    messages?: number;
    tokensIn?: number;
    tokensOut?: number;
    estCostUsd?: number;
  }>;
}

/** Fold the registry's in-window runs. `titleOf` is titleLookup's reader
 * (or () => "" when titles don't matter). */
export function foldRuns(
  runs: Array<InstanceInfo & { live?: boolean }>,
  w: InsightsWindow,
  titleOf: (r: InstanceInfo) => string = () => "",
  topN = 10,
): RunsFold {
  const out: RunsFold = { total: 0, live: 0, withStats: 0, byDay: {}, byProject: {}, byClient: {}, top: [] };
  const rows: RunsFold["top"] = [];
  for (const r of runs) {
    if (!runInWindow(r, w)) continue;
    out.total++;
    if (r.live) out.live++;
    // Exit stats are FLAT fields on the entry (instances.ts, 0.35+) —
    // absent on killed runs and pre-0.35 tombstones.
    const f = r as { pairs?: number; messages?: number; tokensIn?: number; tokensOut?: number; costUsd?: number };
    const s = typeof f.pairs === "number"
      ? { pairs: f.pairs, messages: f.messages || 0, tokensIn: f.tokensIn || 0, tokensOut: f.tokensOut || 0, costUsd: f.costUsd || 0 }
      : null;
    if (s) out.withStats++;
    const startMs = Date.parse(r.startedAt || "") || 0;
    const endMs = r.endedAt ? Date.parse(r.endedAt) || startMs : w.untilMs;
    const add = (bucket: RunBucket) => {
      bucket.runs++;
      if (s) {
        bucket.pairs += s.pairs || 0;
        bucket.messages += s.messages || 0;
        bucket.tokensIn += s.tokensIn || 0;
        bucket.tokensOut += s.tokensOut || 0;
        bucket.estCostUsd += s.costUsd || 0;
      }
    };
    add((out.byDay[dayOf(startMs || w.sinceMs)] ||= emptyRunBucket()));
    add((out.byProject[r.project || "?"] ||= emptyRunBucket()));
    add((out.byClient[r.client || "?"] ||= emptyRunBucket()));
    rows.push({
      id: r.id,
      sessionId: r.sessionId,
      project: r.project,
      client: r.client,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      wallMs: Math.max(0, endMs - startMs),
      live: !!r.live,
      title: titleOf(r) || undefined,
      firstPrompt: r.firstPrompt,
      pairs: s?.pairs,
      messages: s?.messages,
      tokensIn: s?.tokensIn,
      tokensOut: s?.tokensOut,
      estCostUsd: s?.costUsd,
    });
  }
  // Heaviest first: est cost when stamped, total tokens as the fallback —
  // a killed run without stats sorts by nothing and stays out of `top`.
  rows.sort((a, b) =>
    (b.estCostUsd ?? -1) - (a.estCostUsd ?? -1) ||
    ((b.tokensIn ?? 0) + (b.tokensOut ?? 0)) - ((a.tokensIn ?? 0) + (a.tokensOut ?? 0)));
  out.top = rows.slice(0, topN);
  return out;
}

interface UsageBucket {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  thinking: number;
  est: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  unpriced: number;
}

const emptyUsage = (): UsageBucket => ({
  calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0,
  est: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, unpriced: 0,
});

export interface ScanFold {
  pairs: number;
  deduped: number;
  usage: UsageBucket & { cacheHitPct: number | null };
  byDay: Record<string, UsageBucket>;
  byModel: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; estTotal: number }>;
  bySession: Array<{
    sessionId: string;
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estTotal: number;
    firstTs: number;
    lastTs: number;
  }>;
  quota: {
    polls: number;
    windows: Record<string, { min: number; max: number; last: number; lastAt: number; lastResetsAt: string | null }>;
    byDay: Record<string, Record<string, { min: number; max: number }>>;
  };
}

/**
 * A streaming fold over wire pairs: feed every pair of every in-window
 * trace, read the result once. O(1) memory apart from the id set (dedupe
 * across a session file and the trace auto-merge absorbed it from) and the
 * per-session table. Dollars come from stepCost — the caller must have set
 * `globalThis.__PRICING__` (the CLI passes the models.dev catalog exactly
 * like the exit report does).
 */
export function createScanFold(w: InsightsWindow, wire?: WireTables, topSessions = 10) {
  const seen = new Set<string>();
  const byDay: Record<string, UsageBucket> = {};
  const byModel: ScanFold["byModel"] = {};
  const bySession = new Map<string, ScanFold["bySession"][number]>();
  const total = emptyUsage();
  let pairsSeen = 0;
  let deduped = 0;
  const quota: ScanFold["quota"] = { polls: 0, windows: {}, byDay: {} };

  const add = (pair: TracePair) => {
    if (!pair || !pair.request) return;
    const ts = (pair.request.timestamp || 0) * 1000;
    if (!ts || ts < w.sinceMs || ts > w.untilMs) return;
    if (pair.id) {
      if (seen.has(pair.id)) { deduped++; return; }
      seen.add(pair.id);
    }
    pairsSeen++;
    const day = dayOf(ts);

    // Quota polls: the account limits the client asked about, wherever they
    // appear (Claude's /api/oauth/usage; other clients never poll).
    const u = extractUsageInfo(pair);
    if (u && u.limits && u.limits.length) {
      quota.polls++;
      const t = ((pair.response && pair.response.timestamp) || pair.request.timestamp || 0) * 1000;
      for (const l of u.limits) {
        const key = String(l.label);
        const win = (quota.windows[key] ||= { min: l.percent, max: l.percent, last: l.percent, lastAt: 0, lastResetsAt: null });
        win.min = Math.min(win.min, l.percent);
        win.max = Math.max(win.max, l.percent);
        if (t >= win.lastAt) { win.last = l.percent; win.lastAt = t; win.lastResetsAt = l.resetsAt || null; }
        const dayW = ((quota.byDay[day] ||= {})[key] ||= { min: l.percent, max: l.percent });
        dayW.min = Math.min(dayW.min, l.percent);
        dayW.max = Math.max(dayW.max, l.percent);
      }
    }

    if (categorizeUrl(pair.request.url || "", (pair as { client?: string }).client, wire) !== "messages") return;
    const ci = extractCallInfo(pair);
    if (!ci) return;
    const sc = stepCost(pair);
    const buckets = [total, (byDay[day] ||= emptyUsage())];
    for (const b of buckets) {
      b.calls++;
      b.input += ci.input || 0;
      b.output += ci.output || 0;
      b.cacheRead += ci.cacheRead || 0;
      b.cacheWrite += ci.cacheWrite || 0;
      b.thinking += ci.thinking || 0;
      if (sc) {
        b.est.total += sc.total;
        b.est.input += sc.input;
        b.est.output += sc.output;
        b.est.cacheRead += sc.cacheRead;
        b.est.cacheWrite += sc.cacheWrite;
      } else b.unpriced++;
    }
    const model = ci.model || "unknown";
    const m = (byModel[model] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estTotal: 0 });
    m.calls++;
    m.input += ci.input || 0;
    m.output += ci.output || 0;
    m.cacheRead += ci.cacheRead || 0;
    m.cacheWrite += ci.cacheWrite || 0;
    if (sc) m.estTotal += sc.total;
    const sid = extractSessionId(pair, wire) || "";
    if (sid) {
      const s = bySession.get(sid) || { sessionId: sid, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estTotal: 0, firstTs: ts, lastTs: ts };
      s.calls++;
      s.input += ci.input || 0;
      s.output += ci.output || 0;
      s.cacheRead += ci.cacheRead || 0;
      s.cacheWrite += ci.cacheWrite || 0;
      if (sc) s.estTotal += sc.total;
      s.firstTs = Math.min(s.firstTs, ts);
      s.lastTs = Math.max(s.lastTs, ts);
      bySession.set(sid, s);
    }
  };

  const result = (): ScanFold => {
    // Hit rate over the whole window: what share of the prompt tokens the
    // cache served. Null when the window never used the cache at all.
    const denom = total.cacheRead + total.cacheWrite + total.input;
    const sessions = [...bySession.values()].sort((a, b) => b.estTotal - a.estTotal ||
      (b.input + b.cacheRead + b.cacheWrite + b.output) - (a.input + a.cacheRead + a.cacheWrite + a.output));
    return {
      pairs: pairsSeen,
      deduped,
      usage: { ...total, cacheHitPct: denom > 0 ? Math.round((total.cacheRead / denom) * 100) : null },
      byDay,
      byModel,
      bySession: sessions.slice(0, topSessions),
      quota,
    };
  };

  return { add, result };
}
