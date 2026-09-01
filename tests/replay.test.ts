import { describe, test, expect } from "bun:test";
import { join } from "path";
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
  sliceWindow,
  stepOutcome,
  sessionLanes,
  soFar,
  axisTicks,
  mergeBusy,
  timeScale,
  scaleX,
  scaleT,
  threadExtent,
  beatAt,
  chaptersOf,
} from "../src/replay";
import { buildSession, mainThread } from "../src/session";
import { readTraceText } from "../src/history";

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

describe("sliceWindow", () => {
  test("keeps pairs whose response completed inside [a, b], inclusive", () => {
    const w = sliceWindow(P, 102_000, 104_300);
    expect(w.map((p: any) => p.id)).toEqual(["a", "probe", "usage"]);
  });

  test("bounds are order-agnostic (a drag can go either direction)", () => {
    expect(sliceWindow(P, 104_300, 102_000).map((p: any) => p.id)).toEqual(["a", "probe", "usage"]);
  });

  test("a window between events is empty; a degenerate window keeps its one pair", () => {
    expect(sliceWindow(P, 105_000, 109_000)).toEqual([]);
    expect(sliceWindow(P, 115_000, 115_000).map((p: any) => p.id)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// The stage layer (docs/design/replay-stage.md): lanes, state, beat.
// Fixtures are real wire shapes run through buildSession — request.timestamp
// in SECONDS, duration in ms, the full conversation-so-far per request.
// ---------------------------------------------------------------------------

const SID = "11111111-2222-4333-8444-555555555555";

function mpair(id: string, ts: number, durMs: number, messages: any[], content: any[], opts: any = {}) {
  const failed = (opts.status || 200) >= 400;
  return {
    id,
    request: {
      timestamp: ts, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
      body: {
        model: "claude-sonnet-5", max_tokens: 100, stream: false, tools: [],
        system: [{ type: "text", text: opts.system || "sys" }],
        messages,
        metadata: { user_id: JSON.stringify({ device_id: "d", session_id: SID }) },
      },
    },
    response: failed
      ? { timestamp: ts + durMs / 1000, status: opts.status, headers: {}, body: { type: "error", error: { type: "overloaded_error" } } }
      : {
          timestamp: ts + durMs / 1000, status: 200, headers: {},
          body: {
            model: "claude-sonnet-5",
            stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn",
            content,
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: opts.cacheRead == null ? 100 : opts.cacheRead,
              cache_creation_input_tokens: 5,
              output_tokens: 20,
            },
          },
        },
    duration: durMs,
    loggedAt: "x",
  };
}

const U = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const A = (blocks: any[]) => ({ role: "assistant", content: blocks });
const TXT = (text: string) => ({ type: "text", text });

describe("stepOutcome", () => {
  const CALL = { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } };
  const TASK = { type: "tool_use", id: "tu2", name: "Task", input: { subagent_type: "Explore", description: "look", prompt: "go" } };
  const ok = { response: { status: 200 } };

  test("a reply with tool calls goes to tools, carrying the calls in wire order", () => {
    const o = stepOutcome({ blocks: [TXT("on it"), CALL], usage: { stopReason: "tool_use" } }, false, ok);
    expect(o.next).toBe("tools");
    expect(o.stop).toBe("tool_use");
    expect(o.calls.map((c: any) => c.name)).toEqual(["Bash"]);
    expect(o.spawns).toEqual([]);
    expect(o.err).toBe(false);
  });

  test("a spawn outranks a plain call — the step is agents, both are counted", () => {
    const o = stepOutcome({ blocks: [CALL, TASK] }, false, ok);
    expect(o.next).toBe("agents");
    expect(o.calls.length).toBe(2);
    expect(o.spawns).toEqual([{ id: "tu2", name: "Task", agentType: "Explore", description: "look" }]);
  });

  test("task-tracking TaskCreate spawns nothing — the shape decides, not the name", () => {
    const o = stepOutcome({ blocks: [{ type: "tool_use", id: "t3", name: "TaskCreate", input: { subject: "ship it" } }] }, false, ok);
    expect(o.next).toBe("tools");
    expect(o.spawns).toEqual([]);
  });

  test("the loop's final with no calls is a reply; a call-less step inside one is waiting", () => {
    expect(stepOutcome({ blocks: [TXT("done")] }, true, ok).next).toBe("reply");
    expect(stepOutcome({ blocks: [TXT("thinking out loud")] }, false, ok).next).toBe("waiting");
  });

  test("a failed request goes nowhere", () => {
    const o = stepOutcome({ blocks: [] }, true, { response: { status: 529 } });
    expect(o.next).toBe("failed");
    expect(o.err).toBe(true);
    expect(stepOutcome({ blocks: [] }, true, { response: null }).err).toBe(true);
  });
});

// loop 1: ask -> Bash call (A, 2s) -> [tools 8s, a 529 dies inside it] -> done (B, 1s)
// loop 2: [human 89s] -> next -> sure (C, 0.5s) -> [harness nudge 4.5s] -> loaded (D, 0.5s)
describe("sessionLanes / soFar / beatAt / chaptersOf", () => {
  const CALL = { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls", description: "list" } };
  const RES = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file.txt" }] };
  const h1 = [U("ask")];
  const h2 = [U("ask"), A([CALL]), RES];
  const h3 = [...h2, A([TXT("done")]), U("next")];
  const h4 = [...h3, A([TXT("sure")]), U("Tool loaded.")];
  const pairs = [
    mpair("A", 1000, 2000, h1, [CALL]),
    mpair("X", 1005, 1000, h2, [], { status: 529 }),
    mpair("B", 1010, 1000, h2, [TXT("done")], { cacheRead: 200 }),
    mpair("C", 1100, 500, h3, [TXT("sure")]),
    mpair("D", 1105, 500, h4, [TXT("loaded")]),
  ];
  const byId = (id: string) => pairs.find((p) => p.id === id);
  const t = mainThread(buildSession(pairs).threads);
  const lanes = sessionLanes([t], byId);

  test("model spans are the pairs; the failed request is a mark, never a span", () => {
    expect(lanes.model.map((m: any) => [m.pairId, m.t0, m.t1, m.ord, m.step, m.next])).toEqual([
      ["A", 1_000_000, 1_002_000, 0, 1, "tools"],
      ["B", 1_010_000, 1_011_000, 0, 2, "reply"],
      ["C", 1_100_000, 1_100_500, 1, 1, "waiting"],
      ["D", 1_105_000, 1_105_500, 1, 2, "reply"],
    ]);
    expect(lanes.model[0].stop).toBe("tool_use");
    expect(lanes.failed).toEqual([{ t: 1_006_000, threadKey: t.key, pairId: "X", status: 529 }]);
    expect(lanes.t0).toBe(1_000_000);
    expect(lanes.t1).toBe(1_105_500);
  });

  test("the tools gap SPANS the failed request and is threadTimeSplit's own window", () => {
    expect(lanes.tools).toEqual([
      { t0: 1_002_000, t1: 1_010_000, threadKey: t.key, pairId: "A", names: ["Bash"], count: 1 },
    ]);
    expect(lanes.waiting).toEqual([
      { t0: 1_100_500, t1: 1_105_000, threadKey: t.key, pairId: "C" },
    ]);
  });

  test("human points sit at the start of the request that carried the prompt", () => {
    expect(lanes.human).toEqual([
      { t: 1_000_000, threadKey: t.key, ord: 0, label: "ask", pairId: "A" },
      { t: 1_100_000, threadKey: t.key, ord: 1, label: "next", pairId: "C" },
    ]);
    // "Tool loaded." heads no turn — the harness came back on its own.
    expect(lanes.human.length).toBe(2);
  });

  test("soFar tallies steps, calls by name, children, failures and cuts", () => {
    expect(soFar(lanes, 999_000)).toEqual({ steps: 0, tools: {}, agents: 0, failed: 0, cuts: 0 });
    expect(soFar(lanes, 1_004_000)).toEqual({ steps: 1, tools: { Bash: 1 }, agents: 0, failed: 0, cuts: 0 });
    expect(soFar(lanes, 2_000_000)).toEqual({ steps: 4, tools: { Bash: 1 }, agents: 0, failed: 1, cuts: 0 });
  });

  test("threadExtent is the thread's own window and the time inside it that worked", () => {
    const ex = threadExtent(lanes, t.key);
    expect(ex.t0).toBe(1_000_000);
    expect(ex.t1).toBe(1_105_500);
    // the model spans, the tools gap and the retry fuse into one busy run;
    // the 89s the human spent thinking between the loops is NOT busy — it is
    // exactly the kind of hole the axis compresses.
    expect(ex.busy).toEqual([
      [1_000_000, 1_011_000],
      [1_100_000, 1_105_500],
    ]);
    // no key = every item in the lanes; a key nothing carries = nothing
    expect(threadExtent(lanes, "")).toEqual(ex);
    expect(threadExtent(lanes, "no-such-thread")).toBeNull();
    expect(threadExtent(null, "")).toBeNull();
  });

  test("beatAt is the step whose pair END is the latest at or before the cursor", () => {
    expect(beatAt(t, 999_000, byId)).toBeNull();
    const b1 = beatAt(t, 1_005_000, byId);
    expect(b1).toMatchObject({ ord: 0, step: 1, pairId: "A", t0: 1_000_000, t1: 1_002_000, dur: 2000, next: "tools", stop: "tool_use" });
    expect(b1.calls).toEqual([{ name: "Bash", preview: "list · $ ls", ok: true, resultPreview: "file.txt" }]);
    expect(b1.reply).toBeNull();
    // provider-reported window: input + cache read + cache write; the first
    // step grew from nothing, so its delta IS its window.
    expect(b1.tokens).toEqual({ prompt: 115, delta: 115, cachePct: 87 });

    const b2 = beatAt(t, 1_050_000, byId);
    expect(b2).toMatchObject({ ord: 0, step: 2, pairId: "B", next: "reply", reply: "done" });
    expect(b2.calls).toEqual([]);
    expect(b2.tokens.prompt).toBe(215);
    expect(b2.tokens.delta).toBe(100); // 215 - 115
    expect(beatAt(t, 9_000_000, byId).pairId).toBe("D");
  });

  test("the beat carries its loop's head — the task the step serves", () => {
    expect(beatAt(t, 1_005_000, byId).head).toBe("ask");
    expect(beatAt(t, 1_050_000, byId).head).toBe("ask");
    // loop 1's head is the human's "next"; the harness's "Tool loaded."
    // joined that loop, it never headed one
    expect(beatAt(t, 9_000_000, byId).head).toBe("next");
  });

  test("chapters are the working loops with a head, ordinals from loopTurns", () => {
    expect(chaptersOf(t, byId)).toEqual([
      { ord: 0, headIdx: 0, pairId: "A", t: 1_000_000, label: "ask", injected: "" },
      { ord: 1, headIdx: 3, pairId: "C", t: 1_100_000, label: "next", injected: "" },
    ]);
    // without pairOf the shape holds, the clock stays honestly 0
    expect(chaptersOf(t).map((c: any) => c.t)).toEqual([0, 0]);
  });
});

describe("sessionLanes: a failed request holds the hole until its retry", () => {
  // The 429/529 shape: the first request dies, the retry lands 10s later.
  const pairs = [
    mpair("F", 1000, 1000, [U("ask")], [], { status: 529 }),
    mpair("R", 1010, 1000, [U("ask")], [TXT("done")]),
  ];
  const byId = (id: string) => pairs.find((p) => p.id === id);
  const t = mainThread(buildSession(pairs).threads);
  const lanes = sessionLanes([t], byId);

  test("the failure is a mark, the retry is the only model span", () => {
    expect(lanes.model.map((m: any) => m.pairId)).toEqual(["R"]);
    expect(lanes.failed.map((f: any) => [f.pairId, f.t, f.status])).toEqual([["F", 1_001_000, 529]]);
  });

  test("the tally counts the failure before any step completed", () => {
    expect(soFar(lanes, 1_005_000)).toMatchObject({ steps: 0, failed: 1 });
  });
});

describe("sessionLanes: parallel subagents stack on rows", () => {
  const PA = "Explore the repository and report its architecture.";
  const PB = "Review the docs and list every stale claim.";
  const TA = { type: "tool_use", id: "tu_a", name: "Task", input: { subagent_type: "Explore", description: "explore repo", prompt: PA } };
  const TB = { type: "tool_use", id: "tu_b", name: "Task", input: { subagent_type: "Review", description: "review docs", prompt: PB } };
  const AGENT_SYS = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const pairs = [
    mpair("M1", 2000, 1000, [U("map this")], [TA, TB]),
    mpair("a1", 2010, 1000, [U(PA)], [TXT("part 1")], { system: AGENT_SYS }),
    mpair("b1", 2020, 1000, [U(PB)], [TXT("report B")], { system: AGENT_SYS }),
    mpair("a2", 2030, 500, [U(PA), A([TXT("part 1")]), U("go on")], [TXT("report A")], { system: AGENT_SYS }),
    mpair("M2", 2200, 500, [
      U("map this"),
      A([TA, TB]),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: "A done" }, { type: "tool_result", tool_use_id: "tu_b", content: "B done" }] },
    ], [TXT("done")]),
  ];
  const byId = (id: string) => pairs.find((p) => p.id === id);
  const { threads } = buildSession(pairs);
  const parent = mainThread(threads);
  const lanes = sessionLanes(threads, byId);

  test("both dispatches link, and overlapping children never share a row", () => {
    expect(lanes.agents.map((a: any) => [a.agentType, a.t0, a.t1, a.row, a.parentPairId])).toEqual([
      ["Explore", 2_010_000, 2_030_500, 0, "M1"],
      ["Review", 2_020_000, 2_021_000, 1, "M1"],
    ]);
    expect(lanes.agents[0].label).toBe("[Explore] explore repo");
    expect(lanes.agents.every((a: any) => a.parentKey === parent.key)).toBe(true);
  });

  test("the spawning step is `agents`, and its gap counts both calls by name", () => {
    const m1 = lanes.model.find((m: any) => m.pairId === "M1");
    expect(m1.next).toBe("agents");
    expect(lanes.tools.find((g: any) => g.pairId === "M1")).toMatchObject({ names: ["Task", "Task"], count: 2 });
    expect(soFar(lanes, 3_000_000, parent.key)).toEqual({
      steps: 2, tools: { Task: 2 }, agents: 2, failed: 0, cuts: 0,
    });
  });

  test("a thread's extent covers the children it spawned; a child's covers only itself", () => {
    const p = threadExtent(lanes, parent.key);
    // the parent's own requests are 2_000_000..2_200_500, but the children it
    // dispatched are its time too (the strip draws them in its focus)
    expect(p.t0).toBe(2_000_000);
    expect(p.t1).toBe(2_200_500);
    const child = threadExtent(lanes, lanes.agents[1].threadKey);
    expect([child.t0, child.t1]).toEqual([2_020_000, 2_021_000]);
  });

});

describe("sessionLanes: cuts (real compaction fixture)", () => {
  // The same sanitized triple-packing session tests/session-compaction.test.ts
  // pins: one fold boundary on the main conversation, three verified spawns.
  const pairs = readTraceText(join(import.meta.dir, "fixtures", "compaction-session.jsonl.zst"))
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const index: any = {};
  for (const p of pairs) index[p.id] = p;
  const { threads } = buildSession(pairs);
  const main = mainThread(threads);
  const lanes = sessionLanes(threads, (id: string) => index[id]);

  test("the fold boundary is a cut at that request's pair moment", () => {
    const cut = lanes.cuts.find((c: any) => c.pairId === "1784536387048_6t");
    expect(cut).toBeTruthy();
    expect(cut.mode).toBe("fold");
    expect(cut.threadKey).toBe(main.key);
    expect(cut.t).toBe(pairEndMs(index["1784536387048_6t"]));
    expect(soFar(lanes, cut.t - 1).cuts).toBe(0);
    expect(soFar(lanes, cut.t).cuts).toBe(1);
  });

  test("every verified spawn is an agent span inside the trace's own window", () => {
    expect(lanes.agents.length).toBe(3);
    for (const a of lanes.agents) {
      expect(a.t1).toBeGreaterThanOrEqual(a.t0);
      expect(a.t0).toBeGreaterThanOrEqual(lanes.t0);
      expect(a.t1).toBeLessThanOrEqual(lanes.t1);
    }
  });
});

describe("beatAt: a harness-authored head is not the task", () => {
  const pairs = [
    mpair("N1", 3000, 1000, [U("[SYSTEM NOTIFICATION] the sandbox restarted")], [TXT("noted")]),
  ];
  const byId = (id: string) => pairs.find((p) => p.id === id);
  const t = mainThread(buildSession(pairs).threads);

  test("head is empty when the harness wrote the prompt that opened the loop", () => {
    expect(beatAt(t, 9_000_000, byId).head).toBe("");
  });
});

// The strip's axis: wall-clock to pixels, with the thread's idle compressed
// to a fixed column. One mapping, two inverses — every mark on the strip and
// every pointer handler goes through it.
describe("timeScale / scaleX / scaleT", () => {
  const MIN = 60_000;
  const T = 1_000_000;
  const IDLE = 5 * MIN;
  const BRK = 28;

  test("mergeBusy sorts, fuses touching and overlapping runs, keeps points", () => {
    expect(mergeBusy([[30, 40], [0, 10], [10, 20], [15, 25]])).toEqual([[0, 25], [30, 40]]);
    expect(mergeBusy([[5, 5], [9, 8]])).toEqual([[5, 5], [8, 9]]);
    expect(mergeBusy([null, [NaN, 1]] as any)).toEqual([]);
  });

  test("no qualifying gap: ONE linear segment, and every position is what it was", () => {
    const sc = timeScale([[T, T + MIN], [T + 2 * MIN, T + 4 * MIN]], T, T + 4 * MIN, 1000, IDLE, BRK);
    expect(sc.segs.length).toBe(1);
    expect(sc.segs[0]).toEqual({ t0: T, t1: T + 4 * MIN, x0: 0, x1: 1000, kind: "busy" });
    expect(scaleX(sc, T)).toBe(0);
    expect(scaleX(sc, T + 2 * MIN)).toBe(500);
    expect(scaleX(sc, T + 9 * MIN)).toBe(1000); // clamped, both ends
    expect(scaleX(sc, T - MIN)).toBe(0);
    expect(scaleT(sc, 250)).toBe(T + MIN);
    expect(scaleT(sc, -50)).toBe(T);
    expect(scaleT(sc, 5000)).toBe(T + 4 * MIN);
  });

  test("a 20-minute hole becomes a fixed 28px break between two busy segments", () => {
    const busy = [[T, T + 2 * MIN], [T + 22 * MIN, T + 24 * MIN]];
    const sc = timeScale(busy, T, T + 24 * MIN, 1000, IDLE, BRK);
    expect(sc.segs.map((s: any) => s.kind)).toEqual(["busy", "break", "busy"]);
    expect(sc.px).toBe(1000);
    // the break costs exactly 28px; the two busy stretches share the rest in
    // proportion to their real duration (2 minutes each, so 486 each)
    expect(sc.segs[1].x1 - sc.segs[1].x0).toBe(28);
    expect(sc.segs[0].x1 - sc.segs[0].x0).toBeCloseTo(486, 6);
    expect(sc.segs[2].x1 - sc.segs[2].x0).toBeCloseTo(486, 6);
    expect(sc.segs[2].x1).toBe(1000);
    // a moment inside the hole lands inside the break's own column
    const mid = scaleX(sc, T + 12 * MIN);
    expect(mid).toBeGreaterThan(sc.segs[1].x0);
    expect(mid).toBeLessThan(sc.segs[1].x1);
    // ...and the two functions are inverses everywhere, break included
    for (const t of [T, T + MIN, T + 2 * MIN, T + 12 * MIN, T + 22 * MIN, T + 24 * MIN]) {
      expect(scaleT(sc, scaleX(sc, t))).toBeCloseTo(t, 3);
    }
    for (const x of [0, 100, 490, 500, 512, 700, 1000]) {
      expect(scaleX(sc, scaleT(sc, x))).toBeCloseTo(x, 3);
    }
  });

  test("only INTERIOR idle compresses: the edges of the span stay real time", () => {
    // a request still in flight stretches the axis past the last busy span;
    // that trailing stretch is not a gap between two runs, so it draws.
    const sc = timeScale([[T + 10 * MIN, T + 11 * MIN]], T, T + 30 * MIN, 1000, IDLE, BRK);
    expect(sc.segs.length).toBe(1);
    expect(sc.segs[0].kind).toBe("busy");
  });

  test("more breaks than track: one honest linear segment, never a negative width", () => {
    const busy: number[][] = [];
    for (let i = 0; i < 40; i++) busy.push([T + i * 10 * MIN, T + i * 10 * MIN + 1]);
    const sc = timeScale(busy, T, T + 400 * MIN, 1000, IDLE, BRK); // 39 * 28 > 1000
    expect(sc.segs.length).toBe(1);
    expect(sc.segs[0].kind).toBe("busy");
  });

  test("degenerate inputs degrade to the linear segment", () => {
    expect(timeScale([], T, T, 500, IDLE, BRK).segs.length).toBe(1);
    expect(timeScale([], T + 1, T, 500, IDLE, BRK).segs.length).toBe(1);
    const zero = timeScale([], T, T + MIN, 0, IDLE, BRK);
    expect(zero.px).toBe(1);
    expect(scaleX(zero, T + MIN)).toBe(1);
    expect(scaleX(null, T)).toBe(0);
    expect(scaleT({ segs: [], t0: T }, 10)).toBe(T);
  });
});

// The strip's clock ruler. Pure: the caller supplies the timezone offset, so
// the same trace draws the same ruler wherever it is read.
describe("axisTicks", () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  // 2026-08-28 00:00:00 UTC
  const T = Date.UTC(2026, 7, 28, 0, 0, 0);

  test("empty when there is no track or no span", () => {
    expect(axisTicks(0, HOUR, 0, 0)).toEqual([]);
    expect(axisTicks(HOUR, HOUR, 1000, 0)).toEqual([]);
    expect(axisTicks(HOUR, 0, 1000, 0)).toEqual([]);
  });

  test("picks the finest ladder step that still lands ticks >= 72px apart", () => {
    // 4h over 1400px: 10m would land 58px apart, 15m lands 87.5px.
    const ticks = axisTicks(T, T + 4 * HOUR, 1400, 0);
    expect(ticks.length).toBeGreaterThan(2);
    const step = ticks[1].t - ticks[0].t;
    expect([900_000, 1_800_000]).toContain(step);
    expect((step / (4 * HOUR)) * 1400).toBeGreaterThanOrEqual(72);
    // ticks are aligned to the clock, not to the span's start
    for (const k of ticks) expect(k.t % step).toBe(0);
    expect(ticks[0].t).toBeGreaterThanOrEqual(T);
  });

  test("labels are HH:MM in local time, HH:MM:SS under a minute", () => {
    // UTC+8 (getTimezoneOffset() is -480 there)
    const local = axisTicks(T, T + 4 * HOUR, 1400, -480);
    expect(local[0].label).toBe("08:00");
    expect(axisTicks(T, T + 4 * HOUR, 1400, 0)[1].label).toBe("00:15");
    // a 30s span at 1200px: the 1s step fits, so seconds are on the label
    const fine = axisTicks(T, T + 30_000, 1200, 0);
    expect(fine[1].label).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(fine[1].t - fine[0].t).toBe(5000);
  });

  test("the first tick of a local calendar day is major and names the date", () => {
    const ticks = axisTicks(T - 3 * HOUR, T + 3 * HOUR, 900, 0);
    const major = ticks.filter((k: any) => k.major);
    expect(major.length).toBe(1);
    expect(major[0].t).toBe(T);
    expect(major[0].label).toBe("08-28 00:00");
    expect(ticks.every((k: any) => k.major || !/-/.test(k.label))).toBe(true);
    // and a day boundary that only exists in LOCAL time is the one marked
    const shifted = axisTicks(T - DAY / 2, T + DAY / 2, 900, -480);
    expect(shifted.filter((k: any) => k.major).map((k: any) => k.t)).toEqual([T - 8 * HOUR]);
  });

  test("a merged multi-day session keeps the 72px floor — a day step is multiplied", () => {
    // 30 days at 900px: the ladder's top rung (1d) lands 30px apart, which
    // would draw 31 ticks of mush, every one of them major.
    const span = 30 * DAY;
    const ticks = axisTicks(T, T + span, 900, 0);
    expect(ticks.length).toBeGreaterThan(1);
    const step = ticks[1].t - ticks[0].t;
    expect((step / span) * 900).toBeGreaterThanOrEqual(72);
    expect(step % DAY).toBe(0); // still local midnights, so the labels are dates
    expect(ticks.every((k: any) => k.major)).toBe(true);
  });
});
