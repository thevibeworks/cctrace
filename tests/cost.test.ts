import { describe, test, expect } from "bun:test";
import { stepCost, threadCostSplit, costEvents, usagePolls } from "../src/cost";

// Wire-shaped fixtures, never real trace content. Cost is estimated from
// the embedded Claude table (offline), so the arithmetic below is checked
// against the published rates: sonnet $3/$15 per MTok, cache read 0.1x
// ($0.30), 5m write 1.25x ($3.75), 1h write 2x ($6.00).

let seq = 0;
type Usage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
};

function msgPair(u: Usage = {}, opts: any = {}): any {
  seq++;
  const usage =
    `"usage":{"input_tokens":${u.input ?? 0},` +
    `"output_tokens":${u.output ?? 100},` +
    `"cache_read_input_tokens":${u.cacheRead ?? 0},` +
    `"cache_creation_input_tokens":${(u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0)},` +
    `"cache_creation":{"ephemeral_5m_input_tokens":${u.cacheWrite5m ?? 0},"ephemeral_1h_input_tokens":${u.cacheWrite1h ?? 0}}}`;
  const model = opts.model || "claude-sonnet-4-6";
  const sse = [
    `data: {"type":"message_start","message":{"model":"${model}",${usage}}}`,
    opts.noStop
      ? `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"cut"}}`
      : `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},${usage}}`,
  ].join("\n");
  const ts = opts.ts ?? 1751900000 + seq * 10;
  return {
    id: opts.id || "pair_" + seq,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model, messages: [{ role: "user", content: "hi" }] },
    },
    response: opts.noResponse
      ? undefined
      : {
          timestamp: ts + 1,
          status: opts.status ?? 200,
          headers: {},
          ...(opts.status && opts.status >= 400
            ? { body: { type: "error", error: { type: "overloaded_error" } } }
            : { bodyRaw: sse }),
        },
    duration: opts.duration ?? 1000,
  };
}

/** A warm step: most of the prompt served from cache. */
const warm = (opts: any = {}) => msgPair({ input: 10, cacheRead: 100000, cacheWrite5m: 500 }, opts);

describe("stepCost", () => {
  test("prices a Claude pair by component and memoizes on the pair", () => {
    const p = msgPair({ input: 1_000_000, output: 100_000, cacheRead: 500_000 });
    const c = stepCost(p);
    expect(c.input).toBeCloseTo(3);
    expect(c.output).toBeCloseTo(1.5);
    expect(c.cacheRead).toBeCloseTo(0.15);
    expect(c.total).toBeCloseTo(4.65);
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(p._sc).toBe(c);
    expect(stepCost(p)).toBe(c); // second call reads the memo
  });

  test("an unknown model is unpriced — null, never $0", () => {
    expect(stepCost(msgPair({ input: 100 }, { model: "some-unknown-model" }))).toBeNull();
    expect(stepCost(null)).toBeNull();
  });

  test("an OpenAI-dialect pair prices through the same path", () => {
    const completed = {
      type: "response.completed",
      response: {
        status: "completed",
        model: "claude-sonnet-4-6", // catalog-free: the embedded table prices it
        output: [],
        usage: {
          input_tokens: 1_000_000, // OpenAI counts cached tokens inside input
          input_tokens_details: { cached_tokens: 900_000 },
          output_tokens: 100_000,
        },
      },
    };
    const p: any = {
      id: "o1",
      client: "codex",
      request: {
        timestamp: 1751900000,
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: {},
        body: { model: "claude-sonnet-4-6", stream: true, input: [] },
      },
      response: { timestamp: 1751900002, status: 200, headers: {}, bodyRaw: `data: ${JSON.stringify(completed)}\n` },
      duration: 2000,
    };
    const c = stepCost(p);
    expect(c.input).toBeCloseTo(0.3); // 100k uncached input
    expect(c.cacheRead).toBeCloseTo(0.27); // 900k reads at $0.30/MTok
    expect(c.output).toBeCloseTo(1.5);
  });
});

describe("threadCostSplit", () => {
  test("sums the four components, and splits by pair and by model", () => {
    const a = msgPair({ input: 1_000_000, output: 100_000, cacheRead: 500_000 }, { id: "a" });
    const b = msgPair({ cacheWrite5m: 1_000_000 }, { id: "b", model: "claude-opus-4-8" });
    const s = threadCostSplit([a, b]);
    expect(s.steps).toBe(2);
    expect(s.unpriced).toBe(0);
    expect(s.input).toBeCloseTo(3);
    expect(s.cacheRead).toBeCloseTo(0.15);
    expect(s.cacheWrite).toBeCloseTo(6.25); // opus 4.8: $5 input -> $6.25 5m write
    expect(s.byPair["a"]).toBeCloseTo(4.65);
    expect(s.byModel["claude-opus-4-8"].requests).toBe(1);
    expect(s.byModel["claude-sonnet-4-6"].total).toBeCloseTo(4.65);
    expect(s.total).toBeCloseTo(s.input + s.output + s.cacheRead + s.cacheWrite);
  });

  test("unpriced models are counted, never folded into the total", () => {
    const s = threadCostSplit([msgPair({ input: 1000 }, { model: "some-unknown-model" }), warm()]);
    expect(s.unpriced).toBe(1);
    expect(s.steps).toBe(1);
  });
});

describe("costEvents", () => {
  test("the first request of a conversation is a start, not a bump", () => {
    // cold, expensive — but nothing came before it to be warm against
    expect(costEvents([msgPair({ cacheWrite5m: 200000 })])).toEqual([]);
  });

  test("a warm step emits nothing", () => {
    expect(costEvents([warm(), warm()])).toEqual([]);
  });

  test("expired: a gap past the previous write's TTL", () => {
    const a = warm({ ts: 1000, duration: 2000 });
    // 40 min later: the 5m entry the previous read refreshed is long gone
    const b = msgPair({ input: 100, cacheWrite5m: 285_000 }, { ts: 1000 + 2400 });
    const [ev] = costEvents([a, b]);
    expect(ev.kind).toBe("cost");
    expect(ev.cause).toBe("expired");
    expect(ev.ttl).toBe("5m");
    expect(ev.gap).toBe(2398); // from the previous request's END
    expect(ev.tokens).toBe(285_100);
    // 285k re-written at $3.75 instead of read at $0.30, plus 100 fresh input
    expect(ev.extra).toBeCloseTo((285_000 * 3.45 + 100 * 2.7) / 1e6, 6);
  });

  test("a 1h write holds for an hour: 40 min is a changed prefix, 2h is expired", () => {
    const hot = msgPair({ input: 10, cacheRead: 100000, cacheWrite1h: 5000 }, { ts: 1000, duration: 0 });
    const soon = msgPair({ cacheWrite1h: 200_000 }, { ts: 1000 + 2400 });
    expect(costEvents([hot, soon])[0].cause).toBe("invalidated");
    const late = msgPair({ cacheWrite1h: 200_000 }, { ts: 1000 + 7200 });
    const ev = costEvents([hot, late])[0];
    expect(ev.cause).toBe("expired");
    expect(ev.ttl).toBe("1h");
    // a 1h write bills at 2x input ($6.00) against a $0.30 read
    expect(ev.extra).toBeCloseTo((200_000 * 5.7) / 1e6, 6);
  });

  test("retry: the previous request failed, so it never banked its write", () => {
    const hot = warm({ ts: 900 });
    const dead = msgPair({}, { ts: 1000, status: 529 });
    const again = msgPair({ input: 100, cacheRead: 20_000, cacheWrite5m: 284_000 }, { ts: 1001 });
    const ev = costEvents([hot, dead, again])[0];
    expect(ev.cause).toBe("retry");
    expect(ev.prevStatus).toBe(529);
    expect(ev.hitPct).toBe(7); // 20k of 304.1k
  });

  test("retry: an interrupted stream (no stop_reason) is equally unbanked", () => {
    const cut = msgPair({ input: 10, cacheRead: 100_000 }, { ts: 1000, noStop: true });
    const again = msgPair({ cacheWrite5m: 100_000 }, { ts: 1002 });
    const ev = costEvents([cut, again])[0];
    expect(ev.cause).toBe("retry");
    expect(ev.prevStatus).toBe(200);
  });

  test("invalidated: the prefix changed, and a same-step event names why", () => {
    const a = warm({ ts: 1000, duration: 1000 });
    const b = msgPair({ cacheWrite5m: 150_000 }, { ts: 1010, id: "b" });
    const bare = costEvents([a, b])[0];
    expect(bare.cause).toBe("invalidated");
    expect(bare.causeKind).toBeNull(); // "cause not on the wire"
    const named = costEvents([a, b], [{ kind: "tools", pairId: "b", t: 1010, tokens: 900 }])[0];
    expect(named.causeKind).toBe("tools");
    // an inject event is not a prefix change and must not be blamed
    expect(costEvents([a, b], [{ kind: "inject", pairId: "b", t: 1010 }])[0].causeKind).toBeNull();
  });

  test("a weak hit (under 90%) is a bump; the counterfactual is the difference", () => {
    const a = warm({ ts: 1000, duration: 1000 });
    // 5% hit on a 341k prompt, all of it re-written at the 1h rate
    const b = msgPair({ input: 0, cacheRead: 17_000, cacheWrite1h: 324_000 }, { ts: 1005 });
    const ev = costEvents([a, b])[0];
    expect(ev.hitPct).toBe(5);
    expect(ev.tokens).toBe(324_000);
    expect(ev.extra).toBeCloseTo((324_000 * 5.7) / 1e6, 6); // ≈$1.85 over warm
    expect(ev.t).toBe(1005);
    expect(ev.pairId).toBe(b.id);
  });

  test("an unpriced model produces no bump, and still counts as a previous request", () => {
    const a = warm({ ts: 990 });
    const b = msgPair({ input: 100 }, { ts: 1000, model: "some-unknown-model" });
    const c = msgPair({ cacheWrite5m: 100_000 }, { ts: 1005 });
    const evs = costEvents([a, b, c]);
    expect(evs.length).toBe(1);
    expect(evs[0].pairId).toBe(c.id);
  });

  test("a thread that never used the cache has no bumps to report", () => {
    // nothing was ever banked, so paying input rate is the price of the
    // prompt — not a prefix bought twice
    const a = msgPair({ input: 5000 }, { ts: 1000 });
    const b = msgPair({ input: 9000 }, { ts: 1100 });
    expect(costEvents([a, b])).toEqual([]);
  });
});

describe("usagePolls", () => {
  const pollPair = (id: string, ts: number, body: any) => ({
    id,
    request: { timestamp: ts, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {} },
    response: { timestamp: ts + 1, status: 200, headers: {}, body },
    duration: 100,
  });

  test("reads the flat five_hour/seven_day shape, oldest first", () => {
    const polls = usagePolls([
      pollPair("u2", 2000, {
        five_hour: { utilization: 37, resets_at: "2026-08-19T10:59:59Z" },
        seven_day: { utilization: 47, resets_at: "2026-08-19T15:59:59Z" },
      }),
      pollPair("u1", 1000, { five_hour: { utilization: 12, resets_at: "2026-08-19T10:59:59Z" } }),
      msgPair({ input: 10 }), // a model call is not a poll
    ]);
    expect(polls.length).toBe(2);
    expect(polls[0].t).toBe(1001);
    expect(polls[0].limits[0]).toMatchObject({ label: "5h", percent: 12 });
    expect(polls[1].limits.map((l: any) => l.label)).toEqual(["5h", "7d"]);
    expect(polls[1].limits[1].resetsAt).toBe("2026-08-19T15:59:59Z");
  });

  test("reads the newer limits[] shape, with credits", () => {
    const [poll] = usagePolls([
      pollPair("u3", 3000, {
        limits: [
          { kind: "session", percent: 42, resets_at: "2026-08-19T10:59:59Z" },
          { kind: "weekly_all", percent: 61, severity: "warning", resets_at: "2026-08-21T00:00:00Z" },
          { kind: "weekly_scoped", percent: 8, scope: { model: { display_name: "Opus" } } },
        ],
        extra_usage: { is_enabled: true, used_credits: 250, monthly_limit: 5000, currency: "USD", decimal_places: 2 },
      }),
    ]);
    expect(poll.limits.map((l: any) => l.label)).toEqual(["5h", "7d", "Opus"]);
    expect(poll.limits[1].severity).toBe("warning");
    expect(poll.credits).toMatchObject({ used: 250, limit: 5000, currency: "USD" });
  });

  test("a trace with no usage poll gets an empty list", () => {
    expect(usagePolls([msgPair({ input: 10 })])).toEqual([]);
    expect(usagePolls([])).toEqual([]);
  });
});
