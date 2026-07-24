import { describe, test, expect } from "bun:test";
import {
  firstUserText,
  threadSig,
  normalizeTurns,
  buildToolResultIndex,
  responseBlocks,
  buildSession,
  threadEpochs,
  turnSnippet,
  mainThread,
  toolPreview,
  wsPath,
  cwdFromText,
} from "../src/session";

// Wire-shaped fixtures mirroring real captures (see .cctrace/*.jsonl):
// each /v1/messages request carries the full history-so-far; the streamed
// response is SSE in bodyRaw.

let seq = 0;
function msgPair(messages: any[], opts: any = {}) {
  seq++;
  const sse = [
    `data: {"type":"message_start","message":{"model":"${opts.model || "claude-sonnet-5"}","usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":5,"output_tokens":1}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${opts.reply || "reply " + seq}"}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":5,"output_tokens":20}}`,
  ].join("\n");
  return {
    id: "pair_" + seq,
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages?beta=true",
      headers: {},
      body: {
        model: opts.model || "claude-sonnet-5",
        max_tokens: opts.maxTokens ?? 32000,
        stream: true,
        system: opts.system ?? [{ type: "text", text: "You are Claude Code" }],
        tools: opts.tools ?? [],
        messages,
      },
    },
    response: opts.response ?? {
      timestamp: 1751900002 + seq,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      bodyRaw: sse,
    },
    duration: 1500,
    loggedAt: "x",
  };
}

// Claude Code prepends the SAME <system-reminder> context block (claudeMd,
// hook output) to the first user message of every thread — main and all
// subagents. The signature must key on the user text, never the reminder.
const REMINDER = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n" + "x".repeat(500) + "\n</system-reminder>";

describe("firstUserText", () => {
  test("skips injected reminder blocks, returns the real prompt", () => {
    expect(firstUserText([{ type: "text", text: REMINDER }, { type: "text", text: "do the thing" }])).toBe("do the thing");
    expect(firstUserText("plain")).toBe("plain");
    expect(firstUserText([{ type: "text", text: "no reminder" }])).toBe("no reminder");
  });

  test("all-reminder content falls back to the first block", () => {
    expect(firstUserText([{ type: "text", text: REMINDER }])).toBe(REMINDER);
    expect(firstUserText([{ type: "tool_result", content: "x" }])).toBe("");
    expect(firstUserText(null)).toBe("");
  });
});

describe("threadSig", () => {
  test("keys on user text: same text -> same signature, regardless of block shape", () => {
    const a = threadSig({ role: "user", content: "hello" });
    expect(threadSig({ role: "user", content: "hello" })).toBe(a);
    expect(threadSig({ role: "user", content: "other" })).not.toBe(a);
    expect(threadSig({ role: "user", content: [{ type: "text", text: "hello" }] })).toBe(a);
  });

  test("identical reminder prefixes do not collide different prompts", () => {
    const a = threadSig({ content: [{ type: "text", text: REMINDER }, { type: "text", text: "prompt A" }] });
    const b = threadSig({ content: [{ type: "text", text: REMINDER }, { type: "text", text: "prompt B" }] });
    expect(a).not.toBe(b);
  });

  test("never throws on garbage", () => {
    expect(typeof threadSig(null)).toBe("string");
    expect(typeof threadSig({ content: undefined })).toBe("string");
  });
});

describe("normalizeTurns / buildToolResultIndex", () => {
  test("string content becomes a text block; result-only turns flagged", () => {
    const turns = normalizeTurns([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file.txt" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "x" }, { type: "text", text: "and also" }] },
    ]);
    expect(turns[0].blocks).toEqual([{ type: "text", text: "hi" }]);
    expect(turns[2].toolResultsOnly).toBe(true);
    expect(turns[3].toolResultsOnly).toBe(false); // mixed content stays visible
    const idx = buildToolResultIndex(turns);
    expect(Object.keys(idx).sort()).toEqual(["tu_1", "tu_2"]);
    expect(idx.tu_1.content).toBe("file.txt");
  });
});

describe("buildSession", () => {
  test("groups by first message, reconstructs spine + response, attributes per-turn usage", () => {
    seq = 0;
    const first = { role: "user", content: "build me a thing" };
    const r1 = msgPair([first], { reply: "turn one" });
    const r2 = msgPair(
      [first, { role: "assistant", content: [{ type: "text", text: "turn one" }] }, { role: "user", content: "continue" }],
      { reply: "turn two" },
    );
    const probe = msgPair([{ role: "user", content: "quota" }], { maxTokens: 1, model: "claude-haiku-4-5", system: null });
    const title = msgPair([{ role: "user", content: "<session>hi</session>" }], {
      model: "claude-haiku-4-5",
      system: [{ type: "text", text: "Generate a concise, sentence-case title (3-7 words)" }],
    });
    const nonMessages = { id: "ct", request: { url: "https://api.anthropic.com/v1/messages/count_tokens?beta=true", body: { messages: [first] } }, response: { status: 200, body: {} } };

    const { threads } = buildSession([r1, probe, title, r2, nonMessages]);
    expect(threads.length).toBe(3);

    const chat = threads.find((t: any) => t.kind === "chat");
    expect(chat.pairIds).toEqual([r1.id, r2.id]);
    // spine (r2, 3 msgs) + its response = 4 turns
    expect(chat.turns.length).toBe(4);
    expect(chat.turns[3].blocks[0].text).toBe("turn two");
    // r1's response produced turn index 1; r2's produced turn index 3
    expect(chat.turns[1].pairId).toBe(r1.id);
    expect(chat.turns[3].pairId).toBe(r2.id);
    expect(chat.turns[1].usage.output).toBe(20);
    const { cost, ...usage } = chat.usage;
    expect(usage).toEqual({
      input: 20, output: 40, cacheRead: 200, cacheWrite: 10, requests: 2,
      wireErrors: 0, truncated: 0, toolErrors: 0, toolUses: 0,
      rewound: 0, unattributed: 0,
    });
    expect(cost).toBeGreaterThan(0); // per-request pairCost summed into the thread

    expect(threads.find((t: any) => t.label === "quota probe").kind).toBe("utility");
    expect(threads.find((t: any) => t.label === "title generation").kind).toBe("utility");
    expect(mainThread(threads)).toBe(chat);
  });

  test("subagent thread links to its Task dispatch by prompt", () => {
    seq = 0;
    const agentPrompt = "Explore the repo and report the architecture in detail.";
    const main = msgPair([{ role: "user", content: "map this codebase" }], {
      response: {
        timestamp: 0, status: 200, headers: {},
        body: {
          model: "claude-sonnet-5", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu_task", name: "Task", input: { subagent_type: "Explore", description: "explore repo", prompt: agentPrompt } }],
          usage: { input_tokens: 5, output_tokens: 9 },
        },
      },
    });
    const agent = msgPair([{ role: "user", content: agentPrompt }], { reply: "arch report" });

    const { threads } = buildSession([main, agent]);
    const at = threads.find((t: any) => t.kind === "agent");
    expect(at).toBeDefined();
    expect(at.agentOf.agentType).toBe("Explore");
    expect(at.agentOf.toolUseId).toBe("tu_task");
    expect(at.agentOf.thread).toBe(threads[0].key);
    expect(mainThread(threads)).toBe(threads[0]); // agent thread never wins main
  });

  // The exact failure seen on real traces (cc 2.1.209): every thread's first
  // user message starts with the same reminder block, and the Task prompt is
  // content[1], not content[0]. Pre-fix this collapsed main + all subagents
  // into ONE thread and never set agentOf.
  test("reminder-prefixed sidechains split from main and link to their dispatch", () => {
    seq = 0;
    const agentPrompt = "Explore the repo and report the architecture in detail.";
    const main = msgPair([{ role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "map this codebase" }] }], {
      response: {
        timestamp: 0, status: 200, headers: {},
        body: {
          model: "claude-sonnet-5", stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "tu_agent", name: "Agent", input: { subagent_type: "general-purpose", description: "explore repo", prompt: agentPrompt } }],
          usage: { input_tokens: 5, output_tokens: 9 },
        },
      },
    });
    const agent = msgPair(
      [{ role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: agentPrompt }] }],
      { reply: "arch report", system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }] },
    );

    const { threads } = buildSession([main, agent]);
    expect(threads.length).toBe(2);
    const at = threads.find((t: any) => t.kind === "agent");
    expect(at).toBeDefined();
    expect(at.agentOf.toolUseId).toBe("tu_agent");
    expect(at.label).toBe("[general-purpose] explore repo");
    expect(mainThread(threads)).toBe(threads[0]);
  });

  test("agent-id header groups exactly and marks sidechains even without a dispatch", () => {
    seq = 0;
    // Two subagent runs with IDENTICAL first messages (same reminder, same
    // prompt) — only the per-run agent-id header can tell them apart.
    const msgs = [{ role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "same prompt" }] }];
    const a = msgPair(msgs, { reply: "run A" });
    a.request.headers = { "x-claude-code-agent-id": "aaaa1111" };
    const b = msgPair(msgs, { reply: "run B" });
    b.request.headers = { "x-claude-code-agent-id": "bbbb2222" };
    const { threads } = buildSession([a, b]);
    expect(threads.length).toBe(2);
    expect(threads.every((t: any) => t.kind === "agent")).toBe(true);
    expect(mainThread(threads)).toBe(threads[0]); // fallback, no chat thread
  });

  test("cc_is_subagent billing marker classifies a sidechain", () => {
    seq = 0;
    const p = msgPair([{ role: "user", content: "orphan subagent run" }], {
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.209; cc_entrypoint=cli; cc_is_subagent=true;" }],
    });
    const { threads } = buildSession([p]);
    expect(threads[0].kind).toBe("agent");
  });

  test("later same-length request wins the assistant slot (recap retries)", () => {
    seq = 0;
    const first = { role: "user", content: "hello" };
    const hist = [first, { role: "assistant", content: [{ type: "text", text: "hi!" }] }, { role: "user", content: "recap please" }];
    const a = msgPair(hist, { reply: "recap A" });
    const b = msgPair(hist, { reply: "recap B" });
    const { threads } = buildSession([a, b]);
    expect(threads.length).toBe(1);
    expect(threads[0].turns[3].pairId).toBe(b.id); // last writer wins
    expect(threads[0].turns[3].blocks[0].text).toBe("recap B");
    expect(threads[0].usage.requests).toBe(2);
  });

  test("empty / non-message input", () => {
    expect(buildSession([]).threads).toEqual([]);
    expect(mainThread([])).toBeNull();
  });

  // Idea 4: error metrics aggregate per thread, reported separately —
  // wire failures, truncated streams, and failed tool calls (with the
  // tool_use denominator for a rate).
  test("error metrics: wire errors, truncated streams, tool errors with denominator", () => {
    seq = 0;
    const first = { role: "user", content: "run the tests" };
    const hist = [
      first,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_ok", name: "Bash", input: { command: "ls" } },
          { type: "tool_use", id: "tu_bad", name: "Bash", input: { command: "false" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_ok", content: "file.txt" },
          { type: "tool_result", tool_use_id: "tu_bad", content: "exit 1", is_error: true },
        ],
      },
    ];
    const ok = msgPair([first]);
    const failed = msgPair([first, hist[1], hist[2]], {
      response: { timestamp: 0, status: 529, headers: {}, body: { type: "error", error: { type: "overloaded_error" } } },
    });
    const truncated = msgPair([first, hist[1], hist[2]]);
    (truncated.response as any).truncated = true;

    const { threads } = buildSession([ok, failed, truncated]);
    expect(threads.length).toBe(1);
    const u = threads[0].usage;
    expect(u.requests).toBe(3);
    expect(u.wireErrors).toBe(1);
    expect(u.truncated).toBe(1);
    expect(u.toolUses).toBe(2);
    expect(u.toolErrors).toBe(1);
  });

  test("in-stream SSE error events count as wire errors even on HTTP 200", () => {
    seq = 0;
    const p = msgPair([{ role: "user", content: "hi" }], {
      response: {
        timestamp: 0, status: 200, headers: { "content-type": "text/event-stream" },
        bodyRaw: 'data: {"type":"error","error":{"type":"overloaded_error"}}',
      },
    });
    const { threads } = buildSession([p]);
    expect(threads[0].usage.wireErrors).toBe(1);
  });
});

describe("responseBlocks", () => {
  test("prefers JSON body content, falls back to SSE", () => {
    expect(responseBlocks({ response: { body: { content: [{ type: "text", text: "x" }] } } })[0].text).toBe("x");
    seq = 0;
    const p = msgPair([{ role: "user", content: "q" }], { reply: "streamed" });
    expect(responseBlocks(p)[0].text).toBe("streamed");
    expect(responseBlocks({ response: null })).toEqual([]);
  });
});

describe("toolPreview", () => {
  test("per-tool one-liners", () => {
    expect(toolPreview("Bash", { command: "ls -la" })).toBe("$ ls -la");
    expect(toolPreview("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(toolPreview("Grep", { pattern: "foo", path: "src" })).toBe("/foo/ in src");
    expect(toolPreview("Task", { subagent_type: "Explore", description: "map repo" })).toBe("[Explore] map repo");
    expect(toolPreview("TodoWrite", { todos: [1, 2, 3] })).toBe("3 todos");
    expect(toolPreview("Unknown", { a: 1 })).toBe("");
  });

  test("file tools relativize to the workspace root", () => {
    const ws = "/Users/eric/proj";
    expect(toolPreview("Read", { file_path: "/Users/eric/proj/src/ui.ts" }, ws)).toBe("src/ui.ts");
    expect(toolPreview("Edit", { file_path: "/Users/eric/proj/a.ts", replace_all: true }, ws)).toBe("a.ts · replace all");
    expect(toolPreview("Write", { file_path: "/Users/eric/proj/big.md", content: "x".repeat(12345) }, ws)).toBe("big.md · 12.3k chars");
    expect(toolPreview("Grep", { pattern: "foo", path: "/Users/eric/proj/src" }, ws)).toBe("/foo/ in src");
    // outside the workspace but under a home dir: ~-relative
    expect(toolPreview("Read", { file_path: "/home/deva/.claude/settings.json" }, ws)).toBe("~/.claude/settings.json");
    // outside both: full path, honestly
    expect(toolPreview("Read", { file_path: "/etc/hosts" }, ws)).toBe("/etc/hosts");
  });

  test("Read shows the requested line window", () => {
    expect(toolPreview("Read", { file_path: "/a.ts", limit: 40, offset: 120 })).toBe("/a.ts · 40 lines from 120");
    expect(toolPreview("Read", { file_path: "/a.ts", limit: 40 })).toBe("/a.ts · first 40 lines");
    expect(toolPreview("Read", { file_path: "/a.ts", offset: 120 })).toBe("/a.ts · from line 120");
  });

  test("TodoWrite counts completed items", () => {
    expect(toolPreview("TodoWrite", { todos: [{ status: "completed" }, { status: "completed" }, { status: "pending" }] }))
      .toBe("3 todos · 2 done");
  });
});

describe("wsPath / cwdFromText", () => {
  test("wsPath: workspace, home, and foreign paths", () => {
    expect(wsPath("/w/root/a/b.ts", "/w/root")).toBe("a/b.ts");
    expect(wsPath("/w/root", "/w/root")).toBe(".");
    expect(wsPath("/w/rooter/a.ts", "/w/root")).toBe("/w/rooter/a.ts"); // prefix must be a dir boundary
    expect(wsPath("/Users/x/other/f.ts", "/w/root")).toBe("~/other/f.ts");
    expect(wsPath("/tmp/f", "/w/root")).toBe("/tmp/f");
    expect(wsPath("", "/w/root")).toBe("");
    expect(wsPath("/w/root/a.ts")).toBe("/w/root/a.ts"); // no ws, not a home path: untouched
  });

  test("cwdFromText: precise shapes only, prose never matches", () => {
    expect(cwdFromText("env:\n<cwd>/Users/x/proj</cwd>\nother")).toBe("/Users/x/proj");
    expect(cwdFromText("Stuff\nPrimary working directory: /Users/x/proj\nMore")).toBe("/Users/x/proj");
    expect(cwdFromText("Working directory: /w/app")).toBe("/w/app");
    // the real Claude Code env block bullets the line
    expect(cwdFromText("environment: \n - Primary working directory: /Users/x/proj\n - Is a git repository: true"))
      .toBe("/Users/x/proj");
    // prose mentioning a working directory must not match
    expect(cwdFromText("things in the working directory or on the internet")).toBe("");
    // relative paths are not a cwd
    expect(cwdFromText("Working directory: see below")).toBe("");
    expect(cwdFromText(null)).toBe("");
  });
});

describe("sessions layer", () => {
  test("two sessions with identical first prompts never merge into one thread", () => {
    seq = 0;
    const first = { role: "user", content: "hi" };
    const a = msgPair([first], { reply: "reply A" });
    const b = msgPair([first], { reply: "reply B" });
    (b.request.body as any).metadata = { user_id: JSON.stringify({ session_id: "bbbbbbbb-2222-3333-4444-555555555555" }) };
    const { threads } = buildSession([a, b]);
    expect(threads).toHaveLength(2);
    expect(threads[0].sessionId).not.toBe(threads[1].sessionId);
    expect(threads[0].key).not.toBe(threads[1].key);
  });

  test("pairs without a session id land in the honest empty bucket", () => {
    seq = 0;
    const p = msgPair([{ role: "user", content: "hi" }]);
    delete (p.request.body as any).metadata;
    const { threads } = buildSession([p]);
    expect(threads[0].sessionId).toBe("");
  });
});

describe("turnSnippet", () => {
  const tb = (text: string) => ({ type: "text", text });

  test("skips caveat/stdout wrappers and returns the user's words", () => {
    expect(turnSnippet([
      tb("<local-command-caveat>Caveat: The messages below were generated...</local-command-caveat>"),
      tb("<command-name>/clear</command-name>\n<command-message>clear</command-message>"),
      tb("<local-command-stdout></local-command-stdout>"),
      tb("hihi testa again new chat"),
    ])).toBe("hihi testa again new chat");
  });

  test("a command-only turn previews as the command itself", () => {
    expect(turnSnippet([
      tb("<local-command-caveat>Caveat: ...</local-command-caveat>"),
      tb("<command-name>/model</command-name>\n<command-message>model</command-message>"),
      tb("<local-command-stdout>Set model to Haiku 4.5</local-command-stdout>"),
    ])).toBe("/model");
  });

  test("plain prompts pass through, reminders stripped", () => {
    expect(turnSnippet([tb("<system-reminder>ctx</system-reminder>"), tb("do the thing")])).toBe("do the thing");
    expect(turnSnippet([])).toBe("");
  });

  test("message-first command order and args extract too (wire has both orders)", () => {
    // /codex:status style: <command-message> BEFORE <command-name>
    expect(turnSnippet([
      tb("<command-message>codex:status</command-message>\n<command-name>/codex:status</command-name>\n"),
    ])).toBe("/codex:status");
    // args join the preview
    expect(turnSnippet([
      tb("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-fable-5</command-args>"),
    ])).toBe("/model claude-fable-5");
    // skill invocation shape (message-first + skill-format marker) — the
    // harness's "Base directory" expansion block never wins the preview
    expect(turnSnippet([
      tb("<command-message>ccx</command-message>\n<command-name>/ccx</command-name>\n<skill-format>true</skill-format>"),
      tb("Base directory for this skill: /home/x/.claude/skills/ccx\n\n# ccx skill..."),
    ])).toBe("/ccx");
  });
});

// Model epochs: contiguous runs of one model over a thread's visible turns.
// Sub-structure inside the conversation — a /model switch opens an epoch,
// never a new thread.
describe("threadEpochs", () => {
  const u = (text: string) => ({ role: "user", blocks: [{ type: "text", text }], toolResultsOnly: false });
  const a = (model: string) => ({ role: "assistant", blocks: [{ type: "text", text: "r" }], toolResultsOnly: false, usage: model ? { model } : null });

  test("single-model thread is one epoch", () => {
    const eps = threadEpochs([u("q1"), a("claude-sonnet-5"), u("q2"), a("claude-sonnet-5")]);
    expect(eps).toEqual([{ model: "claude-sonnet-5", from: 0, to: 3 }]);
  });

  test("a /model switch opens an epoch AT the prompt the new model answered", () => {
    const eps = threadEpochs([u("q1"), a("claude-fable-5"), u("q2"), a("claude-opus-4-8")]);
    expect(eps).toEqual([
      { model: "claude-fable-5", from: 0, to: 1 },
      { model: "claude-opus-4-8", from: 2, to: 3 },
    ]);
  });

  test("unattributed replies and tool-result turns never split an epoch", () => {
    const toolRes = { role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1" }], toolResultsOnly: true };
    const eps = threadEpochs([u("q1"), a("claude-fable-5"), toolRes, a(""), u("q2"), a("claude-fable-5")]);
    expect(eps).toEqual([{ model: "claude-fable-5", from: 0, to: 4 }]);
  });

  test("trailing prompt with no reply yet stays in the last epoch (live tail)", () => {
    const eps = threadEpochs([u("q1"), a("claude-fable-5"), u("pending")]);
    expect(eps).toEqual([{ model: "claude-fable-5", from: 0, to: 2 }]);
  });

  test("buildSession stamps t.epochs from attributed turns", () => {
    seq = 0;
    const first = { role: "user", content: "hello" };
    const r1 = msgPair([first], { model: "claude-fable-5", reply: "hi" });
    const hist = [first, { role: "assistant", content: [{ type: "text", text: "hi" }] }, { role: "user", content: "again" }];
    const r2 = msgPair(hist, { model: "claude-opus-4-8", reply: "hello again" });
    const { threads } = buildSession([r1, r2]);
    expect(threads).toHaveLength(1);
    expect(threads[0].epochs.map((e: any) => e.model)).toEqual(["claude-fable-5", "claude-opus-4-8"]);
    expect(threads[0].epochs[1].from).toBe(2); // the "again" prompt starts opus's run
  });
});

describe("packing epochs: /compact repacks history (2026-07-20)", () => {
  const u = (s: string) => ({ role: "user", content: s });
  const a = (s: string) => ({ role: "assistant", content: [{ type: "text", text: s }] });

  test("post-compact requests extend the spine and attribute — never flagged superseded", () => {
    seq = 0;
    const p1 = msgPair([u("q one")], { reply: "answer one" });
    const p2 = msgPair([u("q one"), a("answer one"), u("q two")], { reply: "answer two" });
    const p3 = msgPair([u("q one"), a("answer one"), u("q two"), a("answer two"), u("q three")], { reply: "answer three" });
    const p4 = msgPair(
      [u("q one"), a("answer one"), u("q two"), a("answer two"), u("q three"), a("answer three"), u("q four")],
      { reply: "answer four" },
    );
    const p5 = msgPair(
      [u("q one"), a("answer one"), u("q two"), a("answer two"), u("q three"), a("answer three"), u("q four"), a("answer four"), u("q five")],
      { reply: "answer five" },
    );
    // /compact: early exchanges folded into one rewritten turn, a verbatim
    // tail kept, then the post-compact prompt — SHORTER than the spine.
    const p6 = msgPair(
      [u("q one"), a("folded: worked on q1-q3"), u("q four"), a("answer four"), u("q five"), a("answer five"), u("q six")],
      { reply: "answer six" },
    );
    const { threads } = buildSession([p1, p2, p3, p4, p5, p6]);
    expect(threads.length).toBe(1);
    const t = threads[0];
    // spine (p5: 9 msgs + reply = 10 turns) + appended post-compact turns
    expect(t.turns.length).toBe(12);
    expect(t.turns[10].blocks[0].text).toBe("q six");
    expect(t.turns[11].blocks[0].text).toBe("answer six");
    expect(t.turns[11].pairId).toBe(p6.id);
    expect(t.rewound.length).toBe(0);
    expect(t.unattributed.length).toBe(0);
    // The boundary is display data: where, from what, to what, which mode.
    expect(t.compactions).toEqual([
      { at: 10, pairId: p6.id, fromTurns: 9, toTurns: 7, mode: "fold" },
    ]);
  });

  test("a pair predating the compaction classifies unattributed, not superseded, once the spine is post-compact", () => {
    seq = 0;
    // Pre-compact conversation u0..u7 (15 msgs at the deepest request).
    const pre = (n: number) => {
      const m: any[] = [];
      for (let i = 0; i <= n; i++) {
        m.push(u("question " + i));
        if (i < n) m.push(a("reply " + i));
      }
      return m;
    };
    const pMid = msgPair(pre(3), { reply: "reply 3" });   // hist 7
    const pPre = msgPair(pre(7), { reply: "reply 7" });   // hist 15
    // /compact: 15 -> 5 (a 10-turn drop = a repack event). "reply 3" was
    // folded away; the tail from u7 survives verbatim.
    const folded = [u("question 0"), a("folded: earlier work"), u("question 7"), a("reply 7"), u("question 8")];
    const pPost = msgPair(folded, { reply: "reply 8" });
    // The conversation regrows past the old max — the spine is now a
    // post-compact packing.
    const grown = folded.concat([a("reply 8")]);
    for (let i = 9; i <= 13; i++) grown.push(u("question " + i), a("reply " + i));
    grown.push(u("question 14"));
    const pPost2 = msgPair(grown, { reply: "reply 14" }); // hist 17 > 15
    const { threads } = buildSession([pMid, pPre, pPost, pPost2]);
    const t = threads[0];
    // pMid's reply was rewritten by the fold — it can't be placed, but
    // nothing was superseded: honest unattributed, never a grey row.
    expect(t.unattributed).toEqual([pMid.id]);
    expect(t.rewound.length).toBe(0);
    // pPre's reply survived the fold verbatim — still attributes.
    expect(t.turns.find((x: any) => x.pairId === pPre.id)).toBeTruthy();
    expect(t.turns.find((x: any) => x.pairId === pPost2.id)).toBeTruthy();
  });
});

describe("full /compact continuation (2026-07-20 round 9)", () => {
  const u = (s: string) => ({ role: "user", content: s });
  const a = (s: string) => ({ role: "assistant", content: [{ type: "text", text: s }] });
  const SUMMARY = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

  test("the continuation thread reunifies and its turns append at the timeline tail", () => {
    seq = 0;
    const pre = (n: number) => {
      const m: any[] = [];
      for (let i = 0; i <= n; i++) {
        m.push(u("question " + i));
        if (i < n) m.push(a("reply " + i));
      }
      return m;
    };
    const p1 = msgPair(pre(3), { reply: "reply 3" });   // hist 7
    const p2 = msgPair(pre(7), { reply: "reply 7" });   // hist 15
    // Full /compact: message[0] IS the summary now — a new sig, nothing
    // survives verbatim (no anchor possible), drop 15 -> 1.
    const pc1 = msgPair([u(SUMMARY)], { reply: "welcome back" });
    const pc2 = msgPair([u(SUMMARY), a("welcome back"), u("hi again")], { reply: "still here" });
    const { threads } = buildSession([p1, p2, pc1, pc2]);
    // One conversation — the continuation never mints a thread of its own.
    expect(threads.length).toBe(1);
    const t = threads[0];
    expect(t.kind).toBe("chat");
    expect(t.pairIds).toContain(pc1.id);
    // spine (15 + reply = 16) + full post-compact packing (3) + reply
    expect(t.turns.length).toBe(20);
    expect(t.turns[19].blocks[0].text).toBe("still here");
    expect(t.turns[19].pairId).toBe(pc2.id);
    expect(t.turns.find((x: any) => x.pairId === pc1.id)).toBeTruthy();
    expect(t.rewound.length).toBe(0);
    expect(t.unattributed.length).toBe(0);
    expect(t.compactions).toEqual([
      { at: 16, pairId: pc1.id, fromTurns: 15, toTurns: 1, mode: "rewrite" },
    ]);
  });

  test("a continuation with no prior conversation in the trace stays standalone", () => {
    seq = 0;
    const pc = msgPair([u(SUMMARY)], { reply: "welcome back" });
    const { threads } = buildSession([pc]);
    expect(threads.length).toBe(1);
    expect(threads[0].turns.length).toBe(2);
  });

  test("structural reunification: no preamble needed when identity + quiet-parent + sid line up", () => {
    seq = 0;
    const sid = JSON.stringify({ session_id: "aaaabbbb-cccc-dddd-eeee-ffff00001111" });
    const meta = { metadata: { user_id: sid } };
    const pre = (n: number) => {
      const m: any[] = [];
      for (let i = 0; i <= n; i++) {
        m.push(u("question " + i));
        if (i < n) m.push(a("reply " + i));
      }
      return m;
    };
    const mk = (msgs: any[], reply: string, system?: any) => {
      const p = msgPair(msgs, { reply, system });
      Object.assign(p.request.body, meta);
      return p;
    };
    const p1 = mk(pre(3), "reply 3");
    const p2 = mk(pre(7), "reply 7"); // hist 15
    // A CUSTOMIZED continuation: no harness preamble, but the same system
    // identity block, a real sid, a smaller start, and a parent that
    // never speaks again — the structural signals carry it.
    const pc = mk([u("CUSTOM SUMMARY: seven questions answered, continue from q8")], "welcome back");
    const { threads } = buildSession([p1, p2, pc]);
    expect(threads.length).toBe(1);
    expect(threads[0].turns.find((x: any) => x.pairId === pc.id)).toBeTruthy();
    // Negative: a different system prompt (utility/agent shape) stays its
    // own thread even with the same sid and a quiet parent.
    seq = 0;
    const q1 = mk(pre(7), "reply 7");
    const q2 = mk([u("summarize the repo")], "done", [{ type: "text", text: "You are a title generator" }]);
    const r = buildSession([q1, q2]);
    expect(r.threads.length).toBe(2);
  });
});

describe("rewind vs compaction (2026-07-22)", () => {
  const u = (s: string) => ({ role: "user", content: s });
  const a = (s: string) => ({ role: "assistant", content: [{ type: "text", text: s }] });
  // Claude Code injects the SAME <system-reminder> context block at the head
  // of msg[0] on every request — its first 200 chars dominate turnContentSig,
  // so msg[0]'s sig matches trivially across ANY two requests of a thread.
  // The observed bug (temp/20260722_wrong-session-trace): that unverified
  // match anchored a rewind-to-start as a "fold" compaction.
  const REM = "<system-reminder>\nAs you answer, use this context: " + "x".repeat(300) + "\n</system-reminder>";
  const u0 = { role: "user", content: [{ type: "text", text: REM }, { type: "text", text: "the real prompt" }] };
  const grow = (n: number) => {
    const m: any[] = [u0];
    for (let i = 0; i < n; i++) m.push(a("reply " + i), u("question " + (i + 1)));
    return m;
  };

  test("a rewind-to-start classifies rewind, never fold — the reminder sig is no anchor", () => {
    seq = 0;
    const pPre = msgPair(grow(7), { reply: "old tip" }); // hist 15
    // /rewind back to msg[0]: history truncated, a new branch grows — only
    // msg[0] (with its identical reminder head) is shared.
    const pNew = msgPair([u0, a("fresh start"), u("a different question")], { reply: "a different answer" });
    const { threads } = buildSession([pPre, pNew]);
    expect(threads.length).toBe(1);
    const t = threads[0];
    expect(t.compactions.length).toBe(1);
    expect(t.compactions[0].mode).toBe("rewind");
    expect(t.compactions[0].fromTurns).toBe(15);
    expect(t.compactions[0].toTurns).toBe(3);
    // The shared msg[0] is NOT duplicated below the boundary; the new
    // branch appends and attributes.
    expect(t.turns.length).toBe(16 + 3); // spine turns + [fresh start, question, answer]
    expect(t.turns[18].blocks[0].text).toBe("a different answer");
    expect(t.turns[18].pairId).toBe(pNew.id);
    expect(t.rewound.length).toBe(0);
  });

  test("a mid-conversation rewind (same-index shared prefix) classifies rewind, not fold", () => {
    seq = 0;
    const pPre = msgPair(grow(7), { reply: "old tip" }); // hist 15
    // Rewind to turn 4, then a new direction: the shared content is a
    // same-index verbatim PREFIX (anchor i === j), not a folded tail.
    const branch = grow(2).slice(0, 5); // [u0, r0, q1, r1, q2] verbatim
    branch[4] = u("a new direction");
    const pNew = msgPair(branch, { reply: "down the new path" });
    const { threads } = buildSession([pPre, pNew]);
    const t = threads[0];
    expect(t.compactions.length).toBe(1);
    expect(t.compactions[0].mode).toBe("rewind");
    // append starts after the shared prefix: new direction + reply only
    expect(t.turns.length).toBe(16 + 2);
    expect(t.turns[17].pairId).toBe(pNew.id);
  });

  test("a genuine fold (shifted-index tail) still classifies fold", () => {
    seq = 0;
    const pPre = msgPair(grow(7), { reply: "old tip" }); // hist 15
    // compaction fold: early turns collapse into one rewritten turn, the
    // recent tail survives verbatim at SHIFTED indices, then a new prompt.
    const folded = [u0, a("folded: earlier work"), a("reply 5"), u("question 6"), a("reply 6"), u("question 7"), a("old tip"), u("question 8")];
    const pPost = msgPair(folded, { reply: "reply 8" });
    const { threads } = buildSession([pPre, pPost]);
    const t = threads[0];
    expect(t.compactions.length).toBe(1);
    expect(t.compactions[0].mode).toBe("fold");
  });
});

describe("failed requests land in t.failed at their timeline position", () => {
  const u = (s: string) => ({ role: "user", content: s });
  const a = (s: string) => ({ role: "assistant", content: [{ type: "text", text: s }] });

  test("a retry storm collects in order and never claims the retry's turn", () => {
    seq = 0;
    const first = u("q one");
    const ok1 = msgPair([first], { reply: "r1" });
    const hist2 = [first, a("r1"), u("q two")];
    const mk429 = () => msgPair(hist2, {
      response: { timestamp: 0, status: 429, headers: {}, body: { error: { type: "engine_overloaded_error", message: "overloaded" } } },
    });
    const fail1 = mk429();
    const fail2 = mk429();
    const ok2 = msgPair(hist2, { reply: "r2" });
    const { threads } = buildSession([ok1, fail1, fail2, ok2]);
    expect(threads.length).toBe(1);
    const t = threads[0];
    expect(t.failed).toEqual([
      { pairId: fail1.id, at: 3, status: 429 },
      { pairId: fail2.id, at: 3, status: 429 },
    ]);
    // the successful retry owns the turn; the failures never even
    // transiently claim it, and none leak into unattributed
    expect(t.turns[3].pairId).toBe(ok2.id);
    expect(t.unattributed.length).toBe(0);
    expect(t.rewound.length).toBe(0);
    expect(t.usage.wireErrors).toBe(2);
  });

  test("a trailing failure (no successful retry) sits past the last turn", () => {
    seq = 0;
    const first = u("q one");
    const ok1 = msgPair([first], { reply: "r1" });
    const fail = msgPair([first, a("r1"), u("q two")], {
      response: { timestamp: 0, status: 529, headers: {}, body: { error: { type: "overloaded_error" } } },
    });
    const { threads } = buildSession([ok1, fail]);
    const t = threads[0];
    // spine is the FAILED request (longest history): its 3 history turns
    // render, its position is the would-be reply slot at the tail
    expect(t.failed).toEqual([{ pairId: fail.id, at: 3, status: 529 }]);
    expect(t.turns.length).toBe(3);
  });
});
