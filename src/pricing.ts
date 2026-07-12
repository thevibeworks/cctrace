// Claude model pricing + cost estimation for captured /v1/messages pairs.
//
// Like summarize.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — keep them self-contained (no imports, no
// module state; cross-calls only to other inlined functions by name).
//
// Prices are USD per million tokens, embedded so snapshots work offline.
// Sources: platform.claude.com pricing (2026-06), cross-checked against
// ccusage's LiteLLM/models.dev data (reference/ccusage). Cache rates follow
// Anthropic's universal multipliers: read = 0.1x input, write = 1.25x (5m TTL)
// or 2x (1h TTL). Long-context tiers and intro discounts are ignored — every
// figure shown in the UI is an estimate, not a bill.

/**
 * Per-MTok pricing for a Claude model id, or null when unrecognized.
 * Handles date suffixes (-20251001), bedrock prefixes (anthropic.), vertex
 * @-versions, and Claude Code's [1m] context marker. Unknown versions of a
 * known family fall back to the family's current price.
 */
export function modelPricing(model: unknown): any {
  let m = String(model || "").toLowerCase();
  if (!m) return null;
  m = m
    .replace(/^anthropic\./, "")
    .replace(/\[.*\]$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "")
    .replace(/^(\d(?:-\d)?)-(opus|sonnet|haiku)/, "$2-$1"); // claude-3-opus -> opus-3
  let io: number[] | null = null;
  if (/fable|mythos/.test(m)) io = [10, 50];
  else if (/^opus-(3|4|4-0|4-1)$/.test(m)) io = [15, 75]; // opus 3 / 4.0 / 4.1
  else if (/opus/.test(m)) io = [5, 25]; // opus 4.5+
  else if (/sonnet/.test(m)) io = [3, 15];
  else if (/haiku-3-5/.test(m)) io = [0.8, 4];
  else if (/haiku-3/.test(m)) io = [0.25, 1.25];
  else if (/haiku/.test(m)) io = [1, 5];
  if (!io) return null;
  return {
    input: io[0],
    output: io[1],
    cacheRead: io[0] * 0.1,
    cacheWrite5m: io[0] * 1.25,
    cacheWrite1h: io[0] * 2,
  };
}

/**
 * Estimated USD cost of one /v1/messages pair, from its extractMessageInfo
 * result. Returns {total, input, output, cacheRead, cacheWrite} or null when
 * the model is unknown. Cache writes without a 5m/1h breakdown (older traces)
 * are billed at the 5m rate — the cheaper assumption, same as ccusage.
 */
export function pairCost(m: any): any {
  if (!m) return null;
  const p = modelPricing(m.model);
  if (!p) return null;
  const w5 = m.cacheWrite5m || 0;
  const w1 = m.cacheWrite1h || 0;
  const rest = Math.max(0, (m.cacheWrite || 0) - w5 - w1);
  const M = 1e6;
  const input = ((m.input || 0) * p.input) / M;
  const output = ((m.output || 0) * p.output) / M;
  const cacheRead = ((m.cacheRead || 0) * p.cacheRead) / M;
  const cacheWrite = ((w5 + rest) * p.cacheWrite5m + w1 * p.cacheWrite1h) / M;
  return { total: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite };
}

/** "$0.0123" — cost label with precision scaled to magnitude. */
export function fmtCost(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 1) return "$" + n.toFixed(2);
  const s = n >= 0.01 ? n.toFixed(3) : n.toFixed(4);
  // Trim trailing zeros but keep the conventional two decimals ($0.500 -> $0.50)
  return "$" + (s.endsWith("0") ? s.replace(/0+$/, "").padEnd(4, "0") : s);
}

/** One-line tooltip breaking a pairCost down by component. */
export function costTitle(c: any): string {
  if (!c) return "";
  const bit = (label: string, v: number) => (v > 0 ? label + " " + fmtCost(v) : "");
  return (
    "estimated: " +
    [bit("input", c.input), bit("output", c.output), bit("cache read", c.cacheRead), bit("cache write", c.cacheWrite)]
      .filter(Boolean)
      .join(" + ")
  );
}
