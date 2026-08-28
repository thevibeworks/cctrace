import { describe, test, expect } from "bun:test";
import { parseFragment } from "parse5";
import { renderSnapshot, verifySnapshot, getLiveHtml } from "../src/ui";
import { parseTraceText, type TraceParseStats } from "../src/history";
import { bootSnapshotPage, bootPage } from "./dom-stub";
import type { TracePair } from "../src/types";

// The snapshot page builds its DOM as innerHTML strings from captured wire
// content — content we do not control. These tests render hostile captures
// through the real page script and grammar-check every generated fragment
// with a spec-compliant parser. Two real-world regressions anchor them:
//   - fmtCost's "<$0.0001" reached innerHTML unescaped (raw '<' in markup)
//   - ANSI escapes in captured terminal output ([1m) are HTML parse
//     errors and rendered as garbled "[1m" text

const SESSION = JSON.stringify({ session_id: "aaaabbbb-cccc-dddd-eeee-ffff00001111" });

function msgPair(id: string, over: Record<string, unknown> = {}): TracePair {
  return {
    id,
    request: {
      timestamp: 1000 + Number(id.replace(/\D/g, "") || 0),
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-opus-4-6",
        stream: false,
        metadata: { user_id: SESSION },
        messages: [{ role: "user", content: "hi" }],
        ...(over.reqBody as Record<string, unknown> | undefined),
      },
    },
    response: {
      timestamp: 1002 + Number(id.replace(/\D/g, "") || 0),
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

const HOSTILE: TracePair[] = [
  // tiny usage -> pairCost total < $0.0001 -> fmtCost returns "<$0.0001"
  msgPair("p1", { resBody: { usage: { input_tokens: 1, output_tokens: 1 } } }),
  // ANSI SGR + bare control chars in conversation content
  msgPair("p2", {
    reqBody: {
      messages: [
        { role: "user", content: "stdout: [1mBold[22m and bell  and esc ." },
        { role: "assistant", content: "reply [31mred[0m" },
        { role: "user", content: "also </script><script>alert(1)</script> and <img src=x onerror=alert(2)>" },
      ],
    },
    resBody: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900 } },
  }),
  // weird but present fields
  msgPair("p3", {
    resBody: { model: "<weird>&model[1m", stop_reason: "\"quoted\"" },
  }),
];

function allRoutes(page: ReturnType<typeof bootSnapshotPage>, pairs: TracePair[]) {
  for (const p of pairs) page.goto("#/p/" + encodeURIComponent(p.id));
  page.goto("#/session");
  const keys = [...page.els["threads"].innerHTML.matchAll(/#\/session\/([^"]+)"/g)].map((m) => m[1]);
  for (const k of keys) page.goto("#/session/" + k);
  page.goto("#/context");
  for (const k of keys) page.goto("#/context/" + k);
}

function fragmentErrors(page: ReturnType<typeof bootSnapshotPage>): string[] {
  const out: string[] = [];
  for (const f of page.fragments) {
    parseFragment(f.html, {
      onParseError: (e: { code: string; startOffset: number }) => {
        out.push(
          `[${f.route}] #${f.id} ${e.code}: ...${f.html.slice(Math.max(0, e.startOffset - 60), e.startOffset + 60)}...`,
        );
      },
    });
  }
  return out;
}

describe("live page boot", () => {
  // 0.25.0 shipped IS_VIEW reading META.mode ABOVE `const META` — a temporal
  // dead zone that killed every live page at load. Snapshot boots never caught
  // it: IS_SNAPSHOT short-circuits the read. These boots execute the
  // NON-snapshot script path, where declaration order actually runs.
  test("a live capture page boots, connects, and ingests ws frames cleanly", () => {
    const page = bootPage(getLiveHtml({}));
    expect(page.errors).toEqual([]);
    const ws = page.sockets[0]!;
    ws.onopen!({});
    expect(page.els["status"].textContent).toBe("live");
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1")] }) });
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: msgPair("p2") }) });
    page.goto("#/session");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.els["convo"].innerHTML).toContain("hello");
  });

  test("session turns carry wall-clock: role-bar time, user rows inherit it", () => {
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1")] }) });
    page.goto("#/session");
    const convo = page.els["convo"].innerHTML;
    // Both the user head (inherited from the request that carried it) and
    // the attributed reply wear a time on the role bar.
    expect((convo.match(/class="turn-time/g) || []).length).toBe(2);
    // The user-prompt row hover names the wall-clock too (epoch fixture —
    // the rendered date is TZ-dependent, so match the shape).
    expect(page.els["threads"].innerHTML).toMatch(/user prompt\n\d{4}-\d{2}-\d{2} /);
  });

  // 0.39.0 moved the live trace to /trace and turned the root into a
  // redirect to the dashboard: a switcher row still pointing at the sibling's
  // root would bounce you off the trace view you just clicked toward.
  test("the instance switcher links siblings at their /trace", async () => {
    const others = [{ id: "b", port: 8723, project: "other", client: "codex", pid: 42, sessionId: "abcdef01-2222-3333-4444-555555555555" }];
    const page = bootPage(getLiveHtml({}), {
      hostname: "host.example",
      fetch: (url) => url === "/api/instances"
        ? Promise.resolve({ json: () => Promise.resolve(others) })
        : new Promise(() => {}),
    });
    await new Promise((r) => setTimeout(r, 0)); // let the poll's promise chain settle
    const html = page.els["inst"].innerHTML;
    expect(html).toContain('href="http://host.example:8723/trace"');
    expect(html).not.toContain('href="http://host.example:8723/"');
    expect(html).toContain('href="/dashboard"'); // the menu's all-runs row
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a view page boots as a document: status view, no auto-tail", () => {
    const page = bootPage(getLiveHtml({ mode: "view" }));
    expect(page.errors).toEqual([]);
    expect(page.els["status"].textContent).toBe("view");
    expect(page.els["autoscroll"].classList.contains("active")).toBe(false);
  });

  test("a slice deep link (@a..b) enters replay with the window set", () => {
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1"), msgPair("p2"), msgPair("p3")] }) });
    page.goto("#/session/aaaabbbb/@p1..p2");
    expect(page.errors).toEqual([]);
    expect(page.els["rp-slice"].style.display).toBe("block");
    expect(page.els["rp-slice-chip"].innerHTML).toContain("2 pairs");
    expect(page.els["rp-slice-chip"].innerHTML).toContain("export");
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a tail page behaves live: status 'tail', pulse strip painted from the wire", () => {
    const page = bootPage(getLiveHtml({ mode: "tail" }));
    expect(page.errors).toEqual([]);
    const ws = page.sockets[0]!;
    ws.onopen!({});
    expect(page.els["status"].textContent).toBe("tail");
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1")] }) });
    expect(page.els["pulse"].innerHTML).toContain("opus-4-6"); // the newest model call
    expect(page.els["pulse"].innerHTML).toContain("ago");
  });

  test("the boot placeholder ships a rotating verb; view pages never show the pulse", () => {
    const html = getLiveHtml({});
    expect(html).toContain('id="boot-verb"');
    expect(html).toContain("Reticulating");
    const view = bootPage(getLiveHtml({ mode: "view" }));
    const ws = view.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1")] }) });
    expect(view.els["pulse"] === undefined || !view.els["pulse"].innerHTML).toBe(true);
  });

  test("the newest model call's cache chip states 'expired' when past its deadline", () => {
    // msgPair timestamps are 1970-epoch — any real now is past the 5m hold,
    // which is exactly the reopened-idle-session case the marker exists for.
    const cached = msgPair("p2", { resBody: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } } });
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1"), cached]));
    page.goto("#/p/p2");
    expect(page.els["detail"].innerHTML).toContain("expired");
    page.goto("#/p/p1"); // NOT the newest — older deadlines mean nothing
    expect(page.els["detail"].innerHTML).not.toContain("· expired");
  });

  test("a single-pair deep link (@id) still works after the range grammar", () => {
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1"), msgPair("p2")] }) });
    page.goto("#/session/aaaabbbb/@p1");
    expect(page.errors).toEqual([]);
    expect(page.els["rp-slice"].style.display).not.toBe("block");
  });
});

describe("steps tree (turn → steps → final/recap)", () => {
  // One agentic loop on the wire: user ask, two tool steps (the first one's
  // result is_error), then the final response from the pair's response body.
  const loopPair = msgPair("p1", {
    reqBody: {
      messages: [
        { role: "user", content: "please fix the bug" },
        { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "t1", input: { command: "bun test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "1 fail" }] },
        { role: "assistant", content: [{ type: "tool_use", name: "Edit", id: "t2", input: { file_path: "src/x.ts", old_string: "a", new_string: "b" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
      ],
    },
    resBody: { content: [{ type: "text", text: "fixed it" }], stop_reason: "end_turn" },
  });

  function threadsHtml(pairs: TracePair[]) {
    const page = bootSnapshotPage(renderSnapshot(pairs));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
    return frag!.html;
  }

  test("intermediate steps carry sub-ordinals and step-of-N hovers", () => {
    const html = threadsHtml([loopPair]);
    expect(html).toContain('class="tturn-ord tturn-sord">.1<');
    expect(html).toContain('class="tturn-ord tturn-sord">.2<');
    expect(html).toContain("step 1 of 3");
    expect(html).toContain("step 2 of 3");
  });

  test("a step whose tool call errored wears the outcome mark", () => {
    const html = threadsHtml([loopPair]);
    expect(html).toContain('<span class="tturn-terr">tool err</span>');
    expect(html).toContain("1 tool call this step returned an error");
  });

  test("the final row names its wire stop reason", () => {
    const html = threadsHtml([loopPair]);
    expect(html).toContain("final response");
    expect(html).toContain("stop: end_turn");
  });

  test("a continuation summary heads its turn as a recap node, never the human's ❯", () => {
    const cont = msgPair("p2", {
      reqBody: {
        messages: [
          { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary covers..." },
        ],
      },
      resBody: { content: [{ type: "text", text: "resuming" }], stop_reason: "end_turn" },
    });
    const html = threadsHtml([cont]);
    expect(html).toContain('<span class="sys-tag">recap</span>');
    expect(html).toContain("auto recap (continuation summary)");
    // the recap row's gutter is a neutral dot, not the human's prompt glyph
    const row = html.slice(html.indexOf("auto recap") - 800, html.indexOf("auto recap"));
    expect(row).not.toContain("gut-user");
  });

  test("a genuine user head still wears ❯ and plain steps stay unmarked", () => {
    const html = threadsHtml([loopPair]);
    expect(html).toContain("gut-user");
    // the healthy Edit step has no outcome mark of its own
    const editRow = html.slice(html.indexOf(">.2<"), html.indexOf(">.2<") + 400);
    expect(editRow).not.toContain("tturn-terr");
  });
});

describe("sessions sidebar: ordering + subagent nesting", () => {
  const SID_B = JSON.stringify({ session_id: "bbbb2222-cccc-dddd-eeee-ffff00002222" });
  const agentPrompt = "explore the repo layout and report the entry points";

  // Session A: a main chat that dispatches a Task, plus the subagent run it
  // spawned. Session B: an unrelated, newer session.
  const dispatchPair = msgPair("p2", {
    reqBody: {
      messages: [
        { role: "user", content: "please fix the bug" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu_task", name: "Task", input: { subagent_type: "Explore", description: "explore repo", prompt: agentPrompt } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_task", content: "found them" }] },
      ],
    },
    resBody: { content: [{ type: "text", text: "fixed" }], stop_reason: "end_turn" },
  });
  const subagentPair = msgPair("p3", {
    reqBody: { messages: [{ role: "user", content: agentPrompt }] },
  });
  const otherSessionPair = msgPair("p9", {
    reqBody: {
      metadata: { user_id: SID_B },
      messages: [{ role: "user", content: "unrelated newer session" }],
    },
  });
  const PAIRS = [dispatchPair, subagentPair, otherSessionPair];

  function sidebar(pairs: TracePair[]) {
    const page = bootSnapshotPage(renderSnapshot(pairs));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
    return { page, html: frag!.html };
  }

  test("a subagent card nests under its dispatching thread, whatever is selected", () => {
    const { html } = sidebar(PAIRS);
    expect(html).toContain('class="tkids"');
    // the agent card lives inside the nested block, not as a floating sibling
    const kidsAt = html.indexOf('class="tkids"');
    const agentAt = html.indexOf("tkind-agent");
    expect(kidsAt).toBeGreaterThan(-1);
    expect(agentAt).toBeGreaterThan(kidsAt);
  });

  test("sessions order newest activity first, deterministically", () => {
    const { html } = sidebar(PAIRS);
    const bAt = html.indexOf('data-sid="bbbb2222');
    const aAt = html.indexOf('data-sid="aaaabbbb');
    expect(bAt).toBeGreaterThan(-1);
    expect(aAt).toBeGreaterThan(bAt); // p9 (t=1009) is newer than session A's pairs
  });

  test("the nested card survives selecting the parent (no jump between sibling and hidden)", () => {
    const page = bootSnapshotPage(renderSnapshot(PAIRS));
    page.goto("#/session");
    const keys = [...page.els["threads"].innerHTML.matchAll(/#\/session\/([^"]+)"/g)].map((m) => m[1]);
    for (const k of keys) {
      page.goto("#/session/" + k);
      const frag = page.fragments.filter((f) => f.id === "threads").pop();
      expect(frag!.html).toContain('class="tkids"');
    }
    expect(page.errors).toEqual([]);
  });

  test("a subagent's convo pane carries the jump back to the parent's spawn turn", () => {
    const page = bootSnapshotPage(renderSnapshot(PAIRS));
    page.goto("#/session");
    const keys = [...page.els["threads"].innerHTML.matchAll(/#\/session\/([^"]+)"/g)].map((m) => m[1]);
    let note = "";
    for (const k of keys) {
      page.goto("#/session/" + k);
      const convo = page.els["convo"].innerHTML;
      if (convo.includes("agent-note")) note = convo;
    }
    expect(note).toContain("jumpToParent(event, this)");
    expect(note).toContain('data-tuid="tu_task"');
    expect(note).toContain("parent thread");
    expect(page.errors).toEqual([]);
  });
});

describe("rich tool bodies in the session view", () => {
  test("an Edit fold carries the diff, hostile content stays escaped, raw input one fold deeper", () => {
    const p = msgPair("p1", {
      reqBody: {
        messages: [
          { role: "user", content: "fix it" },
          { role: "assistant", content: [{ type: "tool_use", name: "Edit", id: "t1", input: { file_path: "src/x.ts", old_string: "if (a < b) {", new_string: "if (a <= b) { // <script>" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        ],
      },
      resBody: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/session");
    const convo = page.els["convo"].innerHTML;
    expect(convo).toContain('class="diffview"');
    expect(convo).toContain("- if (a &lt; b) {");
    expect(convo).toContain("+ if (a &lt;= b) { // &lt;script&gt;");
    expect(convo).toContain("raw input");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("mask ships category CSS with sid excluded by default", () => {
    const html = getLiveHtml({});
    expect(html).toContain('data-mask="sid"');
    expect(html).toContain("mask-title [data-mask=");
    expect(html).toContain("['title', 'usage']; // default: sid stays readable");
  });

  test("the actions menu lives in the toolbar, runs housekeeping, hides on snapshots", () => {
    const live = bootPage(getLiveHtml({}));
    expect(live.els["actions-toggle"].style.display || "").not.toBe("none");
    const ws = live.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [msgPair("p1")], traceBytes: 5 * 1024 * 1024 }) });
    // the trace-size metric rides the ws frames into the header rollup
    expect(live.els["stats"].textContent).toContain("MB");
    // opening the menu renders runnable housekeeping, not copy-a-command rows
    live.els["actions-toggle"].onclick!({ stopPropagation() {} } as any);
    const menu = live.els["act-menu"].innerHTML;
    expect(menu).toContain("purge telemetry");
    expect(menu).toContain("compact bodies");
    expect(menu).toContain("snapshot .html");
    expect(menu).not.toContain("click copies");
    const snap = bootSnapshotPage(renderSnapshot([msgPair("p1")]));
    expect(snap.els["actions-toggle"].style.display).toBe("none");
  });
});

describe("generated markup grammar", () => {
  test("hostile captures render on every route with zero HTML parse errors", () => {
    const page = bootSnapshotPage(renderSnapshot(HOSTILE));
    allRoutes(page, HOSTILE);
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a sub-$0.0001 cost renders as text, not as a tag", () => {
    const page = bootSnapshotPage(renderSnapshot([HOSTILE[0]]));
    page.goto("#/p/p1");
    expect(page.els["detail"].innerHTML).toContain("&lt;$0.0001");
  });

  test("ANSI escapes are stripped from rendered conversation text", () => {
    const page = bootSnapshotPage(renderSnapshot([HOSTILE[1]]));
    page.goto("#/p/p2");
    const html = page.els["detail"].innerHTML;
    expect(html).toContain("stdout: Bold and bell");
    expect(html).not.toContain("");
    expect(html).not.toContain("[1m");
    expect(html).not.toContain("");
  });
});

describe("header trace totals", () => {
  test("the stats rollup sums requests, tokens, and est cost with a breakdown tip", () => {
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1"), msgPair("p2")]));
    const stats = page.els["stats"]!;
    expect(stats.textContent).toContain("2 req");
    expect(stats.textContent).toContain("in 200");
    expect(stats.textContent).toContain("out 100");
    expect(stats.textContent).toContain("$");
    expect(String(stats.dataset.tip)).toContain("2 model calls");
  });
});

describe("broken pairs degrade to one visible card", () => {
  test("a request-less pair is dropped at ingestion; the rest of the page renders", () => {
    const broken = { id: "bad1", request: null, response: null, duration: 0 } as unknown as TracePair;
    const page = bootSnapshotPage(renderSnapshot([HOSTILE[0], broken]));
    allRoutes(page, [HOSTILE[0]]);
    expect(page.errors).toEqual([]);
    // the good pair still renders everywhere
    expect(page.els["convo"].innerHTML).toContain("hello");
  });

  test("loader drops torn lines and structurally broken pairs, with counts", () => {
    const good = JSON.stringify(msgPair("p9"));
    const text = [good, '{"id":"x","request":null}', '{"torn...', ""].join("\n");
    const stats: TraceParseStats = { torn: 0, invalid: 0 };
    const pairs = parseTraceText(text, stats);
    expect(pairs).toHaveLength(1);
    expect(stats).toEqual({ torn: 1, invalid: 1 });
  });
});

describe("verifySnapshot", () => {
  test("a healthy snapshot passes", () => {
    const html = renderSnapshot(HOSTILE);
    expect(verifySnapshot(html, HOSTILE.length)).toBeNull();
  });

  test("a wrong pair count is reported", () => {
    const html = renderSnapshot(HOSTILE);
    expect(verifySnapshot(html, 99)).toContain("expected 99");
  });

  test("a tampered payload is reported", () => {
    const html = renderSnapshot(HOSTILE).replace("__PAIRS__ = [", "__PAIRS__ = [oops");
    expect(verifySnapshot(html, HOSTILE.length)).toContain("not valid JSON");
  });
});

describe("sessions layer rendering", () => {
  const SID_B = JSON.stringify({ session_id: "bbbb2222-cccc-dddd-eeee-ffff00002222" });

  test("single-session traces render as one open absorbed container (no chat card)", () => {
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1"), msgPair("p2")]));
    page.goto("#/session");
    const threadsFrag = page.fragments.filter((f) => f.id === "threads").pop();
    // 2026-07-20 round 5: the flat "[chat] N turns" card said less than the
    // session header does — every trace renders the sessions layer, a
    // single session as one container, open by default.
    expect(threadsFrag!.html).toContain("sess-sid");
    expect(threadsFrag!.html).toMatch(/<details class="sess[^"]*"[^>]* open>/);
    expect(threadsFrag!.html).not.toContain("tkind-chat");
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("two session ids render collapsible sections, newest first, grammar-clean", () => {
    const older = msgPair("p1");
    const newer = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (newer.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([older, newer]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(frag!.html).toContain('class="sess"');
    expect(frag!.html).toContain(">bbbb2222</span>"); // newest section
    expect(frag!.html).toContain(">aaaabbbb</span>"); // older section
    expect(frag!.html.indexOf("bbbb2222")).toBeLessThan(frag!.html.indexOf("aaaabbbb"));
    expect(frag!.html).toContain("2 sessions");
    expect(fragmentErrors(page)).toEqual([]); // grammar-check the new markup
    expect(page.errors).toEqual([]);
  });

  test("a session-id-prefix route selects that session's thread", () => {
    const older = msgPair("p1");
    const newer = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (newer.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([older, newer]));
    page.goto("#/session/aaaabbbb");
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain("hello"); // the older session's reply renders
    expect(page.errors).toEqual([]);
  });

  test("thread links carry the short sid8 key — no full (maskable) uuid in the URL", () => {
    const older = msgPair("p1");
    const newer = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (newer.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([older, newer]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    const m = frag!.html.match(/href="#\/session\/([^"]+)"/);
    expect(m).not.toBeNull();
    const key = decodeURIComponent(m![1]);
    expect(key).toMatch(/^[0-9a-f]{8}\|/); // sid8|grouping, not the full uuid
    expect(key).not.toContain("-");
    page.goto("#/session/" + m![1]); // and the short link resolves
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain("hello");
    expect(page.errors).toEqual([]);
  });

  test("outline rows carry sectioned tips, a fold-gutter tip, and copy feedback", () => {
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1"), msgPair("p2")]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    // The ❯ gutter (the fold toggle) explains itself on hover — the symbol's
    // own tip, separate from the row's content tip.
    expect(frag!.html).toContain("fold toggle");
    // Tips read content → divider (---) → metrics → "> " hints.
    expect(frag!.html).toContain("---");
    expect(frag!.html).toMatch(/data-tip="[^"]*&gt; click/);
    // The sid copy goes through the feedback handler, not a bare writeText.
    expect(frag!.html).toContain("copySessSid(event, this)");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("a session with exactly one chat absorbs it into the header (no chat card)", () => {
    const older = msgPair("p1");
    const newer = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (newer.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([older, newer]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    // session -> chat said the same thing twice: the header IS the chat now
    expect(frag!.html).toContain("data-goto=");
    expect(frag!.html).not.toContain("tkind-chat");
    expect(frag!.html).toContain('class="tmodel"'); // the chat's model chip moved up
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe("outline tool labels", () => {
  test("a tool-only assistant turn names its tools instead of a dead 'tools…'", () => {
    const p = msgPair("p1", {
      resBody: {
        content: [{ type: "tool_use", name: "Bash", id: "tu1", input: { command: "ls -la" } }],
        stop_reason: "tool_use",
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threads!.html).toMatch(/class="tname">Bash</); // named the tool, colorized
    expect(threads!.html).not.toContain("tools…"); // the old dead fallback is gone
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("spawn tools name the agent type and goal, purple-tinted", () => {
    const p = msgPair("p1", {
      resBody: {
        content: [{ type: "tool_use", name: "Agent", id: "t1", input: { subagent_type: "general-purpose", description: "map repo" } }],
        stop_reason: "tool_use",
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threads!.html).toContain('tname tname-agent">Agent</span>(general-purpose · map repo)');
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("multiple distinct tools are listed, capped with +N", () => {
    const p = msgPair("p1", {
      resBody: {
        content: [
          { type: "tool_use", name: "Read", id: "t1", input: { file_path: "a" } },
          { type: "tool_use", name: "Edit", id: "t2", input: { file_path: "a" } },
          { type: "tool_use", name: "Bash", id: "t3", input: { command: "x" } },
          { type: "tool_use", name: "Grep", id: "t4", input: { pattern: "y" } },
        ],
        stop_reason: "tool_use",
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    // ToolName(args) items: file tools name what they touched; 3 shown,
    // remainder counted
    expect(threads!.html).toContain('Read</span>(a)');
    expect(threads!.html).toContain('Edit</span>(a)');
    expect(threads!.html).toContain('Bash</span>(x)');
    expect(threads!.html).toContain(", +1");
    expect(fragmentErrors(page)).toEqual([]);
  });
});

describe("harness-authored messages", () => {
  test("a recap prompt wears the sys tag in outline and convo, never the human ring", () => {
    const recap = "The user stepped away and is coming back. Recap in under 40 words.";
    const p1 = msgPair("p1");
    const p2 = msgPair("p2", {
      reqBody: {
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: recap },
        ],
      },
      resBody: { content: [{ type: "text", text: "recap answer" }] },
    });
    const page = bootSnapshotPage(renderSnapshot([p1, p2]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threads!.html).toContain('sys-tag">recap</span>');
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain('sum-tag" title="sent with role');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe("model epochs rendering", () => {
  test("a /model switch renders epoch rows in the pane and a divider in the convo", () => {
    const first = { role: "user", content: "hi" };
    const r1 = msgPair("p1", { reqBody: { model: "claude-fable-5" }, resBody: { model: "claude-fable-5" } });
    const r2 = msgPair("p2", {
      reqBody: {
        model: "claude-opus-4-8",
        messages: [first, { role: "assistant", content: [{ type: "text", text: "hello" }] }, { role: "user", content: "again" }],
      },
      resBody: { model: "claude-opus-4-8", content: [{ type: "text", text: "hello again" }] },
    });
    const page = bootSnapshotPage(renderSnapshot([r1, r2]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threads!.html).toContain('class="tepoch"');       // T0 / T1 section heads
    expect(threads!.html).toContain(">T0</span>");
    expect(threads!.html).toContain(">fable-5</span>");
    expect(threads!.html).toContain(">opus-4-8</span>");
    // ordinals count working-loop turns (user → work → final), BARE and
    // 1-based on the rail: two user exchanges = 01, 02 — the last label
    // agrees with the "2 turns" count
    expect(threads!.html).toContain('tturn-ord">01</span>');
    expect(threads!.html).toContain('tturn-ord">02</span>');
    // the final response nests under its head with the ↳ marker
    expect(threads!.html).toContain('tturn-sub tturn-fin');
    expect(threads!.html).toContain(">↳</span>");
    expect(threads!.html.indexOf(">T0</span>")).toBeLessThan(threads!.html.indexOf('tturn-ord">01</span>'));
    expect(threads!.html.indexOf('tturn-ord">01</span>')).toBeLessThan(threads!.html.indexOf(">T1</span>"));
    // every row leads its gutter: user = ❯ prompt glyph, assistant = verdict dot
    expect(threads!.html).toContain('gut-user');
    expect(threads!.html).toContain('❯');
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain('class="epoch-mark"');     // divider at the switch
    expect(convo!.html).toContain("opus-4-8");
    // prose surfaces spell the same 1-based number: "01" on the rail is
    // "turn 01" on the convo role bar
    expect(convo!.html).toContain('<span class="turn-ord">turn 01</span>');
    expect(convo!.html).toContain('<span class="turn-ord">turn 02</span>');
    expect(convo!.html).not.toContain('<span class="turn-ord">turn 03</span>');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("session headers carry the icon + label; model chips stay bare", () => {
    const SID_B = JSON.stringify({ session_id: "bbbb2222-cccc-dddd-eeee-ffff00002222" });
    const a = msgPair("p1");
    const b = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (b.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([a, b]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(frag!.html).toContain('<span class="klabel">session</span>');
    expect(frag!.html).toContain('class="sico"');            // session glyph
    expect(frag!.html).not.toContain('>model</span>');       // no "model" label — the id speaks
    expect(frag!.html).toContain('data-tip=');               // instant hover details
    expect(page.errors).toEqual([]);
  });

  test("single-model threads render no epoch rows and no dividers", () => {
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1")]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(threads!.html).not.toContain("tepoch");
    expect(convo!.html).not.toContain("epoch-mark");
    expect(page.errors).toEqual([]);
  });
});

describe("compact boundary rendering (session-tab round 10)", () => {
  test("a /compact renders a rail cut row, a convo divider, and tags the summary turn", () => {
    const SUM = "This session is being continued from a previous conversation that ran out of context. The summary covers </script> earlier [1m work.";
    const pre: Record<string, unknown>[] = [];
    for (let i = 0; i <= 7; i++) {
      pre.push({ role: "user", content: "question " + i });
      if (i < 7) pre.push({ role: "assistant", content: [{ type: "text", text: "reply " + i }] });
    }
    const p1 = msgPair("c1", { reqBody: { messages: pre }, resBody: { content: [{ type: "text", text: "reply 7" }] } });
    const p2 = msgPair("c2", { reqBody: { messages: [{ role: "user", content: SUM }] }, resBody: { content: [{ type: "text", text: "welcome back" }] } });
    const page = bootSnapshotPage(renderSnapshot([p1, p2]));
    page.goto("#/session");
    const th = page.els["threads"].innerHTML;
    const cv = page.els["convo"].innerHTML;
    // outline: the cut row on the rail, spelling out the context collapse
    expect(th).toContain('class="tcompact"');
    expect(th).toContain("15 → 1 turns");
    // convo: the dashed divider + the tagged continuation summary turn
    expect(cv).toContain('class="cmark"');
    expect(cv).toContain('class="sum-tag"');
    // hostile summary content stays escaped through the new markup
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe("rewind boundaries and failed-request runs", () => {
  const u = (s: string) => ({ role: "user", content: s });
  const a = (s: string) => ({ role: "assistant", content: [{ type: "text", text: s }] });

  test("a rewind renders a 'rewound' boundary row, not 'compacted'", () => {
    const grown: any[] = [u("start here")];
    for (let i = 0; i < 7; i++) grown.push(a("reply " + i), u("question " + (i + 1)));
    const pPre = msgPair("p1", { reqBody: { messages: grown }, resBody: { content: [{ type: "text", text: "old tip" }] } });
    const pNew = msgPair("p2", {
      reqBody: { messages: [u("start here"), a("fresh start"), u("a new question")] },
      resBody: { content: [{ type: "text", text: "a new answer" }] },
    });
    const page = bootSnapshotPage(renderSnapshot([pPre, pNew]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threads!.html).toMatch(/class="tcompact-label">rewound</);
    expect(threads!.html).not.toMatch(/class="tcompact-label">compacted</);
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain("rewound · history stepped back");
    expect(convo!.html).toContain("a new answer"); // the live branch renders
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("a 429 retry storm collapses into one ordered error run row", () => {
    const hist2 = [u("q one"), a("r1"), u("q two")];
    const ok1 = msgPair("p1");
    const mk429 = (id: string) =>
      msgPair(id, {
        reqBody: { messages: hist2 },
        resBody: undefined as any,
      });
    const f1 = mk429("p2");
    const f2 = mk429("p3");
    const f3 = mk429("p4");
    for (const f of [f1, f2, f3]) {
      (f.response as any).status = 429;
      (f.response as any).body = { error: { type: "engine_overloaded_error", message: "overloaded" } };
    }
    const ok2 = msgPair("p5", { reqBody: { messages: hist2 }, resBody: { content: [{ type: "text", text: "r2" }] } });
    const page = bootSnapshotPage(renderSnapshot([ok1, f1, f2, f3, ok2]));
    page.goto("#/session");
    const threads = page.fragments.filter((f) => f.id === "threads").pop();
    // one collapsed run, not three tail rows
    expect(threads!.html.match(/terr-run/g)!.length).toBe(1);
    expect(threads!.html).toContain("3 failed requests");
    expect(threads!.html).toContain("429 engine_overloaded_error");
    // ordered: the run sits before the retry's turn, not dumped at the tail
    expect(threads!.html.indexOf("terr-run")).toBeLessThan(threads!.html.indexOf(">r2<"));
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain("errrun-mark");
    expect(convo!.html).toContain("3 failed requests");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });
});

describe("find in session (toolbar)", () => {
  test("the session view carries the find group and its keyboard contract", () => {
    const html = renderSnapshot([msgPair("p1")]);
    // The static chrome: a find group with the input + count slot, session-only.
    expect(html).toContain('id="tb-find"');
    expect(html).toContain('id="sfind"');
    expect(html).toContain('id="sfind-count"');
    expect(html).toContain("body.view-session #tb-find { display: flex; }");
    // The pulse clearance: the last line reads above the strip, not beneath it.
    expect(html).toContain("body.view-session.pulse-on #convo { padding-bottom: 64px; }");
    // The page still boots clean with the new script block.
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1")]));
    page.goto("#/session");
    expect(page.errors).toEqual([]);
  });
});

describe("context boundaries on the replay timeline", () => {
  test("a compaction gets its own mark in the harness lane", () => {
    const long: { role: string; content: unknown }[] = [];
    for (let i = 0; i < 12; i++) {
      long.push({ role: "user", content: "prompt " + i });
      long.push({ role: "assistant", content: [{ type: "text", text: "reply " + i }] });
    }
    const before = msgPair("k1", { reqBody: { messages: long } });
    const after = msgPair("k2", {
      reqBody: { messages: [{ role: "user", content: "This session is being continued from a previous conversation. Summary." }] },
    });
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: [before, after] }) });
    page.goto("#/session/aaaabbbb/@k1..k2");
    const body = page.els["rp-lanes-body"].innerHTML as string;
    // The cut is amber on both surfaces — one compaction, one class.
    expect(body).toContain('class="rp-mark cut"');
    expect((body.match(/rp-mark/g) || []).length).toBe(1);
    expect(body).toContain('data-lane="harness"');
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });
});

// The strip is the trace's SHAPE: five lanes over wall-clock, drawn from
// sessionLanes. Its markup is built from captured wire content (tool names,
// agent labels, the human's own words), so it gets the same hostile-fixture
// grammar treatment as every other generated fragment.
describe("the trajectory strip (#rp-lanes)", () => {
  const AGENT_SYS = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
  const PROMPT = "Explore </script><script>alert(1)</script> and report [1mback[0m";
  const TASK = {
    type: "tool_use",
    id: "tu_a",
    name: "Task",
    input: { subagent_type: "Explore", description: "<img src=x onerror=alert(2)>", prompt: PROMPT },
  };
  const BASH = { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "bun test" } };
  const HEAD = "map the repo [1mfast[0m & <b>well</b>";

  // p1 calls Bash -> p2 (result in) spawns a subagent -> a1 is the child ->
  // p4 fails 429 -> p5 is the retry that answers.
  function fixture(): TracePair[] {
    const h1 = [{ role: "user", content: HEAD }];
    const h2 = [...h1, { role: "assistant", content: [BASH] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_b", content: "ok" }] }];
    const h3 = [...h2, { role: "assistant", content: [TASK] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: "done" }] }];
    const p1 = msgPair("p1", { reqBody: { messages: h1 }, resBody: { content: [BASH], stop_reason: "tool_use" } });
    const p2 = msgPair("p2", { reqBody: { messages: h2 }, resBody: { content: [TASK], stop_reason: "tool_use" } });
    const a1 = msgPair("p3", {
      reqBody: { system: [{ type: "text", text: AGENT_SYS }], messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] },
      resBody: { content: [{ type: "text", text: "child reply" }] },
    });
    const p4 = msgPair("p4", { reqBody: { messages: h3 } });
    (p4.response as { status: number }).status = 429;
    (p4.response as { body: unknown }).body = { error: { type: "overloaded_error", message: "slow down" } };
    const p5 = msgPair("p5", { reqBody: { messages: h3 }, resBody: { content: [{ type: "text", text: "all done" }] } });
    return [p1, p2, a1, p4, p5];
  }

  test("replaying, the strip draws every lane and its gutter, and parses", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    page.goto("#/session/aaaabbbb/@p5"); // an @anchor enters replay paused
    const gut = page.els["rp-gut"].innerHTML as string;
    const body = page.els["rp-lanes-body"].innerHTML as string;
    // The gutter names every lane — a lane whose meaning is unstated is
    // decoration (and the geometry is fixed, so none of them can vanish).
    for (const l of ["human", "model", "tools", "agents", "harness"]) expect(gut).toContain(">" + l + "<");
    for (const l of ["human", "model", "tools", "agents", "harness"]) expect(body).toContain('data-lane="' + l + '"');
    // ONE point: the human's own prompt. A subagent's head is the parent
    // model's dispatch text, not a person's — it rides the agents lane
    // (sessionLanes skips heads of threads with agentOf).
    expect((body.match(/class="rp-point"/g) || []).length).toBe(1);
    expect((body.match(/rp-span model/g) || []).length).toBe(4); // p1 p2 p5 + the child's own
    // the Bash gap is a tools span carrying its initials AND its name
    expect(body).toContain("rp-span tools");
    expect(body).toContain('class="rp-lbl i">B<');
    expect(body).toContain('class="rp-lbl n">Bash<');
    // the verified spawn is an agent span; the 429 is a harness mark
    expect(body).toContain("rp-span agent");
    expect(body).toContain('class="rp-mark err"');
    // every span is clickable and carries a tip
    expect(body).toContain("data-rpt=");
    expect(body).toContain("data-tip=");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("not replaying, the strip is inert markup and nothing renders into it", () => {
    const html = renderSnapshot(fixture());
    expect(html).toContain('id="rp-lanes"');
    expect(html).toContain('data-depth="map"');
    expect(html).toContain('id="rp-lanes-body"');
    const page = bootSnapshotPage(html);
    page.goto("#/session");
    expect(page.els["rp-lanes-body"].innerHTML).toBe("");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the strip carries a clock row, ghosts every other thread, and dims the future", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    // The stub's default 100px track fits one tick by the 72px rule; give
    // the frame a real width so the ruler has something to rule.
    page.els["rp-scroll"].getBoundingClientRect = () => ({ left: 0, width: 1400, top: 0, height: 24 });
    page.goto("#/session/aaaabbbb/@p1");
    // the clock row: labelled in the gutter like every other lane, ticks in
    // local wall-clock
    expect(page.els["rp-gut"].innerHTML).toContain(">clock<");
    const axis = page.els["rp-axis"].innerHTML as string;
    expect((axis.match(/class="rp-tick/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(axis).toMatch(/\d\d:\d\d/);
    // thread focus: the subagent's own requests are not the selected loop's
    const body = page.els["rp-lanes-body"].innerHTML as string;
    expect((body.match(/rp-span model other/g) || []).length).toBe(1);
    // ...but the agent SPAN belongs to the parent that spawned it
    expect(body).toContain("rp-span agent");
    expect(body).not.toContain("rp-span agent other");
    // the veil covers the future, from the playhead to the right edge
    expect(page.els["rp-veil"].style.left).toBe("33.333%");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("selecting the CHILD flips the focus: its own spans draw full", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    page.els["rp-scroll"].getBoundingClientRect = () => ({ left: 0, width: 1400, top: 0, height: 24 });
    // at the child's end the parent's latest step is still the dispatch, so
    // the beat carries the spawn row — and its "open thread" link the key
    page.goto("#/session/aaaabbbb/@p3");
    const link = (page.els["threads"].innerHTML as string)
      .match(/class="fold-link" href="(#\/session\/[^"]+)"/);
    expect(link).not.toBeNull();
    page.goto(link![1]!);
    const body = page.els["rp-lanes-body"].innerHTML as string;
    // the parent's three requests ghost; the child's own is the picture
    expect((body.match(/rp-span model other/g) || []).length).toBe(3);
    expect((body.match(/rp-span model/g) || []).length).toBe(4);
    // and the agent span is the SELECTED thread — never ghosted against itself
    expect(body).toContain("rp-span agent");
    expect(body).not.toContain("rp-span agent other");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("entering replay from the requests tab still draws the ruler once it is on screen", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    // The requests tab is the landing view: #session-view is display:none,
    // so the strip's first render measures a zero-width frame — no ticks, no
    // span labels. That draw must not become the cached answer.
    page.els["rp-scroll"].getBoundingClientRect = () => ({ left: 0, width: 0, top: 0, height: 24 });
    page.els["replay-toggle"].onclick!({});
    expect(page.els["rp-axis"].innerHTML).toBe("");
    // the hash route lands, the session view is up, and the strip re-measures
    page.els["rp-scroll"].getBoundingClientRect = () => ({ left: 0, width: 1400, top: 0, height: 24 });
    page.goto("#/session");
    const axis = page.els["rp-axis"].innerHTML as string;
    expect((axis.match(/class="rp-tick/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(axis).toMatch(/\d\d:\d\d/);
    expect(page.els["rp-lanes-body"].innerHTML).toContain("w24"); // labels, too
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the past fill is gone — the strip dims what has not happened instead", () => {
    const html = renderSnapshot(fixture());
    expect(html).toContain('id="rp-veil"');
    expect(html).toContain('id="rp-axis"');
    expect(html).not.toContain('id="rp-fill"');
  });

  test("a live start draws an open span; the pair that answers it retires it", () => {
    const fix = fixture();
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    // init carries the starts already in flight when the page connected
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: fix.slice(0, 4), starts: [] }) });
    page.goto("#/session/aaaabbbb/@p4");
    expect(page.els["rp-lanes-body"].innerHTML).not.toContain("rp-span model open");
    ws.onmessage!({ data: JSON.stringify({ type: "start", start: { id: "p5", url: "https://api.anthropic.com/v1/messages", method: "POST", ts: 1005 } }) });
    const open = page.els["rp-lanes-body"].innerHTML as string;
    expect(open).toContain("rp-span model open");
    expect(open).toContain("in flight");
    // the response retires the start — no double-drawn request
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: fix[4] }) });
    expect(page.els["rp-lanes-body"].innerHTML).not.toContain("rp-span model open");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });
});

// The stage tops the threads column while replaying: the NOW line (the
// observed state at the cursor), the beat (what this step did) and the
// tally. Its rows are built from captured wire content — tool names,
// previews, the model's own words — so it gets the hostile-fixture grammar
// treatment too.
describe("the replay stage (#stage)", () => {
  const PROMPT = "Explore </script><script>alert(1)</script> and report [1mback[0m";
  const TASK = {
    type: "tool_use",
    id: "tu_a",
    name: "Task",
    input: { subagent_type: "Explore", description: "<img src=x onerror=alert(2)>", prompt: PROMPT },
  };
  const BASH = { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "bun test" } };
  const HEAD = "map the repo [1mfast[0m & <b>well</b>";
  const AGENT_SYS = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

  // p1 (head, calls Bash) -> p2 (spawns a subagent) -> p3 the child -> p5 the reply.
  function fixture(): TracePair[] {
    const h1 = [{ role: "user", content: HEAD }];
    const h2 = [...h1, { role: "assistant", content: [BASH] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_b", content: "ok" }] }];
    const h3 = [...h2, { role: "assistant", content: [TASK] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: "done" }] }];
    return [
      msgPair("p1", { reqBody: { messages: h1 }, resBody: { content: [BASH], stop_reason: "tool_use" } }),
      msgPair("p2", { reqBody: { messages: h2 }, resBody: { content: [TASK], stop_reason: "tool_use" } }),
      msgPair("p3", {
        reqBody: { system: [{ type: "text", text: AGENT_SYS }], messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }] },
        resBody: { content: [{ type: "text", text: "child reply" }] },
      }),
      msgPair("p5", { reqBody: { messages: h3 }, resBody: { content: [{ type: "text", text: "all done" }] } }),
    ];
  }
  // #stage is written as part of the threads pane's html — it must lead it.
  const stageOf = (page: ReturnType<typeof bootSnapshotPage>) => {
    const th = page.els["threads"].innerHTML as string;
    const at = th.indexOf('<div id="stage">');
    return at === -1 ? "" : th.slice(at, th.indexOf('<div class="threads-sum"'));
  };

  test("replaying, the stage leads the threads column: now, beat, so far — no diagram", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    page.goto("#/session/aaaabbbb/@p5"); // an @anchor enters replay paused
    const th = page.els["threads"].innerHTML as string;
    expect(th.indexOf('<div id="stage">')).toBe(0); // above the rail, not beside it
    const stage = stageOf(page);
    // The state DIAGRAM is gone: the loop's shape is the strip, the moment
    // is the now line.
    expect(stage).not.toContain('id="sd"');
    expect(stage).not.toContain("sd-node");
    // The now line: at the end of the tape nothing is running, so the dot
    // is hollow and the state is idle — with the clock it began at.
    expect(stage).toContain('<div id="stage-now"');
    expect(stage).toMatch(/id="stage-now"[^>]*data-state="idle"/);
    expect(stage).toContain('class="sn-dot hollow"');
    expect(stage).toMatch(/since \d\d:\d\d:\d\d/);
    // the beat names the turn it is showing (the outline's own numbering)
    expect(stage).toMatch(/turn\s*\d+/);
    expect(stage).toContain("all done"); // the reply's first line
    // the loop's head — which task this step serves — and its chapter seek
    expect(stage).toContain('class="sb-head" data-rpchap="0"');
    expect(stage).toContain("map the repo");
    // the tally: which tools were called and how often, as of the cursor
    expect(stage).toContain('class="st-sofar"');
    expect(stage).toContain("Bash 1");
    expect(stage).toContain("1 agent");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a spawn step's beat row links to the reconstructed child thread", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    // At the child's end the parent's latest step is still the dispatch, and
    // the child thread now exists — so the row can actually point at it.
    page.goto("#/session/aaaabbbb/@p3");
    const stage = stageOf(page);
    expect(stage).toContain('class="sb-row spawn"');
    expect(stage).toContain("open thread");
    expect(stage).toMatch(/class="fold-link" href="#\/session\//);
    // hostile spawn content stays escaped through the new markup
    expect(stage).not.toContain("<img src=x");
    expect(stage).toContain("&lt;img src=x");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a live start lights model as thinking, with an absolute clock", () => {
    const fix = fixture();
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: fix, starts: [] }) });
    page.goto("#/session/aaaabbbb/@p5"); // parked at the newest landed pair
    expect(stageOf(page)).not.toContain('class="live"');
    ws.onmessage!({ data: JSON.stringify({ type: "start", start: { id: "p9", url: "https://api.anthropic.com/v1/messages", method: "POST", ts: 1008 } }) });
    // renderStage patches #stage in place (a start rebuilds no pane), so the
    // fragment the page wrote last is the one to read.
    const live = page.els["stage"].innerHTML as string;
    expect(live).toMatch(/id="stage-now" class="live" data-state="model"/);
    expect(live).toContain(">thinking<");
    expect(live).toMatch(/since \d\d:\d\d:\d\d/); // absolute, never a counter
    // a live in-flight request has no known extent: no held duration
    expect(live).not.toContain("sn-held");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("Escape peels present, then replay — and the stage goes with replay", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    page.goto("#/session/aaaabbbb/@p5");
    expect(page.body.classList.contains("replaying")).toBe(true);
    page.fireKey("f");
    expect(page.body.classList.contains("present")).toBe(true);
    // one Escape drops the presentation and KEEPS the replay
    page.fireKey("Escape");
    expect(page.body.classList.contains("present")).toBe(false);
    expect(page.body.classList.contains("replaying")).toBe(true);
    expect(page.els["threads"].innerHTML).toContain('<div id="stage">');
    // the second exits replay, and the stage is torn down with it
    page.fireKey("Escape");
    expect(page.body.classList.contains("replaying")).toBe(false);
    expect(page.els["threads"].innerHTML).not.toContain('<div id="stage">');
    expect(page.errors).toEqual([]);
  });
});

// Replay TAILS a live run: a landed pair moves a cursor that was sitting at
// the live edge, and leaves one that was not alone. The rule is the convo's
// own (ui.md 3): stick when you're there, never yank when you're not.
describe("replay tails the live session", () => {
  const BASH = { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "bun test" } };

  // p1 (calls Bash) -> p2 -> p3, then p5 lands while the page is replaying.
  function fixture(): TracePair[] {
    const h1 = [{ role: "user", content: "map the repo" }];
    const h2 = [...h1, { role: "assistant", content: [BASH] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_b", content: "ok" }] }];
    return [
      msgPair("p1", { reqBody: { messages: h1 }, resBody: { content: [BASH], stop_reason: "tool_use" } }),
      msgPair("p2", { reqBody: { messages: h2 }, resBody: { content: [{ type: "text", text: "one" }] } }),
      msgPair("p3", { reqBody: { messages: h2 }, resBody: { content: [{ type: "text", text: "two" }] } }),
      msgPair("p5", { reqBody: { messages: h2 }, resBody: { content: [{ type: "text", text: "all done" }] } }),
    ];
  }
  // #rp-time reads "<local clock> · +<offset> / <length>" — the cursor's
  // position on the tape, which is what "did it follow" means.
  const offsetOf = (page: ReturnType<typeof bootPage>) =>
    String(page.els["rp-time"].textContent).split("\u00b7 ")[1];
  // The absolute half of the same readout: the wall-clock instant the cursor
  // sits on (unchanged by anything that only moves the tape's edges) and the
  // tape's length.
  const clockOf = (page: ReturnType<typeof bootPage>) =>
    String(page.els["rp-time"].textContent).split(" \u00b7 ")[0];
  const lengthOf = (page: ReturnType<typeof bootPage>) =>
    String(page.els["rp-time"].textContent).split(" / ")[1];

  function live() {
    const fix = fixture();
    const page = bootPage(getLiveHtml({}));
    const ws = page.sockets[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "init", pairs: fix.slice(0, 3), starts: [] }) });
    return { fix, page, ws };
  }

  test("a pair landing while the cursor is AT the edge advances it", () => {
    const { fix, page, ws } = live();
    page.goto("#/session/aaaabbbb/@p3"); // p3's end IS the live edge
    expect(offsetOf(page)).toBe("+0:04 / 0:04");
    expect(page.els["rp-live"].innerHTML).toContain("at-edge");
    page.els["convo"].scrollTop = page.els["convo"].scrollHeight; // reading the newest turn
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: fix[3] }) });
    // the cursor followed: still at the edge, and the tape is longer
    expect(offsetOf(page)).toBe("+0:06 / 0:06");
    expect(page.els["rp-live"].innerHTML).toContain("at-edge");
    // the beat moved with it, and it got the page's one live-arrived fade
    // (showSession rewrites the threads column, #stage with it)
    const stage = page.els["threads"].innerHTML as string;
    expect(stage).toContain('class="sb arrived"');
    expect(stage).toContain("all done");
    // the convo's bottom IS the moment, and the reader was there
    expect(page.els["convo"].scrollTop).toBe(page.els["convo"].scrollHeight);
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a pair landing while the reader is BEHIND moves nothing", () => {
    const { fix, page, ws } = live();
    page.goto("#/session/aaaabbbb/@p1"); // two pairs back from the edge
    expect(offsetOf(page)).toBe("+0:02 / 0:04");
    expect(page.els["rp-live"].innerHTML).toContain("rp-live-btn"); // the snap-back
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: fix[3] }) });
    // the strip grew; the cursor did not move and the beat did not fade
    expect(offsetOf(page)).toBe("+0:02 / 0:06");
    expect(page.els["threads"].innerHTML).not.toContain("sb arrived");
    expect(page.errors).toEqual([]);
  });

  test("a tail advance rebuilds the session view ONCE, at the new cursor", () => {
    const { fix, page, ws } = live();
    page.goto("#/session/aaaabbbb/@p3");
    const before = page.fragments.filter((f) => f.id === "threads").length;
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: fix[3] }) });
    // The tail moves the cursor and then renders: rendering first would
    // build the whole view twice per landed pair, once at a cursor already
    // gone.
    expect(page.fragments.filter((f) => f.id === "threads").length - before).toBe(1);
    expect(page.errors).toEqual([]);
  });

  test("a pair that changes no step advances the cursor without the fade", () => {
    const { page, ws } = live();
    page.goto("#/session/aaaabbbb/@p3");
    // A count_tokens probe lands at the edge: it is on the tape, it is not a
    // step. The live-arrived fade says "a new step" — it must stay quiet.
    const probe = msgPair("p6");
    (probe.request as { url: string }).url = "https://api.anthropic.com/v1/messages/count_tokens";
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: probe }) });
    expect(offsetOf(page)).toBe("+0:07 / 0:07"); // the cursor still followed
    expect(page.els["threads"].innerHTML).not.toContain("sb arrived");
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a reader who scrolled up keeps their place while the cursor follows", () => {
    const { fix, page, ws } = live();
    page.goto("#/session/aaaabbbb/@p3");
    page.els["convo"].scrollTop = 0; // reading history
    ws.onmessage!({ data: JSON.stringify({ type: "pair", pair: fix[3] }) });
    expect(offsetOf(page)).toBe("+0:06 / 0:06"); // the cursor still followed
    expect(page.els["convo"].scrollTop).toBe(0); // ...and the scroll was not yanked
    expect(page.errors).toEqual([]);
  });

  test("older pairs merged in (history) never move the cursor", () => {
    const { page, ws } = live();
    page.goto("#/session/aaaabbbb/@p3");
    const before = clockOf(page);
    expect(lengthOf(page)).toBe("0:04");
    // A prior run's pair, EARLIER than everything on the tape: the left edge
    // moves, so the offset legitimately changes — the moment does not.
    const older = msgPair("p0", { reqBody: { messages: [{ role: "user", content: "yesterday" }] } });
    ws.onmessage!({ data: JSON.stringify({ type: "history", pairs: [older] }) });
    expect(clockOf(page)).toBe(before); // the same instant, to the second
    expect(lengthOf(page)).toBe("0:05"); // ...on a longer tape
    expect(page.errors).toEqual([]);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the live chip and End both snap a reader back to the edge", () => {
    const { page } = live();
    page.goto("#/session/aaaabbbb/@p1");
    expect(offsetOf(page)).toBe("+0:02 / 0:04");
    // the chip's button
    expect((page.els["rp-live"].innerHTML as string).includes("rp-live-btn")).toBe(true);
    page.els["convo"].scrollTop = 0;
    page.fireKey("End");
    expect(offsetOf(page)).toBe("+0:04 / 0:04");
    expect(page.els["rp-live"].innerHTML).toContain("at-edge");
    // a SEEK rebuilds the convo as of the cursor and lands on its bottom
    expect(page.els["convo"].scrollTop).toBe(page.els["convo"].scrollHeight);
    // and back, then the transport button
    page.fireKey("Home");
    expect(offsetOf(page)).toBe("+0:00 / 0:04");
    page.els["rp-end"].onclick!({});
    expect(offsetOf(page)).toBe("+0:04 / 0:04");
    expect(page.errors).toEqual([]);
  });

  test("a reading page has no live chip — a saved trace has no edge to chase", () => {
    const page = bootSnapshotPage(renderSnapshot(fixture()));
    page.goto("#/session/aaaabbbb/@p3");
    expect(page.els["rp-live"].innerHTML).toBe("");
    expect(page.els["rp-exit"].textContent).toBe("\u2715 exit");
  });
});

describe("the trajectory gutter on the session rail", () => {
  // The rail already drew the agent's path; the gutter gives it magnitude —
  // per step, how full the window was, split cached vs billed fresh.
  const TRAJ: TracePair[] = [
    msgPair("j1", {
      reqBody: { messages: [{ role: "user", content: "start" }] },
      resBody: { usage: { input_tokens: 20000, output_tokens: 40, cache_read_input_tokens: 0 } },
    }),
    msgPair("j2", {
      reqBody: {
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a".repeat(4000) }] },
        ],
      },
      resBody: { usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 60000 } },
    }),
  ];

  test("a track is drawn only where the wire reported usage; every other row gets the spacer", () => {
    const page = bootSnapshotPage(renderSnapshot(TRAJ));
    page.goto("#/session");
    const rail = page.els["threads"].innerHTML;
    // Exactly one row here HAS provider-reported usage: the assistant turn
    // j2's response produced. The human's "start" row and the history-only
    // assistant turn (a tool_use replayed from j2's request, never a wire
    // request of its own) have nothing to measure, so they get the
    // invisible spacer — NOT an empty outlined track, which would be a bar
    // claiming a measurement it does not have.
    expect((rail.match(/class="tctx"/g) || []).length).toBe(1);
    expect((rail.match(/tctx-none/g) || []).length).toBe(2);
    // and the one real track is split: 60k of 60.5k came from cache
    expect(rail).toContain("tctx-c");
    expect(rail).toContain("tctx-f");
    // an empty bordered track must never appear
    expect(rail).not.toMatch(/<span class="tctx"><\/span>/);
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("the hover names the denominator instead of implying one", () => {
    const page = bootSnapshotPage(renderSnapshot(TRAJ));
    page.goto("#/session");
    const rail = page.els["threads"].innerHTML;
    // models.dev knows opus's window, so the % is against the window
    expect(rail).toContain("context 60.5k");
    expect(rail).toMatch(/context [\d.]+k · \d+% of a \d+k window/);
  });
});

describe("context view", () => {
  const REMINDER = "<system-reminder>Recalled memory: the user prefers tabs.</system-reminder>";
  // A three-step thread: reminder + prompt, then a tool round-trip, then a
  // longer packing — enough surface for composition, events, and the graph.
  const CTX_PAIRS: TracePair[] = [
    msgPair("c1", {
      reqBody: {
        system: [{ type: "text", text: "You are Claude Code." }],
        tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
        messages: [{ role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "list the files" }] }],
      },
    }),
    msgPair("c2", {
      reqBody: {
        system: [{ type: "text", text: "You are Claude Code." }],
        tools: [{ name: "Bash", description: "run a command", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: REMINDER }, { type: "text", text: "list the files" }] },
          { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts b.ts" }] },
        ],
      },
      resBody: { content: [{ type: "text", text: "two files" }] },
    }),
  ];

  test("the shell ships: an overview on top, a reconciling margin, one deck", () => {
    const html = renderSnapshot(CTX_PAIRS);
    expect(html).toContain('id="tab-context"');
    expect(html).toContain('id="context-view"');
    // the Trajectory tab folded into this page — it was a reading, not a view
    expect(html).not.toContain('id="tab-trajectory"');
    expect(html).not.toContain('id="trajectory-view"');
    const page = bootSnapshotPage(html);
    page.goto("#/context");
    expect(page.errors).toEqual([]);
    const cx = page.els["context-view"].innerHTML;
    // the overview: the page's time axis, above the two-pane shell
    expect(cx).toContain('id="cx-ov"');
    expect(cx).toContain('id="cx-tracks"');
    expect(cx).toContain('id="cx-brush"');
    expect(cx).toContain('id="cx-ov-scroll"');
    expect(cx).toContain("drag to select");
    expect(cx).toContain("wheel to zoom");
    // the shell: a margin that reconciles beside a deck that scrolls
    expect(cx).toContain('class="cx-cols"');
    expect(cx).toContain('id="cx-margin"');
    expect(cx).toContain('class="cx-canvas mode-window"');
    expect(cx).toContain('id="cx-deck"');
    // three readings of ONE selection, window first
    expect(cx).toContain('data-cxmode="window"');
    expect(cx).toContain('data-cxmode="stream"');
    expect(cx).toContain('data-cxmode="events"');
    expect((cx.match(/class="cx-mode active"/g) || []).length).toBe(1);
    // the margin's balance: the headline, the bar, the reconciliation
    expect(cx).toContain("cx-bal-n");
    expect(cx).toContain("of context used");
    expect(cx).toContain("cx-recon");
    // counts caption the thing they count — never an orphan chips row
    expect(cx).toContain("wire request");
    expect(cx).toContain("working loop");
    // one column per wire request, each addressable by the brush
    expect((cx.match(/data-cxbar=/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(cx).toContain('data-cxc="0"');
    // the ledger names all six categories, and every line is a zoom
    for (const label of ["system prompt", "tool schemas", "user messages", "injected context", "assistant replies", "tool results"]) {
      expect(cx).toContain(label);
    }
    expect((cx.match(/class="cx-crow[ "]/g) || []).length).toBe(6);
    expect(cx).toContain('data-cxnode="c:toolResult"');
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the granularity, zoom and brush controls all live on the overview", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain('data-cxgran="step"');
    expect(cx).toContain('data-cxgran="turn"');
    expect(cx).toContain('data-cxzoomb="in"');
    expect(cx).toContain('data-cxzoomb="out"');
    expect(cx).toContain('data-cxzoomb="fit"');
    // no range brushed yet: no brush window, no caption — never a fake selection
    expect(cx).toContain('id="cx-brush"></div>');
    expect(cx).not.toContain("esc clears<");
    expect(cx).not.toContain("cx-brush-win");
    // the gutter names each track and states its own top of scale
    expect(cx).toContain('class="cx-ov-gn">ctx<');
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the stream deck is the old Trajectory tab, scoped to this page", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context/=stream");
    expect(page.errors).toEqual([]);
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain('class="cx-canvas mode-stream"');
    // the record stream: rows with kind badges, the inspector beside them
    expect(cx).toContain('class="tj-list"');
    expect(cx).toContain('id="tj-detail"');
    expect(cx).toContain('class="tj-badge"');
    expect(cx).toContain("USER");
    expect(cx).toContain("CONTEXT"); // the reminder is the harness's, not the human's
    expect(cx).toContain("TOOL");
    // archify's MAP/READ/FULL, and the kind filter
    expect(cx).toContain('data-tjlvl="map"');
    expect(cx).toContain('data-tjlvl="read"');
    expect(cx).toContain('data-tjlvl="full"');
    expect(cx).toContain('data-tjkind="context"');
    // ...but no second head: the page head and the margin already say it
    expect(cx).not.toContain("tj-head");
    expect(cx).not.toContain("tj-counts");
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a stream search that matches nothing says so instead of throwing", () => {
    // 0.45.0 review: the empty branch referenced an undeclared name, so one
    // unmatched keystroke froze the deck on the previous render.
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context/=stream");
    const search = page.els["tj-search"];
    search.value = "zzz-nothing-in-this-stream";
    // One dispatch: the stub reuses the element by id, so every repaint
    // re-registers the listener and a loop over the live list never ends.
    const onInput = (search.listeners.input || [])[0];
    expect(onInput).toBeDefined();
    onInput!({} as any);
    expect(page.errors).toEqual([]);
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("no records match this filter");
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("the old #/trajectory route lands on the stream deck and rewrites itself", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/trajectory");
    expect(page.errors).toEqual([]);
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain('class="cx-canvas mode-stream"');
    expect(cx).toContain('class="tj-list"');
  });

  test("where the time went is a margin block, and a track on the overview", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("where the time went");
    expect(cx).toContain('class="cx-time"'); // the second overview track
    expect(cx).toContain('class="cx-ov-gn">time<');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("the six numbers are rendered ONCE as a list: no legend, no detail strip", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    // the old page rendered the categories three times (legend, detail
    // strip, icicle row 1). The ledger is the one LIST; the icicle is a
    // chart, not a list. Both dead classes must stay dead.
    expect(cx).not.toContain("cx-leg-row");
    expect(cx).not.toContain('id="cx-detail"');
    // and the graph sheds the step facts the margin already states
    expect((cx.match(/class="cx-dhead"/g) || []).length).toBe(1);
  });

  test("an injected reminder shows as an inject event and in the graph's inject items", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context/=events");
    const cx = page.els["context-view"].innerHTML;
    // the event row names the reminder's opening words
    expect(cx).toContain("Recalled memory");
    // provider-anchored actuals sit next to the estimate
    expect(cx).toContain("actual prompt");
    expect(cx).toContain("≈"); // ≈ estimates
  });

  test("a compaction-scale drop wears the scissors mark and logs the reclaim", () => {
    const long: { role: string; content: unknown }[] = [];
    for (let i = 0; i < 12; i++) {
      long.push({ role: "user", content: "prompt " + i });
      long.push({ role: "assistant", content: [{ type: "text", text: "reply " + i }] });
    }
    const before = msgPair("d1", {
      reqBody: { messages: long },
      resBody: { usage: { input_tokens: 5000, output_tokens: 10 } },
    });
    const after = msgPair("d2", {
      reqBody: { messages: [{ role: "user", content: "This session is being continued from a previous conversation. Summary." }] },
      resBody: { usage: { input_tokens: 300, output_tokens: 10 } },
    });
    const page = bootSnapshotPage(renderSnapshot([before, after]));
    page.goto("#/context/=events");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("cx-mark"); // ✂ above the post-compact bar
    expect(cx).toContain("cx-colw cut"); // ...and the axis-break rule down the bar
    expect(cx).toContain("context rewritten"); // rewrite-mode label via the session layer
    // the count captions the section it belongs to, not an orphan chip row
    expect(cx).toContain("1 compaction");
    expect(cx).toContain("reclaimed");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("a model switch between steps is an event with both ids", () => {
    const p1 = msgPair("m1");
    const p2 = msgPair("m2", {
      reqBody: {
        model: "claude-fable-5",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "more" },
        ],
      },
      resBody: { model: "claude-fable-5" },
    });
    const page = bootSnapshotPage(renderSnapshot([p1, p2]));
    page.goto("#/context/=events");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("opus-4-6 → fable-5");
  });

  test("the graph is an icicle: tool results grouped by tool, schemas by server", () => {
    const p = msgPair("g1", {
      reqBody: {
        tools: [
          { name: "Bash", description: "run", input_schema: { type: "object" } },
          { name: "mcp__docs__search", description: "search", input_schema: { type: "object" } },
          { name: "mcp__docs__fetch", description: "fetch", input_schema: { type: "object" } },
        ],
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "b".repeat(3000) }] },
        ],
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    // the graph is an icicle: rows of positioned nodes, width = tokens
    expect(cx).toContain('class="cx-frow"');
    expect(cx).toMatch(/class="cx-fn[^"]*" style="left:[\d.]+%;width:[\d.]+%/);
    // one node for both Bash results, one for the MCP server's schemas
    expect(cx).toContain('data-cxnode="g:toolResult/t:Bash"');
    expect(cx).toContain('data-cxnode="g:tools/mcp:docs"');
    expect(cx).toContain("mcp · docs");
    // row 1 is the composition bar's six, in CTX_CATS order
    // Row 1 of the flame is the six in CTX_CATS order — scoped to the
    // flame, because the margin's ledger emits the same node keys (that
    // correspondence is the point, and it is asserted next).
    const flame = cx.slice(cx.indexOf('class="cx-flame"'));
    const cats = [...flame.matchAll(/data-cxnode="c:(\w+)"/g)].map(m => m[1]);
    expect(cats).toEqual(["tools", "user", "assistant", "toolResult"]); // no system block in this fixture
    // the ledger states all six, always, in the same order — it is the
    // invariant the chart stops showing the moment you zoom
    const margin = cx.slice(cx.indexOf('id="cx-margin"'), cx.indexOf('class="cx-canvas'));
    expect([...margin.matchAll(/data-cxnode="c:(\w+)"/g)].map(m => m[1]))
      .toEqual(["system", "tools", "user", "inject", "assistant", "toolResult"]);
    // a container node zooms, a leaf opens
    expect(cx).toContain('data-cxkids="1"');
    expect(cx).toContain('data-cxkids="0"');
    // and it opens on the answer: the heaviest group is selected
    expect(cx).toMatch(/class="cx-fn sel"[^>]*data-cxnode="g:toolResult\/t:Bash"/);
    // labelled nodes are keyboard-reachable; slivers are reached by zoom
    expect(cx).toMatch(/data-cxnode="c:toolResult"[^>]*tabindex="0"/);
    // the size/order lens is offered, size by default
    expect(cx).toContain('data-cxsort="size"');
    expect(cx).toContain('data-cxsort="order"');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("a multi-session trace gets the thread picker; a single-thread one does not", () => {
    const one = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    one.goto("#/context");
    expect(one.els["context-view"].innerHTML).not.toContain("other threads");

    // two sessions on the wire (a /clear rotates the sid) — the picker is
    // both the switcher and the cross-session comparison
    const other = msgPair("s9", {
      reqBody: {
        metadata: { user_id: "ccccdddd-1111-2222-3333-444455556666" },
        messages: [{ role: "user", content: "a second session" }],
      },
      resBody: { usage: { input_tokens: 400, output_tokens: 20, cache_read_input_tokens: 9000 } },
    });
    const page = bootSnapshotPage(renderSnapshot([...CTX_PAIRS, other]));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("other threads");
    expect(cx).toContain("2 sessions");
    // each thread is a row linking to its own context route
    expect((cx.match(/class="cx-th[ "]/g) || []).length).toBe(2);
    expect(cx).toContain('href="#/context/');
    expect(cx).toContain("cx-th-fill");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("at the root the graph carries no breadcrumb — row 0 already names it", () => {
    // (the zoomed state's layout is covered in tests/context.test.ts, which
    // drives ctxFlameLayout directly; this stub renders markup, not clicks)
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).not.toContain("cx-crumbs");
    expect(cx).toContain('data-cxnode="root"');
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a recurring injector rolls up instead of burying the one-off events", () => {
    // the per-step token-budget banner fires on EVERY step; 6 of them must
    // not push the one compaction/model event off the top of the list
    const msgs: { role: string; content: unknown }[] = [{ role: "user", content: "the ask" }];
    const pairsOut = [];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: "assistant", content: [{ type: "text", text: "step " + i }] });
      msgs.push({ role: "user", content: [{ type: "text", text: "<total_tokens>" + (14900000 - i * 1000) + " tokens left</total_tokens>\n\nProactive output style is active." }] });
      pairsOut.push(msgPair("e" + i, { reqBody: { messages: msgs.slice() } }));
    }
    const page = bootSnapshotPage(renderSnapshot(pairsOut));
    page.goto("#/context/=events");
    const cx = page.els["context-view"].innerHTML;
    // the chips still count every raw event...
    expect(cx).toContain("inject 6");
    // ...but the list shows one rolled row for the run
    expect(cx).toContain("token budget");
    expect((cx.match(/class="cx-ev"/g) || []).length).toBe(1);
    expect(cx).toContain('class="cx-ev-n">×6<');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("a step links back to its turn in the sessions timeline", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    // the reverse of the convo pane's "context →": the picked step names
    // its turn and jumps into the rail
    expect(cx).toContain('onclick="return ctxJumpTurn(event, this)"');
    expect(cx).toMatch(/data-vi="\d+"/);
    expect(cx).toContain("turn 01");
    expect(fragmentErrors(page)).toEqual([]);
  });

  // A warm step, then one that re-bought the whole prefix: the shape every
  // cost surface below reads (docs/design/cost.md).
  const COST_PAIRS: TracePair[] = [
    msgPair("k1", {
      reqBody: { messages: [{ role: "user", content: "start" }] },
      resBody: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100000, cache_creation_input_tokens: 500 },
      },
    }),
    msgPair("k2", {
      reqBody: {
        messages: [
          { role: "user", content: "start" },
          { role: "assistant", content: "hello" },
          { role: "user", content: "carry on" },
        ],
      },
      resBody: {
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 },
      },
    }),
  ];

  test("the overview grows a cost track when the catalog priced the thread", () => {
    const page = bootSnapshotPage(renderSnapshot(COST_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain('class="cx-cost"');
    expect(cx).toContain('class="cx-ov-gn">cost<');
    // one column per step, addressable by the same brush as the other tracks
    expect((cx.match(/class="cx-cw[ "]/g) || []).length).toBe(2);
    expect(cx).toContain("every dollar is an estimate from catalog rates");
    // the bump wears a mark, the way a compaction wears ✂
    expect(cx).toContain('class="cx-cmark"');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("an unpriced model draws no cost track and no cost block — never $0", () => {
    const p = msgPair("z1", {
      reqBody: { model: "some-unknown-model" },
      resBody: { model: "some-unknown-model" },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).not.toContain('class="cx-cost"');
    expect(cx).not.toContain('class="cx-ov-gn">cost<');
    expect(cx).not.toContain("where the money went");
    expect(page.errors).toEqual([]);
  });

  test("the margin's money block names all four billed components", () => {
    const page = bootSnapshotPage(renderSnapshot(COST_PAIRS));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("where the money went");
    for (const part of ["cache read", "cache write", "input", "output"]) {
      expect(cx).toContain("</i>" + part + " ≈$");
    }
    // the bumps line is a control into the events deck
    expect(cx).toContain("data-cxbumps");
    expect(cx).toContain("over warm");
    // and the pinned step states its own bill once, with the cache share
    expect(cx).toMatch(/≈\$[\d.]+ this step/);
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a cost bump is an event row: the cause in words, the delta in dollars", () => {
    const page = bootSnapshotPage(renderSnapshot(COST_PAIRS));
    page.goto("#/context/=events");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain('class="cx-ev-kind">cost<');
    expect(cx).toContain("prefix changed");
    expect(cx).toMatch(/class="cx-delta plus">≈\+\$[\d.]+</);
    // the chip counts it beside the other kinds
    expect(cx).toContain('data-evf="cost"');
    expect(cx).toContain("re-billed at input/write rate");
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("quota renders from a usage poll, and not at all without one", () => {
    const poll = {
      id: "q1",
      request: { timestamp: 1500, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {} },
      response: {
        timestamp: 1501,
        status: 200,
        headers: {},
        body: {
          five_hour: { utilization: 37, resets_at: "2026-08-19T10:59:59Z" },
          seven_day: { utilization: 47, resets_at: "2026-08-19T15:59:59Z" },
        },
      },
      duration: 100,
      loggedAt: "x",
    } as unknown as TracePair;
    const page = bootSnapshotPage(renderSnapshot([...COST_PAIRS, poll]));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain(">quota<");
    expect(cx).toContain('class="cx-qlabel">5h<');
    expect(cx).toContain('class="cx-qn">37%<');
    expect(cx).toContain("resets ");
    expect(cx).toContain("as polled by the client at");
    expect(fragmentErrors(page)).toEqual([]);

    const bare = bootSnapshotPage(renderSnapshot(COST_PAIRS));
    bare.goto("#/context");
    expect(bare.els["context-view"].innerHTML).not.toContain(">quota<");
  });

  test("a session-id-prefix context route resolves like the sessions view", () => {
    const page = bootSnapshotPage(renderSnapshot(CTX_PAIRS));
    page.goto("#/context/aaaabbbb");
    expect(page.errors).toEqual([]);
    expect(page.els["context-view"].innerHTML).toContain("of context used");
  });
});

describe("multi-modal: wire image attachments", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  test("an Anthropic base64 image renders as a real thumbnail in every surface", () => {
    const p = msgPair("i1", {
      reqBody: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this screenshot?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
        ],
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/p/i1");
    expect(page.els["detail"].innerHTML).toContain('img class="msg-img"');
    expect(page.els["detail"].innerHTML).toContain("data:image/png;base64,");
    page.goto("#/session");
    expect(page.els["convo"].innerHTML).toContain('img class="msg-img"');
    expect(fragmentErrors(page)).toEqual([]);
    expect(page.errors).toEqual([]);
  });

  test("hostile media types and payloads degrade to a note, never markup", () => {
    const p = msgPair("i2", {
      reqBody: {
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: 'image/svg"><script>alert(1)</script>', data: PNG } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: '"><img onerror=alert(1) src=x>' } },
            ],
          },
        ],
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/p/i2");
    const html = page.els["detail"].innerHTML;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=alert");
    expect(fragmentErrors(page)).toEqual([]);
  });

  test("a remote image URL is named, never fetched", () => {
    const p = msgPair("i3", {
      reqBody: {
        messages: [
          { role: "user", content: [{ type: "image", source: { url: "https://evil.example/x.png" } }] },
        ],
      },
    });
    const page = bootSnapshotPage(renderSnapshot([p]));
    page.goto("#/p/i3");
    const html = page.els["detail"].innerHTML;
    expect(html).toContain("not fetched");
    expect(html).not.toContain('src="https://evil.example');
  });

  test("a step's bar tip carries its cache story", () => {
    const page = bootSnapshotPage(renderSnapshot([
      msgPair("h1", { resBody: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 } } }),
    ]));
    page.goto("#/context");
    const cx = page.els["context-view"].innerHTML;
    expect(cx).toContain("cache read 90 (90% of prompt)");
  });
});
