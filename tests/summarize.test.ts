import { describe, test, expect } from "bun:test";
import {
  parseSse,
  fmtCompact,
  fmtMs,
  extractLatency,
  extractSizes,
  shortModel,
  extractMessageInfo,
  extractSessionId,
  extractTokenCount,
  extractUsageInfo,
  assembleAssistant,
  summarizePair,
  hasCacheControl,
  summarizeCache,
  extractEffort,
} from "../src/summarize";

// Fixtures mirror real captured shapes (sanitized), see .cctrace/*.jsonl.

const SSE_STREAM = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_test","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":19623,"cache_read_input_tokens":19635,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":19623},"output_tokens":34,"service_tier":"standard"}}     }`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm, "}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ok"}}`,
  `data: {"type":"content_block_stop","index":0}`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":" world"}}`,
  `data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}`,
  `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}`,
  `data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":3,"cache_creation_input_tokens":19623,"cache_read_input_tokens":19635,"output_tokens":76,"output_tokens_details":{"thinking_tokens":44}}  }`,
  `data: {"type":"message_stop"}`,
  `not-a-data-line`,
].join("\n");

function streamingPair(overrides: Record<string, unknown> = {}) {
  return {
    id: "100_a",
    request: {
      timestamp: 1751900000,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages?beta=true",
      headers: {},
      body: {
        model: "claude-opus-4-6",
        max_tokens: 64000,
        stream: true,
        system: [{ type: "text", text: "sys" }],
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "Bash" }, { name: "Read" }],
      },
    },
    response: {
      timestamp: 1751900005,
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      bodyRaw: SSE_STREAM,
    },
    duration: 5000,
    loggedAt: "x",
    ...overrides,
  };
}

describe("parseSse", () => {
  test("parses data lines, skips event lines and garbage", () => {
    const events = parseSse(SSE_STREAM);
    expect(events.length).toBe(13);
    expect(events[0].type).toBe("message_start");
    expect(events[events.length - 1].type).toBe("message_stop");
  });

  test("empty/null input gives empty array", () => {
    expect(parseSse("")).toEqual([]);
    expect(parseSse(null)).toEqual([]);
  });
});

describe("fmtCompact / shortModel", () => {
  test("formats counts", () => {
    expect(fmtCompact(0)).toBe("0");
    expect(fmtCompact(999)).toBe("999");
    expect(fmtCompact(19635)).toBe("19.6k");
    expect(fmtCompact(107000)).toBe("107k");
    expect(fmtCompact(1234567)).toBe("1.23m");
    expect(fmtCompact(null)).toBe("0");
  });

  test("shortens model ids", () => {
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel("claude-opus-4-6")).toBe("opus-4-6");
    expect(shortModel(null)).toBe("");
  });
});

describe("extractMessageInfo", () => {
  test("streaming SSE: merges message_start and message_delta", () => {
    const m = extractMessageInfo(streamingPair());
    expect(m.model).toBe("claude-opus-4-6");
    expect(m.stream).toBe(true);
    expect(m.input).toBe(3);
    expect(m.output).toBe(76); // final from message_delta, not the 34 in message_start
    expect(m.cacheRead).toBe(19635);
    expect(m.cacheWrite).toBe(19623);
    expect(m.cacheWrite1h).toBe(19623);
    expect(m.cacheWrite5m).toBe(0);
    expect(m.thinking).toBe(44);
    expect(m.stopReason).toBe("end_turn");
    expect(m.serviceTier).toBe("standard");
    expect(m.cachePct).toBe(50); // 19635 / (3 + 19635 + 19623)
    expect(m.turns).toBe(1);
    expect(m.toolCount).toBe(2);
    expect(m.systemBlocks).toBe(1);
    expect(m.error).toBeNull();
  });

  test("non-streaming JSON body", () => {
    const pair = streamingPair({
      response: {
        timestamp: 0,
        status: 200,
        headers: {},
        body: {
          model: "claude-haiku-4-5-20251001",
          stop_reason: "end_turn",
          usage: { input_tokens: 520, output_tokens: 13, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    });
    const m = extractMessageInfo(pair);
    expect(m.input).toBe(520);
    expect(m.output).toBe(13);
    expect(m.cacheRead).toBe(0);
    expect(m.stopReason).toBe("end_turn");
  });

  test("error body", () => {
    const pair = streamingPair({
      response: {
        timestamp: 0,
        status: 429,
        headers: {},
        body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      },
    });
    expect(extractMessageInfo(pair).error).toBe("rate_limit_error");
  });

  test("no response", () => {
    const m = extractMessageInfo(streamingPair({ response: null }));
    expect(m.input).toBe(0);
    expect(m.model).toBe("claude-opus-4-6"); // still from request
  });
});

describe("assembleAssistant", () => {
  test("rebuilds thinking, text, and tool_use blocks from deltas", () => {
    const blocks = assembleAssistant(parseSse(SSE_STREAM));
    expect(blocks.length).toBe(3);
    expect(blocks[0].type).toBe("thinking");
    expect(blocks[0].thinking).toBe("hmm, ok");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toBe("Hello world");
    expect(blocks[2].type).toBe("tool_use");
    expect(blocks[2].name).toBe("Bash");
    expect(blocks[2].input).toEqual({ command: "ls" });
    expect(blocks[2].__json).toBeUndefined();
  });

  test("tolerates empty input", () => {
    expect(assembleAssistant([])).toEqual([]);
    expect(assembleAssistant(null as any)).toEqual([]);
  });
});

describe("extractTokenCount", () => {
  test("model + result", () => {
    const pair = {
      request: { body: { model: "claude-opus-4-6", messages: [] } },
      response: { status: 200, body: { input_tokens: 539 } },
    };
    expect(extractTokenCount(pair)).toEqual({ model: "claude-opus-4-6", tokens: 539 });
  });
});

describe("extractUsageInfo", () => {
  const usageBody = {
    five_hour: { utilization: 11, resets_at: "2026-07-07T10:59:59+00:00" },
    seven_day: { utilization: 23, resets_at: "2026-07-08T15:59:59+00:00" },
    extra_usage: { is_enabled: false, monthly_limit: 20000, used_credits: 0, currency: "USD", decimal_places: 2 },
    limits: [
      { kind: "session", group: "session", percent: 11, severity: "normal", resets_at: "2026-07-07T10:59:59+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 23, severity: "normal", resets_at: "2026-07-08T15:59:59+00:00", scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 24, severity: "normal", resets_at: "2026-07-08T15:59:59+00:00", scope: { model: { id: null, display_name: "Fable" } } },
    ],
  };

  test("maps limits[] to labeled windows", () => {
    const u = extractUsageInfo({ response: { status: 200, body: usageBody } });
    expect(u.limits.map((l: any) => l.label)).toEqual(["5h", "7d", "Fable"]);
    expect(u.limits.map((l: any) => l.percent)).toEqual([11, 23, 24]);
    expect(u.credits).toBeNull(); // extra usage disabled
  });

  test("falls back to five_hour/seven_day when limits[] missing", () => {
    const { limits: _drop, ...flat } = usageBody;
    const u = extractUsageInfo({ response: { status: 200, body: flat } });
    expect(u.limits.map((l: any) => l.label)).toEqual(["5h", "7d"]);
  });

  test("credits surface when enabled", () => {
    const body = { ...usageBody, extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 512, currency: "USD", decimal_places: 2 } };
    const u = extractUsageInfo({ response: { status: 200, body } });
    expect(u.credits).toEqual({ used: 512, limit: 20000, currency: "USD", decimalPlaces: 2 });
  });

  test("null on non-object body", () => {
    expect(extractUsageInfo({ response: { status: 200, bodyRaw: "x" } })).toBeNull();
  });
});

describe("summarizeCache", () => {
  const m = (over: Record<string, unknown> = {}) => ({
    cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, cachePct: null, error: null, ...over,
  });
  const cachedBody = { system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] };

  test("hit: read > 0 is green with hit% and read/write arrows", () => {
    const c = summarizeCache(m({ cacheRead: 90000, cacheWrite: 1200, cacheWrite5m: 1200, cachePct: 97 }), cachedBody);
    expect(c).toMatchObject({ kind: "hit", c: "ok", v: "↓90.0k 97% ↑1.2k" });
    expect(c.title).toContain("read from cache");
  });

  test("weak hit: under 90% of the prompt from cache is a warning", () => {
    const c = summarizeCache(m({ cacheRead: 40000, cachePct: 62 }), cachedBody);
    expect(c).toMatchObject({ kind: "hit", c: "warn" });
    expect(c.title).toContain("low hit rate");
    // 90 is the boundary: exactly 90% still counts as healthy
    expect(summarizeCache(m({ cacheRead: 40000, cachePct: 90 }), cachedBody).c).toBe("ok");
  });

  test("cold: write without read is amber and says why", () => {
    const c = summarizeCache(m({ cacheWrite: 50000, cacheWrite5m: 50000 }), cachedBody);
    expect(c).toMatchObject({ kind: "cold", c: "warn", v: "↑50.0k" });
    expect(c.title).toContain("cold");
  });

  test("1h-TTL writes get a breakdown (they bill at 2x)", () => {
    const c = summarizeCache(m({ cacheWrite: 3000, cacheWrite5m: 1000, cacheWrite1h: 2000 }), cachedBody);
    expect(c.v).toBe("↑3.0k (1.0k 5m + 2.0k 1h)");
  });

  test("miss: cache_control set but nothing read or written", () => {
    const c = summarizeCache(m(), cachedBody);
    expect(c).toMatchObject({ kind: "miss", v: "miss", c: "warn" });
  });

  test("null when the request doesn't use the cache", () => {
    expect(summarizeCache(m(), { messages: [{ role: "user", content: "hi" }] })).toBeNull();
    expect(summarizeCache(m({ error: "overloaded_error" }), cachedBody)).toBeNull();
  });
});

describe("hasCacheControl", () => {
  test("finds cache_control in system, tools, and message blocks", () => {
    expect(hasCacheControl({ system: [{ cache_control: { type: "ephemeral" } }] })).toBe(true);
    expect(hasCacheControl({ tools: [{ name: "t" }, { name: "u", cache_control: {} }] })).toBe(true);
    expect(hasCacheControl({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: {} }] }] })).toBe(true);
  });

  test("false for plain bodies and junk", () => {
    expect(hasCacheControl({ messages: [{ role: "user", content: "hi" }] })).toBe(false);
    expect(hasCacheControl(null)).toBe(false);
    expect(hasCacheControl("nope")).toBe(false);
  });
});

describe("fmtMs / extractLatency", () => {
  test("fmtMs formats like the UI's wall-clock durations", () => {
    expect(fmtMs(850)).toBe("850ms");
    expect(fmtMs(8412)).toBe("8.41s");
    expect(fmtMs(-1)).toBe("");
    expect(fmtMs("x")).toBe("");
  });

  test("null for pairs captured before the timing fields existed", () => {
    expect(extractLatency(streamingPair())).toBeNull();
    expect(extractLatency({ request: {}, response: null })).toBeNull();
    expect(extractLatency(null)).toBeNull();
  });

  test("token timing wins, share of wall-clock computed", () => {
    const pair = streamingPair();
    (pair.response as any).firstByteMs = 90;
    (pair.response as any).firstTokenMs = 1250;
    const l = extractLatency(pair);
    expect(l).toEqual({ ms: 1250, isToken: true, ttftMs: 1250, ttfbMs: 90, totalMs: 5000, pct: 25 });
  });

  test("falls back to first-byte timing when no token event was seen", () => {
    const pair = streamingPair();
    (pair.response as any).firstByteMs = 90;
    const l = extractLatency(pair);
    expect(l.isToken).toBe(false);
    expect(l.ms).toBe(90);
    expect(l.pct).toBe(2);
  });
});

describe("extractSizes", () => {
  test("wire byte counts stamped at capture time are exact", () => {
    const pair = streamingPair();
    (pair.request as any).bodyBytes = 4321;
    (pair.response as any).bodyBytes = 987;
    expect(extractSizes(pair)).toEqual({ up: 4321, down: 987, exact: true, tunneled: false });
  });

  test("pre-0.17 pairs estimate from the decoded trace body", () => {
    const pair = streamingPair();
    const s = extractSizes(pair);
    expect(s.exact).toBe(false);
    expect(s.up).toBe(JSON.stringify(pair.request.body).length);
    expect(s.down).toBe((pair.response as any).bodyRaw.length);
  });

  test("absent bodies are exactly zero, not an estimate", () => {
    const s = extractSizes({
      request: { method: "GET", url: "https://x/", headers: {}, body: null },
      response: { status: 204, headers: {} },
    });
    expect(s).toEqual({ up: 0, down: 0, exact: true, tunneled: false });
  });

  test("tunnel meta pairs report whole-connection byte counts", () => {
    const s = extractSizes({
      request: { method: "CONNECT", url: "https://registry.npmjs.org/", headers: {}, body: null },
      response: { status: 200, headers: {}, body: { tunneled: true, bytesUp: 1400, bytesDown: 54700000 } },
    });
    expect(s).toEqual({ up: 1400, down: 54700000, exact: true, tunneled: true });
  });

  test("null without a request", () => {
    expect(extractSizes(null)).toBeNull();
    expect(extractSizes({})).toBeNull();
  });
});

describe("extractEffort", () => {
  test("anthropic current: output_config.effort wins over adaptive thinking", () => {
    const eff = extractEffort({ thinking: { type: "adaptive" }, output_config: { effort: "xhigh" } });
    expect(eff.v).toBe("xhigh");
    expect(eff.title).toContain("output_config.effort");
  });

  test("transitional anthropic / kimi: thinking.effort", () => {
    const eff = extractEffort({ thinking: { type: "enabled", effort: "high", keep: "all" } });
    expect(eff.v).toBe("high");
    expect(eff.title).toContain("thinking.effort");
  });

  test("classic extended thinking: budget_tokens", () => {
    const eff = extractEffort({ thinking: { type: "enabled", budget_tokens: 31999 } });
    expect(eff.v).toBe("32.0k budget");
    expect(eff.title).toContain("31,999");
  });

  test("adaptive without an explicit effort", () => {
    expect(extractEffort({ thinking: { type: "adaptive" } }).v).toBe("adaptive");
  });

  test("codex/grok Responses: reasoning.effort", () => {
    const eff = extractEffort({ reasoning: { effort: "medium", summary: "concise" } });
    expect(eff.v).toBe("medium");
    expect(eff.title).toContain("reasoning.effort");
  });

  test("chat completions: top-level reasoning_effort", () => {
    expect(extractEffort({ reasoning_effort: "low" }).v).toBe("low");
  });

  test("null when reasoning isn't requested", () => {
    expect(extractEffort({ model: "claude-haiku-4-5" })).toBeNull();
    expect(extractEffort({ thinking: { type: "disabled" } })).toBeNull();
    expect(extractEffort({ reasoning: { summary: "concise" } })).toBeNull();
    expect(extractEffort(null)).toBeNull();
    expect(extractEffort("nope")).toBeNull();
  });
});

describe("summarizePair", () => {
  test("messages: effort chip follows the model chip", () => {
    const pair = streamingPair();
    (pair.request.body as any).thinking = { type: "adaptive" };
    (pair.request.body as any).output_config = { effort: "high" };
    const chips = summarizePair(pair, "messages");
    expect(chips[0].t).toBe("opus-4-6");
    expect(chips[1].t).toBe("effort high");
    expect(chips[1].title).toContain("output_config.effort");
  });

  test("messages: truncated response gets a 'stopped early' warn chip", () => {
    const pair = streamingPair();
    (pair.response as any).truncated = true;
    const chips = summarizePair(pair, "messages");
    const stopped = chips.find((c: any) => c.t === "stopped early");
    expect(stopped).toBeTruthy();
    expect(stopped.c).toBe("warn");
    expect(stopped.title).toContain("keeps capturing after a CLI abort");
    // absent when the stream completed normally
    expect(summarizePair(streamingPair(), "messages").some((c: any) => c.t === "stopped early")).toBe(false);
  });

  test("messages: model, tokens, cache, thinking", () => {
    const chips = summarizePair(streamingPair(), "messages");
    const texts = chips.map((c: any) => c.t);
    // One compact cache chip: read + hit% + write. Last chip is the cost.
    expect(texts.slice(0, 5)).toEqual(["opus-4-6", "in 3", "out 76", "cache ↓19.6k 50% ↑19.6k (19.6k 1h)", "think 44"]);
    expect(texts[5]).toMatch(/^\$0\./);
    expect(chips[5].title).toContain("estimated");
    // a hit covering only 50% of the prompt is a WARNING, not a win —
    // half the context was re-billed at full input price
    expect(chips[3].c).toBe("warn");
    expect(chips[3].title).toContain("low hit rate");
    expect(chips[3].title).toContain("read from cache");
    expect(chips[3].title).toContain("written to cache");
  });

  test("messages: ttft chip appears when the pair carries firstTokenMs", () => {
    const pair = streamingPair();
    (pair.response as any).firstTokenMs = 1234;
    const chips = summarizePair(pair, "messages");
    const ttft = chips.find((c: any) => c.t.startsWith("ttft "));
    expect(ttft.t).toBe("ttft 1.23s");
    expect(ttft.title).toContain("25% of 5.00s"); // 1234ms of the 5000ms pair
  });

  test("messages: no ttft chip on pre-0.15 pairs or byte-only timing", () => {
    expect(summarizePair(streamingPair(), "messages").some((c: any) => c.t.startsWith("ttft"))).toBe(false);
    const byteOnly = streamingPair();
    (byteOnly.response as any).firstByteMs = 90;
    expect(summarizePair(byteOnly, "messages").some((c: any) => c.t.startsWith("ttft"))).toBe(false);
  });

  test("tunnel meta rows get a byte-count chip", () => {
    const pair = {
      request: { url: "https://registry.npmjs.org/", method: "CONNECT" },
      response: { status: 200, body: { cctrace: "opaque TLS tunnel", tunneled: true, bytesUp: 1400, bytesDown: 54700000 } },
    };
    const chips = summarizePair(pair, "external");
    expect(chips[0].t).toBe("tunnel ↑1.4KB ↓52.2MB");
    expect(chips[0].title).toContain("payload not captured");
  });

  test("messages: error chip short-circuits token chips", () => {
    const pair = streamingPair({
      response: { timestamp: 0, status: 529, headers: {}, body: { type: "error", error: { type: "overloaded_error" } } },
    });
    const chips = summarizePair(pair, "messages");
    expect(chips.map((c: any) => c.t)).toEqual(["opus-4-6", "overloaded_error"]);
    expect(chips[1].c).toBe("err");
  });

  test("tokens: counted result", () => {
    const pair = {
      request: { url: "https://api.anthropic.com/v1/messages/count_tokens?beta=true", body: { model: "claude-opus-4-6" } },
      response: { status: 200, body: { input_tokens: 539 } },
    };
    expect(summarizePair(pair, "tokens").map((c: any) => c.t)).toEqual(["opus-4-6", "= 539 tok"]);
  });

  test("usage: window percentages", () => {
    const pair = {
      request: { url: "https://api.anthropic.com/api/oauth/usage" },
      response: {
        status: 200,
        body: {
          limits: [
            { kind: "session", percent: 11, severity: "normal" },
            { kind: "weekly_all", percent: 80, severity: "normal" },
            { kind: "weekly_scoped", percent: 95, severity: "normal", scope: { model: { display_name: "Fable" } } },
          ],
        },
      },
    };
    const chips = summarizePair(pair, "usage");
    expect(chips.map((c: any) => c.t)).toEqual(["5h 11%", "7d 80%", "Fable 95%"]);
    expect(chips.map((c: any) => c.c)).toEqual(["", "warn", "err"]);
  });

  test("telemetry: event count", () => {
    const pair = {
      request: { url: "https://api.anthropic.com/api/event_logging/v2/batch", body: { events: [{}, {}, {}] } },
      response: { status: 200, headers: {}, body: {} },
    };
    expect(summarizePair(pair, "telemetry").map((c: any) => c.t)).toEqual(["3 events"]);
  });

  test("bootstrap: model from query param", () => {
    const pair = {
      request: { url: "https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-fable-5" },
      response: { status: 200, headers: {}, body: {} },
    };
    expect(summarizePair(pair, "bootstrap").map((c: any) => c.t)).toEqual(["fable-5"]);
  });

  test("no response / http error fallback", () => {
    expect(summarizePair({ request: { url: "x" }, response: null }, "other")[0]).toEqual({ t: "no response", c: "err" });
    const chips = summarizePair({ request: { url: "x" }, response: { status: 403, body: {} } }, "other");
    expect(chips).toEqual([{ t: "HTTP 403", c: "err" }]);
  });
});

describe("extractSessionId", () => {
  const UUID = "70683b4f-e779-414c-bcdb-9b22361a0232";
  const withUserId = (user_id: unknown) => ({
    request: { url: "https://api.anthropic.com/v1/messages", body: { metadata: { user_id } } },
    response: null,
  });

  test("current JSON user_id format", () => {
    const uid = JSON.stringify({ device_id: "d".repeat(64), account_uuid: "ac09a023-ee4c-4b26-bd92-683d452a3b79", session_id: UUID });
    expect(extractSessionId(withUserId(uid))).toBe(UUID);
  });

  test("legacy underscored format", () => {
    expect(extractSessionId(withUserId(`user_abc123_account__session_${UUID}`))).toBe(UUID);
  });

  test("missing metadata / user_id / malformed", () => {
    expect(extractSessionId({ request: { body: {} } })).toBe("");
    expect(extractSessionId(withUserId(undefined))).toBe("");
    expect(extractSessionId(withUserId(42))).toBe("");
    expect(extractSessionId(withUserId("no session here"))).toBe("");
    expect(extractSessionId(withUserId('{"broken json'))).toBe("");
    expect(extractSessionId(null)).toBe("");
  });
});
