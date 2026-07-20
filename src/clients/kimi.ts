import { join } from "path";
import type { ClientPlugin } from "./types";

// Kimi Code CLI (Moonshot AI). Wire facts from real traces against the live
// coding-plan endpoint (2026-07-20): model calls are OpenAI CHAT COMPLETIONS
// at api.kimi.com/coding/v1/chat/completions — a third wire sub-shape adapted
// into the Responses object model in src/dialects/openai.ts (openaiInput +
// the chat branch of openaiCompleted). No conversation-id HEADER on the wire
// (x-trace-id is per-request), so threads reconstruct from the first-user-text
// signature — but K3 sends the session id in the BODY: prompt_cache_key
// ("session_<uuid>"), stable across subagent threads, auto-compaction, and
// --resume across processes (devlog 2026-07-20). It is SESSION identity, not
// a thread key: subagents share it. The coding host also serves
// the web search/fetch tools (/coding/v1/search, /coding/v1/fetch), the usage
// meter (/coding/v1/usages), and models bootstrap (/coding/v1/models).
export const kimi: ClientPlugin = {
  name: "kimi",
  bin: "kimi",
  candidates: (home) => [
    join(home, ".local", "bin", "kimi"),
    join(home, ".npm-global", "bin", "kimi"),
    join(home, ".kimi", "bin", "kimi"),
    "/opt/homebrew/bin/kimi",
    "/usr/local/bin/kimi",
  ],
  installHint:
    "Install Kimi Code (curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash) or use --client-path",
  wire: {
    dialect: "openai",
    firstPartyHosts: ["kimi.com", "moonshot.ai", "moonshot.cn"],
    hostCategories: [
      ["auth.kimi.com/", "oauth"],
      ["api.kimi.com/coding/v1/usages", "usage"],
      ["api.kimi.com/coding/v1/models", "bootstrap"],
      ["api.kimi.com/coding/v1/feedback", "telemetry"],
      ["telemetry-logs.kimi.com/", "telemetry"],
      ["cdn.kimi.com/", "bootstrap"],
      ["code.kimi.com/kimi-code", "bootstrap"],
    ],
    sessionHeader: "", // no session header — the id rides in the body instead
    sessionBodyField: "prompt_cache_key", // "session_<uuid>", durable across compaction + resume
    threadHeader: "", // no conversation header — threads key on first-user-text sig
  },
};
