export interface CatMeta {
  id: string;
  label: string;
  color: string;
}

export const CATEGORIES: CatMeta[] = [
  { id: "messages", label: "Messages", color: "#3fb950" },
  { id: "tokens", label: "Count Tokens", color: "#56d364" },
  { id: "usage", label: "Usage/Credits", color: "#d29922" },
  { id: "oauth", label: "OAuth", color: "#a371f7" },
  { id: "mcp", label: "MCP", color: "#39c5cf" },
  { id: "bootstrap", label: "Bootstrap", color: "#2f81a3" },
  { id: "telemetry", label: "Telemetry", color: "#6e7681" },
  { id: "external", label: "External", color: "#f0883e" },
  { id: "other", label: "Other", color: "#8b949e" },
];

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
