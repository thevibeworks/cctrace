import { extractCallInfo, extractUsageInfo } from "./summarize";
import { pairCost, modelPricing } from "./pricing";
import { wireDialect, openaiCompleted } from "./dialects/openai";

// The cost layer (docs/design/cost.md): where a session's money went, and
// which steps were BUMPS — a prefix re-billed at write price because the
// cache expired, the prefix changed, or the previous request never banked
// its write.
//
// Measured on real traces: 70-85% of a session's estimated cost is cache
// READS (re-reading the window every step), output ~10%, fresh input ~0%.
// The interesting part is the tail: a 5% hit on a 341k prompt cost ≈$6.48
// more than a warm one would have.
//
// Like context.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — self-contained, cross-calls only to other
// inlined functions by name (extractCallInfo, pairCost, modelPricing,
// wireDialect, extractUsageInfo).
//
// Every dollar here is an ESTIMATE from catalog rates; every CAUSE is a
// wire fact (a gap against a TTL, a status code, a same-step timeline
// event). "Over warm" is a counterfactual — what those tokens would have
// cost as cache reads — and the UI labels it as one.

/**
 * Estimated cost of one model-call pair, by component:
 * `{ total, input, output, cacheRead, cacheWrite, model }` — or null when
 * the model has no pricing (unknown model = say nothing, never $0).
 * Memoized on the pair as `_sc`, beside extractCallInfo's `_ci`.
 */
export function stepCost(pair: any): any {
  if (!pair) return null;
  if (pair._sc !== undefined) return pair._sc;
  const ci = pair._ci || (pair._ci = extractCallInfo(pair));
  const c = pairCost(ci);
  const out = c
    ? { total: c.total, input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, model: ci.model || "" }
    : null;
  pair._sc = out;
  return out;
}

/**
 * A thread's whole bill: the four components, the per-pair totals (the
 * overview's cost track reads these), and a per-model split. `steps` counts
 * the priced requests, `unpriced` the model calls whose model the catalog
 * doesn't know — stated out loud rather than folded into the total.
 */
export function threadCostSplit(threadPairs: any[]): any {
  const out: any = {
    total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    steps: 0, unpriced: 0, byPair: {}, byModel: {},
  };
  for (const p of threadPairs || []) {
    if (!p || !p.request || !wireDialect(p)) continue;
    const c = stepCost(p);
    if (!c) { out.unpriced++; continue; }
    out.steps++;
    out.total += c.total;
    out.input += c.input;
    out.output += c.output;
    out.cacheRead += c.cacheRead;
    out.cacheWrite += c.cacheWrite;
    out.byPair[p.id] = c.total;
    const m = c.model || "unknown";
    const e = out.byModel[m] || (out.byModel[m] = { requests: 0, total: 0 });
    e.requests++;
    e.total += c.total;
  }
  return out;
}

/**
 * The cost BUMPS of a thread: one event per priced step that re-bought a
 * prefix a warm cache would have read — a hit under 90%, or cold — and that
 * has a previous request to be measured against (a conversation's first
 * request is a start, not a bump).
 *
 * `extra` is the counterfactual: the re-billed tokens (uncached input +
 * cache writes) at their billed rate MINUS what the same tokens would have
 * cost as cache reads. `tokens` is how many were re-billed.
 *
 * Cause, in precedence order — each one a wire fact, never a guess:
 *  1. retry       — the previous request failed (no response / >=400 / an
 *                   error body) or was interrupted (a response that never
 *                   reached a stop_reason): a failed request does not bank
 *                   its cache write. Carries prevStatus.
 *  2. expired     — the gap from the previous request's END to this one's
 *                   start exceeded that write's TTL (1h when it wrote any
 *                   1h tokens, else 5m — a pure read refreshes 5m).
 *                   Carries gap (seconds) and ttl.
 *  3. invalidated — otherwise: the cached prefix changed. When the context
 *                   timeline holds a system / tools / compact / model event
 *                   on the SAME step, causeKind names it; else null, and
 *                   the view says "cause not on the wire".
 *
 * A bump also needs a warm cache to have been POSSIBLE: until some earlier
 * request in the thread has read or written the cache, paying input rate is
 * the price of a first prompt, not a bump.
 *
 * `events` is contextTimeline's event list (optional).
 */
export function costEvents(threadPairs: any[], events?: any[]): any[] {
  const causeByPair: any = {};
  for (const ev of events || []) {
    if (!ev || !ev.pairId || causeByPair[ev.pairId]) continue;
    if (ev.kind === "compact" || ev.kind === "system" || ev.kind === "tools" || ev.kind === "model") {
      causeByPair[ev.pairId] = ev.kind;
    }
  }
  const out: any[] = [];
  let prev: any = null;
  let banked = false; // has any earlier request in this thread used the cache?
  for (const p of threadPairs || []) {
    if (!p || !p.request) continue;
    const dialect = wireDialect(p);
    if (!dialect) continue;
    const ci = p._ci || (p._ci = extractCallInfo(p));
    const resp = p.response;
    // A request with no response, an HTTP error or an error body never
    // banked its cache write; neither did one whose stream was cut off
    // before it completed (the client aborted). "Completed" is a per-
    // dialect wire fact: Anthropic sends a stop_reason, OpenAI a
    // response.completed / finished chunk.
    const cut = dialect === "openai" ? !openaiCompleted(p) : !ci.stopReason;
    const cur = {
      end: (p.request.timestamp || 0) * 1000 + (typeof p.duration === "number" ? p.duration : 0),
      unbanked: !resp || resp.status >= 400 || !!ci.error || !!p.truncated || cut,
      status: resp ? resp.status : null,
      write1h: (ci.cacheWrite1h || 0) > 0,
    };
    const tokens = (ci.input || 0) + (ci.cacheWrite || 0);
    const weak = (ci.cacheRead || 0) === 0 || (typeof ci.cachePct === "number" && ci.cachePct < 90);
    const pr = stepCost(p) ? modelPricing(ci.model) : null;
    // "Warm" has to have been possible: a thread whose earlier requests
    // never touched the prompt cache has no prefix this one could have
    // re-read, so paying input rate is the price, not a bump. `banked`
    // tracks the whole THREAD, not the previous step — the retry case is
    // exactly a run of failed requests between the warm prefix and the
    // re-write.
    if (prev && pr && tokens && weak && banked) {
      const w5 = ci.cacheWrite5m || 0;
      const w1 = ci.cacheWrite1h || 0;
      const rest = Math.max(0, (ci.cacheWrite || 0) - w5 - w1);
      const extra =
        ((ci.input || 0) * (pr.input - pr.cacheRead) +
          (w5 + rest) * (pr.cacheWrite5m - pr.cacheRead) +
          w1 * (pr.cacheWrite1h - pr.cacheRead)) / 1e6;
      if (extra > 0) {
        let cause = "invalidated";
        let gap: any = null;
        let ttl: any = null;
        let causeKind: any = null;
        let prevStatus: any = null;
        const gapMs = (p.request.timestamp || 0) * 1000 - prev.end;
        const ttlMs = prev.write1h ? 3600000 : 300000;
        if (prev.unbanked) {
          cause = "retry";
          prevStatus = prev.status;
        } else if (prev.end > 0 && gapMs > ttlMs) {
          cause = "expired";
          gap = Math.round(gapMs / 1000);
          ttl = prev.write1h ? "1h" : "5m";
        } else {
          causeKind = causeByPair[p.id] || null;
        }
        out.push({
          kind: "cost", cause, pairId: p.id, t: p.request.timestamp || 0,
          extra, tokens, hitPct: typeof ci.cachePct === "number" ? ci.cachePct : null,
          gap, ttl, causeKind, prevStatus, model: ci.model || "",
        });
      }
    }
    prev = cur;
    if ((ci.cacheRead || 0) > 0 || (ci.cacheWrite || 0) > 0) banked = true;
  }
  return out;
}

/**
 * The account's quota as the client polled it: one entry per captured
 * /api/oauth/usage response that reported limits, oldest first. Quota is
 * account-wide, so this reads the WHOLE trace, not one thread. Clients with
 * no such poll on the wire (codex/grok/kimi/opencode) get an empty list and
 * the view renders nothing.
 */
export function usagePolls(pairs: any[]): any[] {
  const out: any[] = [];
  for (const p of pairs || []) {
    if (!p || !p.response) continue;
    const u = extractUsageInfo(p);
    if (!u || !u.limits || !u.limits.length) continue;
    out.push({
      t: p.response.timestamp || (p.request && p.request.timestamp) || 0,
      limits: u.limits,
      credits: u.credits || null,
      pairId: p.id,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
