import { join } from "path";
import { existsSync, readFileSync } from "fs";
import type { ClientPlugin } from "./types";

/**
 * Hostnames from every `"baseURL": "..."` in an opencode config file
 * (opencode.json / opencode.jsonc — provider.*.options.baseURL routes a
 * custom provider's model calls to a host the include-list would otherwise
 * tunnel opaque). Same argument as codexProviderHosts: baseURL is one
 * well-specified string key, not worth a JSONC parser — a plain scan can't
 * be broken by comments or trailing commas, and enrolling a baseURL the
 * config merely mentions is harmless (no traffic, no capture). Exported
 * for tests.
 */
export function opencodeConfigHosts(json: string): string[] {
  const hosts = new Set<string>();
  for (const m of json.matchAll(/"baseURL"\s*:\s*"([^"]+)"/g)) {
    try {
      hosts.add(new URL(m[1]!).hostname.toLowerCase());
    } catch {
      // not a URL — nothing to enroll
    }
  }
  return [...hosts];
}

// opencode (opencode.ai, anomalyco/opencode). Wire facts from the shipped
// v1.18.x binary + live traces (issue #89, devlog 2026-08-07): a
// MULTI-PROVIDER client — models come from a models.dev-style catalog and
// calls fan out to whichever provider the chosen model routes to (the
// opencode zen gateway at opencode.ai/zen, BYO Anthropic/OpenAI keys,
// copilot, openrouter, ...). There is no single model-call dialect:
// wireDialect() picks anthropic vs openai PER PAIR from the wire shape, so
// one session's Anthropic- and OpenAI-shaped calls both reconstruct; the
// client-level dialect below only steers categorizeUrl's fallback (unpinned
// first-party -> other, foreign hosts -> external — never the Anthropic
// keyword taxonomy). Sessions live in local sqlite (~/.local/share/opencode/
// opencode.db) and no session id was observed on provider calls, so threads
// key on first-user-text and cross-run continuity stays per-run for now.
// Bun-compiled binary, same runtime as Claude Code: HTTPS_PROXY +
// NODE_EXTRA_CA_CERTS just work.
export const opencode: ClientPlugin = {
  name: "opencode",
  bin: "opencode",
  candidates: (home) => [
    join(home, ".opencode", "bin", "opencode"),
    join(home, ".npm-global", "bin", "opencode"),
    join(home, ".local", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ],
  installHint:
    "Install opencode (npm i -g opencode-ai, or curl -fsSL https://opencode.ai/install | bash) or use --client-path",
  wire: {
    dialect: "openai", // categorize fallback only — model calls pick their dialect per pair (see above)
    // One suffix covers the zen gateway (opencode.ai/zen) and every
    // first-party subdomain: console. (device oauth, account), models.
    // (catalog), api. (github app), app./dev. (workspace sync).
    firstPartyHosts: ["opencode.ai"],
    hostCategories: [
      ["console.opencode.ai/auth", "oauth"], // device-code flow: /auth/device/{code,token}
      ["opencode.ai/auth", "oauth"],
      ["models.dev/", "bootstrap"], // provider/model catalog (OPENCODE_MODELS_URL default)
      ["models.opencode.ai/", "bootstrap"], // first-party catalog mirror
      // Claude Pro/Max login: the anthropic provider refreshes its oauth
      // token here — without the pin it would read as External.
      ["console.anthropic.com/v1/oauth", "oauth"],
    ],
    // Zen-gateway model calls carry the sqlite session id on the wire
    // (live trace 2026-08-07: x-opencode-session: ses_..., both the
    // /zen/v1/messages and /zen/v1/responses mounts), so cross-run
    // continuity works for gateway traffic. BYO-provider calls that omit
    // the header fall back to first-user-text threading.
    sessionHeader: "x-opencode-session",
    threadHeader: "", // x-opencode-request is per-message, not a thread id
    // The popular catalog providers, enrolled unconditionally: each is a
    // single-purpose LLM API host, so decrypting it can only ever capture
    // model traffic — exactly what a trace is for. Deliberately absent:
    // shared/multi-purpose hosts (github.com mints the copilot token,
    // googleapis.com serves everything Google) — those stay opaque tunnels;
    // only the dedicated model subdomains are listed. Exotic providers:
    // configHosts below + --intercept-host.
    providerHosts: [
      "api.anthropic.com",
      "api.openai.com",
      "openrouter.ai",
      "githubcopilot.com", // api. + business/enterprise variants via suffix match
      "generativelanguage.googleapis.com",
      "api.x.ai",
      "api.deepseek.com",
      "api.groq.com",
      "api.mistral.ai",
    ],
  },
  // Custom provider baseURLs from every opencode config the client itself
  // would read: $OPENCODE_CONFIG, the global config dir, and the project
  // config in cwd. Fail-soft — an absent or broken file enrolls nothing.
  configHosts: (env) => {
    const dirs = [
      env.OPENCODE_CONFIG || "",
      ...["opencode.json", "opencode.jsonc"].flatMap((f) => [
        join(env.XDG_CONFIG_HOME || join(env.HOME || "", ".config"), "opencode", f),
        join(process.cwd(), f),
      ]),
    ];
    const hosts = new Set<string>();
    for (const path of dirs) {
      try {
        if (!path || !existsSync(path)) continue;
        for (const h of opencodeConfigHosts(readFileSync(path, "utf8"))) hosts.add(h);
      } catch {
        // unreadable config — nothing to enroll
      }
    }
    return [...hosts];
  },
};
