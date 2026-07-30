import { describe, test, expect } from "bun:test";
import { traceSummary, fmtDur } from "../src/report";
import { wireTables } from "../src/clients";

const SID = "dafcee7b-1111-2222-3333-444455556666";

function messagesPair(over: any = {}): any {
  return {
    id: over.id || "p1",
    client: "claude",
    request: {
      url: "https://api.anthropic.com/v1/messages",
      timestamp: 1000,
      body: {
        model: over.model || "claude-fable-5",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ session_id: SID }) },
      },
    },
    response: over.response !== undefined ? over.response : {
      status: over.status || 200,
      timestamp: 2000,
      body: {
        type: "message",
        model: over.model || "claude-fable-5",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 0,
          ...(over.usage || {}),
        },
      },
    },
    ...over.extra,
  };
}

function telemetryPair(id: string): any {
  return {
    id,
    client: "claude",
    request: { url: "https://api.anthropic.com/api/event_logging/batch", timestamp: 1500 },
    response: { status: 200, timestamp: 1600 },
  };
}

describe("fmtDur", () => {
  test("scales seconds, minutes, hours", () => {
    expect(fmtDur(42_000)).toBe("42s");
    expect(fmtDur(33 * 60_000)).toBe("33m");
    expect(fmtDur(125 * 60_000)).toBe("2h 05m");
    expect(fmtDur(0)).toBe("");
  });
});

describe("traceSummary", () => {
  test("the receipt: counts, categories, size, session, tokens, cost", () => {
    const s = traceSummary(
      [messagesPair(), messagesPair({ id: "p2" }), telemetryPair("t1")],
      { wire: wireTables(), sizeBytes: 1024 * 1900, durationMs: 33 * 60_000 },
    );
    expect(s.traced).toBe("Traced 3 pairs in 33m — 2 messages, 1 telemetry — 1.9 MB");
    expect(s.session).toContain("Session dafcee7b");
    expect(s.session).toContain("fable-5");
    expect(s.session).toContain("in 2.0k tok (90% cached)");
    expect(s.session).toContain("out 100");
    expect(s.session).toContain("est $");
    expect(s.errors).toBeUndefined();
  });

  test("a single category skips the redundant breakdown", () => {
    const s = traceSummary([messagesPair()], { wire: wireTables() });
    expect(s.traced).toBe("Traced 1 pair");
  });

  test("failures surface: HTTP status, missing response, in-stream error", () => {
    const s = traceSummary(
      [
        messagesPair(),
        messagesPair({ id: "p2", status: 529 }),
        messagesPair({ id: "p3", response: null }),
      ],
      { wire: wireTables() },
    );
    expect(s.errors).toContain("2 failed requests");
    expect(s.errors).toContain("529");
    expect(s.errors).toContain("no response");
  });

  test("empty run stays quiet", () => {
    const s = traceSummary([], {});
    expect(s.traced).toBe("Traced 0 pairs");
    expect(s.session).toBeUndefined();
    expect(s.errors).toBeUndefined();
  });
});
