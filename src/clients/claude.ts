import { join } from "path";
import type { ClientPlugin } from "./types";

// Claude Code. Discovery keeps its richer path in cli.ts (native/node
// detection, base-url mode, bash-wrapper resolve); the wire table has no
// category pins because categorizeUrl's keyword taxonomy IS the Anthropic
// taxonomy — first-party hosts fall through to it.
export const claude: ClientPlugin = {
  name: "claude",
  bin: "claude",
  candidates: (home) => [
    join(home, ".claude", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    join(home, ".npm-global", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ],
  installHint: "Install Claude Code or use --claude-path",
  wire: {
    dialect: "anthropic",
    firstPartyHosts: ["anthropic.com", "claude.ai", "claude.com"],
    hostCategories: [
      // Claude Code ships its own logs to datadog (~200 reqs/session on real
      // traces) — first-party telemetry on a third-party host. Pinned so it
      // categorizes as telemetry (purge-able) AND stays on the intercept
      // include-list instead of degrading to a meta-only tunnel.
      ["http-intake.logs.us5.datadoghq.com/", "telemetry"],
    ],
    sessionHeader: "", // session id lives in request.body.metadata.user_id
    threadHeader: "x-claude-code-agent-id",
  },
};
