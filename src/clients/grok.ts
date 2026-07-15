import { join } from "path";
import type { ClientPlugin } from "./types";

// Grok CLI. Wire facts from real traces (2026-07-14): model calls are OpenAI
// Responses at cli-chat-proxy.grok.com/v1/responses; conversations key on the
// x-grok-conv-id header (recap-* conv-ids are harness utilities); mixpanel is
// grok's telemetry sink, pinned so `purge --drop telemetry` sweeps it.
export const grok: ClientPlugin = {
  name: "grok",
  bin: "grok",
  candidates: (home) => [
    join(home, ".local", "bin", "grok"),
    join(home, ".npm-global", "bin", "grok"),
    "/opt/homebrew/bin/grok",
    "/usr/local/bin/grok",
  ],
  installHint: "Install the Grok CLI or use --client-path",
  wire: {
    dialect: "openai",
    firstPartyHosts: ["grok.com", "x.ai"],
    hostCategories: [
      ["auth.x.ai/", "oauth"],
      ["api.mixpanel.com/", "telemetry"],
      ["cli-chat-proxy.grok.com/v1/billing", "usage"],
      ["cli-chat-proxy.grok.com/v1/traces", "telemetry"],
      ["grok.com/_data/v1/events", "telemetry"],
      // sessions/:id/signals + turn-deltas: session state sync, not chat
      ["cli-chat-proxy.grok.com/v1/sessions", "telemetry"],
      ["cli-chat-proxy.grok.com/v1/feedback", "telemetry"],
      ["cli-chat-proxy.grok.com/v1/mcp", "mcp"],
      ["cli-chat-proxy.grok.com/v1/user", "oauth"],
      ["cli-chat-proxy.grok.com/v1/models", "bootstrap"],
      ["cli-chat-proxy.grok.com/v1/settings", "bootstrap"],
      ["cli-chat-proxy.grok.com/v1/login-config", "bootstrap"],
      ["cli-chat-proxy.grok.com/v1/bundle", "bootstrap"],
      ["x.ai/cli/changelogs", "bootstrap"],
    ],
    sessionHeader: "x-grok-session-id",
    threadHeader: "x-grok-conv-id",
  },
};
