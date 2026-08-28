import { describe, test, expect } from "bun:test";
import { buildSession, threadTimeSplit, mainThread } from "../src/session";
import { pairStartMs, pairEndMs } from "../src/replay";
import { wireTables } from "../src/clients";

// Where a thread's wall-clock went (dsh's Trajectory lanes read off the
// wire): synthetic pairs with controlled timestamps and durations.

const sseText = (text: string) => [
  `data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
].join("\n");
const sseTool = (id: string, name: string, input: any) => [
  `data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}}}`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${id}","name":"${name}","input":{}}}`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(JSON.stringify(input))}}}`,
  `data: {"type":"content_block_stop","index":0}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}`,
].join("\n");

function pair(id: string, ts: number, durMs: number, messages: any[], sse: string) {
  return {
    id,
    request: {
      timestamp: ts, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
      body: { model: "claude-sonnet-5", max_tokens: 100, stream: true, system: [{ type: "text", text: "sys" }], tools: [], messages,
        metadata: { user_id: JSON.stringify({ device_id: "d", session_id: "11111111-2222-4333-8444-555555555555" }) } },
    },
    response: { timestamp: ts + durMs / 1000, status: 200, headers: { "content-type": "text/event-stream" }, bodyRaw: sse },
    duration: durMs,
    loggedAt: "x",
  };
}

const U = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const A = (blocks: any[]) => ({ role: "assistant", content: blocks });
const CALL = { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "ls" } };
const RESULT = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] };

describe("threadTimeSplit", () => {
  // loop 1: ask -> tool call (A, 2s) -> [tools run 8s] -> final (B, 1s)
  // loop 2: [human 89s] -> next -> final (C, 0.5s) -> [harness nudge 4.5s] -> final (D, 0.5s)
  const pairs = [
    pair("A", 1000, 2000, [U("ask")], sseTool("tu1", "Bash", { cmd: "ls" })),
    pair("B", 1010, 1000, [U("ask"), A([CALL]), RESULT], sseText("done")),
    pair("C", 1100, 500, [U("ask"), A([CALL]), RESULT, A([{ type: "text", text: "done" }]), U("next")], sseText("sure")),
    pair("D", 1105, 500, [U("ask"), A([CALL]), RESULT, A([{ type: "text", text: "done" }]), U("next"), A([{ type: "text", text: "sure" }]), U("Tool loaded.")], sseText("loaded")),
  ];
  const t = mainThread(buildSession(pairs, wireTables()).threads);
  const byId = (id: string) => pairs.find((p) => p.id === id);

  test("every reply is attributed, so all four requests are on the path", () => {
    expect(t.turns.filter((x: any) => x.role === "assistant").map((x: any) => x.pairId)).toEqual(["A", "B", "C", "D"]);
  });

  test("model / tools / waiting / between add up from wire timestamps", () => {
    const s = threadTimeSplit(t, byId);
    expect(s.steps).toBe(4);
    expect(s.model).toBe(2000 + 1000 + 500 + 500);
    expect(s.tools).toBe(10_000 - 2000);          // A -> B, same loop, A made a call
    expect(s.between).toBe(90_000 - 1000);        // B -> C, the loop ended
    expect(s.waiting).toBe(5000 - 500);           // C -> D, same loop, C made no call (harness nudge)
    expect(s.wall).toBe(105_000 + 500);
    expect(s.byPair.A).toEqual({ t0: 1_002_000, t1: 1_010_000, tools: 8000 });
    expect(s.byPair.C).toEqual({ t0: 1_100_500, t1: 1_105_000, waiting: 4500 });
    expect(s.byPair.B).toBeUndefined();
    expect(s.byPair.D).toBeUndefined();
  });

  test("byPair carries the gap's absolute window: reply end -> next request start", () => {
    const s = threadTimeSplit(t, byId);
    // A ends at 1000s + 2s; B goes on the wire at 1010s. One definition of
    // tools time — the lanes draw exactly the ms this split counts.
    expect(s.byPair.A.t0).toBe(pairEndMs(byId("A")));
    expect(s.byPair.A.t1).toBe(pairStartMs(byId("B")));
    expect(s.byPair.A.t1 - s.byPair.A.t0).toBe(s.byPair.A.tools);
    expect(s.byPair.C.t1 - s.byPair.C.t0).toBe(s.byPair.C.waiting);
  });

  test("a thread with no attributed reply reports zeros, not NaN", () => {
    const s = threadTimeSplit({ turns: [] }, () => null);
    expect(s).toEqual({ wall: 0, model: 0, tools: 0, waiting: 0, between: 0, steps: 0, byPair: {} });
  });

  test("a failed request between two steps is spanned, never counted", () => {
    const failed = { ...pair("X", 1005, 30_000, [U("ask"), A([CALL]), RESULT], ""), response: { timestamp: 1005, status: 529, headers: {}, body: {} } };
    const t2 = mainThread(buildSession([...pairs, failed], wireTables()).threads);
    const all = [...pairs, failed];
    const s = threadTimeSplit(t2, (id: string) => all.find((p) => p.id === id));
    expect(s.steps).toBe(4);
    expect(s.model).toBe(4000);
    expect(s.tools).toBe(8000);
  });
});
