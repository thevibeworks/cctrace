import { histLenOf, historyHas, isStubBody, lastMsgSig, stubPair, threadKeyOf, type StubKind } from "./compact";
import { categorizeUrl } from "./categorize";
import { contextComposition } from "./context";
import { extractCallInfo } from "./summarize";
import type { TracePair } from "./types";

interface Held {
  pair: TracePair;
  bytes: number;
  len: number;
  sig: string;
}

/** Request-body retention only. Responses and pair metadata remain available. */
export function createLiveBodies(bodyBytes: number, wire?: unknown) {
  const full = new Map<string, Held>();
  const threads = new Map<string, Held>();
  let retainedBytes = 0;

  const fold = (h: Held, kind: StubKind, keeper: string, changed: TracePair[]) => {
    const p = h.pair;
    if (isStubBody(p.request.body)) {
      const body = p.request.body as { kind: string; keptPairId?: string };
      if (kind === "superseded" && (body.kind !== kind || body.keptPairId !== keeper)) {
        body.kind = kind;
        body.keptPairId = keeper;
        changed.push(p);
      }
      return;
    }
    // Preserve request-derived usage/pricing parameters before removing them.
    (p as TracePair & { _ci?: unknown })._ci = extractCallInfo(p);
    // ...and the reading the body is about to take with it: ten numbers
    // that keep the Context view EXACT for this step instead of derived
    // (src/context.ts ctxEffectiveBody is the fallback, not the plan).
    const composition = contextComposition(p);
    delete (p as TracePair & { _ctxc?: unknown })._ctxc; // a memo, not wire data
    const folded = stubPair(p, keeper, kind);
    if (composition) (folded.request.body as { composition?: unknown }).composition = composition;
    p.request = folded.request;
    retainedBytes -= h.bytes;
    h.bytes = 0;
    full.delete(p.id);
    changed.push(p);
  };

  return {
    /** Hold one pair's request body. Idempotent: a body already held (or
     * already folded to a stub) is not taken twice, so the prior-session
     * preload can fold as it reads and mergePairs can hand the same pairs
     * over again without double-counting the budget. */
    add(pair: TracePair): TracePair[] {
      if (pair.request.body == null || isStubBody(pair.request.body)) return [];
      if (full.has(pair.id)) return [];
      const changed: TracePair[] = [];
      const modelCall = categorizeUrl(pair.request.url, pair.client, wire) === "messages";
      const h: Held = { pair, bytes: Buffer.byteLength(JSON.stringify(pair.request.body)),
        len: modelCall ? histLenOf(pair) : 0, sig: modelCall ? lastMsgSig(pair) : "" };
      full.set(pair.id, h);
      retainedBytes += h.bytes;
      if (modelCall && h.len > 0) {
        const key = threadKeyOf(pair, wire);
        const prev = threads.get(key);
        if (!prev || pair.request.timestamp >= prev.pair.request.timestamp) {
          if (prev && h.len >= prev.len && prev.sig && historyHas(pair, prev.sig)) {
            fold(prev, "superseded", pair.id, changed);
          }
          threads.set(key, h);
        } else if (h.len <= prev.len && h.sig && historyHas(prev.pair, h.sig)) {
          // Arrived OLDER than the thread's candidate: the prior-session
          // preload reads the newest trace file first, and a late pair can
          // land out of order on a live run. The candidate already re-sent
          // this history, so THIS is the superseded body — fold it against
          // the candidate rather than leave it for the budget, which would
          // drop it with no keeper to read it back from.
          fold(h, "superseded", prev.pair.id, changed);
        }
      }
      while (retainedBytes > bodyBytes && full.size) {
        fold(full.values().next().value!, "budgeted", "", changed);
      }
      return changed;
    },
    forget(id: string) {
      const h = full.get(id);
      if (h) retainedBytes -= h.bytes;
      full.delete(id);
      for (const [key, item] of threads) if (item.pair.id === id) threads.delete(key);
    },
    retainedBytes: () => retainedBytes,
  };
}
