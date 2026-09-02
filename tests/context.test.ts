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
  ctxGroupOf,
  contextGraph,
  ctxFlameTree,
  ctxFlameFind,
  ctxFlameLayout,
  ctxFlameDefault,
  contextTimeline,
  ctxInjectLabel,
  ctxAggregateTurns,
  ctxWindowTurns,
  ctxTurnSig,
  ctxOriginTurn,
  ctxCarrySpan,
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

describe("ctxTextCat: the harness banners are not the human", () => {
  // Measured on a real 91-step session: 97 of 99 "user" blocks were these.
  const BUDGET = "<total_tokens>14944833 tokens left</total_tokens>\n\nProactive output style is active.";
  const HOOK = "SessionStart hook additional context: deadman: auto-handoff from 2026-08-24T06:51Z";
  test("the per-turn token-budget banner is injected context", () => {
    expect(ctxTextCat(BUDGET)).toBe("inject");
    expect(ctxInjectLabel(BUDGET)).toBe("token budget");
  });
  test("SessionStart hook output is injected context", () => {
    expect(ctxTextCat(HOOK)).toBe("inject");
    expect(ctxInjectLabel(HOOK)).toBe("SessionStart hook");
  });
  test("budget banners collapse into ONE graph node, not one per number", () => {
    const msgs: any[] = [{ role: "user", content: [{ type: "text", text: "the actual ask" }] }];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: "assistant", content: [{ type: "text", text: "step " + i }] });
      msgs.push({ role: "user", content: [{ type: "text", text: "<total_tokens>" + (14900000 - i) + " tokens left</total_tokens>\n\nProactive output style is active." }] });
    }
    const g = contextGraph(msgPair(msgs));
    const inj = g.cats.find((c: any) => c.id === "inject");
    expect(inj.groups.length).toBe(1);
    expect(inj.groups[0].count).toBe(5);
    expect(inj.groups[0].label).toBe("token budget");
    // and the human's own words stay exactly one item
    const user = g.cats.find((c: any) => c.id === "user");
    expect(user.count).toBe(1);
  });
  test("a human message that merely mentions the tag is still the human", () => {
    expect(ctxTextCat("why does <total_tokens> show up in my context?")).toBe("user");
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

describe("contextGraph", () => {
  // Three Bash results, two Reads, an MCP tool and a built-in, the same
  // reminder twice — the shapes the graph exists to collapse.
  function busyPair() {
    return msgPair(
      [
        { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "clean this up" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            { type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "a b c" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "pwd" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "b2", content: "/tmp" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "x".repeat(400), is_error: true }] },
        { role: "user", content: [{ type: "text", text: REMINDER }] },
      ],
      {
        tools: [
          { name: "Bash", description: "run", input_schema: { type: "object" } },
          { name: "Read", description: "read", input_schema: { type: "object" } },
          { name: "mcp__docs__search", description: "search", input_schema: { type: "object" } },
          { name: "mcp__docs__fetch", description: "fetch", input_schema: { type: "object" } },
        ],
      },
    );
  }

  test("tool results group by the tool that produced them", () => {
    const g = contextGraph(busyPair());
    const tr = g.cats.find((c: any) => c.id === "toolResult");
    const keys = tr.groups.map((x: any) => x.key).sort();
    expect(keys).toEqual(["t:Bash", "t:Read"]);
    const bash = tr.groups.find((x: any) => x.key === "t:Bash");
    expect(bash.count).toBe(2);
    expect(bash.tokens).toBe(bash.items[0].tokens + bash.items[1].tokens);
    // the Read result came back is_error — the group counts it
    expect(tr.groups.find((x: any) => x.key === "t:Read").err).toBe(1);
  });

  test("tool schemas split built-ins from each MCP server", () => {
    const g = contextGraph(busyPair());
    const tools = g.cats.find((c: any) => c.id === "tools");
    const keys = tools.groups.map((x: any) => x.key).sort();
    expect(keys).toEqual(["builtin", "mcp:docs"]);
    expect(tools.groups.find((x: any) => x.key === "mcp:docs").count).toBe(2);
    expect(tools.groups.find((x: any) => x.key === "mcp:docs").label).toContain("docs");
  });

  test("repeated injections collapse under one producer", () => {
    const g = contextGraph(busyPair());
    const inj = g.cats.find((c: any) => c.id === "inject");
    expect(inj.groups.length).toBe(1);
    expect(inj.groups[0].count).toBe(2);
    expect(inj.groups[0].label.includes("<system-reminder>")).toBe(false);
  });

  test("a reply and the tool calls it made are one node", () => {
    const g = contextGraph(busyPair());
    const asst = g.cats.find((c: any) => c.id === "assistant");
    const first = asst.groups[0];
    expect(first.count).toBe(2); // the text + the tool_use of turn index 1
    expect(first.key).toBe("assistant:1");
  });

  test("groups come back in wire order and every node sums to its category", () => {
    const g = contextGraph(busyPair());
    for (const cat of g.cats) {
      let sum = 0;
      for (const grp of cat.groups) {
        let gs = 0;
        for (const it of grp.items) gs += it.tokens;
        expect(grp.tokens).toBe(gs);
        expect(grp.count).toBe(grp.items.length);
        sum += grp.tokens;
      }
      expect(cat.tokens).toBe(sum);
      expect(cat.count).toBe(cat.groups.reduce((n: number, x: any) => n + x.count, 0));
    }
    // wire order, not size order — ranking is the view's lens, not the data's
    const tr = g.cats.find((c: any) => c.id === "toolResult");
    expect(tr.groups[0].key).toBe("t:Bash");
    // the whole graph sums to the flat walk's estimate
    let est = 0;
    for (const cat of g.cats) est += cat.tokens;
    expect(est).toBe(g.est);
  });

  test("a compact-folded stub has no graph, same as its source walk", () => {
    const p = msgPair([{ role: "user", content: "hi" }]);
    p.request.body = { _cctrace_stub: true, model: "claude-sonnet-5", historyLen: 40 };
    expect(contextGraph(p)).toBeNull();
  });

  test("ctxGroupOf keys are stable across steps", () => {
    // the same tool result in two different requests groups identically —
    // that is what lets fold state survive scrubbing the history chart
    const a = ctxGroupOf("toolResult", { toolName: "Bash", ti: 3 }, 0);
    const b = ctxGroupOf("toolResult", { toolName: "Bash", ti: 41 }, 7);
    expect(a.key).toBe(b.key);
    expect(ctxGroupOf("toolResult", { toolName: "", ti: 0 }, 0).label).toBe("unattributed result");
  });
});

describe("ctxFlameLayout: the graph is a graph", () => {
  function pair() {
    const msgs: any[] = [{ role: "user", content: [{ type: "text", text: "do the thing" }] }];
    // Bash dominates; Read is a mid node; twenty tiny Edits are slivers.
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "x" } }] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "B".repeat(8000) }] });
    msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "a" } }] });
    msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: "R".repeat(2000) }] });
    for (let i = 0; i < 20; i++) {
      msgs.push({ role: "assistant", content: [{ type: "tool_use", id: "e" + i, name: "Edit", input: { file_path: "f" } }] });
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "e" + i, content: "ok" }] });
    }
    return msgPair(msgs);
  }

  test("rows are levels and widths are token shares of the parent", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g);
    expect(fl.rows[0].length).toBe(1);           // the focused node, full width
    expect(fl.rows[0][0].key).toBe("root");
    expect(fl.rows[0][0].w).toBe(100);
    // row 1 is the categories, and they fill the row
    const cats = fl.rows[1];
    expect(cats.length).toBeGreaterThan(1);
    const span = cats.reduce((n: number, x: any) => n + x.w, 0);
    expect(span).toBeGreaterThan(99.9);
    expect(span).toBeLessThan(100.01);
    // every child sits inside its parent's span
    for (const row of fl.rows) for (const n of row) {
      expect(n.x).toBeGreaterThanOrEqual(-0.001);
      expect(n.x + n.w).toBeLessThan(100.01);
    }
  });

  test("the category row never collapses — it is the composition bar's six", () => {
    const g = contextGraph(pair());
    // even with an absurd sliver threshold, row 1 keeps every category:
    // the bar above shows six segments and the graph must show the same six
    const fl = ctxFlameLayout(g, { minW: 40 });
    expect(fl.rows[1].some((n: any) => n.tail)).toBe(false);
    expect(fl.rows[1].length).toBe(g.cats.filter((c: any) => c.count).length);
  });

  test("categories keep CTX_CATS order so the row matches the composition bar", () => {
    const g = contextGraph(pair());
    for (const sort of ["size", "order"]) {
      const ids = ctxFlameLayout(g, { sort }).rows[1].map((n: any) => n.cat);
      const want = CTX_CATS.map(c => c.id).filter(id => ids.indexOf(id) !== -1);
      expect(ids).toEqual(want);
    }
  });

  test("the size lens ranks INSIDE a category, never the categories", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g, { sort: "size" });
    const tr = fl.rows[2].filter((n: any) => n.cat === "toolResult");
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].tail) continue;
      expect(tr[i - 1].tokens).toBeGreaterThanOrEqual(tr[i].tokens);
    }
    expect(tr[0].label).toBe("Bash");
  });

  test("slivers collapse into one labeled, countable node instead of confetti", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g, { sort: "size", minW: 5, tailMin: 3 });
    const tails = [];
    for (const row of fl.rows) for (const n of row) if (n.tail) tails.push(n);
    expect(tails.length).toBeGreaterThan(0);
    expect(tails[0].label).toMatch(/^\+\d+ smaller$/);
    // nothing is silently dropped: a parent's children still sum to it
    const cat = fl.rows[1].find((n: any) => n.cat === "toolResult");
    const kids = fl.rows[2].filter((n: any) => n.x >= cat.x - 0.001 && n.x + n.w <= cat.x + cat.w + 0.001);
    const sum = kids.reduce((n: number, x: any) => n + x.tokens, 0);
    expect(sum).toBe(cat.tokens);
  });

  test("zoom lays the focused subtree across the full width and keeps the breadcrumb", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g, { focus: "c:toolResult" });
    expect(fl.rows[0][0].key).toBe("c:toolResult");
    expect(fl.rows[0][0].w).toBe(100);
    expect(fl.path.map((n: any) => n.key)).toEqual(["root", "c:toolResult"]);
    // percentages stay against the WHOLE request, so a number cannot
    // change meaning when you drill in
    expect(fl.rows[0][0].pct).toBeLessThan(100);
    expect(Math.round(fl.rows[0][0].pct)).toBe(
      Math.round(ctxFlameLayout(g).rows[1].find((n: any) => n.key === "c:toolResult").pct));
  });

  test("a focus key from another step falls back to the root, never to nothing", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g, { focus: "g:toolResult/t:NoSuchTool" });
    expect(fl.focus.key).toBe("root");
    expect(fl.rows[0][0].key).toBe("root");
  });

  test("a one-item group is its item, promoted — no rung for a lone node", () => {
    const g = contextGraph(pair());
    const tree = ctxFlameTree(g, true);
    const tr = tree.kids.find((c: any) => c.cat === "toolResult");
    const read = tr.kids.find((n: any) => n.label === "Read");
    expect(read.kids.length).toBe(0);
    expect(read.item).toBeTruthy();
    expect(ctxFlameFind(tree, read.key)!.map((n: any) => n.key)).toEqual(["root", tr.key, read.key]);
  });

  test("a child never repeats its parent's name in the narrowest column", () => {
    const tree = ctxFlameTree(contextGraph(pair()), true);
    const bash = tree.kids.find((c: any) => c.cat === "toolResult").kids.find((n: any) => n.label === "Bash");
    for (const it of bash.kids) expect(it.label.startsWith("Bash \u2192 ")).toBe(false);
  });

  test("the section opens on the heaviest group holding items", () => {
    const g = contextGraph(pair());
    expect(ctxFlameDefault(g)).toBe("g:toolResult/t:Bash");
  });

  test("a row entry says only whether it can be zoomed, never a child list", () => {
    const fl = ctxFlameLayout(contextGraph(pair()));
    expect(fl.rows[1].every((n: any) => typeof n.hasKids === "boolean")).toBe(true);
    expect(fl.rows[1].find((n: any) => n.cat === "toolResult").hasKids).toBe(true);
  });

  test("narrow nodes carry no label — the hover has it", () => {
    const g = contextGraph(pair());
    const fl = ctxFlameLayout(g, { minW: 0.1 });
    for (const row of fl.rows) for (const n of row) {
      expect(n.lbl).toBe(n.w >= 4);
    }
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

describe("provenance: ctxOriginTurn / ctxTurnSig / ctxWindowTurns", () => {
  const CALL = { type: "tool_use", id: "tu9", name: "Bash", input: { cmd: "ls" } };
  const RES = { type: "tool_result", tool_use_id: "tu9", content: "ok" };
  // The session's spine, as buildSession keeps it — with an ephemeral
  // notice the harness injected at index 1 AFTER the window below was sent.
  const spine = [
    { role: "user", blocks: [{ type: "text", text: "ask" }] },
    { role: "user", blocks: [{ type: "text", text: "<system-reminder>notice</system-reminder>" }] },
    { role: "assistant", blocks: [CALL] },
    { role: "user", blocks: [RES], toolResultsOnly: true },
    { role: "assistant", blocks: [{ type: "text", text: "done" }] },
  ];
  // An older request's window: same turns, no notice — indices drift by one.
  const win = [
    { role: "user", blocks: [{ type: "text", text: "ask" }] },
    { role: "assistant", blocks: [CALL] },
    { role: "user", blocks: [RES] },
  ];
  test("matches by content, so a repacked index still lands on the right spine turn", () => {
    expect(ctxOriginTurn(spine, win, 0)).toBe(0);
    expect(ctxOriginTurn(spine, win, 1)).toBe(2);
    expect(ctxOriginTurn(spine, win, 2)).toBe(3); // tool results match by tool_use id
  });
  test("precomputed sigs give the same answer", () => {
    const sigs = spine.map((s) => ctxTurnSig(s.blocks));
    expect(sigs[3]).toBe("r:tu9");
    expect(ctxOriginTurn(spine, win, 2, sigs)).toBe(3);
  });
  test("repeated content after a compaction resolves to the occurrence nearest the request, not the first in the session", () => {
    // 300-turn spine where the human said "continue" at turns 1, 101, 201
    // and the model replied "ok" after each; the request under review is
    // the reply at index 203, whose (compacted) window holds only the
    // last exchange: [summary, "continue"]. Start-anchoring matched
    // "continue" to index 1 (|1-1| = 0); end-anchoring lands on 201.
    const spine: any[] = [];
    for (let i = 0; i < 300; i++) {
      if (i % 100 === 1) spine.push({ role: "user", blocks: [{ type: "text", text: "continue" }] });
      else if (i % 100 === 2) spine.push({ role: "assistant", blocks: [{ type: "text", text: "ok" }] });
      else spine.push({ role: i % 2 ? "assistant" : "user", blocks: [{ type: "text", text: "turn " + i }] });
    }
    const win = [
      { role: "user", blocks: [{ type: "text", text: "This session is being continued from a previous conversation" }] },
      { role: "user", blocks: [{ type: "text", text: "continue" }] },
    ];
    expect(ctxOriginTurn(spine, win, 1)).toBe(1);            // legacy start anchor: wrong by 200
    expect(ctxOriginTurn(spine, win, 1, undefined, 203)).toBe(201);
    // Mid-session, pre-compaction: the window is the spine's prefix up to
    // the request, and the same anchor still picks the right occurrence.
    const win2 = spine.slice(0, 103);
    expect(ctxOriginTurn(spine, win2, 101, undefined, 103)).toBe(101);
    expect(ctxOriginTurn(spine, win2, 1, undefined, 103)).toBe(1);
  });
  test("no turn, no identity, or nothing matching says -1 rather than guessing", () => {
    expect(ctxOriginTurn(spine, win, -1)).toBe(-1);
    expect(ctxOriginTurn(spine, win, 7)).toBe(-1);
    expect(ctxOriginTurn(spine, [{ role: "user", blocks: [] }], 0)).toBe(-1);
    expect(ctxOriginTurn(spine, [{ role: "user", blocks: [{ type: "text", text: "never sent" }] }], 0)).toBe(-1);
  });
  test("ctxWindowTurns is the request body's history, normalized like contextItems", () => {
    const p = msgPair([{ role: "user", content: "ask" }, { role: "assistant", content: [CALL] }, { role: "user", content: [RES] }]);
    const w = ctxWindowTurns(p);
    expect(w.length).toBe(3);
    expect(w[0].blocks[0].text).toBe("ask");
    expect(ctxWindowTurns({ request: { body: { _cctrace_stub: true } } })).toEqual([]);
  });
});

describe("ctxCarrySpan: how many requests re-sent an item", () => {
  const steps = [
    { pairId: "a" }, { pairId: "b" }, { pairId: "c", mark: "compact" }, { pairId: "d" }, { pairId: "e" },
  ];
  test("runs forward to the next boundary, exclusive, and names it", () => {
    const s = ctxCarrySpan(steps, "a");
    expect(s.n).toBe(2);
    expect(s.from.pairId).toBe("a");
    expect(s.to.pairId).toBe("b");
    expect(s.boundary.pairId).toBe("c");
  });
  test("with a known end it counts through the boundary — the item is in that window", () => {
    const s = ctxCarrySpan(steps, "a", "d");
    expect(s.n).toBe(4);
    expect(s.to.pairId).toBe("d");
    expect(s.boundary).toBeNull();
  });
  test("no boundary ahead: to the thread's last request", () => {
    const s = ctxCarrySpan(steps, "d");
    expect(s.n).toBe(2);
    expect(s.to.pairId).toBe("e");
    expect(s.boundary).toBeNull();
  });
  test("an unknown origin is null; an end before the origin counts the origin alone", () => {
    expect(ctxCarrySpan(steps, "zz")).toBeNull();
    expect(ctxCarrySpan(steps, "d", "a").n).toBe(1);
    expect(ctxCarrySpan([], "a")).toBeNull();
  });
});

describe("contextItems: an image-bearing tool result still has a label", () => {
  test("array content reads its text blocks and marks the image", () => {
    const pair = {
      request: {
        url: "https://api.anthropic.com/v1/messages",
        body: {
          model: "claude-opus-4-1",
          messages: [
            { role: "user", content: "shoot" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__browser__shot", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "text", text: "Successfully captured screenshot" },
            ] }] },
          ],
        },
      },
      response: { status: 200, body: {} },
    };
    const items = contextItems(pair);
    const res = items.cats.toolResult[0];
    expect(res.toolName).toBe("mcp__browser__shot");
    expect(res.label).toContain("[image]");
    expect(res.label).toContain("Successfully captured screenshot");
  });
});
