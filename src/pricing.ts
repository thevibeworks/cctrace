// Claude model pricing + cost estimation for captured /v1/messages pairs.
//
// Like summarize.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — keep them self-contained (no imports, no
// module state; cross-calls only to other inlined functions by name).
//
// Prices are USD per million tokens, embedded so snapshots work offline.
// Sources: platform.claude.com/docs/en/about-claude/pricing (2026-09-01),
// cross-checked against models.dev (the live catalog, src/pricing-catalog.ts).
// Cache rates follow Anthropic's multipliers: read = 0.1x input — 0.025x on
// Claude Fable 5.1 / Mythos 5.1 — write = 1.25x (5m TTL) or 2x (1h TTL).
// Long context is standard-rate on Claude 4.6+ (a 900k request bills like a
// 9k one), so no tier applies. Two modifiers ARE read off the wire (pairRates):
// fast mode — the response's usage.speed says "fast" — doubles every rate on
// Opus 5 / Opus 4.8; US-only inference (request inference_geo: "us") is 1.1x
// on every token class. Every figure shown in the UI is an estimate, not a
// bill.

/**
 * Per-MTok pricing for a model id, or null when unrecognized. Consults the
 * models.dev catalog first (src/pricing-catalog.ts — passed as `catalog`, or
 * ambient as globalThis.__PRICING__, which the web page sets from
 * META.pricing), then falls back to the embedded Claude table so snapshots
 * and offline runs still price Claude traffic. Catalog lookup normalizes:
 * exact id, then without the date suffix, then progressively without
 * trailing "-segment"s (gpt-5.6-sol -> gpt-5.6). Catalog cache rates default
 * to Anthropic's universal multipliers when the entry has no explicit ones;
 * an entry's cache_write is the 5m rate (1h = input x2, ccusage convention);
 * a missing cache rate means the provider doesn't bill that operation (0).
 * Handles date suffixes (-20251001), bedrock prefixes (anthropic.), vertex
 * @-versions, and Claude Code's [1m] context marker. Unknown versions of a
 * known family fall back to the family's current price.
 */
export function modelPricing(model: unknown, catalog?: any): any {
  let m = String(model || "").toLowerCase();
  if (!m) return null;
  const cat = catalog || (typeof globalThis !== "undefined" && (globalThis as any).__PRICING__) || null;
  if (cat) {
    const id = m.replace(/\[.*\]$/, "");
    const tries = [id, id.replace(/[-@]\d{8}$/, "")];
    for (let i = 0; i < 2; i++) {
      const base = tries[tries.length - 1].replace(/-[a-z0-9.]+$/, "");
      if (!base || base === tries[tries.length - 1]) break;
      tries.push(base);
    }
    for (const t of tries) {
      const e = cat[t];
      if (e && typeof e.input === "number" && typeof e.output === "number") {
        const w = typeof e.cacheWrite === "number" ? e.cacheWrite : 0;
        return {
          input: e.input,
          output: e.output,
          cacheRead: typeof e.cacheRead === "number" ? e.cacheRead : 0,
          cacheWrite5m: w,
          cacheWrite1h: w > 0 ? e.input * 2 : 0,
        };
      }
    }
  }
  m = m
    .replace(/^anthropic\./, "")
    .replace(/\[.*\]$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "")
    .replace(/^(\d(?:-\d)?)-(opus|sonnet|haiku)/, "$2-$1"); // claude-3-opus -> opus-3
  let io: number[] | null = null;
  // Cache reads are 0.1x input everywhere except Fable 5.1 / Mythos 5.1
  // (0.025x — $0.25 on $10 input; Fable 5 / Mythos 5 stay at $1).
  let readX = 0.1;
  if (/fable|mythos/.test(m)) {
    io = [10, 50];
    if (/(fable|mythos)-5-1(?!\d)/.test(m)) readX = 0.025;
  }
  else if (/^opus-(3|4|4-0|4-1)$/.test(m)) io = [15, 75]; // opus 3 / 4.0 / 4.1
  else if (/opus/.test(m)) io = [5, 25]; // opus 4.5+
  else if (/^sonnet-5(?!\d)/.test(m)) io = [2, 10]; // sonnet 5: the launch price is the standard price
  else if (/sonnet/.test(m)) io = [3, 15];
  else if (/haiku-3-5/.test(m)) io = [0.8, 4];
  else if (/haiku-3/.test(m)) io = [0.25, 1.25];
  else if (/haiku/.test(m)) io = [1, 5];
  if (!io) return null;
  return {
    input: io[0],
    output: io[1],
    cacheRead: io[0] * readX,
    cacheWrite5m: io[0] * 1.25,
    cacheWrite1h: io[0] * 2,
  };
}

/**
 * The rates ONE pair is billed at: modelPricing for its model, then the
 * modifiers the wire states for that request — read here, in one place,
 * so pairCost and the cost-bump arithmetic price the same request the
 * same way:
 *   - fast mode: the response's `usage.speed` is "fast" (Opus 5 / Opus 4.8
 *     research preview; a request that asked and was downgraded reports
 *     "standard" and is not a modifier) — $10/$50, i.e. 2x the base rates,
 *     and the cache multipliers stack on top, so every rate doubles;
 *   - US-only inference: the request's `inference_geo` is "us" — 1.1x on
 *     every token class (Claude 4.6+; earlier models reject the parameter,
 *     so a captured pair carrying it is a 4.6+ pair).
 * `mods` names the modifiers applied, for the cost tooltip. Null when the
 * model has no price.
 */
export function pairRates(m: any): any {
  const p = modelPricing(m && m.model);
  if (!p) return null;
  let f = 1;
  const mods: string[] = [];
  if (m && m.fast) { f *= 2; mods.push("fast mode"); }
  if (m && m.geoUs) { f *= 1.1; mods.push("us inference"); }
  if (f === 1) return p;
  return {
    input: p.input * f,
    output: p.output * f,
    cacheRead: p.cacheRead * f,
    cacheWrite5m: p.cacheWrite5m * f,
    cacheWrite1h: p.cacheWrite1h * f,
    mods,
  };
}

/**
 * Context-window size (tokens) for a model id, or 0 when unknown. Same
 * resolution ladder as modelPricing over the models.dev catalog (which now
 * carries limit.context — src/pricing-catalog.ts); the embedded fallback
 * covers Claude models at their standard 200k so offline pages still anchor.
 * The caller applies the 1m-context beta override (a wire header fact, not
 * a model fact). 0 = don't pretend — occupancy renders without a % then.
 */
export function modelWindow(model: unknown, catalog?: any): number {
  let m = String(model || "").toLowerCase();
  if (!m) return 0;
  const cat = catalog || (typeof globalThis !== "undefined" && (globalThis as any).__PRICING__) || null;
  if (cat) {
    const id = m.replace(/\[.*\]$/, "");
    const tries = [id, id.replace(/[-@]\d{8}$/, "")];
    for (let i = 0; i < 2; i++) {
      const base = tries[tries.length - 1].replace(/-[a-z0-9.]+$/, "");
      if (!base || base === tries[tries.length - 1]) break;
      tries.push(base);
    }
    for (const t of tries) {
      const e = cat[t];
      if (e && typeof e.context === "number" && e.context > 0) return e.context;
    }
  }
  // Embedded fallback, the docs' rule (2026-09): Claude 4.6 and later ship
  // the full 1M window at standard rates — Opus 4.6/4.7/4.8/5, Sonnet
  // 4.6/5, Fable and Mythos. Earlier tiers are 200k (Opus 4.5 and before,
  // Sonnet 4.5 and before, every Haiku); the caller's context-1m header
  // override covers Sonnet 4.5's beta. An unversioned family name is not
  // guessed at — 0 renders no %, never a wrong one.
  m = m
    .replace(/^anthropic\./, "")
    .replace(/\[.*\]$/, "")
    .replace(/@\d{8}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "")
    .replace(/^(\d(?:-\d)?)-(opus|sonnet|haiku)/, "$2-$1");
  if (/^(fable|mythos)/.test(m)) return 1000000;
  const v = m.match(/^(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!v) return 0;
  if (v[1] === "haiku") return 200000;
  const major = +v[2];
  const minor = v[3] != null ? +v[3] : 0;
  return major >= 5 || (major === 4 && minor >= 6) ? 1000000 : 200000;
}

/**
 * Estimated USD cost of one /v1/messages pair, from its extractMessageInfo
 * result. Returns {total, input, output, cacheRead, cacheWrite} or null when
 * the model is unknown. Cache writes without a 5m/1h breakdown (older traces)
 * are billed at the 5m rate — the cheaper assumption, same as ccusage.
 */
export function pairCost(m: any): any {
  if (!m) return null;
  const p = pairRates(m);
  if (!p) return null;
  const w5 = m.cacheWrite5m || 0;
  const w1 = m.cacheWrite1h || 0;
  const rest = Math.max(0, (m.cacheWrite || 0) - w5 - w1);
  const M = 1e6;
  const input = ((m.input || 0) * p.input) / M;
  const output = ((m.output || 0) * p.output) / M;
  const cacheRead = ((m.cacheRead || 0) * p.cacheRead) / M;
  const cacheWrite = ((w5 + rest) * p.cacheWrite5m + w1 * p.cacheWrite1h) / M;
  const out: any = { total: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite };
  if (p.mods && p.mods.length) out.mods = p.mods;
  return out;
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
  const mods = c.mods && c.mods.length ? " (" + c.mods.join(", ") + ")" : "";
  return (
    "estimated" + mods + ": " +
    [bit("input", c.input), bit("output", c.output), bit("cache read", c.cacheRead), bit("cache write", c.cacheWrite)]
      .filter(Boolean)
      .join(" + ")
  );
}
