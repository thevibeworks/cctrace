import { describe, test, expect } from "bun:test";
import { parseFragment } from "parse5";
import { renderSnapshot, verifySnapshot } from "../src/ui";
import { parseTraceText, type TraceParseStats } from "../src/history";
import { bootSnapshotPage } from "./dom-stub";
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
    // turns nest under their epoch head, ordinals global across epochs
    expect(threads!.html).toContain(">turn00</span>");
    expect(threads!.html).toContain(">turn02</span>");
    expect(threads!.html.indexOf(">T0</span>")).toBeLessThan(threads!.html.indexOf(">turn00</span>"));
    expect(threads!.html.indexOf(">turn01</span>")).toBeLessThan(threads!.html.indexOf(">T1</span>"));
    // every turn row carries a dot: user = hollow ring, assistant = verdict
    expect(threads!.html).toContain('cdot-user');
    const convo = page.fragments.filter((f) => f.id === "convo").pop();
    expect(convo!.html).toContain('class="epoch-mark"');     // divider at the switch
    expect(convo!.html).toContain("opus-4-8");
    // the outline's numbering repeats on the reconstructed turns
    expect(convo!.html).toContain('<span class="turn-ord">turn00</span>');
    expect(convo!.html).toContain('<span class="turn-ord">turn03</span>');
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
