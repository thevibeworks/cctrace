import { describe, test, expect } from "bun:test";
import {
  wireDialect,
  openaiCompleted,
  openaiBlocks,
  normalizeOpenaiTurns,
  openaiSystemText,
  openaiTools,
  openaiFirstUserText,
  extractOpenaiInfo,
} from "../src/dialects/openai";
import { extractCallInfo, extractSessionId } from "../src/summarize";
import { buildSession, mainThread } from "../src/session";
import { wireTables } from "../src/clients";

// Synthetic fixtures mirroring the REAL wire shapes from the 2026-07-14
// codex/grok example traces (devlog entry of that date) — never raw trace
// content. Codex: custom_tool_call + encrypted reasoning + session-id/
// thread-id headers. Grok: function_call + readable reasoning summaries +
// x-grok-conv-id. Both stream SSE whose final response.completed event
// carries the complete output + usage.

const WIRE = wireTables();

function sse(events: any[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join("\n");
}

const COMPLETED = {
  type: "response.completed",
  response: {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-5.6-test",
    output: [
      { type: "reasoning", summary: [], encrypted_content: "gAAAAAB..." },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "All done." }] },
    ],
    usage: {
      input_tokens: 15740,
      input_tokens_details: { cached_tokens: 5888, cache_write_tokens: 100 },
      output_tokens: 17,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 15757,
    },
  },
};

function codexPair(opts: { input: any[]; headers?: Record<string, string>; status?: number; body?: any; id?: string; ts?: number }): any {
  return {
    id: opts.id || "p1",
    client: "codex",
    request: {
      timestamp: opts.ts || 1,
      method: "POST",
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: { "session-id": "sess-1", "thread-id": "thread-1", ...(opts.headers || {}) },
      body: { model: "gpt-5.6-test", stream: true, input: opts.input },
    },
    response:
      opts.status && opts.status >= 400
        ? { timestamp: 2, status: opts.status, headers: {}, body: opts.body }
        : { timestamp: 2, status: 200, headers: { "content-type": "text/event-stream" }, bodyRaw: sse([{ type: "response.created" }, COMPLETED]) },
    duration: 1000,
    loggedAt: "x",
  };
}

const CODEX_INPUT = [
  { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "exec", description: "Run JS" }] },
  { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a coding agent running in the Codex CLI." }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\ncontext block" }] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug please" }] },
  { type: "reasoning", summary: [], encrypted_content: "gAAAAAB..." },
  { type: "custom_tool_call", status: "completed", call_id: "call_A", name: "exec", input: "await tools.exec_command('ls')" },
  { type: "custom_tool_call_output", call_id: "call_A", output: [{ type: "input_text", text: "file1\nfile2" }] },
];

describe("wireDialect", () => {
  const at = (url: string) => wireDialect({ request: { url } });
  test("classifies model calls by path shape", () => {
    expect(at("https://api.anthropic.com/v1/messages?beta=true")).toBe("anthropic");
    expect(at("https://api.anthropic.com/v1/messages/count_tokens")).toBe(null);
    expect(at("https://chatgpt.com/backend-api/codex/responses")).toBe("openai");
    expect(at("https://cli-chat-proxy.grok.com/v1/responses")).toBe("openai");
    expect(at("https://api.x.ai/v1/chat/completions")).toBe("openai");
    expect(at("https://example.com/survey/responses/list")).toBe(null);
    expect(at("https://api.mixpanel.com/track")).toBe(null);
  });
});

describe("openaiCompleted", () => {
  test("returns the response.completed payload from SSE", () => {
    const done = openaiCompleted(codexPair({ input: CODEX_INPUT }));
    expect(done.status).toBe("completed");
    expect(done.usage.input_tokens).toBe(15740);
    expect(done.output).toHaveLength(2);
  });

  test("falls back to output_item.done items on a truncated stream", () => {
    const pair = codexPair({ input: CODEX_INPUT });
    pair.response.bodyRaw = sse([
      { type: "response.created" },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] } },
    ]);
    const done = openaiCompleted(pair);
    expect(done.status).toBe("truncated");
    expect(done.output).toHaveLength(1);
  });

  test("accepts a non-streamed JSON response body", () => {
    const pair = codexPair({ input: CODEX_INPUT });
    pair.response = { timestamp: 2, status: 200, headers: {}, body: COMPLETED.response };
    expect(openaiCompleted(pair).usage.output_tokens).toBe(17);
  });
});

describe("openaiBlocks", () => {
  test("message content: string and typed-part array", () => {
    expect(openaiBlocks({ type: "message", role: "user", content: "hi" })).toEqual([{ type: "text", text: "hi" }]);
    expect(openaiBlocks({ type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] })).toHaveLength(2);
  });

  test("function_call parses JSON arguments (grok shape)", () => {
    const [b] = openaiBlocks({ type: "function_call", call_id: "c1", name: "list_dir", arguments: '{"target_directory":"/x"}' });
    expect(b).toEqual({ type: "tool_use", id: "c1", name: "list_dir", input: { target_directory: "/x" } });
  });

  test("custom_tool_call keeps freeform input raw (codex exec shape)", () => {
    const [b] = openaiBlocks({ type: "custom_tool_call", call_id: "c2", name: "exec", input: "await tools.x()" });
    expect(b.type).toBe("tool_use");
    expect(b.input).toEqual({ input: "await tools.x()" });
  });

  test("tool outputs fold to tool_result, joining text-part arrays", () => {
    const [b] = openaiBlocks({ type: "custom_tool_call_output", call_id: "c2", output: [{ type: "input_text", text: "x" }, { type: "input_text", text: "y" }] });
    expect(b).toEqual({ type: "tool_result", tool_use_id: "c2", content: "xy" });
    const [s] = openaiBlocks({ type: "function_call_output", call_id: "c3", output: "plain" });
    expect(s.content).toBe("plain");
  });

  test("reasoning: readable summaries become thinking, encrypted a placeholder", () => {
    const [g] = openaiBlocks({ type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "thinking about it" }] });
    expect(g).toEqual({ type: "thinking", thinking: "thinking about it" });
    const [c] = openaiBlocks({ type: "reasoning", summary: [], encrypted_content: "gAAA" });
    expect(c.thinking).toBe("(encrypted reasoning)");
  });

  test("additional_tools and unknown items carry no conversation", () => {
    expect(openaiBlocks({ type: "additional_tools", tools: [] })).toEqual([]);
    expect(openaiBlocks({ type: "mystery_item" })).toEqual([]);
  });
});

describe("normalizeOpenaiTurns", () => {
  const turns = normalizeOpenaiTurns(CODEX_INPUT);

  test("folds flat items into alternating role turns", () => {
    expect(turns.map((t: any) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  test("the first developer message is the system prompt, not a turn", () => {
    const texts = turns.flatMap((t: any) => t.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text));
    expect(texts.join(" ")).not.toContain("You are a coding agent");
  });

  test("assistant turn folds reasoning + tool call together", () => {
    const a = turns[1];
    expect(a.blocks.map((b: any) => b.type)).toEqual(["thinking", "tool_use"]);
  });

  test("tool outputs ride user turns and mark toolResultsOnly", () => {
    const last = turns[2];
    expect(last.blocks[0].type).toBe("tool_result");
    expect(last.toolResultsOnly).toBe(true);
  });

  test("a later developer message renders as a user turn (context injection)", () => {
    const t2 = normalizeOpenaiTurns([
      { type: "message", role: "developer", content: "system prompt" },
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "developer", content: "<environment_context>update</environment_context>" },
    ]);
    expect(t2.map((t: any) => t.role)).toEqual(["user"]);
    expect(t2[0].blocks).toHaveLength(2);
  });
});

describe("system/tools/first-user extraction", () => {
  test("openaiSystemText finds the first system/developer message", () => {
    expect(openaiSystemText(CODEX_INPUT)).toContain("You are a coding agent");
    expect(openaiSystemText([{ type: "message", role: "system", content: "You are Grok" }])).toBe("You are Grok");
    expect(openaiSystemText([])).toBe("");
  });

  test("openaiTools merges body.tools with codex additional_tools items", () => {
    const req = { tools: [{ type: "function", name: "bash" }], input: CODEX_INPUT };
    expect(openaiTools(req).map((t: any) => t.name)).toEqual(["bash", "exec"]);
  });

  test("openaiFirstUserText returns the first user message text", () => {
    expect(openaiFirstUserText(CODEX_INPUT)).toContain("AGENTS.md");
  });
});

describe("extractOpenaiInfo / extractCallInfo", () => {
  test("maps Responses usage onto the Anthropic-convention shape", () => {
    const m = extractOpenaiInfo(codexPair({ input: CODEX_INPUT }));
    expect(m.model).toBe("gpt-5.6-test");
    // OpenAI input_tokens INCLUDES cache; ours excludes: 15740 - 5888 - 100
    expect(m.input).toBe(9752);
    expect(m.cacheRead).toBe(5888);
    expect(m.cacheWrite).toBe(100);
    expect(m.output).toBe(17);
    expect(m.thinking).toBe(5);
    expect(m.cachePct).toBe(Math.round((5888 / 15740) * 100));
    expect(m.stopReason).toBe(null);
    expect(m.error).toBe(null);
    expect(m.toolCount).toBe(1);
    expect(m.systemBlocks).toBe(1);
  });

  test("a 4xx surfaces the body detail as the error", () => {
    const m = extractOpenaiInfo(codexPair({ input: CODEX_INPUT, status: 400, body: { detail: "The 'x' model is not supported" } }));
    expect(m.error).toContain("not supported");
  });

  test("extractCallInfo dispatches on dialect", () => {
    const openai = codexPair({ input: CODEX_INPUT });
    expect(extractCallInfo(openai).input).toBe(9752);
    const anthropic = {
      client: "claude",
      request: { url: "https://api.anthropic.com/v1/messages", headers: {}, body: { model: "claude-x", messages: [] } },
      response: { status: 200, body: { usage: { input_tokens: 3, output_tokens: 4 } } },
    };
    expect(extractCallInfo(anthropic).input).toBe(3);
    expect(extractCallInfo(anthropic).output).toBe(4);
  });
});

describe("extractSessionId with wire tables", () => {
  test("codex/grok read their session header; claude keeps body metadata", () => {
    expect(extractSessionId(codexPair({ input: CODEX_INPUT }), WIRE)).toBe("sess-1");
    const grokPair = { client: "grok", request: { url: "https://cli-chat-proxy.grok.com/v1/responses", headers: { "x-grok-session-id": "g-sess" }, body: {} } };
    expect(extractSessionId(grokPair, WIRE)).toBe("g-sess");
    const claudePair = {
      client: "claude",
      request: { url: "https://api.anthropic.com/v1/messages", headers: {}, body: { metadata: { user_id: '{"session_id":"11111111-2222-3333-4444-555555555555"}' } } },
    };
    expect(extractSessionId(claudePair, WIRE)).toBe("11111111-2222-3333-4444-555555555555");
    // without wire (pre-plugin callers), header ids are invisible — no throw
    expect(extractSessionId(codexPair({ input: CODEX_INPUT }))).toBe("");
  });
});

describe("buildSession — OpenAI dialect", () => {
  const short = CODEX_INPUT;
  const long = [
    ...CODEX_INPUT,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "found it" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "now fix it" }] },
  ];

  test("threads key on the wire conv header; turns rebuild from the spine", () => {
    const pairs = [
      codexPair({ id: "a", ts: 1, input: short }),
      codexPair({ id: "b", ts: 2, input: long }),
      codexPair({ id: "c", ts: 3, input: short, headers: { "session-id": "sess-2", "thread-id": "thread-2" } }),
    ];
    const { threads } = buildSession(pairs, WIRE);
    expect(threads).toHaveLength(2);
    const main = mainThread(threads);
    expect(main.key).toBe("conv:thread-1");
    expect(main.usage.requests).toBe(2);
    expect(main.system).toContain("You are a coding agent");
    expect(main.tools.map((t: any) => t.name)).toEqual(["exec"]);
    // spine (long: 5 turns) + streamed response appended
    const roles = main.turns.map((t: any) => t.role);
    expect(roles[roles.length - 1]).toBe("assistant");
    expect(main.turns[main.turns.length - 1].blocks.some((b: any) => b.text === "All done.")).toBe(true);
  });

  test("per-turn usage attributes to the request that produced the turn", () => {
    const pairs = [codexPair({ id: "a", ts: 1, input: short }), codexPair({ id: "b", ts: 2, input: long })];
    const { threads } = buildSession(pairs, WIRE);
    const t = threads[0];
    // request "a" carried 3 normalized turns of history -> produced turn[3]
    const attributed = t.turns.filter((x: any) => x.pairId);
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed[0].usage.output).toBe(17);
  });

  test("codex prewarm probes and grok recap convs classify as utility", () => {
    const prewarm = codexPair({
      id: "w",
      input: short,
      headers: { "session-id": "sess-9", "thread-id": "thread-9", "x-codex-turn-metadata": '{"session_id":"s","request_kind":"prewarm"}' },
    });
    const recap = codexPair({ id: "r", input: short, headers: { "session-id": "", "thread-id": "" } });
    recap.client = "grok";
    recap.request.url = "https://cli-chat-proxy.grok.com/v1/responses";
    recap.request.headers = { "x-grok-conv-id": "recap-abc123" };
    const { threads } = buildSession([prewarm, recap], WIRE);
    expect(threads.map((t: any) => [t.kind, t.label])).toEqual([
      ["utility", "prewarm"],
      ["utility", "recap"],
    ]);
  });

  test("header-less pairs fall back to the first-user-text signature", () => {
    const a = codexPair({ id: "a", input: short, headers: {} });
    const b = codexPair({ id: "b", input: long, headers: {} });
    a.request.headers = {};
    b.request.headers = {};
    const other = codexPair({ id: "c", input: [{ type: "message", role: "user", content: "completely different opener" }], headers: {} });
    other.request.headers = {};
    const { threads } = buildSession([a, b, other], WIRE);
    expect(threads).toHaveLength(2);
    expect(threads[0].usage.requests).toBe(2);
  });

  test("mixed-dialect captures keep anthropic and openai threads apart", () => {
    const anthropic = {
      id: "cl",
      client: "claude",
      request: {
        timestamp: 1,
        url: "https://api.anthropic.com/v1/messages",
        headers: {},
        body: { model: "claude-x", messages: [{ role: "user", content: "hello claude" }] },
      },
      response: { timestamp: 2, status: 200, headers: {}, body: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 2 } } },
      duration: 5,
      loggedAt: "x",
    };
    const { threads } = buildSession([anthropic, codexPair({ input: short })], WIRE);
    expect(threads).toHaveLength(2);
    expect(threads.map((t: any) => t.dialect)).toEqual(["anthropic", "openai"]);
  });
});
