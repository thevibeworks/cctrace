import { describe, test, expect } from "bun:test";
import {
  pairStartMs,
  pairEndMs,
  isTurnPair,
  replayEvents,
  replaySpan,
  visibleAt,
  nextBoundary,
  prevBoundary,
  anchorAt,
  nextTick,
} from "../src/replay";

// Timeline fixture: request.timestamp is in SECONDS on the wire, duration in ms.
const pair = (id: string, startSec: number, durMs: number, url = "https://api.anthropic.com/v1/messages") => ({
  id,
  request: { timestamp: startSec, url, method: "POST", headers: {} },
  response: { status: 200, headers: {} },
  duration: durMs,
});

const P = [
  pair("a", 100, 2000), //            ends 102_000
  pair("probe", 103, 500, "https://api.anthropic.com/v1/messages/count_tokens"), // ends 103_500
  pair("usage", 104, 300, "https://api.anthropic.com/api/oauth/usage"), // ends 104_300
  pair("b", 110, 5000), //            ends 115_000
];

describe("time primitives", () => {
  test("start/end convert wire seconds + ms duration to ms epoch", () => {
    expect(pairStartMs(P[0])).toBe(100_000);
    expect(pairEndMs(P[0])).toBe(102_000);
  });

  test("isTurnPair: messages yes, count_tokens and other endpoints no", () => {
    expect(isTurnPair(P[0])).toBe(true);
    expect(isTurnPair(P[1])).toBe(false);
    expect(isTurnPair(P[2])).toBe(false);
  });

  test("replaySpan covers first start to last end; null when empty", () => {
    expect(replaySpan(P)).toEqual({ t0: 100_000, t1: 115_000 });
    expect(replaySpan([])).toBeNull();
  });
});

describe("replayEvents / visibleAt", () => {
  test("one boundary per pair at response end, sorted, turn-flagged", () => {
    const ev = replayEvents([P[3], P[0], P[1]]); // out of order in
    expect(ev.map((e: any) => e.id)).toEqual(["a", "probe", "b"]);
    expect(ev.map((e: any) => e.turn)).toEqual([true, false, true]);
  });

  test("visibleAt returns only pairs whose response completed by the cursor", () => {
    expect(visibleAt(P, 99_000).map((p: any) => p.id)).toEqual([]);
    expect(visibleAt(P, 102_000).map((p: any) => p.id)).toEqual(["a"]);
    expect(visibleAt(P, 104_300).map((p: any) => p.id)).toEqual(["a", "probe", "usage"]);
    expect(visibleAt(P, 999_999).length).toBe(4);
  });
});

describe("boundaries", () => {
  const ev = replayEvents(P);

  test("nextBoundary finds the first event strictly after the cursor", () => {
    expect(nextBoundary(ev, 0).id).toBe("a");
    expect(nextBoundary(ev, 102_000).id).toBe("probe"); // sitting on a -> next
    expect(nextBoundary(ev, 102_000, true).id).toBe("b"); // turns only skips probes
    expect(nextBoundary(ev, 115_000)).toBeNull();
  });

  test("prevBoundary finds the last event strictly before the cursor", () => {
    expect(prevBoundary(ev, 115_000).id).toBe("usage");
    expect(prevBoundary(ev, 115_000, true).id).toBe("a");
    expect(prevBoundary(ev, 102_000)).toBeNull();
  });

  test("anchorAt is the boundary at-or-before the cursor (deep-link anchor)", () => {
    expect(anchorAt(ev, 102_000).id).toBe("a");
    expect(anchorAt(ev, 110_000).id).toBe("usage");
    expect(anchorAt(ev, 1)).toBeNull();
  });
});

describe("nextTick", () => {
  const ev = replayEvents(P);

  test("advances to the next boundary, delay scaled by speed", () => {
    const t = nextTick(ev, 102_000, 1, 60_000);
    expect(t.cursor).toBe(103_500);
    expect(t.delay).toBe(1500);
    expect(t.compressed).toBe(false);
  });

  test("idle compression caps the on-screen wait", () => {
    const t = nextTick(ev, 104_300, 1); // 10.7s real gap to b, default 2s cap
    expect(t.cursor).toBe(115_000);
    expect(t.delay).toBe(2000);
    expect(t.compressed).toBe(true);
  });

  test("speed divides the real gap before capping", () => {
    const t = nextTick(ev, 104_300, 60);
    expect(t.delay).toBeCloseTo(10_700 / 60);
    expect(t.compressed).toBe(false);
  });

  test("returns null at the end of the tape", () => {
    expect(nextTick(ev, 115_000, 1)).toBeNull();
  });
});
