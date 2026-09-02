export interface CatMeta {
  id: string;
  label: string;
  color: string;
}

/**
 * Category inks. These are DATA colors: one fixed hex per category, the
 * same in both themes (a wire fact is not a chrome decision), mid-tone so
 * each reads on paper and on near-black. They are the six hues the Claude
 * Design System already ships for git status — green, blue, violet, gold,
 * orange, gray, plus its aqua — so a cctrace category and a Claude Code
 * diff badge are the same inks. The model family gets the blues, tools the
 * aqua, identity the violet, money the gold, foreign hosts the orange,
 * noise the grays.
 */
export const CATEGORIES: CatMeta[] = [
  { id: "messages", label: "Messages", color: "#4a8fdb" },
  { id: "tokens", label: "Count Tokens", color: "#86b6ef" },
  { id: "usage", label: "Usage/Credits", color: "#c39b2b" },
  { id: "oauth", label: "OAuth", color: "#8e6bd9" },
  { id: "mcp", label: "MCP", color: "#1baf7a" },
  { id: "bootstrap", label: "Bootstrap", color: "#3f9d8f" },
  { id: "telemetry", label: "Telemetry", color: "#737373" },
  { id: "external", label: "External", color: "#c5621b" },
  { id: "other", label: "Other", color: "#8a8a83" },
];

/**
 * The model-call wire shapes, one predicate: Anthropic /v1/messages (incl.
 * count_tokens) and the OpenAI path tails on ANY host/prefix. The mitm
 * --messages-only filter uses this so it can never drop a pair
 * categorizeUrl would have called "messages" — a custom provider mounting
 * at the root ({base}/responses) was exactly that bug.
 */
export function isModelCallPath(path: string): boolean {
  const p = path.toLowerCase();
  return p.includes("/v1/messages") || /\/(responses|chat\/completions)($|\?)/.test(p);
}

// Pure, self-contained: a request URL in, a category id out. This function is
// ALSO inlined into the live web UI via toString(), so it must not reference
// anything outside its own body — per-client wire knowledge arrives as the
// `wire` argument (the JSON-safe tables from src/clients, embedded into the
// page as a constant). Pairs without a client label (pre-0.13 traces)
// categorize exactly as before.
export function categorizeUrl(url: string, client?: string, wire?: any): string {
  let path: string;
  let host: string;
  try {
    const u = new URL(url);
    path = (u.pathname + u.search).toLowerCase();
    host = u.hostname.toLowerCase();
  } catch {
    path = String(url).toLowerCase();
    host = "";
  }
  // Wire shape first, host second: a model API endpoint is what it is on ANY
  // host — third-party Anthropic-compatible providers (ANTHROPIC_BASE_URL
  // gateways, moonshot/deepseek-style compat endpoints) and OpenAI-style APIs
  // (codex/grok) must not drown in the External bucket.
  if (path.includes("/v1/messages/count_tokens")) return "tokens";
  if (path.includes("/v1/messages")) return "messages";
  // OpenAI wire shapes: custom providers mount them under arbitrary prefixes
  // (api.openai.com/v1/responses, chatgpt.com/backend-api/codex/responses,
  // relay.example/responses), so match the path tail, not a /v1/ prefix.
  // Keep in lockstep with isModelCallPath below (regression-tested) — this
  // body can't call it: categorizeUrl is inlined into the page via
  // toString() and must stay self-contained.
  if (/\/(responses|chat\/completions)($|\?)/.test(path)) return "messages";
  // Client wire table: explicit host/path pins first (these may pin
  // third-party analytics hosts like mixpanel to telemetry), then the
  // first-party check. Non-anthropic dialects stop at "other" for unpinned
  // first-party traffic — the keyword taxonomy below is Anthropic's own and
  // its keywords are too generic to trust on foreign APIs.
  const w = wire && client ? wire[client] : null;
  if (w && host) {
    const hp = host + path;
    for (const pin of w.hostCategories || []) {
      if (hp.lastIndexOf(pin[0], 0) === 0) return pin[1];
    }
    let firstParty = false;
    for (const h of w.firstPartyHosts || []) {
      if (host === h || host.endsWith("." + h)) {
        firstParty = true;
        break;
      }
    }
    if (firstParty && w.dialect !== "anthropic") return "other";
    if (!firstParty && w.dialect !== "anthropic") return "external";
  }
  // The remaining taxonomy is Anthropic's own — its keywords are far too
  // broad for foreign hosts (any URL containing "logging" or "cost" would
  // match), so everything else off-domain is honestly External.
  if (host && !host.endsWith("anthropic.com") && !host.endsWith("claude.ai") && !host.endsWith("claude.com")) return "external";
  if (["usage", "credit", "prepaid", "overage", "spend", "cost"].some((s) => path.includes(s))) return "usage";
  if (path.includes("oauth") || path.includes("account/settings") || path.includes("/roles") || path.includes("/profile")) return "oauth";
  if (path.includes("mcp")) return "mcp";
  if (path.includes("claude_cli") || path.includes("claude_code") || path.includes("bootstrap") || path.includes("/v1/code/")) return "bootstrap";
  if (path.includes("event_logging") || path.includes("/eval") || path.includes("statsig") || path.includes("logging")) return "telemetry";
  return "other";
}
