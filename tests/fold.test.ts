import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFold } from "../src/fold";
import { isStubBody, stubPair, collapsePair } from "../src/compact";
import { contextComposition } from "../src/context";
import { buildSession } from "../src/session";
import { categorizeUrl } from "../src/categorize";
import { wireTables } from "../src/clients";

const WIRE = wireTables();
const categorize = (url: string, client?: string) => categorizeUrl(url, client, WIRE);

let seq = 0;
function msgPair(messages: any[], opts: any = {}): any {
  seq++;
  return {
    id: opts.id || "pair_" + seq,
    client: "claude",
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-sonnet-5",
        stream: true,
        metadata: { user_id: JSON.stringify({ session_id: opts.sid || "11111111-2222-3333-4444-555555555555" }) },
        messages,
      },
    },
    response: opts.response ?? {
      timestamp: 1751900001 + seq,
      status: 200,
      headers: { "content-type": "text/event-stream" },
      bodyRaw:
        'data: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":10,"output_tokens":1}}}\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + (opts.reply || "r" + seq) + '"}}\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":20}}',
    },
    duration: 1500,
    loggedAt: "x",
  };
}

function telemetryPair(): any {
  seq++;
  return {
    id: "tel_" + seq,
    client: "claude",
    request: {
      timestamp: 1751900000 + seq,
      method: "POST",
      url: "https://api.anthropic.com/api/event_logging/batch",
      headers: {},
      body: { events: Array.from({ length: 40 }, (_, i) => ({ name: "ev" + i, meta: "x".repeat(200) })) },
    },
    response: { timestamp: 1751900001 + seq, status: 202, headers: {}, body: { ok: "y".repeat(2000) } },
    duration: 80,
    loggedAt: "x",
  };
}

/** A growing conversation, each request re-sending everything so far. */
function growingThread(n: number, opts: any = {}): any[] {
  const out: any[] = [];
  const hist: any[] = [{ role: "user", content: opts.first || "build the thing" }];
  for (let i = 0; i < n; i++) {
    out.push(msgPair([...hist], opts));
    hist.push({ role: "assistant", content: [{ type: "text", text: "reply " + i + " " + "z".repeat(400) }] });
    hist.push({ role: "user", content: "continue " + i + " " + "w".repeat(400) });
  }
  return out;
}

function traceFile(pairs: any[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cctrace-fold-"));
  const path = join(dir, "trace-test.jsonl");
  writeFileSync(path, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  return path;
}

async function fold(pairs: any[], opts: any = {}) {
  const f = createFold({ categorize, wire: WIRE, bodyBytes: Infinity, ...opts });
  await f.addFile(traceFile(pairs));
  return f.finish();
}

const stubbed = (p: any) => isStubBody(p.request.body);

describe("fold rule 1: superseded bodies", () => {
  test("every pair reaches the page; only the epoch keeper keeps its body", async () => {
    seq = 0;
    const pairs = growingThread(5);
    const r = await fold(pairs);
    expect(r.pairs.length).toBe(5);
    expect(r.superseded).toBe(4);
    expect(r.budgeted).toBe(0);
    expect(r.pairs.slice(0, 4).every(stubbed)).toBe(true);
    expect(stubbed(r.pairs[4])).toBe(false);
    expect(r.foldedBytes).toBeGreaterThan(0);
    expect(r.keptBytes).toBeLessThan(r.seenBytes);
  });

  test("a stub names the request that kept the history", async () => {
    seq = 0;
    const pairs = growingThread(3);
    const r = await fold(pairs);
    const keeper = r.pairs[2]!.id;
    for (const p of r.pairs.slice(0, 2)) {
      expect((p.request.body as any).keptPairId).toBe(keeper);
      expect((p.request.body as any).kind).toBe("superseded");
    }
  });

  // The fold takes bytes, not the reading: what the body was made of is
  // measured on the way out, so the Context view stays EXACT per step.
  test("a stub carries the composition of the body it gave up", async () => {
    seq = 0;
    const pairs = growingThread(3);
    const before = pairs.map((p) => contextComposition(structuredClone(p)));
    const r = await fold(pairs, { bodyBytes: 1 });
    expect(r.superseded + r.budgeted).toBe(3);
    for (const [i, p] of r.pairs.entries()) {
      expect(stubbed(p)).toBe(true);
      expect((p.request.body as any).composition).toEqual(before[i]);
      expect((p as any)._ctxc).toBeUndefined(); // a page memo, never page data
    }
  });

  test("responses are never folded — the reply exists exactly once", async () => {
    seq = 0;
    const pairs = growingThread(4);
    const r = await fold(pairs);
    for (const [i, p] of r.pairs.entries()) {
      expect(p.response?.bodyRaw).toBe(pairs[i]!.response.bodyRaw);
    }
  });

  test("a compaction closes the epoch: the pre-compaction keeper stays full", async () => {
    seq = 0;
    const before = growingThread(3);
    // history drops — /compact or /clear; what follows is not a superset
    const after = growingThread(2, { first: "summary of the above" });
    const r = await fold([...before, ...after]);
    expect(r.pairs.length).toBe(5);
    expect(stubbed(r.pairs[2])).toBe(false); // epoch 1's keeper
    expect(stubbed(r.pairs[4])).toBe(false); // epoch 2's keeper
    expect(r.superseded).toBe(3);
  });

  test("a rewound branch tip keeps its body — its content lives nowhere else", async () => {
    seq = 0;
    const u = (t: string) => ({ role: "user", content: t });
    const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
    const pairs = [
      msgPair([u("q1")]),
      msgPair([u("q1"), a("r1"), u("erased question")]),
      msgPair([u("q1"), a("r1"), u("survivor question")]),
      msgPair([u("q1"), a("r1"), u("survivor question"), a("r3"), u("q3")]),
    ];
    const r = await fold(pairs);
    expect(stubbed(r.pairs[1])).toBe(false); // the rewind victim
    expect(stubbed(r.pairs[2])).toBe(true);
    expect(stubbed(r.pairs[3])).toBe(false); // keeper
  });

  test("an ephemeral system notice as the final turn is not a rewind", async () => {
    seq = 0;
    const u = (t: string) => ({ role: "user", content: t });
    const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
    const sys = (n: number) => ({ role: "system", content: `<total_tokens>${n} tokens left</total_tokens>` });
    const pairs = [
      msgPair([u("q1"), sys(900)]),
      msgPair([u("q1"), sys(880), a("r1"), u("q2"), sys(870)]),
      msgPair([u("q1"), sys(860), a("r1"), u("q2"), sys(850), a("r2"), u("q3"), sys(840)]),
    ];
    const r = await fold(pairs);
    expect(r.superseded).toBe(2);
    expect(stubbed(r.pairs[2])).toBe(false);
  });

  test("separate threads fold independently", async () => {
    seq = 0;
    const a = growingThread(3, { sid: "aaaaaaaa-1111-2222-3333-444444444444", first: "thread a" });
    const b = growingThread(3, { sid: "bbbbbbbb-1111-2222-3333-444444444444", first: "thread b" });
    const r = await fold([...a, ...b]);
    expect(r.superseded).toBe(4); // two keepers survive
    expect(r.pairs.filter((p) => !stubbed(p)).length).toBe(2);
  });
});

describe("fold rule 2: the body budget", () => {
  test("oldest bodies fold first and every pair still reaches the page", async () => {
    seq = 0;
    const a = growingThread(3, { sid: "aaaaaaaa-1111-2222-3333-444444444444", first: "thread a" });
    const b = growingThread(3, { sid: "bbbbbbbb-1111-2222-3333-444444444444", first: "thread b" });
    const all = [...a, ...b];
    const r = await fold(all, { bodyBytes: 1 }); // room for nothing
    expect(r.pairs.length).toBe(6);
    expect(r.pairs.every(stubbed)).toBe(true);
    expect(r.budgeted).toBeGreaterThan(0);
    expect(r.superseded + r.budgeted).toBe(6);
    // the newest body is the one that survives longest: it folds last
    expect((r.pairs[5]!.request.body as any).kind).toBe("budgeted");
  });

  test("a body the budget folded early is still superseded, and still names its keeper", async () => {
    seq = 0;
    const pairs = growingThread(4);
    const r = await fold(pairs, { bodyBytes: 1 }); // the budget folds each body as it lands
    expect(r.pairs.length).toBe(4);
    // rule 1 owns the first three: a later request re-sent their history
    expect(r.superseded).toBe(3);
    expect(r.budgeted).toBe(1); // only the keeper itself fell to the budget
    const keeper = r.pairs[3]!.id;
    for (const p of r.pairs.slice(0, 3)) {
      expect((p.request.body as any).kind).toBe("superseded");
      expect((p.request.body as any).keptPairId).toBe(keeper);
    }
    expect((r.pairs[3]!.request.body as any).kind).toBe("budgeted");
  });

  test("a body compact already folded on disk is left alone, link and label intact", async () => {
    seq = 0;
    const pairs = growingThread(3);
    // as `cctrace compact` would leave them: the first two stubbed to the keeper, plus a meta-collapsed noise pair
    const onDisk = [stubPair(pairs[0]!, pairs[2]!.id), stubPair(pairs[1]!, pairs[2]!.id), pairs[2]!, collapsePair(telemetryPair())];
    const r = await fold(onDisk, { bodyBytes: 1 });
    expect(r.pairs.length).toBe(4);
    // the fold folded only what was still whole: the keeper's body (to the budget)
    expect(r.superseded).toBe(0);
    expect(r.budgeted).toBe(1);
    for (const p of r.pairs.slice(0, 2)) {
      expect((p.request.body as any).kind).toBe("superseded");
      expect((p.request.body as any).keptPairId).toBe(pairs[2]!.id);
    }
    expect((r.pairs[3]!.request.body as any).kind).toBe("meta");
    expect((r.pairs[3]!.response as any).body.kind).toBe("meta");
  });

  test("noise bodies collapse to byte counts, request and response both", async () => {
    seq = 0;
    const r = await fold([telemetryPair(), telemetryPair(), telemetryPair()], { bodyBytes: 1 });
    expect(r.pairs.length).toBe(3);
    for (const p of r.pairs) {
      expect(isStubBody(p.request.body)).toBe(true);
      expect((p.request.body as any).kind).toBe("meta");
      expect(isStubBody(p.response!.body)).toBe(true);
    }
    expect(r.budgeted).toBe(3);
  });

  test("a generous budget folds nothing beyond rule 1", async () => {
    seq = 0;
    const r = await fold(growingThread(4), { bodyBytes: 64 * 1024 * 1024 });
    expect(r.budgeted).toBe(0);
    expect(r.superseded).toBe(3);
  });
});

describe("fold: what the page can still read", () => {
  test("the session reconstructs identically — turns, order, attribution", async () => {
    seq = 0;
    const pairs = growingThread(6);
    const before = buildSession(pairs, categorize, WIRE);
    const r = await fold(pairs);
    const after = buildSession(r.pairs, categorize, WIRE);
    expect(after.threads.length).toBe(before.threads.length);
    expect(after.threads[0]!.turns.length).toBe(before.threads[0]!.turns.length);
    expect(after.threads[0]!.turns.map((t: any) => t.pairId)).toEqual(
      before.threads[0]!.turns.map((t: any) => t.pairId),
    );
  });

  test("a pair merged from two files is carried once", async () => {
    seq = 0;
    const pairs = growingThread(3);
    const f = createFold({ categorize, wire: WIRE, bodyBytes: Infinity });
    await f.addFile(traceFile(pairs));
    await f.addFile(traceFile(pairs)); // the same session, merged copy
    expect(f.finish().pairs.length).toBe(3);
  });

  test("torn and broken lines are counted, never rendered", async () => {
    seq = 0;
    const dir = mkdtempSync(join(tmpdir(), "cctrace-fold-"));
    const path = join(dir, "trace-damaged.jsonl");
    writeFileSync(path, [JSON.stringify(msgPair([{ role: "user", content: "q" }])), "{not json", '{"noRequest":1}'].join("\n") + "\n");
    const stats = { torn: 0, invalid: 0 };
    const f = createFold({ categorize, wire: WIRE, bodyBytes: Infinity, stats });
    await f.addFile(path);
    expect(f.finish().pairs.length).toBe(1);
    expect(stats.torn).toBe(1);
    expect(stats.invalid).toBe(1);
  });
});
