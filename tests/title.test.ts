import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  sessionSpine, renderDigest, cleanTitle, titleKey, titleFor, readTitles, writeTitles,
  planTitles, applyTitles, titleLookup, DIGEST_CHARS,
} from "../src/title";
import { wireTables } from "../src/clients";

const WIRE = wireTables();
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// One main-thread pair whose messages[] carry the full alternating history
// (how Claude Code re-sends a conversation) + the final response.
let seq = 0;
function txt(t: string) { return [{ type: "text", text: t }]; }
function chatPair(history: [string, string][], finalText: string) {
  seq++;
  const messages: any[] = [];
  for (const [u, a] of history) { messages.push({ role: "user", content: txt(u) }); if (a) messages.push({ role: "assistant", content: txt(a) }); }
  return {
    id: "c" + seq,
    client: "claude",
    request: { url: "https://api.anthropic.com/v1/messages", timestamp: 1000 + seq, headers: {}, body: { model: "claude-fable-5", messages, metadata: { user_id: JSON.stringify({ session_id: SID }) } } },
    response: { status: 200, body: { type: "message", role: "assistant", content: txt(finalText), stop_reason: "end_turn" } },
  };
}
// A sub-agent pair (agent-id header) — must NOT feed the digest.
function agentPair(text: string) {
  seq++;
  return {
    id: "a" + seq,
    client: "claude",
    request: { url: "https://api.anthropic.com/v1/messages", timestamp: 2000 + seq, headers: { "x-claude-code-agent-id": "sub-1" }, body: { model: "claude-fable-5", messages: [{ role: "user", content: [{ type: "text", text }] }], metadata: { user_id: JSON.stringify({ session_id: SID }) } } },
    response: { status: 200, body: { type: "message", role: "assistant", content: [{ type: "text", text: "subagent work" }], stop_reason: "end_turn" } },
  };
}

describe("sessionSpine", () => {
  test("keeps human prompts + agent finals of the main chat; drops sub-agent threads", () => {
    seq = 0;
    const pairs = [
      agentPair("research auth libraries"),
      chatPair([["build the login form", "Login form built and tested"], ["now add validation", ""]], "Validation added with tests"),
    ];
    const spines = sessionSpine(pairs as any, WIRE);
    expect(spines.length).toBe(1);
    const loops = spines[0]!.loops;
    expect(loops.map((l) => l.user)).toEqual(["build the login form", "now add validation"]);
    expect(loops.every((l) => !/subagent/.test(l.final))).toBe(true);
    expect(loops[loops.length - 1]!.final).toContain("Validation added");
  });
});

describe("renderDigest", () => {
  test("all loops when they fit", () => {
    const d = renderDigest([{ user: "a", final: "b" }, { user: "c", final: "d" }]);
    expect(d).toContain("[1] USER: a");
    expect(d).toContain("[2] AGENT: d");
  });
  test("front + back with a gap marker when over budget", () => {
    const loops = Array.from({ length: 40 }, (_, i) => ({ user: "u".repeat(600) + i, final: "f".repeat(400) + i }));
    const d = renderDigest(loops, 4000);
    expect(d.length).toBeLessThan(6000);
    expect(d).toContain("omitted");
    expect(d).toContain("u".repeat(20) + "0"); // first loop kept
    expect(d).toContain("39");                  // last loop kept
  });
});

describe("cleanTitle", () => {
  test("first line, strips quotes/markdown/trailing period, caps length", () => {
    expect(cleanTitle('"Fix the login bug"\nextra')).toBe("Fix the login bug");
    expect(cleanTitle("## Add dark mode.")).toBe("Add dark mode");
    expect(cleanTitle("`Refactor parser`")).toBe("Refactor parser");
    expect(cleanTitle("x".repeat(200)).length).toBeLessThanOrEqual(100);
    expect(cleanTitle("  ")).toBe("");
  });
});

describe("titles.json store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cctrace-title-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("key by session id, else file:<name>", () => {
    expect(titleKey(SID, "trace-x.jsonl")).toBe(SID);
    expect(titleKey(null, "trace-x.jsonl.zst")).toBe("file:trace-x");
  });

  test("write/read round-trip; titleFor by sid then file", () => {
    writeTitles(dir, { [SID]: { title: "By session", model: "sonnet", at: "t", source: "s" }, "file:trace-y": { title: "By file", model: "sonnet", at: "t", source: "s" } });
    expect(readTitles(dir)[SID]!.title).toBe("By session");
    expect(titleFor(dir, SID)).toBe("By session");
    expect(titleFor(dir, null, "trace-y.jsonl")).toBe("By file");
    expect(titleFor(dir, "unknown", "trace-z.jsonl")).toBe("");
  });

  test("plan skips named sessions unless force; apply writes via the runner", async () => {
    seq = 0;
    const trace = join(dir, "trace-t.jsonl");
    writeFileSync(trace, [chatPair([["do the thing", ""]], "Thing done")].map((p) => JSON.stringify(p)).join("\n") + "\n");
    const plan1 = await planTitles(dir, dir, WIRE);
    expect(plan1.jobs.length).toBe(1);
    const runner = async () => "A Clear Title";
    const res = await applyTitles(dir, plan1.jobs, { runner });
    expect(res.titled).toBe(1);
    expect(readTitles(dir)[SID]!.title).toBe("A Clear Title");
    // second plan: already named -> skipped, force re-plans
    expect((await planTitles(dir, dir, WIRE)).jobs.length).toBe(0);
    expect((await planTitles(dir, dir, WIRE, { force: true })).jobs.length).toBe(1);
  });

  test("applyTitles counts a runner failure without writing", async () => {
    seq = 0;
    const trace = join(dir, "trace-f.jsonl");
    writeFileSync(trace, [chatPair([["hello", ""]], "Hi")].map((p) => JSON.stringify(p)).join("\n") + "\n");
    const { jobs } = await planTitles(dir, dir, WIRE);
    const res = await applyTitles(dir, jobs, { runner: async () => { throw new Error("boom"); } });
    expect(res).toEqual({ titled: 0, failed: 1 });
    expect(readTitles(dir)[SID]).toBeUndefined();
  });
});
