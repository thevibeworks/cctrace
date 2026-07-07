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
// anything outside its own body.
export function categorizeUrl(url: string): string {
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
  if (host && !host.endsWith("anthropic.com") && !host.endsWith("claude.ai") && !host.endsWith("claude.com")) return "external";
  if (path.includes("/v1/messages/count_tokens")) return "tokens";
  if (path.includes("/v1/messages")) return "messages";
  if (["usage", "credit", "prepaid", "overage", "spend", "cost"].some((s) => path.includes(s))) return "usage";
  if (path.includes("oauth") || path.includes("account/settings") || path.includes("/roles") || path.includes("/profile")) return "oauth";
  if (path.includes("mcp")) return "mcp";
  if (path.includes("claude_cli") || path.includes("claude_code") || path.includes("bootstrap") || path.includes("/v1/code/")) return "bootstrap";
  if (path.includes("event_logging") || path.includes("/eval") || path.includes("statsig") || path.includes("logging")) return "telemetry";
  return "other";
}
