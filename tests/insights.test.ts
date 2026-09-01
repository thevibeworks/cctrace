import { describe, test, expect } from "bun:test";
import { parseWindow, runInWindow, foldRuns, createScanFold } from "../src/insights";
import type { InstanceInfo } from "../src/instances";
import type { TracePair } from "../src/types";

// The insights DATA layer: windowed folds over registry tombstones (flat
// exit-stat fields) and wire pairs (usage, per-model, per-session, quota).
// The skill reasons; these folds must only state wire facts and estimates.

const NOW = Date.parse("2026-08-31T12:00:00Z");

describe("parseWindow", () => {
  test("understands d/h/m and rejects nonsense", () => {
    expect(parseWindow("7d", NOW).sinceMs).toBe(NOW - 7 * 24 * 3600 * 1000);
    expect(parseWindow("24h", NOW).sinceMs).toBe(NOW - 24 * 3600 * 1000);
    expect(parseWindow("90m", NOW).sinceMs).toBe(NOW - 90 * 60 * 1000);
    expect(() => parseWindow("next tuesday", NOW)).toThrow();
  });
});

const run = (over: Partial<InstanceInfo> & { live?: boolean } = {}): InstanceInfo & { live?: boolean } => ({
  id: over.id || "r1",
  pid: 1,
  port: 0,
  mode: "mitm",
  startedAt: "2026-08-30T10:00:00Z",
  endedAt: "2026-08-30T11:00:00Z",
  ...over,
} as InstanceInfo & { live?: boolean });

describe("foldRuns", () => {
  const w = parseWindow("7d", NOW);

  test("reads the FLAT exit-stat fields and sorts the heaviest first", () => {
    const runs = [
      run({ id: "a", project: "p1", client: "claude", pairs: 10, messages: 4, tokensIn: 1000, tokensOut: 50, costUsd: 2 } as Partial<InstanceInfo>),
      run({ id: "b", project: "p1", client: "claude", pairs: 90, messages: 40, tokensIn: 9000, tokensOut: 500, costUsd: 20 } as Partial<InstanceInfo>),
      run({ id: "c", project: "p2", client: "codex" }), // killed run: no stats
    ];
    const f = foldRuns(runs, w);
    expect(f.total).toBe(3);
    expect(f.withStats).toBe(2);
    expect(f.byProject.p1!.estCostUsd).toBe(22);
    expect(f.byProject.p1!.tokensIn).toBe(10000);
    expect(f.byProject.p2!.runs).toBe(1);
    expect(f.byClient.claude!.pairs).toBe(100);
    expect(f.top[0]!.id).toBe("b");
    expect(f.top[1]!.id).toBe("a");
  });

  test("a run outside the window contributes nothing; one straddling it counts", () => {
    const runs = [
      run({ id: "old", startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-08-01T01:00:00Z" }),
      run({ id: "straddle", startedAt: "2026-08-24T00:00:00Z", endedAt: "2026-08-25T00:00:00Z" }),
    ];
    expect(runInWindow(runs[0]!, w)).toBe(false);
    expect(runInWindow(runs[1]!, w)).toBe(true);
    expect(foldRuns(runs, w).total).toBe(1);
  });
});

// A synthetic messages pair with real-shaped usage. Timestamps in seconds
// (the wire convention).
const msg = (id: string, tsSec: number, over: { model?: string; input?: number; output?: number; read?: number; write?: number; sid?: string } = {}): TracePair => ({
  id,
  request: {
    timestamp: tsSec,
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: {},
    body: {
      model: over.model || "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      ...(over.sid ? { metadata: { user_id: `user_x_account__session_${over.sid}` } } : {}),
    },
  },
  response: {
    timestamp: tsSec + 2,
    status: 200,
    headers: { "content-type": "application/json" },
    body: {
      model: over.model || "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: over.input ?? 100,
        output_tokens: over.output ?? 10,
        cache_read_input_tokens: over.read ?? 0,
        cache_creation_input_tokens: over.write ?? 0,
      },
    },
  },
  duration: 2000,
  loggedAt: new Date(tsSec * 1000).toISOString(),
});

const quotaPoll = (id: string, tsSec: number, fivePct: number, sevenPct: number): TracePair => ({
  id,
  request: { timestamp: tsSec, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {} },
  response: {
    timestamp: tsSec + 1,
    status: 200,
    headers: {},
    body: {
      five_hour: { utilization: fivePct, resets_at: "2026-08-31T14:00:00Z" },
      seven_day: { utilization: sevenPct, resets_at: "2026-09-03T00:00:00Z" },
    },
  },
  duration: 1000,
  loggedAt: new Date(tsSec * 1000).toISOString(),
});

describe("createScanFold", () => {
  const w = parseWindow("7d", NOW);
  const T = Math.floor((NOW - 24 * 3600 * 1000) / 1000); // yesterday, inside

  test("folds usage by day/model/session and computes the cache hit share", () => {
    const fold = createScanFold(w);
    const sid = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
    fold.add(msg("m1", T, { input: 100, read: 800, write: 100, output: 20, sid }));
    fold.add(msg("m2", T + 60, { input: 0, read: 900, write: 0, output: 30, sid }));
    fold.add(msg("m3", T + 120, { model: "claude-opus-4-1-20250805", input: 50, output: 5 }));
    const r = fold.result();
    expect(r.pairs).toBe(3);
    expect(r.usage.calls).toBe(3);
    expect(r.usage.cacheRead).toBe(1700);
    expect(r.usage.cacheWrite).toBe(100);
    expect(r.usage.input).toBe(150);
    // 1700 read of (1700 + 100 + 150) prompt tokens = 87%
    expect(r.usage.cacheHitPct).toBe(87);
    expect(Object.keys(r.byModel).sort()).toEqual(["claude-opus-4-1-20250805", "claude-sonnet-4-20250514"]);
    expect(r.bySession.length).toBe(1);
    expect(r.bySession[0]!.sessionId).toBe(sid);
    expect(r.bySession[0]!.calls).toBe(2);
    expect(Object.keys(r.byDay).length).toBe(1);
    // dollars are estimates from the embedded table — present, never asserted exactly
    expect(r.usage.est.total).toBeGreaterThan(0);
  });

  test("dedupes by pair id across sources and drops pairs outside the window", () => {
    const fold = createScanFold(w);
    const p = msg("dup", T);
    fold.add(p);
    fold.add(JSON.parse(JSON.stringify(p)));
    fold.add(msg("old", Math.floor((NOW - 30 * 24 * 3600 * 1000) / 1000)));
    const r = fold.result();
    expect(r.pairs).toBe(1);
    expect(r.deduped).toBe(1);
    expect(r.usage.calls).toBe(1);
  });

  test("reads quota polls: min/max/last per window, per day", () => {
    const fold = createScanFold(w);
    fold.add(quotaPoll("q1", T, 12, 60));
    fold.add(quotaPoll("q2", T + 3600, 37, 61));
    const r = fold.result();
    expect(r.quota.polls).toBe(2);
    expect(r.quota.windows["5h"]!.min).toBe(12);
    expect(r.quota.windows["5h"]!.max).toBe(37);
    expect(r.quota.windows["5h"]!.last).toBe(37);
    expect(r.quota.windows["7d"]!.last).toBe(61);
    expect(r.quota.windows["5h"]!.lastResetsAt).toBe("2026-08-31T14:00:00Z");
    const day = Object.values(r.quota.byDay)[0]!;
    expect(day["5h"]!.min).toBe(12);
    expect(day["5h"]!.max).toBe(37);
  });

  test("a never-cached window reports cacheHitPct honestly, not zero", () => {
    const fold = createScanFold(w);
    const r0 = fold.result();
    expect(r0.usage.cacheHitPct).toBe(null);
  });
});
