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

  test("single-session traces render with zero new chrome", () => {
    const page = bootSnapshotPage(renderSnapshot([msgPair("p1"), msgPair("p2")]));
    page.goto("#/session");
    const threadsFrag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(threadsFrag!.html).not.toContain('class="sess"');
    expect(threadsFrag!.html).not.toContain("sess-sid");
  });

  test("two session ids render collapsible sections, newest first, grammar-clean", () => {
    const older = msgPair("p1");
    const newer = msgPair("p9", { reqBody: { metadata: { user_id: SID_B } } });
    (newer.request as any).timestamp = 99999;
    const page = bootSnapshotPage(renderSnapshot([older, newer]));
    page.goto("#/session");
    const frag = page.fragments.filter((f) => f.id === "threads").pop();
    expect(frag!.html).toContain('class="sess"');
    expect(frag!.html).toContain("session bbbb2222"); // newest section
    expect(frag!.html).toContain("session aaaabbbb"); // older section
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
});
