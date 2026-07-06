import { describe, test, expect } from "bun:test";
import { redactHeaders, redactBody, redactUrl, redactPair } from "../src/redact";
import type { TracePair } from "../src/types";

describe("redactHeaders", () => {
  test("masks authorization with a first-10/last-4 preview", () => {
    const out = redactHeaders({ authorization: "Bearer sk-ant-oat01-SECRETMIDDLE-TAIL" });
    expect(out.authorization).not.toContain("SECRETMIDDLE");
    expect(out.authorization).toContain("...");
  });

  test("fully masks short secret values", () => {
    const out = redactHeaders({ "x-api-key": "short" });
    expect(out["x-api-key"]).toBe("[REDACTED]");
  });

  test("leaves ordinary headers intact", () => {
    const out = redactHeaders({ "content-type": "application/json" });
    expect(out["content-type"]).toBe("application/json");
  });
});

describe("redactBody (object)", () => {
  test("masks OAuth token fields", () => {
    const out = redactBody({ access_token: "at-SECRET", refresh_token: "rt-SECRET", token_type: "Bearer" }) as Record<string, unknown>;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refresh_token).toBe("[REDACTED]");
    expect(out.token_type).toBe("Bearer"); // not a credential field
  });

  test("masks nested and client_secret", () => {
    const out = redactBody({ data: { client_secret: "cs-SECRET", nested: { api_key: "ak-SECRET" } } }) as any;
    expect(out.data.client_secret).toBe("[REDACTED]");
    expect(out.data.nested.api_key).toBe("[REDACTED]");
  });

  test("does NOT touch /v1/messages content (keys are role/content/system)", () => {
    const body = { model: "claude", system: "you are helpful", messages: [{ role: "user", content: "write code that reads a secret" }] };
    const out = redactBody(body) as any;
    expect(out.messages[0].content).toBe("write code that reads a secret");
    expect(out.system).toBe("you are helpful");
  });
});

describe("redactBody (form-encoded string)", () => {
  test("masks refresh_token in a token-exchange body", () => {
    const out = redactBody("grant_type=refresh_token&refresh_token=rt-SECRET-VALUE&client_id=abc") as string;
    expect(out).not.toContain("rt-SECRET-VALUE");
    expect(out).toContain("client_id=abc");
  });

  test("leaves ordinary text bodies intact", () => {
    const out = redactBody("this is a plain error message, nothing to mask") as string;
    expect(out).toBe("this is a plain error message, nothing to mask");
  });
});

describe("redactUrl", () => {
  test("masks OAuth ?code= in the query string", () => {
    const out = redactUrl("https://api.anthropic.com/oauth/callback?code=AUTHCODE-SECRET&state=xyz");
    expect(out).not.toContain("AUTHCODE-SECRET");
    expect(out).toContain("state=xyz");
  });

  test("leaves credential-free URLs unchanged", () => {
    const url = "https://api.anthropic.com/v1/messages";
    expect(redactUrl(url)).toBe(url);
  });
});

describe("redactPair (end-to-end, the sink guarantee)", () => {
  test("an OAuth token-refresh pair serializes with no live token anywhere", () => {
    const pair: TracePair = {
      id: "x",
      request: {
        timestamp: 1,
        method: "POST",
        url: "https://api.anthropic.com/v1/oauth/token?code=AUTHCODE_LEAK",
        headers: { authorization: "Bearer sk-ant-oat01-HEADER_LEAK-tail", "content-type": "application/json" },
        body: { grant_type: "refresh_token", refresh_token: "REFRESH_LEAK" },
      },
      response: {
        timestamp: 2,
        status: 200,
        headers: { "set-cookie": "session=COOKIE_LEAK" },
        body: { access_token: "ACCESS_LEAK", refresh_token: "REFRESH2_LEAK", expires_in: 3600 },
      },
      duration: 5,
      loggedAt: "now",
    };
    const serialized = JSON.stringify(redactPair(pair));
    for (const leak of ["AUTHCODE_LEAK", "REFRESH_LEAK", "ACCESS_LEAK", "REFRESH2_LEAK", "COOKIE_LEAK", "HEADER_LEAK"]) {
      expect(serialized).not.toContain(leak);
    }
    // Non-secret metadata survives.
    expect(serialized).toContain("3600");
  });

  test("does not mutate the input pair", () => {
    const pair: TracePair = {
      id: "x",
      request: { timestamp: 1, method: "POST", url: "u", headers: { authorization: "Bearer LONGSECRETVALUE123" }, body: { refresh_token: "RT" } },
      response: null,
      duration: 1,
      loggedAt: "now",
    };
    redactPair(pair);
    expect(pair.request.headers.authorization).toBe("Bearer LONGSECRETVALUE123");
    expect((pair.request.body as any).refresh_token).toBe("RT");
  });

  test("a /v1/messages pair keeps its conversation content", () => {
    const pair: TracePair = {
      id: "x",
      request: { timestamp: 1, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: { messages: [{ role: "user", content: "hello" }] } },
      response: { timestamp: 2, status: 200, headers: {}, bodyRaw: "data: {\"type\":\"content_block_delta\"}" },
      duration: 1,
      loggedAt: "now",
    };
    const out = redactPair(pair);
    expect((out.request.body as any).messages[0].content).toBe("hello");
    expect(out.response?.bodyRaw).toContain("content_block_delta");
  });
});
