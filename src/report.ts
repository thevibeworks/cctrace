// End-of-run close-out: the summary lines the CLI prints when a traced
// session exits, computed from the run's own pairs (never prior-run merges —
// those are the viewer's business). Pure presentation: no file or network
// access; the CLI hands in the on-disk size and wall-clock it already knows.

import { categorizeUrl, CATEGORIES } from "./categorize";
import { extractCallInfo, extractSessionId, fmtCompact, shortModel } from "./summarize";
import { pairCost, fmtCost } from "./pricing";
import { human } from "./storage";
import type { TracePair } from "./types";

/** Coarse wall-clock for a whole session: "42s", "33m", "2h 05m". */
export function fmtDur(ms: number): string {
  if (!(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export interface TraceSummaryOpts {
  /** Merged client wire tables (wireTables()) for categorize + session ids. */
  wire?: any;
  /** models.dev pricing catalog; without it only Claude models price. */
  pricing?: any;
  sizeBytes?: number;
  durationMs?: number;
}

export interface TraceSummary {
  /** "Traced 19 pairs in 33m — 12 messages, 4 telemetry, 3 other — 1.8 MB" */
  traced: string;
  /** "Session dafcee7b — fable-5 · in 1.2m tok (98% cached) · out 45.1k · est $1.23" */
  session?: string;
  /** "2 failed requests (429, overloaded_error)" — only when something failed. */
  errors?: string;
}

export function traceSummary(pairs: TracePair[], opts: TraceSummaryOpts = {}): TraceSummary {
  // pairCost resolves the catalog ambiently (the web page sets __PRICING__
  // from META); the CLI passes it here instead, once, before summing.
  if (opts.pricing) (globalThis as any).__PRICING__ = opts.pricing;

  const catCounts = new Map<string, number>();
  const sids: string[] = [];
  const modelOut = new Map<string, number>();
  let totalIn = 0, cacheRead = 0, out = 0, cost = 0;
  let failed = 0;
  const failWhy = new Set<string>();

  for (const p of pairs) {
    const cat = categorizeUrl((p as any).request?.url || "", (p as any).client, opts.wire);
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
    const sid = extractSessionId(p, opts.wire);
    if (sid && !sids.includes(sid)) sids.push(sid);
    const status = (p as any).response?.status;
    if (typeof status === "number" && status >= 400) { failed++; failWhy.add(String(status)); }
    if (cat !== "messages") continue;
    const m = extractCallInfo(p);
    if (!m) continue;
    if (!(p as any).response) { failed++; failWhy.add("no response"); }
    else if (m.error && !(typeof status === "number" && status >= 400)) { failed++; failWhy.add(String(m.error)); }
    totalIn += (m.input || 0) + (m.cacheRead || 0) + (m.cacheWrite || 0);
    cacheRead += m.cacheRead || 0;
    out += m.output || 0;
    if (m.model) modelOut.set(m.model, (modelOut.get(m.model) || 0) + (m.output || 0));
    const c = pairCost(m);
    if (c) cost += c.total;
  }

  // Categories in the taxonomy's order, ids as labels — the same vocabulary
  // as `cctrace purge --drop`.
  const order = CATEGORIES.map((c) => c.id);
  const cats = [...catCounts.entries()]
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99))
    .map(([id, n]) => `${n} ${id}`)
    .join(", ");
  let traced = `Traced ${pairs.length} pair${pairs.length === 1 ? "" : "s"}`;
  const dur = fmtDur(opts.durationMs || 0);
  if (dur) traced += ` in ${dur}`;
  if (cats && catCounts.size > 1) traced += ` — ${cats}`;
  if (opts.sizeBytes && opts.sizeBytes > 0) traced += ` — ${human(opts.sizeBytes)}`;

  const parts: string[] = [];
  if (sids.length) parts.push(`Session${sids.length > 1 ? "s" : ""} ${sids.map((s) => s.slice(0, 8)).join(", ")}`);
  if (modelOut.size) {
    const face = [...modelOut.entries()].sort((a, b) => b[1] - a[1])[0][0];
    parts.push(shortModel(face) + (modelOut.size > 1 ? ` +${modelOut.size - 1}` : ""));
  }
  if (totalIn > 0) {
    const pct = Math.round((cacheRead / totalIn) * 100);
    parts.push(`in ${fmtCompact(totalIn)} tok${pct > 0 ? ` (${pct}% cached)` : ""}`);
  }
  if (out > 0) parts.push(`out ${fmtCompact(out)}`);
  if (cost > 0) parts.push(`est ${fmtCost(cost)}`);

  const summary: TraceSummary = { traced };
  if (parts.length) summary.session = parts[0] + (parts.length > 1 ? ` — ${parts.slice(1).join(" · ")}` : "");
  if (failed > 0) summary.errors = `${failed} failed request${failed === 1 ? "" : "s"} (${[...failWhy].slice(0, 3).join(", ")})`;
  return summary;
}
