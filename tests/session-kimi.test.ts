import { describe, test, expect } from "bun:test";
import { join } from "path";
import { buildSession, mainThread } from "../src/session";
import { readTraceText } from "../src/history";
import { wireTables } from "../src/clients";
import { extractCallInfo, extractSessionId } from "../src/summarize";
import { stubPair, planDecisions } from "../src/compact";
import { wireDialect, openaiInput, openaiCompleted } from "../src/dialects/openai";
import { categorizeUrl } from "../src/categorize";

// Real Kimi coding-plan session, captured from the live
// api.kimi.com/coding/v1/chat/completions endpoint (2026-07-20): four requests
// resending a growing message[] history — a plain reply, a get_time tool
// round-trip, then a follow-up. Kimi speaks OpenAI CHAT COMPLETIONS, a third
// wire sub-shape adapted into the Responses object model in
// src/dialects/openai.ts (openaiInput + the chat branch of openaiCompleted).
// Auth header stripped at capture; content is benign self-authored prompts.
// This file is the tripwire if that adapter drifts.
const WIRE = wireTables();
const pairs = readTraceText(join(import.meta.dir, "fixtures", "kimi-session.jsonl.zst"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("kimi chat-completions dialect (real wire, 2026-07-20)", () => {
  test("categorizes as an OpenAI-shaped model call, not External", () => {
    // shape-first: /chat/completions is a model call wherever it's mounted
    expect(categorizeUrl("https://api.kimi.com/coding/v1/chat/completions", "kimi", WIRE)).toBe("messages");
    expect(wireDialect(pairs[0])).toBe("openai");
    // the client's host pins route the rest of its traffic
    expect(categorizeUrl("https://api.kimi.com/coding/v1/models", "kimi", WIRE)).toBe("bootstrap");
    expect(categorizeUrl("https://api.kimi.com/coding/v1/usages", "kimi", WIRE)).toBe("usage");
    expect(categorizeUrl("https://auth.kimi.com/verify", "kimi", WIRE)).toBe("oauth");
    expect(categorizeUrl("https://telemetry-logs.kimi.com/v1/event", "kimi", WIRE)).toBe("telemetry");
  });

  test("messages[] adapts into the same input[] item model as Responses", () => {
    const items = openaiInput(pairs[2].request.body); // the tool round-trip req
    const types = items.map((i: any) => i.type);
    // system/user messages -> message; assistant tool_calls -> function_call;
    // the tool role message -> function_call_output
    expect(types).toContain("message");
    expect(types).toContain("function_call");
    expect(types).toContain("function_call_output");
  });

  test("streamed chat.completion.chunk deltas assemble into output + usage", () => {
    const done = openaiCompleted(pairs[1]); // the request that emits a tool call
    expect(Array.isArray(done.output)).toBe(true);
    expect(done.output.some((i: any) => i.type === "function_call" && i.name === "get_time")).toBe(true);
    expect(done.output.some((i: any) => i.type === "reasoning")).toBe(true); // reasoning_content
    // prompt_tokens/completion_tokens map onto input_tokens/output_tokens
    expect(done.usage.input_tokens).toBeGreaterThan(0);
    expect(done.usage.output_tokens).toBeGreaterThan(0);
  });

  test("per-pair usage extracts through the shared openai path", () => {
    const info = extractCallInfo(pairs[0]);
    expect(info.model).toBe("kimi-for-coding");
    expect(info.stream).toBe(true);
    expect(info.input).toBeGreaterThan(0);
    expect(info.output).toBeGreaterThan(0);
    // Moonshot bills input inclusive of cache; with no cached tokens here,
    // input == prompt_tokens and cacheRead is zero.
    expect(info.cacheRead).toBe(0);
  });
});

describe("kimi session reconstruction", () => {
  const { threads } = buildSession(pairs, WIRE);
  const main = mainThread(threads);

  test("the four requests are ONE openai-dialect chat thread", () => {
    expect(threads.length).toBe(1);
    expect(main.kind).toBe("chat");
    expect(main.dialect).toBe("openai");
    expect(main.usage.requests).toBe(4);
    expect(main.model).toBe("kimi-for-coding");
    expect(main.system).toBeTruthy(); // system prompt lifted out of messages[]
  });

  test("history folds into eight attributed turns with a tool round-trip", () => {
    expect(main.turns.length).toBe(8);
    // the get_time call and its result fold Anthropic-style
    expect(main.turns[3].blocks.some((b: any) => b.type === "tool_use")).toBe(true);
    expect(main.turns[4].blocks.some((b: any) => b.type === "tool_result")).toBe(true);
    expect(main.usage.toolUses).toBe(1);
    // reasoning_content renders as thinking on the assistant turns
    expect(main.turns[1].blocks.some((b: any) => b.type === "thinking")).toBe(true);
    // every assistant turn attributes to the wire request that produced it
    const assistants = main.turns.filter((t: any) => t.role === "assistant");
    expect(assistants.length).toBe(4);
    expect(assistants.every((t: any) => !!t.pairId)).toBe(true);
  });

  test("a clean stateless session flags nothing false", () => {
    expect(main.rewound.length).toBe(0);
    expect(main.unattributed.length).toBe(0);
    expect(main.compactions.length).toBe(0);
    // no conversation header on the wire -> the sig-fallback thread key
    expect(main.key.indexOf("osig:")).toBeGreaterThanOrEqual(0);
  });
});

// K3 (2026-07-20, devlog kimi-k3-wire-facts): thinking config, a
// prompt_cache_key session id in the body, and a live auto-compaction —
// the packing restarts at msgs=4 with the original first user message
// MERGED with later user text (splitting the sig fallback) and the working
// summary re-sent as a user message. Fully synthetic fixture mirroring the
// observed wire shape (benign arithmetic, fake uuid) — the compaction call
// carries mct=131072 (the model's true output limit), every other call the
// dynamic ~1M-minus-prompt value.
const k3pairs = readTraceText(join(import.meta.dir, "fixtures", "kimi-k3-session.jsonl.zst"))
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("kimi K3 session: prompt_cache_key + auto-compaction", () => {
  const { threads } = buildSession(k3pairs, WIRE);
  const main = mainThread(threads);

  test("prompt_cache_key is the session id (bare uuid extracted)", () => {
    expect(extractSessionId(k3pairs[0], WIRE)).toBe("00000000-1111-2222-3333-444444444444");
    expect(main.sessionId).toBe("00000000-1111-2222-3333-444444444444");
  });

  test("the post-compaction packing reunifies into ONE thread", () => {
    // pre-fix behavior: the restart's merged first user message minted a
    // new sig and the packing listed as a separate conversation
    expect(threads.length).toBe(1);
    expect(main.usage.requests).toBe(6);
  });

  test("the compaction boundary is displayed, post-compaction turns attributed", () => {
    expect(main.compactions.length).toBe(1);
    const c = main.compactions[0];
    expect(c.mode).toBe("rewrite"); // nothing survives verbatim in the restart
    expect(c.pairId).toBe(k3pairs[4].id); // the first request of the new packing
    // the conversation continues past the boundary: summary turn + the live
    // exchanges, every assistant turn attributed to its wire pair
    expect(main.turns.length).toBeGreaterThan(c.at);
    const post = main.turns.slice(c.at);
    expect(post.some((t: any) => t.role === "assistant")).toBe(true);
    expect(main.unattributed.length).toBe(0);
    expect(main.rewound.length).toBe(0);
  });

  test("K3 wire shape flows through the shared openai path", () => {
    const done = openaiCompleted(k3pairs[5]);
    // usage arrives twice at stream end (finish chunk + terminal choices:[]) —
    // applied idempotently, never doubled
    expect(done.usage.input_tokens).toBe(215); // OpenAI convention: inclusive of cache
    expect(done.usage.input_tokens_details.cached_tokens).toBe(190);
    expect(done.usage.output_tokens).toBe(8);
    const info = extractCallInfo(k3pairs[5]);
    expect(info.model).toBe("k3");
    expect(info.cacheRead).toBe(190); // cached_tokens peeled off prompt_tokens
  });

  test("compact stubs keep prompt_cache_key — session identity survives folding", () => {
    const stub = stubPair(k3pairs[0], k3pairs[5].id);
    expect((stub.request.body as any)._cctrace_stub).toBeTruthy();
    expect(extractSessionId(stub, WIRE)).toBe("00000000-1111-2222-3333-444444444444");
  });

  test("rebuild is identical pre/post compact — the devlog's open question", () => {
    // cctrace compact stubs superseded bodies per thread-epoch; the
    // compaction restart must still reunify and keep its boundary (contOf
    // reads the first NON-stub request, and compact keeps each epoch's
    // longest request full).
    const categorize = (url: string, client?: string) => categorizeUrl(url, client, WIRE);
    const dec = planDecisions(k3pairs, categorize, WIRE);
    const compacted = k3pairs.map((p: any, i: number) => (dec.stub.has(i) ? stubPair(p, dec.stub.get(i)!) : p));
    const after = buildSession(compacted, WIRE);
    const ta = mainThread(after.threads);
    expect(after.threads.length).toBe(1);
    expect(ta.key).toBe(main.key);
    expect(ta.sessionId).toBe(main.sessionId);
    expect(ta.turns.length).toBe(main.turns.length);
    expect(ta.compactions.length).toBe(1);
    expect(ta.compactions[0].at).toBe(main.compactions[0].at);
    for (let i = 0; i < main.turns.length; i++) {
      expect(ta.turns[i].pairId).toBe(main.turns[i].pairId);
    }
  });
});
