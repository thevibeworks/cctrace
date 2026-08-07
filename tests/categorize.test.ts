import { describe, test, expect } from "bun:test";
import { categorizeUrl, CATEGORIES, isModelCallPath } from "../src/categorize";
import { wireTables } from "../src/clients";

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

// Client wire tables (src/clients): a labeled pair gets its client's host
// pins + first-party taxonomy. Endpoints below are the real traffic from the
// 2026-07-14 example traces (see the devlog entry of that date).
describe("categorizeUrl — client-scoped wire tables", () => {
  const WIRE = wireTables();
  const cat = (url: string, client?: string) => categorizeUrl(url, client, WIRE);

  const codexCases: Array<[string, string]> = [
    ["https://chatgpt.com/backend-api/codex/responses", "messages"],
    ["https://auth.openai.com/api/accounts/deviceauth/token", "oauth"],
    ["https://chatgpt.com/backend-api/accounts/abc/settings", "oauth"],
    ["https://chatgpt.com/backend-api/wham/usage", "usage"],
    ["https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", "usage"],
    ["https://chatgpt.com/backend-api/ps/mcp", "mcp"],
    ["https://chatgpt.com/backend-api/connectors/directory/list", "mcp"],
    ["https://chatgpt.com/backend-api/codex/analytics-events/events", "telemetry"],
    ["https://ab.chatgpt.com/otlp/v1/metrics", "telemetry"],
    ["https://chatgpt.com/backend-api/codex/models", "bootstrap"],
    ["https://chatgpt.com/backend-api/ps/plugins/installed", "bootstrap"],
    ["https://chatgpt.com/backend-api/plugins/featured", "bootstrap"],
    // first-party but unpinned: honestly "other", never the Anthropic keywords
    ["https://chatgpt.com/backend-api/some/new/thing", "other"],
    ["https://sdmntprnorthcentralus.oaiusercontent.com/files/x/raw", "other"],
    // genuinely foreign stays External
    ["https://github.com/openai/plugins.git/info/refs", "external"],
    ["https://registry.npmjs.org/@openai%2fcodex", "external"],
    ["https://pypi.org/simple/pyyaml/", "external"],
  ];
  for (const [url, expected] of codexCases) {
    test(`codex: ${url.replace(/^https:\/\//, "")} -> ${expected}`, () => {
      expect(cat(url, "codex")).toBe(expected);
    });
  }

  const grokCases: Array<[string, string]> = [
    ["https://cli-chat-proxy.grok.com/v1/responses?stream=true", "messages"],
    ["https://auth.x.ai/oauth2/token", "oauth"],
    ["https://cli-chat-proxy.grok.com/v1/user", "oauth"],
    ["https://cli-chat-proxy.grok.com/v1/billing", "usage"],
    // third-party analytics the client calls pin to telemetry (purgeable)
    ["https://api.mixpanel.com/track", "telemetry"],
    ["https://grok.com/_data/v1/events", "telemetry"],
    ["https://cli-chat-proxy.grok.com/v1/traces", "telemetry"],
    ["https://cli-chat-proxy.grok.com/v1/sessions/abc/signals", "telemetry"],
    ["https://cli-chat-proxy.grok.com/v1/mcp/tools/list", "mcp"],
    ["https://cli-chat-proxy.grok.com/v1/models-v2", "bootstrap"],
    ["https://cli-chat-proxy.grok.com/v1/settings", "bootstrap"],
    ["https://cli-chat-proxy.grok.com/v1/login-config", "bootstrap"],
    ["https://x.ai/cli/changelogs/0.2.101.external.md", "bootstrap"],
    ["https://registry.npmjs.org/@xai-official%2fgrok", "external"],
  ];
  for (const [url, expected] of grokCases) {
    test(`grok: ${url.replace(/^https:\/\//, "")} -> ${expected}`, () => {
      expect(cat(url, "grok")).toBe(expected);
    });
  }

  // opencode (#89) is multi-provider: model calls categorize by wire shape
  // on WHATEVER host the catalog routed to — Anthropic- and OpenAI-shaped
  // calls in the same session — while opencode's own infra pins/falls
  // through like any other non-anthropic client.
  const opencodeCases: Array<[string, string]> = [
    ["https://opencode.ai/zen/v1/messages?beta=true", "messages"], // zen gateway, anthropic-shaped
    ["https://opencode.ai/zen/v1/chat/completions", "messages"], // zen gateway, openai-shaped
    ["https://api.anthropic.com/v1/messages", "messages"], // BYO Anthropic key
    ["https://api.githubcopilot.com/chat/completions", "messages"], // copilot provider
    ["https://openrouter.ai/api/v1/chat/completions", "messages"],
    ["https://console.opencode.ai/auth/device/code", "oauth"],
    ["https://console.opencode.ai/auth/device/token", "oauth"],
    ["https://console.anthropic.com/v1/oauth/token", "oauth"], // Claude Pro/Max refresh
    ["https://models.dev/api.json", "bootstrap"], // provider/model catalog
    ["https://models.opencode.ai/api.json", "bootstrap"],
    // first-party but unpinned: honestly "other", never the Anthropic keywords
    ["https://api.opencode.ai/get_github_app_installation", "other"],
    ["https://opencode.ai/config.json", "other"],
    // provider infra that is NOT a model call stays external — the taxonomy
    // has no honest first-party category for someone else's endpoints
    ["https://api.githubcopilot.com/models", "external"],
    ["https://api.github.com/copilot_internal/v2/token", "external"],
    ["https://registry.npmjs.org/opencode-ai", "external"],
  ];
  for (const [url, expected] of opencodeCases) {
    test(`opencode: ${url.replace(/^https:\/\//, "")} -> ${expected}`, () => {
      expect(cat(url, "opencode")).toBe(expected);
    });
  }

  test("claude wire falls through to the Anthropic keyword taxonomy", () => {
    expect(cat("https://api.anthropic.com/api/oauth/usage", "claude")).toBe("usage");
    expect(cat("https://api.anthropic.com/api/event_logging/v2/batch", "claude")).toBe("telemetry");
    expect(cat("https://github.com/foo/bar", "claude")).toBe("external");
  });

  test("every pinned category id is a real category", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    for (const w of Object.values(WIRE)) {
      for (const [, catId] of w.hostCategories) expect(ids.has(catId)).toBe(true);
    }
  });

  // FROZEN by the goal contract: pairs without a client label (pre-0.13
  // traces) must categorize byte-identically to the client-less call.
  test("an unknown or absent client changes nothing", () => {
    const urls = [
      "https://api.anthropic.com/api/oauth/usage",
      "https://api.mixpanel.com/track",
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/codex/responses",
      "https://github.com/foo/bar",
    ];
    for (const u of urls) {
      expect(categorizeUrl(u, undefined, WIRE)).toBe(categorizeUrl(u));
      expect(categorizeUrl(u, "some-future-client", WIRE)).toBe(categorizeUrl(u));
    }
  });
});

describe("isModelCallPath — the --messages-only predicate", () => {
  const MODEL_CALLS = [
    "/v1/messages",
    "/v1/messages?beta=true",
    "/v1/messages/count_tokens",
    "/responses", // custom provider mounted at the root (codex base_url)
    "/backend-api/codex/responses",
    "/coding/v1/chat/completions",
    "/v1/chat/completions",
    "/openai/v1/responses?x=1",
  ];
  const NOT_MODEL_CALLS = ["/v1/responses/stream", "/api/oauth/token", "/backend-api/codex/models", "/otlp/v1/logs"];

  test("keeps every model-call shape, on any host prefix", () => {
    for (const p of MODEL_CALLS) expect(isModelCallPath(p)).toBe(true);
    for (const p of NOT_MODEL_CALLS) expect(isModelCallPath(p)).toBe(false);
  });

  test("lockstep with categorizeUrl: whatever categorize calls messages/tokens, the filter keeps", () => {
    for (const p of [...MODEL_CALLS, ...NOT_MODEL_CALLS]) {
      const cat = categorizeUrl("https://any-host.example" + p);
      if (cat === "messages" || cat === "tokens") {
        expect(isModelCallPath(p)).toBe(true);
      }
    }
  });
});
