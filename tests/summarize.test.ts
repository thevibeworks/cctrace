import { describe, test, expect } from "bun:test";
import {
  parseSse,
  fmtCompact,
  shortModel,
  extractMessageInfo,
  extractSessionId,
  extractTokenCount,
  extractUsageInfo,
  assembleAssistant,
  summarizePair,
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

describe("summarizePair", () => {
  test("messages: model, tokens, cache, thinking", () => {
    const chips = summarizePair(streamingPair(), "messages");
    const texts = chips.map((c: any) => c.t);
    expect(texts).toEqual(["opus-4-6", "in 3", "out 76", "cache read 19.6k (50%)", "cache write 19.6k", "think 44"]);
    expect(chips[3].c).toBe("ok");
    expect(chips[4].c).toBe("warn");
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
