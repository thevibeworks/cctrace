import { describe, test, expect } from "bun:test";
import { renderTranscript } from "../src/transcript";
import type { TracePair } from "../src/types";

// The markdown session dump: user text blockquoted in full, assistant text
// in full, tool calls one line each with their result attached, thinking
// and utility threads omitted. Times UTC (shareable artifact).

const SID = "aaaa1111-bbbb-cccc-dddd-eeee00001111";
const SESSION = JSON.stringify({ session_id: SID });

function msgPair(id: string, ts: number, over: Record<string, unknown> = {}): TracePair {
  return {
    id,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-opus-4-6",
        metadata: { user_id: SESSION },
        messages: [{ role: "user", content: "hi" }],
        ...(over.reqBody as Record<string, unknown> | undefined),
      },
    },
    response: {
      timestamp: ts + 2,
      status: 200,
      headers: {},
      body: {
        model: "claude-opus-4-6",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 100, output_tokens: 50 },
        stop_reason: "end_turn",
        ...(over.resBody as Record<string, unknown> | undefined),
      },
    },
    duration: 2000,
    loggedAt: "x",
  } as unknown as TracePair;
}

const agentPrompt = "explore the repo layout and report the entry points";

const PAIRS: TracePair[] = [
  // main chat: user ask -> failing Bash -> Task dispatch -> final
  msgPair("p1", 1000, {
    reqBody: {
      messages: [
        { role: "user", content: [{ type: "text", text: "<system-reminder>injected noise</system-reminder>" }, { type: "text", text: "please fix the bug\nin the parser" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "private chain" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 fail" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_task", name: "Task", input: { subagent_type: "Explore", description: "explore repo", prompt: agentPrompt } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_task", content: "entry points found" }] },
      ],
    },
    resBody: { content: [{ type: "text", text: "fixed the parser" }] },
  }),
  // the subagent run that dispatch spawned
  msgPair("p2", 1010, {
    reqBody: { messages: [{ role: "user", content: agentPrompt }] },
    resBody: { content: [{ type: "text", text: "src/cli.ts is the entry" }] },
  }),
  // a quota probe (utility) — must be omitted, but counted
  msgPair("p3", 1020, {
    reqBody: { max_tokens: 1, messages: [{ role: "user", content: "quota" }] },
  }),
];

describe("renderTranscript", () => {
  const md = renderTranscript(PAIRS, undefined, { project: "myproj", client: "claude" });

  test("header carries identity and totals", () => {
    expect(md).toContain("# session " + SID);
    expect(md).toContain("myproj · claude");
    expect(md).toContain("3 requests");
    expect(md).toContain("1 utility thread (probes, title generation) omitted");
  });

  test("user text is blockquoted in full; system reminders dropped", () => {
    expect(md).toContain("> please fix the bug\n> in the parser");
    expect(md).not.toContain("injected noise");
  });

  test("tool calls are one line with their result; thinking omitted", () => {
    expect(md).toContain("- Bash($ bun test) -> [err] 1 fail");
    expect(md).not.toContain("private chain");
  });

  test("the main chat and the subagent both render, utility does not", () => {
    expect(md).toContain("## chat");
    expect(md).toContain("## subagent · [Explore] explore repo");
    expect(md).toContain("dispatched by the parent thread as [Explore]");
    expect(md).toContain("src/cli.ts is the entry");
    expect(md).not.toContain("quota probe");
  });

  test("turns are numbered with UTC times", () => {
    expect(md).toContain("### turn 01 · 00:16:40"); // ts=1000 epoch
    expect(md).toContain("fixed the parser");
  });
});
