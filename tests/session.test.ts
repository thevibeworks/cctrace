import { describe, test, expect } from "bun:test";
import {
  threadSig,
  normalizeTurns,
  buildToolResultIndex,
  responseBlocks,
  buildSession,
  mainThread,
  toolPreview,
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

describe("threadSig", () => {
  test("same first message -> same signature; different -> different", () => {
    const a = threadSig({ role: "user", content: "hello" });
    expect(threadSig({ role: "user", content: "hello" })).toBe(a);
    expect(threadSig({ role: "user", content: "other" })).not.toBe(a);
    expect(threadSig({ role: "user", content: [{ type: "text", text: "hello" }] })).not.toBe(a);
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
    expect(usage).toEqual({ input: 20, output: 40, cacheRead: 200, cacheWrite: 10, requests: 2 });
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
});
