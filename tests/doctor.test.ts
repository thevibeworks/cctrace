import { describe, test, expect } from "bun:test";
import {
  diagnoseSession,
  renderDoctor,
  systemSections,
  injectionParts,
  toolTarget,
  nearDuplicates,
  itemText,
  DOCTOR_RULES,
} from "../src/doctor";

// Wire-shaped fixtures, the context.test.ts way: every /v1/messages request
// carries the whole history so far; usage rides the SSE stream.

const SID = "aaaa1111-bbbb-cccc-dddd-eeee00002222";
let seq = 0;
function msgPair(messages: any[], opts: any = {}) {
  seq++;
  const usage = `"usage":{"input_tokens":${opts.input ?? 10},"cache_read_input_tokens":${opts.cacheRead ?? 100},"cache_creation_input_tokens":5,"output_tokens":20}`;
  const sse = [
    `data: {"type":"message_start","message":{"model":"${opts.model || "claude-sonnet-5"}",${usage}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${opts.reply || "ok"}"}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}`,
    `data: {"type":"message_stop"}`,
  ].join("\n\n") + "\n\n";
  return {
    id: "p" + seq,
    client: "claude",
    request: {
      timestamp: 1000 + seq * 10,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: opts.model || "claude-sonnet-5",
        system: opts.system || [{ type: "text", text: "You are a test agent." }],
        tools: opts.tools || [],
        messages,
        metadata: { user_id: JSON.stringify({ session_id: SID }) },
      },
    },
    response: { timestamp: 1000 + seq * 10 + 1, status: 200, headers: {}, bodyRaw: sse },
    duration: 1000,
    loggedAt: "x",
  };
}

const bigText = (seed: string, lines = 60) => Array.from({ length: lines }, (_, i) => `${seed} line ${i} with enough characters to count as a real line`).join("\n");

const TOOLS = [
  { name: "Bash", description: "run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
  { name: "Read", description: "read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
  { name: "Edit", description: "edit a file " + "x".repeat(2000), input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
  { name: "mcp__idle__thing", description: "an mcp tool nobody calls " + "y".repeat(4000), input_schema: { type: "object", properties: {} } },
  { name: "mcp__idle__other", description: "another " + "z".repeat(1000), input_schema: { type: "object", properties: {} } },
  { name: "mcp__lazy__search", description: "deferred " + "d".repeat(3000), input_schema: { type: "object", properties: {} }, defer_loading: true },
];

const SYSTEM = [
  { type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=abc" },
  { type: "text", text: "You are Claude Code.\n\n# Harness\n" + "h".repeat(400) + "\n\n# Memory\n" + "m".repeat(20000) + "\n\n# Environment\nlinux", cache_control: { type: "ephemeral" } },
];

const fileA = bigText("src/a.ts");
const claudeMd = "Contents of /repo/CLAUDE.md:\n\n# repo\n" + bigText("rule", 80);
const instructions = "<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /home/u/.claude/CLAUDE.md (user's private global instructions for all projects):\n\n" + "g".repeat(2000) + "\n\nContents of /repo/CLAUDE.md (project instructions, checked into the codebase):\n\n" + "p".repeat(6000) + "\n</system-reminder>";

function session(): any[] {
  const pairs: any[] = [];
  const hist: any[] = [];
  const step = (opts: any = {}) => { pairs.push(msgPair(hist.map((m) => ({ ...m })), opts)); };
  // turn 0: human + the project-instructions reminder + a nudge
  hist.push({ role: "user", content: [
    { type: "text", text: instructions },
    { type: "text", text: "please fix the parser" },
    { type: "text", text: "<system-reminder>\nOnly you see that command's output.\n\n<total_tokens>1000000 tokens left</total_tokens>\n</system-reminder>" },
  ] });
  step({ tools: TOOLS, system: SYSTEM });
  // Read a.ts three times, Bash the same command twice; one error result
  for (let i = 0; i < 3; i++) {
    hist.push({ role: "assistant", content: [{ type: "tool_use", id: "r" + i, name: "Read", input: { file_path: "/repo/src/a.ts" } }] });
    hist.push({ role: "user", content: [
      { type: "tool_result", tool_use_id: "r" + i, content: fileA },
      { type: "text", text: "<system-reminder>\nOnly you see that command's output.\n</system-reminder>" },
    ] });
    step({ tools: TOOLS, system: SYSTEM, cacheRead: 1000, input: 50 });
  }
  hist.push({ role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "bun test" } }] });
  hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "b1", is_error: true, content: "1 fail\n" + bigText("FAIL", 30) }] });
  step({ tools: TOOLS, system: SYSTEM, cacheRead: 1000, input: 50 });
  hist.push({ role: "assistant", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "bun test" } }] });
  // a near-duplicate of the first Bash output: same lines, two changed
  hist.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "b2", content: "0 fail\n" + bigText("FAIL", 30).replace("line 3 ", "line 3x ") }] });
  step({ tools: TOOLS, system: SYSTEM, cacheRead: 1000, input: 50 });
  // the harness delivers a CLAUDE.md as a plain user block (worktree entry) — twice
  hist.push({ role: "assistant", content: [{ type: "text", text: "entering worktree" }] });
  hist.push({ role: "user", content: [{ type: "text", text: claudeMd }, { type: "text", text: "go on" }] });
  step({ tools: TOOLS, system: SYSTEM, cacheRead: 1000, input: 50 });
  hist.push({ role: "assistant", content: [{ type: "text", text: "and again" }] });
  hist.push({ role: "user", content: [{ type: "text", text: claudeMd }, { type: "text", text: "finish" }] });
  step({ tools: TOOLS, system: SYSTEM, cacheRead: 1000, input: 50, reply: "done" });
  return pairs;
}

describe("diagnoseSession", () => {
  const pairs = session();
  const dx = diagnoseSession(pairs)!;
  const r = dx.report;

  test("reads the main thread's latest window, anchored to the provider count", () => {
    expect(dx).not.toBeNull();
    expect(r.session.sid).toBe(SID);
    expect(r.window.pick).toBe("latest");
    expect(r.window.pairId).toBe(pairs[pairs.length - 1].id);
    expect(r.window.actual.total).toBe(50 + 1000 + 5);
    expect(r.window.est.total).toBeGreaterThan(0);
    expect(typeof r.window.calibration).toBe("number");
    const sh = r.window.share;
    expect(Math.round(sh.system + sh.tools + sh.user + sh.inject + sh.assistant + sh.toolResult)).toBeGreaterThanOrEqual(99);
  });

  test("system prompt: sections by heading, billing block flagged, cache_control read", () => {
    expect(r.system.blocks.length).toBe(2);
    expect(r.system.blocks[0].billing).toBe(true);
    expect(r.system.blocks[1].cacheControl).toBe(true);
    const secs = r.system.blocks[1].sections.map((s: any) => s.heading);
    expect(secs).toEqual(["(preamble)", "Harness", "Memory", "Environment"]);
    const mem = r.system.blocks[1].sections.find((s: any) => s.heading === "Memory");
    expect(mem.tokens).toBeGreaterThan(DOCTOR_RULES.bigSystemSection);
    expect(r.findings.some((f: any) => f.id === "system-section:" + mem.key)).toBe(true);
    // The big section opens by its key.
    expect(dx.show(mem.key)!.startsWith("# Memory")).toBe(true);
  });

  test("tool schemas: called vs never called, idle MCP server named", () => {
    expect(r.tools.count).toBe(6);
    expect(r.tools.unused.names.sort()).toEqual(["Edit", "mcp__idle__other", "mcp__idle__thing"]);
    expect(r.tools.deferred.count).toBe(1); // defer_loading: on the wire, not in the prompt until searched
    expect(r.tools.byOrigin.find((g: any) => g.origin === "mcp:lazy").unused).toEqual([]);
    const idle = r.tools.byOrigin.find((g: any) => g.origin === "mcp:idle");
    expect(idle.called).toBe(0);
    expect(idle.count).toBe(2);
    expect(r.findings.some((f: any) => f.id === "idle-mcp:mcp:idle")).toBe(true);
    expect(dx.show("tool:Bash")).toContain("run a command");
  });

  test("injections: recurring nudges counted, one-offs named with their file parts", () => {
    const rec = Object.fromEntries(r.injections.recurring.map((x: any) => [x.kind, x.count]));
    expect(rec["terminal caveat"]).toBe(4);
    expect(rec["tokens left"]).toBe(1);
    const proj = r.injections.oneOff.find((o: any) => o.kind === "project instructions");
    expect(proj).toBeTruthy();
    expect(proj.parts.map((p: any) => p.file)).toEqual(["/home/u/.claude/CLAUDE.md", "/repo/CLAUDE.md"]);
    expect(proj.parts[1].tokens).toBeGreaterThan(proj.parts[0].tokens);
    // The harness-delivered CLAUDE.md reads as injected, not as the human.
    const files = r.injections.oneOff.filter((o: any) => o.kind === "file contents");
    expect(files.length).toBe(2);
    expect(r.conversation.userMessages).toBe(3); // fix / go on / finish
  });

  test("duplicates: exact groups, near pairs, and re-reads of one target", () => {
    const read = r.duplicates.exact.find((g: any) => g.cat === "toolResult");
    expect(read.count).toBe(3);
    expect(read.wasted).toBe(2 * read.tokens);
    const md = r.duplicates.exact.find((g: any) => g.cat === "inject");
    expect(md.count).toBe(2);
    expect(dx.show("dup:" + read.hash)).toBe(fileA);
    expect(r.duplicates.near.length).toBeGreaterThanOrEqual(1);
    const nb = r.duplicates.near[0];
    expect(nb.similarity).toBeGreaterThan(0.8);
    expect(nb.similarity).toBeLessThan(1);
    expect(r.duplicates.nearGroups.length).toBe(1);
    expect(r.duplicates.nearGroups[0].copies).toBe(2);
    expect(r.duplicates.nearGroups[0].redundant).toBe(Math.min(nb.a.tokens, nb.b.tokens));
    const rr = r.duplicates.rereads.find((g: any) => g.tool === "Read");
    expect(rr.count).toBe(3);
    expect(rr.target).toBe("/repo/src/a.ts");
    const bash = r.duplicates.rereads.find((g: any) => g.tool === "Bash");
    expect(bash.count).toBe(2);
    expect(r.findings.some((f: any) => f.id === "reread:Read:/repo/src/a.ts")).toBe(true);
    expect(r.findings.some((f: any) => f.id === "exact-dups")).toBe(true);
  });

  test("results: by tool, errors, largest with keys that open", () => {
    const bash = r.results.byTool.find((g: any) => g.name === "Bash");
    expect(bash.count).toBe(2);
    expect(bash.errors).toBe(1);
    expect(r.results.errors.count).toBe(1);
    expect(r.results.largest[0].tool).toBe("Read");
    expect(dx.show(r.results.largest[0].key)).toBe(fileA);
  });

  test("timeline: steps, peak, cache hit, injections by producer", () => {
    expect(r.timeline.steps).toBe(pairs.length);
    expect(r.timeline.peak.pairId).toBe(pairs[pairs.length - 1].id);
    expect(r.timeline.cache.hitPct).toBeGreaterThan(80);
    expect(r.timeline.compactions).toEqual([]);
    const by = Object.fromEntries(r.timeline.injectionsByProducer.map((p: any) => [p.label, p.count]));
    expect(by["project instructions"]).toBe(1);
    expect(by["file contents"]).toBe(2);
    expect(r.system.changes).toBe(0); // the billing block never counts as a change
    expect(r.findings.some((f: any) => f.id.startsWith("system-versions"))).toBe(false);
  });

  test("findings are ordered by level then weight and carry their rule", () => {
    const levels = r.findings.map((f: any) => f.level);
    const order = { high: 0, warn: 1, info: 2 } as any;
    for (let i = 1; i < levels.length; i++) expect(order[levels[i]]).toBeGreaterThanOrEqual(order[levels[i - 1]]);
    for (const f of r.findings) { expect(f.rule).toBeTruthy(); expect(f.title.length).toBeGreaterThan(0); }
    expect(r.findings.some((f: any) => f.id === "overhead")).toBe(true);
  });

  test("--peak and --step pick other windows; unknown keys show null", () => {
    const peak = diagnoseSession(pairs, undefined, { peak: true })!.report;
    expect(peak.window.pick).toBe("peak");
    const first = diagnoseSession(pairs, undefined, { step: pairs[0].id })!.report;
    expect(first.window.pick).toBe("step");
    expect(first.window.histLen).toBe(1);
    expect(dx.show("res:999")).toBeNull();
    expect(dx.show("sys:1/99")).toBeNull();
  });

  test("renders a plain terminal report", () => {
    const txt = renderDoctor(r);
    expect(txt).toContain("Doctor · session " + SID.slice(0, 8));
    expect(txt).toContain("tool schemas");
    expect(txt).toContain("Findings (");
    expect(txt).toContain("[--show ");
  });

  test("returns null when nothing reconstructs", () => {
    expect(diagnoseSession([])).toBeNull();
    expect(diagnoseSession([{ id: "x", request: { url: "https://api.anthropic.com/api/oauth/usage", body: {} }, response: null }])).toBeNull();
  });
});

describe("helpers", () => {
  test("systemSections splits on markdown headings, preamble first", () => {
    const s = systemSections("intro\n# A\naaa\n## B\nbb\n#notaheading\n");
    expect(s.map((x) => x.heading)).toEqual(["(preamble)", "A", "B"]);
    expect(s[2]!.chars).toBe("## B\nbb\n#notaheading\n".length);
    expect(systemSections("no headings here").length).toBe(1);
  });

  test("injectionParts sizes each 'Contents of' run", () => {
    const p = injectionParts("Contents of /a/CLAUDE.md (x):\n\n1234\n\nContents of /b/MEMORY.md (y):\n\n12345678\n");
    expect(p.map((x) => x.file)).toEqual(["/a/CLAUDE.md", "/b/MEMORY.md"]);
    expect(p[1]!.chars).toBeGreaterThan(p[0]!.chars);
    expect(injectionParts("plain")).toEqual([]);
  });

  test("toolTarget names what a call re-reads", () => {
    expect(toolTarget("Read", { file_path: "/x" })).toBe("/x");
    expect(toolTarget("Bash", { command: " ls " })).toBe("ls");
    expect(toolTarget("Grep", { pattern: "foo", path: "src" })).toBe("foo src");
    expect(toolTarget("WebFetch", { url: "https://a" })).toBe("https://a");
    expect(toolTarget("Edit", { file_path: "/x" })).toBe("");
    expect(toolTarget("mcp__fs__read", { path: "/m" })).toBe("/m");
  });

  test("nearDuplicates: shared lines, not identical bytes; tiny blocks ignored", () => {
    const a = bigText("A", 40), b = bigText("A", 40).replace("line 2 ", "line 2x "), c = bigText("C", 40);
    const out = nearDuplicates([
      { key: "a", text: a, tokens: 500 }, { key: "b", text: b, tokens: 500 }, { key: "c", text: c, tokens: 500 },
      { key: "d", text: "short\nlines", tokens: 500 },
    ]);
    expect(out.length).toBe(1);
    expect([out[0]!.a, out[0]!.b].sort()).toEqual(["a", "b"]);
    expect(out[0]!.similarity).toBeGreaterThan(0.9);
  });

  test("itemText: images hash their bytes so two screenshots differ", () => {
    const img = (data: string) => ({ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", data } }] });
    expect(itemText(img("AAAA"))).not.toBe(itemText(img("BBBB")));
    expect(itemText(img("AAAA"))).toBe(itemText(img("AAAA")));
    expect(itemText({ type: "tool_result", content: "plain" })).toBe("plain");
    expect(itemText({ type: "tool_use", name: "Bash", input: { command: "ls" } })).toContain('"command"');
  });
});
