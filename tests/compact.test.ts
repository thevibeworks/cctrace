import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  planDecisions,
  stubPair,
  collapsePair,
  isStubBody,
  histLenOf,
  threadKeyOf,
  planCompact,
  applyCompact,
} from "../src/compact";
import { buildSession } from "../src/session";
import { categorizeUrl } from "../src/categorize";
import { wireTables } from "../src/clients";
import type { TracePair } from "../src/types";

const WIRE = wireTables();
const categorize = (url: string, client?: string) => categorizeUrl(url, client, WIRE);

// Wire-shaped fixtures: each /v1/messages request re-sends the whole
// conversation-so-far — the redundancy compact folds.

let seq = 0;
function msgPair(messages: any[], opts: any = {}): any {
  seq++;
  return {
    id: opts.id || "pair_" + seq,
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages?beta=true",
      headers: opts.headers || {},
      body: {
        model: "claude-sonnet-5",
        stream: true,
        metadata: { user_id: JSON.stringify({ session_id: opts.sid || "11111111-2222-3333-4444-555555555555" }) },
        system: [{ type: "text", text: "You are Claude Code. ".repeat(50) }],
        messages,
      },
    },
    response: opts.response ?? {
      timestamp: 1751900001 + seq,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      bodyRaw: 'data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}}}\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + (opts.reply || "r" + seq) + '"}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":20}}',
    },
    duration: opts.duration ?? 1500,
    loggedAt: "x",
  };
}

/** A growing conversation: request i carries i*2-1 messages. */
function growingThread(n: number, first = "build the thing"): any[] {
  const out: any[] = [];
  const hist: any[] = [{ role: "user", content: first }];
  for (let i = 0; i < n; i++) {
    out.push(msgPair([...hist]));
    hist.push({ role: "assistant", content: [{ type: "text", text: "reply " + i }] });
    hist.push({ role: "user", content: "continue " + i });
  }
  return out;
}

function telemetryPair(opts: any = {}): any {
  seq++;
  return {
    id: "tel_" + seq,
    client: "claude",
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/api/event_logging/batch",
      headers: {},
      body: opts.body ?? { events: Array.from({ length: 40 }, (_, i) => ({ name: "ev" + i, meta: "x".repeat(30) })) },
    },
    response: opts.response ?? { timestamp: 1751900001 + seq, status: 202, headers: {}, body: { success: true } },
    duration: opts.duration ?? 80,
    loggedAt: "x",
  };
}

describe("planDecisions: supersede-stub", () => {
  test("keeps the longest request per thread, stubs the rest", () => {
    seq = 0;
    const pairs = growingThread(4);
    const dec = planDecisions(pairs, categorize, WIRE);
    expect(dec.stub.size).toBe(3);
    expect(dec.stub.has(3)).toBe(false); // the longest (last) survives
    for (const [, keptId] of dec.stub) expect(keptId).toBe(pairs[3].id);
  });

  test("epoch guard: a history-length drop closes the epoch and keeps its longest too", () => {
    seq = 0;
    const first = { role: "user", content: "hello" };
    const lens = [1, 3, 5, 2, 4]; // compaction after the 5-turn request
    const pairs = lens.map((n) =>
      msgPair(Array.from({ length: n }, (_, i) => (i === 0 ? first : { role: i % 2 ? "assistant" : "user", content: "t" + i }))),
    );
    const dec = planDecisions(pairs, categorize, WIRE);
    // epoch 1 = lens 1,3,5 (keeper idx 2); epoch 2 = lens 2,4 (keeper idx 4)
    expect(dec.stub.has(2)).toBe(false);
    expect(dec.stub.has(4)).toBe(false);
    expect([...dec.stub.keys()].sort()).toEqual([0, 1, 3]);
    expect(dec.stub.get(0)).toBe(pairs[2].id);
    expect(dec.stub.get(3)).toBe(pairs[4].id);
  });

  test("threads never cross: different sessions/first prompts fold independently", () => {
    seq = 0;
    const a = growingThread(2, "thread A");
    const b = growingThread(2, "thread B");
    const dec = planDecisions([...a, ...b], categorize, WIRE);
    expect(dec.stub.size).toBe(2); // one superseded request per thread
    expect(dec.stub.get(0)).toBe(a[1].id);
    expect(dec.stub.get(2)).toBe(b[1].id);
  });

  test("idempotent: already-stubbed pairs are never re-folded or made keeper", () => {
    seq = 0;
    const pairs = growingThread(3);
    const dec = planDecisions(pairs, categorize, WIRE);
    const compacted = pairs.map((p, i) => (dec.stub.has(i) ? stubPair(p, dec.stub.get(i)!) : p));
    const again = planDecisions(compacted, categorize, WIRE);
    expect(again.stub.size).toBe(0);
    expect(again.collapse.size).toBe(0);
  });
});

describe("stubPair", () => {
  test("keeps exactly what reconstruction needs", () => {
    seq = 0;
    const [a, b] = growingThread(2);
    const s: any = stubPair(a, b.id);
    expect(isStubBody(s.request.body)).toBe(true);
    expect(s.request.body.kind).toBe("superseded");
    expect(s.request.body.model).toBe("claude-sonnet-5");
    expect(s.request.body.historyLen).toBe(1);
    expect(s.request.body.firstUserText).toBe("build the thing");
    expect(s.request.body.keptPairId).toBe(b.id);
    expect(s.request.body.droppedBytes).toBe(JSON.stringify(a.request.body).length);
    expect(s.request.body.metadata).toEqual(a.request.body.metadata); // session id survives
    expect(s.response).toBe(a.response); // responses are NEVER touched
    expect(s.request.headers).toBe(a.request.headers);
    // grouping + attribution equivalence
    expect(threadKeyOf(s, WIRE)).toBe(threadKeyOf(a, WIRE));
    expect(histLenOf(s)).toBe(histLenOf(a));
  });
});

describe("planDecisions: exemplar retention", () => {
  test("keeps first, last, largest, slowest, and every error; collapses the rest", () => {
    seq = 0;
    const pairs: any[] = [];
    for (let i = 0; i < 10; i++) pairs.push(telemetryPair());
    pairs[3].duration = 99999; // slowest
    pairs[5].request.body = { events: Array.from({ length: 400 }, () => ({ pad: "y".repeat(50) })) }; // largest
    pairs[7].response = { timestamp: 0, status: 500, headers: {}, body: { error: "boom" } }; // error
    const dec = planDecisions(pairs, categorize, WIRE);
    for (const keep of [0, 9, 3, 5, 7]) expect(dec.collapse.has(keep)).toBe(false);
    expect(dec.collapse.size).toBe(5);
    expect(dec.stub.size).toBe(0);
  });

  test("small groups and small bodies are left alone", () => {
    seq = 0;
    const two = [telemetryPair(), telemetryPair()];
    expect(planDecisions(two, categorize, WIRE).collapse.size).toBe(0);
    const tiny = Array.from({ length: 6 }, () => telemetryPair({ body: { e: 1 } }));
    expect(planDecisions(tiny, categorize, WIRE).collapse.size).toBe(0); // under the churn floor
  });

  test("messages and oauth/usage pairs never collapse", () => {
    seq = 0;
    const pairs = [...growingThread(1), telemetryPair(), telemetryPair()];
    const dec = planDecisions(pairs, categorize, WIRE);
    expect(dec.collapse.size).toBe(0);
  });
});

describe("collapsePair", () => {
  test("bodies become meta byte counts; the envelope survives", () => {
    seq = 0;
    const p = telemetryPair();
    const c: any = collapsePair(p);
    expect(c.request.body._cctrace_stub).toBe(1);
    expect(c.request.body.kind).toBe("meta");
    expect(c.request.body.droppedBytes).toBe(JSON.stringify(p.request.body).length);
    expect(c.response.body.kind).toBe("meta");
    expect(c.response.status).toBe(202);
    expect(c.duration).toBe(p.duration);
    expect(c.id).toBe(p.id);
    expect("bodyRaw" in c.response).toBe(false);
  });
});

describe("session reconstruction survives compaction", () => {
  test("threads, turns, and per-turn attribution are identical pre/post compact", () => {
    seq = 0;
    const pairs = growingThread(4);
    const before = buildSession(pairs, WIRE);
    const dec = planDecisions(pairs, categorize, WIRE);
    const compacted = pairs.map((p, i) => (dec.stub.has(i) ? stubPair(p, dec.stub.get(i)!) : p));
    const after = buildSession(compacted, WIRE);

    expect(after.threads.length).toBe(before.threads.length);
    const tb = before.threads[0], ta = after.threads[0];
    expect(ta.key).toBe(tb.key);
    expect(ta.turns.length).toBe(tb.turns.length);
    // per-turn wire attribution: every assistant turn keeps its pairId
    for (let i = 0; i < tb.turns.length; i++) {
      expect(ta.turns[i].pairId).toBe(tb.turns[i].pairId);
    }
    expect(ta.usage.requests).toBe(tb.usage.requests);
    expect(ta.usage.output).toBe(tb.usage.output);
  });
});

describe("planCompact / applyCompact", () => {
  test("rewrites a trace in place; unparseable tail lines survive; idempotent", () => {
    seq = 0;
    const dir = mkdtempSync(join(tmpdir(), "cctrace-compact-"));
    const pairs = [...growingThread(3), ...Array.from({ length: 5 }, () => telemetryPair())];
    const torn = '{"id":"torn_tail","request":{"time';
    writeFileSync(join(dir, "trace-x.jsonl"), pairs.map((p) => JSON.stringify(p)).join("\n") + "\n" + torn);

    const plan = planCompact(dir, categorize, WIRE);
    expect(plan.files.length).toBe(1);
    expect(plan.stubbed).toBe(2);
    expect(plan.savedBytes).toBeGreaterThan(0);

    const res = applyCompact(plan, categorize, WIRE);
    expect(res.rewritten).toEqual(["trace-x.jsonl"]);
    expect(res.bytes).toBeGreaterThan(0);

    const lines = readFileSync(join(dir, "trace-x.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(pairs.length + 1); // no pair deleted, torn line kept
    expect(lines[lines.length - 1]).toBe(torn);
    const rewritten: TracePair[] = lines.slice(0, -1).map((l) => JSON.parse(l));
    expect(rewritten.filter((p: any) => p.request.body?._cctrace_stub && p.request.body.kind === "superseded").length).toBe(2);
    // the keeper still carries its full history
    const keeper: any = rewritten.find((p) => p.id === pairs[2].id);
    expect(keeper.request.body.messages.length).toBe(5);

    // idempotent: nothing left to do
    const again = planCompact(dir, categorize, WIRE);
    expect(again.files.length).toBe(0);
  });

  test("a file that grew between plan and apply is skipped, not folded blind", () => {
    seq = 0;
    const dir = mkdtempSync(join(tmpdir(), "cctrace-compact-"));
    const pairs = growingThread(3);
    const path = join(dir, "trace-live.jsonl");
    writeFileSync(path, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
    const plan = planCompact(dir, categorize, WIRE);
    expect(plan.files.length).toBe(1);
    appendFileSync(path, JSON.stringify(msgPair([{ role: "user", content: "late arrival" }])) + "\n");
    const res = applyCompact(plan, categorize, WIRE);
    expect(res.rewritten).toEqual([]);
    expect(res.skipped).toEqual(["trace-live.jsonl"]);
  });
});

describe("rewind guard (devlog 2026-07-17 decision 4)", () => {
  const mk = (id: string, ts: number, messages: any[]) => ({
    id,
    request: {
      timestamp: ts, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
      body: { model: "claude-fable-5", messages, metadata: { user_id: JSON.stringify({ session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }) } },
    },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: { content: [{ type: "text", text: "r" + id }] } },
    duration: 10, loggedAt: "x",
  }) as any;
  const u = (t: string) => ({ role: "user", content: t });
  const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
  const cat = () => "messages";

  test("a rewound branch tip (same length, different final message) is never stubbed", () => {
    const pairs = [
      mk("p1", 100, [u("q1")]),
      mk("p2", 200, [u("q1"), a("r1"), u("erased question")]),   // branch tip: /rewind victim
      mk("p3", 300, [u("q1"), a("r1"), u("survivor question")]), // rewrite at the same length
      mk("p4", 400, [u("q1"), a("r1"), u("survivor question"), a("r3"), u("q3")]), // keeper
    ];
    const { stub } = planDecisions(pairs, cat);
    expect(stub.has(1)).toBe(false); // the erased exchange's only copy stays full
    expect(stub.has(2)).toBe(true);  // survivor branch is inside the keeper
    expect(stub.has(3)).toBe(false); // keeper
    expect(stub.has(0)).toBe(true);  // plain superseded request still stubs
  });

  test("a pure retry (identical final message) still stubs", () => {
    const pairs = [
      mk("p1", 100, [u("q1"), a("r1"), u("q2")]),
      mk("p2", 200, [u("q1"), a("r1"), u("q2")]), // retry, same packing
      mk("p3", 300, [u("q1"), a("r1"), u("q2"), a("r2"), u("q3")]),
    ];
    const { stub } = planDecisions(pairs, cat);
    expect(stub.has(0)).toBe(true);
    expect(stub.has(1)).toBe(true);
    expect(stub.has(2)).toBe(false);
  });
});
