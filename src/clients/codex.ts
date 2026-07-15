import { join } from "path";
import type { ClientPlugin } from "./types";

// OpenAI Codex CLI. Wire facts from real traces (2026-07-14, see
// docs/devlog/2026-07-14-multi-client-plugin-design.org): model calls are
// OpenAI Responses at chatgpt.com/backend-api/codex/responses (matched by
// the shape-first path-tail rule, not pinned here); session-id and thread-id
// headers are equal and stable per conversation; prewarm probes identify
// via request_kind in the x-codex-turn-metadata JSON header.
export const codex: ClientPlugin = {
  name: "codex",
  bin: "codex",
  candidates: (home) => [
    join(home, ".npm-global", "bin", "codex"),
    join(home, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ],
  installHint: "Install the OpenAI Codex CLI (npm i -g @openai/codex) or use --client-path",
  wire: {
    dialect: "openai",
    // oaiusercontent.com is OpenAI's file CDN — first-party, not External.
    firstPartyHosts: ["chatgpt.com", "openai.com", "oaiusercontent.com"],
    hostCategories: [
      ["auth.openai.com/", "oauth"],
      ["chatgpt.com/backend-api/wham", "usage"],
      ["chatgpt.com/backend-api/accounts", "oauth"],
      ["chatgpt.com/backend-api/ps/mcp", "mcp"],
      ["chatgpt.com/backend-api/connectors", "mcp"],
      ["chatgpt.com/backend-api/codex/analytics-events", "telemetry"],
      ["ab.chatgpt.com/otlp", "telemetry"],
      ["chatgpt.com/backend-api/codex/models", "bootstrap"],
      ["chatgpt.com/backend-api/ps/plugins", "bootstrap"],
      ["chatgpt.com/backend-api/plugins", "bootstrap"],
    ],
    sessionHeader: "session-id",
    threadHeader: "thread-id",
  },
};
