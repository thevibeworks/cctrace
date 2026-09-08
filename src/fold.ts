import { traceLines, type TraceParseStats } from "./history";
import { histLenOf, threadKeyOf, lastMsgSig, isStubBody, stubPair, collapsePair, type Categorize, type StubKind } from "./compact";
import type { TracePair } from "./types";

// The render FOLD — how a whole session fits on one page.
//
// A rendered document pays ~1:1 for every byte it embeds: the browser holds
// it as script source and parses it. So `/view/<run-id>` used to budget its
// read (VIEW_BYTES) and show the newest slice — a real 708 MB session
// opened as its newest 32 MB and silently left 78% of the session off the
// page (issue #106). Budgeting LINES is the wrong cut: it drops whole
// requests, and the request list is the recording.
//
// The right cut is the one `compact` already found on disk: ~79% of a
// trace's bytes are messages request bodies re-sending a conversation the
// NEXT request re-sends again. One page does not need forty copies of one
// conversation. So the fold cuts bodies, never pairs, by two rules:
//
//   1. Superseded: a request body a later request re-sent in full folds to
//      compact's stub — model, session metadata, historyLen, firstUserText,
//      a link to the request that kept the history. Reconstruction, thread
//      grouping and per-turn attribution all read the stub (session.ts has
//      been stub-aware since compact shipped), so the Sessions view still
//      renders every turn. Rewound/edited branch tips keep their bodies:
//      their content lives nowhere else.
//   2. Budgeted: what survives rule 1 is spent NEWEST-FIRST against a byte
//      budget. Older bodies fold to meta as the budget runs out, so the
//      page has a ceiling no session can breach.
//
// Every pair reaches the page either way — the requests list, its timings,
// statuses, tokens, costs and pen strokes are complete. Measured on a real
// 291 MB trace: 462 pairs, 27 MB folded (10.6x); on a 3.5 GB one: 3796
// pairs, whole, against 32 MB of bodies.
//
// Nothing here is destructive — the trace on disk is untouched, and a
// served page fetches any folded body back from /view/<run-id>/pair/<id>.
// That is the difference from `cctrace compact`, which decides the same
// two questions for a REWRITE and therefore plans a whole file before
// touching it. The fold streams instead: it never holds a trace, only the
// page it is building. The stub FORMAT and the facts behind the decision
// (histLenOf / threadKeyOf / lastMsgSig / stubPair / collapsePair) are
// compact.ts's, single-implementation; only the traversal differs.

/** Default bytes of full bodies a rendered page may carry. */
export const FOLD_BODY_BYTES = 32 * 1024 * 1024;

/** What a stub says about why it folded. */
export type FoldKind = StubKind;

export interface FoldOpts {
  categorize: Categorize;
  wire?: unknown;
  /** Bytes of full bodies the page may carry; Infinity folds nothing by
   * budget (rule 1 still applies). Default FOLD_BODY_BYTES. */
  bodyBytes?: number;
  /** Only lines containing one of these substrings are considered — the
   * same cheap pre-check readTracePairs uses for session-scoped reads. */
  needles?: string[];
  /** Keep only pairs this accepts. */
  filter?: (pair: TracePair) => boolean;
  stats?: TraceParseStats;
}

export interface FoldResult {
  /** Every pair the fold kept, oldest first. */
  pairs: TracePair[];
  /** Request bodies folded because a later request re-sent them. */
  superseded: number;
  /** Bodies folded because the page's byte budget ran out. */
  budgeted: number;
  /** Decoded bytes of every candidate line seen. */
  seenBytes: number;
  /** What those pairs weigh now, after folding. */
  keptBytes: number;
  /** Bytes the fold took out of the page. */
  foldedBytes: number;
}

interface Held {
  pair: TracePair;
  /** What this pair costs the page right now. */
  weight: number;
  /** Foldable body bytes still inline (0 once folded). */
  bodyBytes: number;
  /** A model call: it folds to a reconstruction stub and keeps its reply. */
  isModelCall: boolean;
  folded: boolean;
  /** The epoch keeper this pair's stub should point at, once known. */
  keptPairId?: string;
}

export interface Folder {
  /** Fold one trace file into the page. Call the NEWEST file first when
   * several carry the session: the body budget is spent newest-first, so
   * the newest conversation is the one that stays whole. */
  addFile(path: string): Promise<{ lines: number; seenBytes: number }>;
  finish(): FoldResult;
}

/**
 * A fold in progress. Memory is bounded by the budget: a pair is held
 * either whole (charged against the budget) or as a stub (~2 KB).
 */
export function createFold(opts: FoldOpts): Folder {
  const budget = opts.bodyBytes ?? FOLD_BODY_BYTES;
  const held: Held[] = [];
  const seenIds = new Set<string>();
  /** Indexes of pairs still holding a full body, oldest first — the queue
   * the budget eats from. */
  const fullQueue: number[] = [];
  let fullBytes = 0;
  let seenBytes = 0;
  let superseded = 0;
  let budgeted = 0;
  let foldedBytes = 0;

  // Per open thread-epoch: the request that may still turn out to be the
  // epoch's keeper, and the stubs waiting to learn its id.
  interface Epoch { at: number; len: number; sig: string; stubs: number[] }
  let epochs = new Map<string, Epoch>();

  /** Fold one held pair's bodies. */
  const foldAt = (i: number, kind: FoldKind) => {
    const h = held[i]!;
    if (h.folded) return;
    // A model call keeps its reconstruction stub (history length, first
    // user text, session metadata) and its RESPONSE — the reply is the
    // conversation's other half and exists exactly once. Everything else
    // is noise whose bodies collapse to byte counts, response included.
    h.pair = h.isModelCall ? stubPair(h.pair, h.keptPairId ?? "", kind) : collapsePair(h.pair);
    h.folded = true;
    // What the fold actually bought, measured on the folded pair rather
    // than assumed: a stub carries up to 2 KB of first-user-text.
    const after = foldableBytes(h.pair, h.isModelCall);
    h.weight = Math.max(0, h.weight - h.bodyBytes + after);
    foldedBytes += Math.max(0, h.bodyBytes - after);
    h.bodyBytes = 0;
    if (kind === "superseded") superseded++;
    else budgeted++;
  };

  /** Spend the budget down by folding the oldest bodies still inline. */
  const settle = () => {
    while (fullBytes > budget && fullQueue.length) {
      const i = fullQueue.shift()!;
      const h = held[i]!;
      if (h.folded) continue;
      fullBytes -= h.bodyBytes;
      foldAt(i, "budgeted");
    }
  };

  const addLine = (line: string): boolean => {
    if (!line.trim()) return false;
    if (opts.needles && !opts.needles.some((n) => line.includes(n))) return false;
    let pair: TracePair;
    try {
      pair = JSON.parse(line);
    } catch {
      if (opts.stats) opts.stats.torn++;
      return false;
    }
    if (!pair?.request || typeof pair.request.url !== "string") {
      if (opts.stats) opts.stats.invalid++;
      return false;
    }
    if (opts.filter && !opts.filter(pair)) return false;
    seenBytes += line.length + 1;
    // After a merge a pair exists in both its trace-*.jsonl and the
    // session file — the same dedupe loadPriorPairs does.
    if (pair.id) {
      if (seenIds.has(pair.id)) return false;
      seenIds.add(pair.id);
    }

    const isModelCall =
      opts.categorize(pair.request.url, pair.client) === "messages" && histLenOf(pair) > 0;
    const bodyBytes = foldableBytes(pair, isModelCall);
    const i = held.length;
    const h: Held = { pair, weight: line.length + 1, bodyBytes, isModelCall, folded: false };
    held.push(h);
    if (bodyBytes > 0) {
      fullQueue.push(i);
      fullBytes += bodyBytes;
    }

    // ---- rule 1: supersede ----
    if (isModelCall && !isStubBody(pair.request.body)) {
      const len = histLenOf(pair);
      if (len > 0) {
        const key = threadKeyOf(pair, opts.wire);
        const ep = epochs.get(key);
        if (!ep) {
          epochs.set(key, { at: i, len, sig: lastMsgSig(pair), stubs: [] });
        } else if (len >= ep.len) {
          // This request re-sent the candidate's history. Fold the
          // candidate — unless its durable tip is absent here, which
          // means a rewind/edit erased that exchange and this body holds
          // its only copy (compact's guard, checked against the
          // immediate successor: a later keeper's history is a superset,
          // so checking the nearest one only ever keeps MORE).
          const prev = held[ep.at]!;
          if (ep.sig && historyHas(pair, ep.sig)) {
            if (!prev.folded) {
              if (prev.bodyBytes > 0) fullBytes -= prev.bodyBytes;
              foldAt(ep.at, "superseded");
            } else if (prev.isModelCall) {
              // The budget got here first (settle() runs per line, so on
              // a large trace most bodies fold before their successor
              // arrives). The fact is the same — a later request re-sent
              // this history — so the stub says so and, below, learns
              // its keeper: without this a 1592-pair page reported
              // "71 superseded + 1328 over budget" and 327 stubs had no
              // history link.
              const body = prev.pair.request.body as { kind?: FoldKind } | null;
              if (body && isStubBody(body) && body.kind === "budgeted") {
                body.kind = "superseded";
                budgeted--;
                superseded++;
              }
            }
            ep.stubs.push(ep.at);
          }
          ep.at = i;
          ep.len = len;
          ep.sig = lastMsgSig(pair);
        } else {
          // History shrank: a compaction or /clear closed the epoch, and
          // the candidate is its keeper. Post-compaction history is not a
          // superset, so the next request supersedes nothing before it.
          closeEpoch(ep);
          epochs.set(key, { at: i, len, sig: lastMsgSig(pair), stubs: [] });
        }
      }
    }
    settle();
    return true;
  };

  /** Name the epoch's keeper on every stub that pointed at it. */
  const closeEpoch = (ep: Epoch) => {
    const keeperId = held[ep.at]?.pair.id || "";
    for (const s of ep.stubs) {
      const h = held[s]!;
      h.keptPairId = keeperId;
      const body = h.pair.request.body as { keptPairId?: string } | null;
      if (keeperId && body && isStubBody(body)) body.keptPairId = keeperId;
    }
    ep.stubs = [];
  };

  return {
    async addFile(path: string) {
      // Each file folds on its own epochs: files arrive newest-first, so
      // carrying a thread's candidate across them would compare a request
      // against an OLDER one.
      for (const ep of epochs.values()) closeEpoch(ep);
      epochs = new Map();
      let lines = 0;
      const before = seenBytes;
      for await (const line of traceLines(path)) {
        if (addLine(line)) lines++;
      }
      for (const ep of epochs.values()) closeEpoch(ep);
      epochs = new Map();
      return { lines, seenBytes: seenBytes - before };
    },
    finish() {
      for (const ep of epochs.values()) closeEpoch(ep);
      const pairs = held.map((h) => h.pair);
      let keptBytes = 0;
      for (const h of held) keptBytes += h.weight;
      return { pairs, superseded, budgeted, seenBytes, keptBytes, foldedBytes };
    },
  };
}

/**
 * The bytes of a pair the fold can take back. A model call gives up its
 * request body only — its response IS the reply, and a reply exists once.
 * A noise pair gives up both, which is what collapsePair takes.
 */
function foldableBytes(pair: TracePair, isModelCall: boolean): number {
  // A body `cctrace compact` already folded on disk is a stub: it has no
  // bytes to take back, and re-stubbing it would relabel a "superseded"
  // stub "budgeted" and drop its keptPairId. Measured on a compacted 1592-
  // pair trace before this guard: 1327 stubs re-folded as "over budget",
  // 326 of them with their history link erased.
  let n = isStubBody(pair.request.body) ? 0 : jsonLen(pair.request.body);
  if (isModelCall) return n;
  const r = pair.response as { body?: unknown; bodyRaw?: unknown } | undefined;
  if (r) {
    if (!isStubBody(r.body)) n += jsonLen(r.body);
    if (typeof r.bodyRaw === "string") n += r.bodyRaw.length;
  }
  return n;
}

/** Raw byte weight of a body value as it sits in the trace line. */
function jsonLen(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v)?.length || 0;
  } catch {
    return 0;
  }
}

/**
 * Does this request's history still carry the given message signature?
 * Scanned from the END with an early exit: a superseded request's tip sits
 * a turn or two from the successor's, so the common answer costs a handful
 * of stringifies instead of one per message in the conversation.
 */
function historyHas(pair: TracePair, sig: string): boolean {
  const body = pair.request.body as { messages?: unknown[]; input?: unknown[] } | null;
  const hist = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  for (let i = hist.length - 1; i >= 0; i--) {
    try {
      if ((JSON.stringify(hist[i]) || "").slice(0, 400) === sig) return true;
    } catch {
      // unserializable message — nothing to match against
    }
  }
  return false;
}
