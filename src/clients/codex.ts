import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { ClientPlugin } from "./types";

/**
 * Hostnames from every `[model_providers.*] base_url` in a codex
 * config.toml. A custom provider routes model calls to a host the
 * include-list would otherwise tunnel opaque — the trace would show an
 * empty Messages view. Line-based on purpose: base_url is one
 * well-specified string key, not worth a TOML dependency (the devlog's
 * argument against config sniffing was aimed at open-ended files like
 * .mcp.json; this reads a single key, fail-soft). Exported for tests.
 */
export function codexProviderHosts(toml: string): string[] {
  const hosts = new Set<string>();
  let inProvider = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      inProvider = sec[1]!.trim().lastIndexOf("model_providers.", 0) === 0;
      continue;
    }
    if (!inProvider) continue;
    const m = line.match(/^base_url\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (!m) continue;
    try {
      hosts.add(new URL(m[1] ?? m[2] ?? "").hostname.toLowerCase());
    } catch {
      // not a URL — nothing to enroll
    }
  }
  return [...hosts];
}

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
  // Every provider's base_url enrolls (not just the active model_provider):
  // -c model_provider=X switches at launch, and enrolling the user's own
  // provider endpoints can't over-capture. The env-var path
  // (OPENAI_BASE_URL/OPENAI_API_BASE) is buildInterceptSet's own job.
  configHosts: (env) => {
    const path = join(env.CODEX_HOME || join(env.HOME || "", ".codex"), "config.toml");
    try {
      return existsSync(path) ? codexProviderHosts(readFileSync(path, "utf8")) : [];
    } catch {
      return [];
    }
  },
};
