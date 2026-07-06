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
