// Session replay: a time cursor over captured pairs.
//
// The trace IS the timeline — every pair carries request.timestamp (seconds)
// and duration (ms), so replay is a viewer-side feature (see
// docs/design/session-replay.md). These are the pure primitives: the wire as
// of a cursor, the event boundaries playback walks, and the tick scheduler.
//
// Like summarize.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — keep them self-contained (cross-calls only
// to other inlined functions by name; no module state).

/** A pair's start on the wall clock, in ms epoch. */
export function pairStartMs(p: any): number {
  return ((p && p.request && p.request.timestamp) || 0) * 1000;
}

/** When a pair's response finished — the moment it becomes "visible". */
export function pairEndMs(p: any): number {
  return pairStartMs(p) + ((p && p.duration) || 0);
}

/** Conversation-bearing pair: /v1/messages, excluding count_tokens probes. */
export function isTurnPair(p: any): boolean {
  let path = "";
  try {
    path = new URL(p.request.url).pathname.toLowerCase();
  } catch {
    path = String((p && p.request && p.request.url) || "").toLowerCase();
  }
  return path.indexOf("/v1/messages") !== -1 && path.indexOf("count_tokens") === -1;
}

/**
 * The event boundaries playback steps through: one per pair, at response end,
 * sorted by time. `turn` marks conversation pairs (the ←/→ stepper's stops);
 * everything else is a minor tick (count_tokens, usage probes, telemetry).
 */
export function replayEvents(pairs: any[]): any[] {
  const out: any[] = [];
  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    out.push({ t: pairEndMs(p), id: p.id, turn: isTurnPair(p) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Wall-clock span of a capture: first request start to last response end. */
export function replaySpan(pairs: any[]): any {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    const s = pairStartMs(p);
    const e = pairEndMs(p);
    if (s < t0) t0 = s;
    if (e > t1) t1 = e;
  }
  return t0 === Infinity ? null : { t0, t1 };
}

/** The wire as of the cursor: every pair whose response had completed. */
export function visibleAt(pairs: any[], cursor: number): any[] {
  return (pairs || []).filter((p) => p && p.request && pairEndMs(p) <= cursor + 0.5);
}

/** First boundary strictly after the cursor (turn boundaries only if asked). */
export function nextBoundary(events: any[], cursor: number, turnsOnly?: boolean): any {
  for (const e of events || []) {
    if (e.t > cursor + 0.5 && (!turnsOnly || e.turn)) return e;
  }
  return null;
}

/** Last boundary strictly before the cursor (turn boundaries only if asked). */
export function prevBoundary(events: any[], cursor: number, turnsOnly?: boolean): any {
  let last: any = null;
  for (const e of events || []) {
    if (e.t >= cursor - 0.5) break;
    if (!turnsOnly || e.turn) last = e;
  }
  return last;
}

/** The boundary at or before the cursor — the deep-link anchor for a moment. */
export function anchorAt(events: any[], cursor: number): any {
  let last: any = null;
  for (const e of events || []) {
    if (e.t > cursor + 0.5) break;
    last = e;
  }
  return last;
}

/**
 * Playback scheduler: from `cursor` at `speed`, when and where is the next
 * tick? Returns {cursor, delay, compressed} or null at the end of the tape.
 * Idle compression caps the on-screen wait at `capMs` (default 2000) — real
 * sessions have 20-minute thinking gaps nobody wants to sit through.
 */
export function nextTick(events: any[], cursor: number, speed: number, capMs?: number): any {
  const e = nextBoundary(events, cursor, false);
  if (!e) return null;
  const cap = capMs == null ? 2000 : capMs;
  const wait = (e.t - cursor) / (speed > 0 ? speed : 1);
  return { cursor: e.t, delay: Math.min(wait, cap), compressed: wait > cap };
}
