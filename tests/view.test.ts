import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveView, applySlice, findTraceCarrier, ViewError } from "../src/view";

const SID_A = "4f9a2c1e-1111-2222-3333-444444444444";
const SID_B = "9e8d7c6b-aaaa-bbbb-cccc-dddddddddddd";

function pair(id: string, sessionId: string, ts: number) {
  return {
    id,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: { model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) } },
    },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: {} },
    duration: 1, loggedAt: "x",
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cctrace-view-"));
  writeFileSync(join(dir, "trace-A.jsonl"), [pair("a1", SID_A, 100), pair("a2", SID_A, 200)].map((p) => JSON.stringify(p)).join("\n"));
  writeFileSync(join(dir, "trace-B.jsonl"), [pair("b1", SID_B, 300)].map((p) => JSON.stringify(p)).join("\n"));
  // A second file that continued session A (cross-run continuity).
  writeFileSync(join(dir, "trace-A2.jsonl"), [pair("a3", SID_A, 400)].map((p) => JSON.stringify(p)).join("\n"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveView", () => {
  test("explicit .jsonl path renders that file, html sibling", () => {
    const r = resolveView(join(dir, "trace-B.jsonl"), dir);
    expect(r.matchedBy).toBe("file");
    expect(r.pairs).toHaveLength(1);
    expect(r.htmlPath).toBe(join(dir, "trace-B.html"));
  });

  test("session id merges every trace holding it, deduped and sorted", () => {
    const r = resolveView(SID_A, dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(r.sources.sort()).toEqual(["trace-A.jsonl", "trace-A2.jsonl"]);
    expect(r.htmlPath).toContain("session-4f9a2c1e");
  });

  test("session id prefix works", () => {
    const r = resolveView("4f9a2c1e", dir);
    expect(r.pairs).toHaveLength(3);
  });

  // Regression: the id is a substring of a merge output's filename, and
  // filename matching used to win — returning only the merged file and
  // silently dropping every newer unmerged trace of the session.
  test("session id still merges all traces when a merged session file exists", () => {
    writeFileSync(join(dir, "session-4f9a2c1e.jsonl"), JSON.stringify(pair("a1", SID_A, 100)));
    const r = resolveView("4f9a2c1e", dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
  });

  test("filename fragment with a single match renders it", () => {
    const r = resolveView("trace-B", dir);
    expect(r.matchedBy).toBe("filename");
    expect(r.pairs).toHaveLength(1);
  });

  test("no match throws ViewError listing recent traces", () => {
    expect(() => resolveView("nope-nothere", dir)).toThrow(ViewError);
  });
});

describe("applySlice", () => {
  const ps = [pair("a1", SID_A, 100), pair("a2", SID_A, 200), pair("a3", SID_A, 300)] as any[];

  test("narrows to the window between the two pairs' ends, inclusive", () => {
    expect(applySlice(ps, "a1..a2").map((p: any) => p.id)).toEqual(["a1", "a2"]);
    expect(applySlice(ps, "a1..a3").map((p: any) => p.id)).toEqual(["a1", "a2", "a3"]);
  });

  test("malformed specs and unknown ids throw ViewError with the id named", () => {
    expect(() => applySlice(ps, "a1")).toThrow(ViewError);
    expect(() => applySlice(ps, "a1..zz")).toThrow('"zz" not found');
    expect(() => applySlice(ps, "zz..a1")).toThrow(ViewError);
  });
});

describe("followTrace", () => {
  test("delivers complete appended lines, buffers torn tails, survives truncation", async () => {
    const { followTrace } = await import("../src/view");
    const { appendFileSync, writeFileSync: wf, statSync: st } = await import("fs");
    const f = join(dir, "live.jsonl");
    wf(f, JSON.stringify(pair("t1", SID_A, 100)) + "\n");
    const got: string[] = [];
    const h = followTrace(f, st(f).size, (ps) => got.push(...ps.map((p: any) => p.id)), 15);
    // a complete line + a torn line (no newline yet)
    appendFileSync(f, JSON.stringify(pair("t2", SID_A, 200)) + "\n" + '{"id":"t3","request"');
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual(["t2"]); // t3 is torn — held, not delivered
    // the torn line completes
    appendFileSync(f, ':{"timestamp":300,"url":"https://api.anthropic.com/v1/messages"}}' + "\n");
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual(["t2", "t3"]);
    // truncation (purge rewrote the file) — rescan from 0, dedup is the server's job
    wf(f, JSON.stringify(pair("t4", SID_A, 400)) + "\n");
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toContain("t4");
    h.stop();
  });
});

// A tombstone's logFile stops resolving for benign local reasons (compress
// renamed it, auto-merge absorbed it into the session file). findTraceCarrier
// is what stands between those and a wrong "trace missing" verdict.
describe("findTraceCarrier", () => {
  test("literal path wins when it exists", () => {
    const f = join(dir, "trace-A.jsonl");
    const c = findTraceCarrier(f, SID_A);
    expect(c?.path).toBe(f);
    expect(c!.bytes).toBeGreaterThan(0);
  });

  test("compressed sibling: .zst and legacy .gz", () => {
    const f = join(dir, "trace-gone.jsonl");
    writeFileSync(f + ".zst", "z");
    expect(findTraceCarrier(f)?.path).toBe(f + ".zst");
    rmSync(f + ".zst");
    writeFileSync(f + ".gz", "g");
    expect(findTraceCarrier(f)?.path).toBe(f + ".gz");
  });

  test("session file absorbs a pruned trace when the sid is known", () => {
    const f = join(dir, "trace-pruned.jsonl"); // never written — auto-merge pruned it
    const session = join(dir, `session-${SID_A.slice(0, 8)}.jsonl`);
    writeFileSync(session, "s");
    expect(findTraceCarrier(f, SID_A)?.path).toBe(session);
    // compressed session archives count too
    rmSync(session);
    writeFileSync(session + ".zst", "s");
    expect(findTraceCarrier(f, SID_A)?.path).toBe(session + ".zst");
    // without a sid there is nothing to find
    expect(findTraceCarrier(f)).toBeNull();
  });

  test("truly absent trace returns null", () => {
    expect(findTraceCarrier(join(dir, "trace-nope.jsonl"), SID_B.replace(/9e8d7c6b/, "00000000"))).toBeNull();
  });
});
