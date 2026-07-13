import { describe, test, expect } from "bun:test";
import { categorizeUrl, CATEGORIES } from "../src/categorize";

describe("categorizeUrl — real Claude Code endpoints", () => {
  const cases: Array<[string, string]> = [
    ["https://api.anthropic.com/v1/messages?beta=true", "messages"],
    ["https://api.anthropic.com/api/oauth/usage", "usage"],
    ["https://api.anthropic.com/api/oauth/organizations/x/prepaid/credits", "usage"],
    ["https://api.anthropic.com/api/oauth/organizations/x/overage_spend_limit", "usage"],
    ["https://api.anthropic.com/api/oauth/account/settings", "oauth"],
    ["https://api.anthropic.com/api/oauth/claude_cli/roles", "oauth"],
    ["https://api.anthropic.com/v1/mcp_servers?limit=1000", "mcp"],
    ["https://api.anthropic.com/mcp-registry/v0/servers?version=latest", "mcp"],
    ["https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=sdk-cli", "bootstrap"],
    ["https://api.anthropic.com/api/claude_code_penguin_mode", "bootstrap"],
    ["https://api.anthropic.com/api/event_logging/v2/batch", "telemetry"],
    ["https://api.anthropic.com/api/eval/sdk-abc", "telemetry"],
    ["https://api.anthropic.com/v1/some_unknown_endpoint", "other"],
  ];

  for (const [url, expected] of cases) {
    test(`${url.replace("https://api.anthropic.com", "")} -> ${expected}`, () => {
      expect(categorizeUrl(url)).toBe(expected);
    });
  }

  test("usage is checked before oauth (credits endpoint is a usage subset)", () => {
    expect(categorizeUrl("https://api.anthropic.com/api/oauth/usage")).toBe("usage");
  });

  test("every category id has metadata", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const [, expected] of cases) {
      expect(ids.has(expected)).toBe(true);
    }
  });

  test("malformed url falls back to string match, never throws", () => {
    expect(categorizeUrl("not-a-url-but-has-mcp-in-it")).toBe("mcp");
    expect(categorizeUrl("")).toBe("other");
  });
});

describe("categorizeUrl — shape first, host second (#19)", () => {
  const cases: Array<[string, string]> = [
    // Third-party Anthropic-compatible providers (ANTHROPIC_BASE_URL)
    ["https://api.moonshot.cn/anthropic/v1/messages", "messages"],
    ["https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true", "messages"],
    ["https://gateway.corp.example/v1/messages/count_tokens", "tokens"],
    ["https://api.anthropic.com/v1/messages/count_tokens", "tokens"],
    // OpenAI-style model APIs (codex, grok) are messages-shaped too. Custom
    // providers mount them under arbitrary prefixes, so the path TAIL decides.
    ["https://api.openai.com/v1/responses", "messages"],
    ["https://chatgpt.com/backend-api/codex/responses", "messages"],
    ["https://relay.example/responses", "messages"],
    ["https://cli-chat-proxy.grok.com/v1/responses?stream=true", "messages"],
    ["https://api.x.ai/v1/chat/completions", "messages"],
    // ...but only the tail: a REST resource merely named "responses" isn't one
    ["https://example.com/survey/responses/list", "external"],
    // The Anthropic-only taxonomy must NOT leak onto foreign hosts: its
    // keywords ("logging", "cost", "mcp", ...) are generic substrings.
    ["https://api.moonshot.cn/logging/batch", "external"],
    ["https://example.com/pricing/cost", "external"],
    ["https://registry.npmjs.org/some-mcp-package", "external"],
    ["https://github.com/foo/bar", "external"],
  ];

  for (const [url, expected] of cases) {
    test(`${url} -> ${expected}`, () => {
      expect(categorizeUrl(url)).toBe(expected);
    });
  }
});
