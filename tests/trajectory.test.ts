import { describe, test, expect } from "bun:test";
import { trajectoryRecords, trajectoryAtLevel } from "../src/context";

// A built thread is what buildSession produces: { turns, system, tools,
// reqs, ... }. trajectoryRecords is a pure function of it — we hand it a
// minimal hand-built thread mirroring a real spine (system prompt, a human
// turn carrying an injected system-reminder + a budget banner, an assistant
// turn that thinks then calls a tool, the tool's result on a following
// user turn, then the reply).
const BUDGET = "<total_tokens>14900000 tokens left</total_tokens>\n\nProactive style active.";
const REMINDER = "<system-reminder>\nAvailable skills: animate-it, kiln.\n</system-reminder>";

const thread = () => ({
  system: [{ type: "text", text: "You are Claude Code." }],
  tools: [{ name: "Bash" }],
  turns: [
    { role: "user", pairId: "p1", blocks: [
      { type: "text", text: REMINDER },
      { type: "text", text: "fix the seal bug" },
      { type: "text", text: BUDGET },
    ] },
    { role: "assistant", pairId: "p1", blocks: [
      { type: "thinking", thinking: "the helper isn't setsid'd, so a closed terminal kills it" },
      { type: "tool_use", id: "tu1", name: "Bash", input: { cmd: "rg seal src" } },
    ] },
    { role: "user", pairId: "p2", toolResultsOnly: true, blocks: [
      { type: "tool_result", tool_use_id: "tu1", content: "14 hits across cli.ts" },
    ] },
    { role: "assistant", pairId: "p2", blocks: [
      { type: "text", text: "archive first, then merge" },
    ] },
  ],
});

describe("trajectoryRecords", () => {
  const recs = trajectoryRecords(thread());
  const kinds = recs.map((r) => r.kind);

  test("emits one linear record per block, in spine order", () => {
    expect(kinds).toEqual(["system", "context", "user", "context", "assistant", "tool", "assistant"]);
  });

  test("context injections are first-class inline records with producer labels", () => {
    const ctx = recs.filter((r) => r.kind === "context");
    expect(ctx).toHaveLength(2);
    // the reminder keeps its own snippet label; the budget banner collapses
    // to its stable producer name (not one row per changing number)
    expect(recs[1].label).not.toBe("token budget");
    expect(recs[3].label).toBe("token budget");
  });

  test("the human's own words stay a user record, not context", () => {
    const user = recs.filter((r) => r.kind === "user");
    expect(user).toHaveLength(1);
    expect(user[0].label).toBe("fix the seal bug");
  });

  test("a tool_use fuses its result: call label + result detail + err flag", () => {
    const tool = recs.find((r) => r.kind === "tool");
    expect(tool.toolName).toBe("Bash");
    expect(tool.label).toBe("Bash");
    expect(tool.detail).toContain("14 hits");
    expect(tool.err).toBe(false);
    expect(tool.result.tool_use_id).toBe("tu1");
  });

  test("thinking is marked, reply is not", () => {
    const asst = recs.filter((r) => r.kind === "assistant");
    expect(asst[0].think).toBe(true);
    expect(asst[1].think).toBe(false);
    expect(asst[1].label).toBe("archive first, then merge");
  });

  test("records carry their working-loop address and wire pair", () => {
    const user = recs.find((r) => r.kind === "user");
    expect(user.ord).toBe(0);      // first working loop
    expect(user.pairId).toBe("p1");
    const tool = recs.find((r) => r.kind === "tool");
    expect(tool.ord).toBe(0);      // same loop (agent work under the human's turn)
    expect(tool.step).toBeGreaterThanOrEqual(1);
  });

  test("an injected user turn is addressed by the step of the request it entered with", () => {
    // head -> reply (step 1, tool call) -> results -> a nudge the harness
    // injected -> reply (step 2). The nudge entered the window with the
    // step-2 request, so it says "step 2" — the same address the Context
    // pane's provenance gives it. A nudge after the final reply: step 0.
    const t = {
      key: "k", system: "", turns: [
        { role: "user", pairId: "p1", blocks: [{ type: "text", text: "do it" }] },
        { role: "assistant", pairId: "p1", blocks: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }] },
        { role: "user", pairId: "p2", toolResultsOnly: true, blocks: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
        { role: "user", pairId: "p2", blocks: [{ type: "text", text: "<system-reminder>Tool loaded.</system-reminder>" }] },
        { role: "assistant", pairId: "p2", blocks: [{ type: "text", text: "done" }] },
        { role: "user", pairId: "p3", blocks: [{ type: "text", text: "<system-reminder>late notice</system-reminder>" }] },
      ],
    };
    const recs = trajectoryRecords(t);
    const ctx = recs.filter((r) => r.kind === "context");
    expect(ctx).toHaveLength(2);
    expect(ctx[0].step).toBe(2);
    expect(ctx[1].step).toBe(0);
    expect(recs.find((r) => r.kind === "tool").step).toBe(1);
    expect(recs.find((r) => r.kind === "assistant" && !r.think).step).toBe(2);
  });

  test("toolResultsOnly turns never become their own records", () => {
    // 4 turns in, one is toolResultsOnly — it must not add a user/context row
    expect(recs.filter((r) => r.pairId === "p2" && r.kind === "user")).toHaveLength(0);
  });

  test("an empty thread is empty, not a crash", () => {
    expect(trajectoryRecords(null)).toEqual([]);
    expect(trajectoryRecords({ turns: [] })).toEqual([]);
  });

  test("an unattributed user turn takes the pair of the request that carried it", () => {
    // Most of a long spine has no pairId of its own — the history arrived
    // inside request bodies whose own requests were never captured. A
    // user turn that answers to no request at all cannot resolve "wire →"
    // and cannot be sliced by the overview's brushed range, so it takes
    // the pair of the NEXT request, the same one its Context-pane
    // provenance names.
    const t = {
      key: "k", system: "",
      turns: [
        { role: "user", blocks: [{ type: "text", text: "the ask" }] },              // no pairId
        { role: "user", blocks: [{ type: "text", text: "<system-reminder>a notice</system-reminder>" }] },
        { role: "assistant", pairId: "pX", blocks: [{ type: "text", text: "done" }] },
      ],
    };
    const r = trajectoryRecords(t);
    expect(r.find((x) => x.kind === "user")!.pairId).toBe("pX");
    expect(r.find((x) => x.kind === "context")!.pairId).toBe("pX");
    expect(r.find((x) => x.kind === "assistant")!.pairId).toBe("pX");
  });
});

describe("trajectoryAtLevel (archify MAP/READ/FULL)", () => {
  const recs = trajectoryRecords(thread());
  test("full keeps everything", () => {
    const { records, hidden } = trajectoryAtLevel(recs, "full");
    expect(records).toHaveLength(recs.length);
    expect(hidden).toBe(0);
  });
  test("read drops banners and bare thinking, keeps substantive context", () => {
    const { records, hidden } = trajectoryAtLevel(recs, "read");
    const kinds = records.map((r) => r.kind);
    expect(kinds).not.toContain(undefined);
    // the token-budget banner and the thinking record are gone
    expect(records.find((r) => r.label === "token budget")).toBeUndefined();
    expect(records.filter((r) => r.kind === "assistant" && r.think)).toHaveLength(0);
    // the skills reminder (substantive context) stays
    expect(records.some((r) => r.kind === "context")).toBe(true);
    expect(hidden).toBe(2);
  });
  test("map is the skeleton: system, human turns, tool calls only", () => {
    const { records } = trajectoryAtLevel(recs, "map");
    expect([...new Set(records.map((r) => r.kind))].sort()).toEqual(["system", "tool", "user"]);
  });
});
