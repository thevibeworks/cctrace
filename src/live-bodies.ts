import { histLenOf, isStubBody, lastMsgSig, stubPair, threadKeyOf, type StubKind } from "./compact";
import { categorizeUrl } from "./categorize";
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
    const folded = stubPair(p, keeper, kind);
    p.request = folded.request;
    retainedBytes -= h.bytes;
    h.bytes = 0;
    full.delete(p.id);
    changed.push(p);
  };

  return {
    add(pair: TracePair): TracePair[] {
      if (pair.request.body == null || isStubBody(pair.request.body)) return [];
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
          if (prev && h.len >= prev.len && prev.sig) {
            const body = pair.request.body as { messages?: unknown[]; input?: unknown[] };
            const history = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
            for (let i = history.length - 1; i >= 0; i--) {
              if (JSON.stringify(history[i]).slice(0, 400) === prev.sig) {
                fold(prev, "superseded", pair.id, changed);
                break;
              }
            }
          }
          threads.set(key, h);
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
