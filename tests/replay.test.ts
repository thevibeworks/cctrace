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
  stateAt,
  stateCounts,
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
describe("sessionLanes / stateAt / stateCounts / beatAt / chaptersOf", () => {
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

  test("stateAt names the lane covering the cursor, and the holes between them", () => {
    expect(stateAt(lanes, 999_000).state).toBe("idle"); // before the first pair
    expect(stateAt(lanes, 1_001_000)).toMatchObject({ state: "model", since: 1_000_000, agentsRunning: 0 });
    expect(stateAt(lanes, 1_004_000)).toMatchObject({ state: "tools", since: 1_002_000 });
    // the 529 died inside the gap: the harness is still running tools
    expect(stateAt(lanes, 1_007_000).state).toBe("tools");
    expect(stateAt(lanes, 1_102_000)).toMatchObject({ state: "waiting", since: 1_100_500 });
    // reply landed, the human hasn't answered yet
    expect(stateAt(lanes, 1_050_000)).toMatchObject({ state: "human", since: 1_011_000 });
    // after the last pair nothing is happening at all
    expect(stateAt(lanes, 2_000_000)).toMatchObject({ state: "idle", since: 1_105_500 });
  });

  test("stateCounts grows with the cursor: a span counts at t0, its ms up to the cursor", () => {
    const mid = stateCounts(lanes, 1_004_000);
    expect(mid.human).toBe(1);
    expect(mid.model).toEqual({ n: 1, ms: 2000, failed: 0 });
    expect(mid.tools).toEqual({ n: 1, ms: 2000, byName: { Bash: 1 } });
    expect(mid.transitions["human>model"]).toBe(1);
    expect(mid.transitions["model>tools"]).toBe(1);
    expect(mid.transitions["tools>model"]).toBe(0); // the gap hasn't closed yet

    const end = stateCounts(lanes, 2_000_000);
    expect(end.human).toBe(2);
    expect(end.model).toEqual({ n: 4, ms: 4000, failed: 1 });
    expect(end.tools).toEqual({ n: 1, ms: 8000, byName: { Bash: 1 } });
    expect(end.waiting).toEqual({ n: 1, ms: 4500 });
    expect(end.agents).toEqual({ n: 0, ms: 0 });
    expect(end.cuts).toBe(0);
    expect(end.transitions).toEqual({
      "human>model": 2, "model>tools": 1, "tools>model": 1,
      "model>agents": 0, "agents>model": 0, "model>reply": 2,
      "model>waiting": 1, "waiting>model": 1, "reply>human": 1,
    });
    expect(stateCounts(lanes, 999_000).model).toEqual({ n: 0, ms: 0, failed: 0 });
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

  test("between the failure and the retry the state is failed, counted as a badge", () => {
    expect(stateAt(lanes, 1_005_000)).toMatchObject({ state: "failed", since: 1_001_000 });
    expect(stateCounts(lanes, 1_005_000).model).toEqual({ n: 0, ms: 0, failed: 1 });
    expect(stateAt(lanes, 1_010_500).state).toBe("model");
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
    const c = stateCounts(lanes, 3_000_000, parent.key);
    expect(c.tools.byName).toEqual({ Task: 2 });
    expect(c.agents).toEqual({ n: 2, ms: 20_500 + 1000 });
    expect(c.transitions["model>agents"]).toBe(1);
    expect(c.transitions["agents>model"]).toBe(2);
  });

  test("stateAt scoped to the parent reports the children running under it", () => {
    expect(stateAt(lanes, 2_020_500, parent.key)).toMatchObject({ state: "agents", agentsRunning: 2 });
    expect(stateAt(lanes, 2_025_000, parent.key)).toMatchObject({ state: "agents", agentsRunning: 1 });
    // a request in flight is the actor even while a child runs
    expect(stateAt(lanes, 2_020_500, lanes.agents[1].threadKey)).toMatchObject({ state: "model", agentsRunning: 0 });
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
    expect(stateCounts(lanes, cut.t - 1).cuts).toBe(0);
    expect(stateCounts(lanes, cut.t).cuts).toBe(1);
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
