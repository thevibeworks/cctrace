import { describe, test, expect } from "bun:test";
import {
  CTX_CATS,
  CTX_IMG_EST,
  estTokens,
  ctxTextCat,
  ctxBlockTokens,
  ctxEnvelope,
  contextComposition,
  contextItems,
  contextTimeline,
  ctxInjectLabel,
  ctxAggregateTurns,
} from "../src/context";
import { modelWindow } from "../src/pricing";
import { filterCatalog } from "../src/pricing-catalog";

// Wire-shaped fixtures mirroring real captures: each /v1/messages request
// carries the full history-so-far; usage rides the SSE stream.

let seq = 0;
function msgPair(messages: any[], opts: any = {}) {
  seq++;
  const usage = `"usage":{"input_tokens":${opts.input ?? 10},"cache_read_input_tokens":${opts.cacheRead ?? 100},"cache_creation_input_tokens":5,"output_tokens":20}`;
  const sse = [
    `data: {"type":"message_start","message":{"model":"${opts.model || "claude-sonnet-5"}",${usage}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${opts.reply || "reply " + seq}"}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},${usage}}`,
  ].join("\n");
  return {
    id: "pair_" + seq,
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: opts.model || "claude-sonnet-5",
        system: opts.system ?? [{ type: "text", text: "You are Claude Code." }],
        tools: opts.tools ?? [{ name: "Bash", description: "run", input_schema: { type: "object" } }],
        messages,
      },
    },
    response: opts.failed
      ? undefined
      : { timestamp: 1751900001 + seq, status: opts.status ?? 200, headers: {}, bodyRaw: sse },
    duration: 900,
  } as any;
}

const REMINDER = "<system-reminder>\nAs you answer, use the context below.\n</system-reminder>";

describe("ctxTextCat", () => {
  test("system-reminder blocks are injected context", () => {
    expect(ctxTextCat(REMINDER)).toBe("inject");
  });
  test("harness prompts are injected", () => {
    expect(ctxTextCat("The user stepped away and is coming back. Recap.")).toBe("inject");
    expect(ctxTextCat("Tool loaded.")).toBe("inject");
    expect(ctxTextCat("[SYSTEM NOTIFICATION - NOT USER INPUT] task done")).toBe("inject");
  });
  test("continuation summaries are injected", () => {
    expect(ctxTextCat("This session is being continued from a previous conversation...")).toBe("inject");
    expect(ctxTextCat("The conversation so far has been compacted...")).toBe("inject");
  });
  test("openai harness wrappers are injected", () => {
    expect(ctxTextCat("# AGENTS.md instructions\n...")).toBe("inject");
    expect(ctxTextCat("<environment_context>cwd</environment_context>")).toBe("inject");
  });
  test("human text and command wrappers stay user", () => {
    expect(ctxTextCat("fix the bug in ui.ts")).toBe("user");
    expect(ctxTextCat("<command-name>/model</command-name>")).toBe("user");
  });
});

describe("ctxBlockTokens", () => {
  test("text is chars/4 rounded up", () => {
    expect(ctxBlockTokens({ type: "text", text: "abcd" })).toBe(1);
    expect(ctxBlockTokens({ type: "text", text: "abcde" })).toBe(2);
    expect(estTokens(0)).toBe(0);
  });
  test("tool_use prices its serialized input", () => {
    const t = ctxBlockTokens({ type: "tool_use", name: "Bash", input: { command: "ls -la" } });
    expect(t).toBeGreaterThan(0);
  });
  test("tool_result walks nested content blocks", () => {
    const t = ctxBlockTokens({
      type: "tool_result", tool_use_id: "x",
      content: [{ type: "text", text: "12345678" }, { type: "image", source: {} }],
    });
    expect(t).toBe(2 + CTX_IMG_EST);
  });
});

describe("contextComposition", () => {
  test("splits one request into the six categories", () => {
    const p = msgPair([
      { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "do the thing please" }] },
      { role: "assistant", content: [{ type: "text", text: "on it" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file-a file-b file-c" }] },
    ]);
    const c = contextComposition(p);
    expect(c.sums.system).toBe(estTokens("You are Claude Code.".length));
    expect(c.sums.tools).toBeGreaterThan(0);
    expect(c.sums.inject).toBe(estTokens(REMINDER.length));
    expect(c.sums.user).toBe(estTokens("do the thing please".length));
    expect(c.sums.assistant).toBeGreaterThan(0);
    expect(c.sums.toolResult).toBe(estTokens("file-a file-b file-c".length));
    expect(c.est).toBe(
      c.sums.system + c.sums.tools + c.sums.user + c.sums.inject + c.sums.assistant + c.sums.toolResult,
    );
    expect(c.histLen).toBe(3);
    expect(c.toolCount).toBe(1);
  });
  test("string system prompts and string message content work", () => {
    const p = msgPair([{ role: "user", content: "hello" }], { system: "sys text here", tools: [] });
    const c = contextComposition(p);
    expect(c.sums.system).toBe(estTokens("sys text here".length));
    expect(c.sums.user).toBe(estTokens("hello".length));
  });
  test("compact stubs return null (composition is gone)", () => {
    const p = msgPair([{ role: "user", content: "hi" }]);
    p.request.body = { _cctrace_stub: true, kind: "superseded", historyLen: 42 };
    expect(contextComposition(p)).toBeNull();
  });
  test("non-model-call pairs return null", () => {
    const p = msgPair([{ role: "user", content: "hi" }]);
    p.request.url = "https://api.anthropic.com/api/oauth/usage";
    expect(contextComposition(p)).toBeNull();
  });
  test("openai responses requests compose through the dialect", () => {
    const p = {
      id: "op1",
      request: {
        timestamp: 1751900500,
        method: "POST",
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: {},
        body: {
          model: "gpt-5.4",
          tools: [{ type: "function", name: "shell", parameters: {} }],
          input: [
            { type: "message", role: "developer", content: "You are Codex." },
            { type: "message", role: "user", content: "# AGENTS.md instructions\nstuff" },
            { type: "message", role: "user", content: "real prompt" },
            { type: "function_call", call_id: "c1", name: "shell", arguments: '{"command":["ls"]}' },
            { type: "function_call_output", call_id: "c1", output: "files..." },
          ],
        },
      },
      response: { timestamp: 1751900501, status: 200, headers: {}, bodyRaw: "" },
      duration: 500,
    } as any;
    const c = contextComposition(p);
    expect(c.sums.system).toBe(estTokens("You are Codex.".length));
    expect(c.sums.inject).toBe(estTokens("# AGENTS.md instructions\nstuff".length));
    expect(c.sums.user).toBe(estTokens("real prompt".length));
    expect(c.sums.assistant).toBeGreaterThan(0); // the function_call
    expect(c.sums.toolResult).toBe(estTokens("files...".length));
  });
});

describe("contextItems", () => {
  test("items carry labels, and tool_results name their tool", () => {
    const p = msgPair([
      { role: "user", content: [{ type: "text", text: "list the files" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a b c" }] },
    ]);
    const it = contextItems(p);
    expect(it.cats.system.length).toBe(1);
    expect(it.cats.tools[0].label).toBe("Bash");
    expect(it.cats.user[0].label).toBe("list the files");
    expect(it.cats.assistant[0].kind).toBe("tool_use");
    expect(it.cats.toolResult[0].toolName).toBe("Bash");
    expect(it.cats.toolResult[0].label.startsWith("Bash → ")).toBe(true);
    expect(it.est).toBeGreaterThan(0);
  });
  test("reminder text lands under inject with the tag stripped from the label", () => {
    const p = msgPair([{ role: "user", content: [{ type: "text", text: REMINDER }] }]);
    const it = contextItems(p);
    expect(it.cats.inject.length).toBe(1);
    expect(it.cats.inject[0].label.includes("<system-reminder>")).toBe(false);
  });
});

describe("contextTimeline", () => {
  test("steps grow with the conversation and anchor to actual prompt tokens", () => {
    const h1 = [{ role: "user", content: "first prompt" }];
    const h2 = h1.concat([
      { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
      { role: "user", content: "second prompt" },
    ] as any);
    const p1 = msgPair(h1, { input: 50, cacheRead: 0 });
    const p2 = msgPair(h2, { input: 10, cacheRead: 60 });
    const tl = contextTimeline([p1, p2]);
    expect(tl.steps.length).toBe(2);
    expect(tl.steps[0].actualIn).toBe(55); // 50 + 0 + 5 cacheWrite
    expect(tl.steps[1].actualIn).toBe(75);
    expect(tl.steps[1].est).toBeGreaterThan(tl.steps[0].est);
    expect(tl.maxTotal).toBe(75);
  });
  test("a model switch between steps is an event", () => {
    const p1 = msgPair([{ role: "user", content: "hi" }], { model: "claude-sonnet-5" });
    const p2 = msgPair([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "more" }], { model: "claude-fable-5" });
    const tl = contextTimeline([p1, p2]);
    const ev = tl.events.find((e: any) => e.kind === "model");
    expect(ev).toBeTruthy();
    expect(ev.from).toBe("claude-sonnet-5");
    expect(ev.to).toBe("claude-fable-5");
  });
  test("a compaction-scale history drop marks the step and logs the reclaim", () => {
    const long: any[] = [];
    for (let i = 0; i < 12; i++) {
      long.push({ role: "user", content: "prompt " + i });
      long.push({ role: "assistant", content: [{ type: "text", text: "reply " + i }] });
    }
    const p1 = msgPair(long, { input: 5000, cacheRead: 0 });
    const p2 = msgPair([{ role: "user", content: "This session is being continued from a previous conversation. Summary..." }], { input: 400, cacheRead: 0 });
    const tl = contextTimeline([p1, p2]);
    expect(tl.steps[1].mark).toBe("compact");
    const ev = tl.events.find((e: any) => e.kind === "compact");
    expect(ev).toBeTruthy();
    expect(ev.tokens).toBeLessThan(0); // reclaimed
    expect(ev.fromTurns).toBe(24);
    expect(ev.toTurns).toBe(1);
  });
  test("session-layer compaction labels win over the bare drop rule", () => {
    const long: any[] = [];
    for (let i = 0; i < 12; i++) long.push({ role: "user", content: "p" + i }, { role: "assistant", content: "r" + i });
    const p1 = msgPair(long);
    const p2 = msgPair([{ role: "user", content: "back to the start" }]);
    const tl = contextTimeline([p1, p2], [{ at: 3, pairId: p2.id, fromTurns: 24, toTurns: 1, mode: "rewind" }]);
    expect(tl.steps[1].mark).toBe("rewind");
    expect(tl.events.find((e: any) => e.kind === "compact").mode).toBe("rewind");
  });
  test("an injected reminder in an appended turn is an inject event", () => {
    const h1 = [{ role: "user", content: "start" }];
    const h2 = h1.concat([
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "next" }] },
    ] as any);
    const p1 = msgPair(h1);
    const p2 = msgPair(h2);
    const tl = contextTimeline([p1, p2]);
    const inj = tl.events.filter((e: any) => e.kind === "inject");
    expect(inj.length).toBe(1);
    expect(inj[0].tokens).toBe(estTokens(REMINDER.length));
  });
  test("first-step injections (session-start context) are recorded too", () => {
    const p1 = msgPair([
      { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "go" }] },
    ]);
    const tl = contextTimeline([p1]);
    expect(tl.events.filter((e: any) => e.kind === "inject").length).toBe(1);
  });
  test("a tools-envelope change between steps is an event", () => {
    const tools1 = [{ name: "Bash", description: "run", input_schema: {} }];
    const tools2 = tools1.concat([{ name: "WebSearch", description: "search the web with a long schema", input_schema: { type: "object", properties: { query: { type: "string" } } } }] as any);
    const p1 = msgPair([{ role: "user", content: "hi" }], { tools: tools1 });
    const p2 = msgPair([{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }], { tools: tools2 });
    const tl = contextTimeline([p1, p2]);
    const ev = tl.events.find((e: any) => e.kind === "tools");
    expect(ev).toBeTruthy();
    expect(ev.from).toBe(1);
    expect(ev.to).toBe(2);
    expect(ev.tokens).toBeGreaterThan(0);
  });
  test("failed requests keep their bar (est only), stubs keep their usage", () => {
    const p1 = msgPair([{ role: "user", content: "hi" }], { failed: true });
    const p2 = msgPair([{ role: "user", content: "hi" }]);
    p2.request.body = { _cctrace_stub: true, kind: "superseded", historyLen: 7 };
    const tl = contextTimeline([p1, p2]);
    expect(tl.steps[0].failed).toBe(true);
    expect(tl.steps[0].actualIn).toBeNull();
    expect(tl.steps[0].est).toBeGreaterThan(0);
    expect(tl.steps[1].stub).toBe(true);
    expect(tl.steps[1].histLen).toBe(7);
    expect(tl.steps[1].actualIn).toBe(115); // usage survives compact
  });
});

describe("ctxInjectLabel", () => {
  test("names known producers", () => {
    expect(ctxInjectLabel("The user stepped away and is coming back.")).toBe("recap");
    expect(ctxInjectLabel("This session is being continued from a previous conversation")).toBe("continuation summary");
    expect(ctxInjectLabel("# AGENTS.md instructions\n...")).toBe("AGENTS.md");
    expect(ctxInjectLabel("<environment_context>x</environment_context>")).toBe("environment context");
  });
  test("falls back to the reminder's opening words", () => {
    const l = ctxInjectLabel("<system-reminder>As you answer the user's questions, you can use the following context</system-reminder>");
    expect(l.startsWith("As you answer")).toBe(true);
  });
});

describe("ctxAggregateTurns", () => {
  test("one bar per turn, last step's composition wins, marks carry", () => {
    const steps = [
      { pairId: "a", est: 10, failed: false },
      { pairId: "b", est: 20, failed: false },
      { pairId: "c", est: 30, failed: false, mark: "compact" },
      { pairId: "d", est: 5, failed: true },
    ];
    const addr = { a: { ord: 0, step: 1 }, b: { ord: 0, step: 2 }, c: { ord: 1, step: 1 } };
    const turns = ctxAggregateTurns(steps as any, addr);
    expect(turns.length).toBe(2);
    expect(turns[0].steps).toBe(2);
    expect(turns[0].last.pairId).toBe("b");
    expect(turns[1].steps).toBe(2); // c + the addressless failed d
    expect(turns[1].last.pairId).toBe("c"); // failed steps never become the face
    expect(turns[1].mark).toBe("compact");
    expect(turns[1].failed).toBe(1);
  });
});

describe("modelWindow", () => {
  test("reads the catalog, with the same id normalization as pricing", () => {
    const cat = { "claude-fable-5": { input: 10, output: 50, context: 300000 }, "gpt-5.6": { input: 2, output: 8, context: 400000 } };
    expect(modelWindow("claude-fable-5", cat)).toBe(300000);
    expect(modelWindow("gpt-5.6-sol", cat)).toBe(400000); // trailing-segment fallback
  });
  test("classic claude families fall back to 200k offline; unknown-window models to 0", () => {
    expect(modelWindow("claude-sonnet-5", null)).toBe(200000);
    expect(modelWindow("claude-opus-4-6", null)).toBe(200000);
    // Fable/Mythos windows are larger and not publicly fixed — an unknown
    // window must render no %, never a wrong 200k (a real 431k prompt on
    // fable-5 once read "100% of context used").
    expect(modelWindow("claude-fable-5", null)).toBe(0);
    expect(modelWindow("grok-4.5", null)).toBe(0);
    expect(modelWindow("", null)).toBe(0);
  });
});

describe("filterCatalog carries context windows", () => {
  test("limit.context lands on the entry", () => {
    const api = {
      anthropic: {
        models: {
          "claude-fable-5": { cost: { input: 10, output: 50, cache_read: 1 }, limit: { context: 300000, output: 64000 } },
        },
      },
    };
    const cat = filterCatalog(api);
    expect(cat["claude-fable-5"].context).toBe(300000);
  });
});

describe("CTX_CATS", () => {
  test("six categories in stacking order", () => {
    expect(CTX_CATS.map((c) => c.id)).toEqual(["system", "tools", "user", "inject", "assistant", "toolResult"]);
  });
});
