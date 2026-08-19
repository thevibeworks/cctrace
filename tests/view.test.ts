import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, utimesSync } from "fs";
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
  test("explicit .jsonl path renders that file, html sibling", async () => {
    const r = await resolveView(join(dir, "trace-B.jsonl"), dir);
    expect(r.matchedBy).toBe("file");
    expect(r.pairs).toHaveLength(1);
    expect(r.htmlPath).toBe(join(dir, "trace-B.html"));
  });

  test("session id merges every trace holding it, deduped and sorted", async () => {
    const r = await resolveView(SID_A, dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(r.sources.sort()).toEqual(["trace-A.jsonl", "trace-A2.jsonl"]);
    expect(r.htmlPath).toContain("session-4f9a2c1e");
  });

  test("session id prefix works", async () => {
    const r = await resolveView("4f9a2c1e", dir);
    expect(r.pairs).toHaveLength(3);
  });

  // Regression: the id is a substring of a merge output's filename, and
  // filename matching used to win — returning only the merged file and
  // silently dropping every newer unmerged trace of the session.
  test("session id still merges all traces when a merged session file exists", async () => {
    writeFileSync(join(dir, "session-4f9a2c1e.jsonl"), JSON.stringify(pair("a1", SID_A, 100)));
    const r = await resolveView("4f9a2c1e", dir);
    expect(r.matchedBy).toBe("session");
    expect(r.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
  });

  test("filename fragment with a single match renders it", async () => {
    const r = await resolveView("trace-B", dir);
    expect(r.matchedBy).toBe("filename");
    expect(r.pairs).toHaveLength(1);
  });

  test("no match throws ViewError listing recent traces", async () => {
    await expect(resolveView("nope-nothere", dir)).rejects.toThrow(ViewError);
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

  // After `adopt` (or a capture straight into the shared store from another
  // container) the tombstone still names the legacy path; the store dir is
  // the last place to look, by the same names.
  test("falls back to the project's store dir by basename and session file", () => {
    const store = join(dir, "store-proj");
    const legacy = join(dir, "legacy-proj", ".cctrace", "trace-moved.jsonl");
    rmSync(store, { recursive: true, force: true });
    require("fs").mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "trace-moved.jsonl.zst"), "z");
    expect(findTraceCarrier(legacy, undefined, store)?.path).toBe(join(store, "trace-moved.jsonl.zst"));
    rmSync(join(store, "trace-moved.jsonl.zst"));
    writeFileSync(join(store, `session-${SID_A.slice(0, 8)}.jsonl.zst`), "s");
    expect(findTraceCarrier(legacy, SID_A, store)?.path).toBe(join(store, `session-${SID_A.slice(0, 8)}.jsonl.zst`));
    expect(findTraceCarrier(legacy, SID_B, store)).toBeNull();
    // A tombstone that already names the archive resolves it, not a phantom .zst.zst
    writeFileSync(join(store, "trace-x.jsonl.zst"), "z");
    expect(findTraceCarrier(join(store, "trace-x.jsonl.zst"))?.path).toBe(join(store, "trace-x.jsonl.zst"));
  });
});

// A path cctrace printed (Log:, CCTRACE_TRACE_FILE, the header copy) names
// the plain .jsonl; after exit only the .zst exists — the path must keep
// resolving, and a stale absolute path still finds the trace by name.
describe("resolveView after the trace went to rest", () => {
  test("a plain path resolves to its .zst; a stale absolute path resolves by basename", async () => {
    const plain = join(dir, "trace-rest.jsonl");
    writeFileSync(plain + ".zst", Bun.zstdCompressSync(Buffer.from(JSON.stringify(pair("r1", SID_B, 500)) + "\n")));
    expect((await resolveView(plain, dir)).sources).toEqual(["trace-rest.jsonl.zst"]);
    expect((await resolveView(join("/somewhere/else", "trace-rest.jsonl"), dir)).sources).toEqual(["trace-rest.jsonl.zst"]);
    await expect(resolveView("/somewhere/else/trace-nope.jsonl", dir)).rejects.toThrow(ViewError);
  });
});

// The store dir plus a legacy ./.cctrace read as one: session merges span
// both, filename fragments find either, and the picker lists both.
describe("resolveView across dirs", () => {
  test("merges a session split across the store and a legacy dir", async () => {
    const legacy = join(dir, "legacy");
    require("fs").mkdirSync(legacy);
    writeFileSync(join(legacy, "trace-old.jsonl"), JSON.stringify(pair("a0", SID_A, 50)));
    const r = await resolveView(SID_A, [dir, legacy]);
    expect(r.pairs.map((p) => p.id)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(r.sources.sort()).toEqual(["trace-A.jsonl", "trace-A2.jsonl", "trace-old.jsonl"]);
    // the snapshot lands in the primary (first) dir
    expect(r.htmlPath.startsWith(dir + "/")).toBe(true);
    const byName = await resolveView("trace-old", [dir, legacy]);
    expect(byName.matchedBy).toBe("filename");
  });
});

describe("view tail budget", () => {
  test("a big trace opens to its newest pairs with a notice; --full (Infinity) loads all; sessions budget newest-first", async () => {
    const { truncationNotice } = require("../src/view");
    const d = mkdtempSync(join(tmpdir(), "cctrace-view-tail-"));
    const many = Array.from({ length: 30 }, (_, i) => pair(`m${String(i).padStart(2, "0")}`, SID_A, 1000 + i));
    const f = join(d, "trace-big.jsonl");
    writeFileSync(f, many.map((p) => JSON.stringify(p)).join("\n") + "\n");
    const lineLen = JSON.stringify(many[0]).length + 1;
    const r = await resolveView(f, d, { tailBytes: lineLen * 5 });
    expect(r.pairs.length).toBeGreaterThanOrEqual(4);
    expect(r.pairs.length).toBeLessThan(30);
    expect(r.pairs[r.pairs.length - 1].id).toBe("m29");
    expect(r.truncated?.droppedLines).toBeGreaterThan(0);
    expect(truncationNotice(r)).toContain("--full");
    const full = await resolveView(f, d, { tailBytes: Infinity });
    expect(full.pairs).toHaveLength(30);
    expect(full.truncated).toBeUndefined();
    expect(truncationNotice(full)).toBe("");
    // session across two files: the older file falls off first
    const older = join(d, "trace-older.jsonl");
    writeFileSync(older, many.slice(0, 10).map((p) => JSON.stringify({ ...p, id: "o" + p.id })).join("\n") + "\n");
    const now = Date.now();
    utimesSync(older, new Date(now - 60_000), new Date(now - 60_000));
    utimesSync(f, new Date(now), new Date(now));
    const s = await resolveView(SID_A, d, { tailBytes: lineLen * 5 });
    expect(s.matchedBy).toBe("session");
    expect(s.sources).toEqual(["trace-big.jsonl"]);
    expect(s.pairs[s.pairs.length - 1].id).toBe("m29");
    expect(s.truncated?.droppedLines).toBeGreaterThan(0);
    const sAll = await resolveView(SID_A, d, { tailBytes: Infinity });
    expect(sAll.pairs).toHaveLength(40);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("trace sizes", () => {
  test("an archived source reports decoded bytes as the trace and its file size as disk", async () => {
    const { traceSizes } = require("../src/view");
    const d = mkdtempSync(join(tmpdir(), "cctrace-view-sizes-"));
    const text = Array.from({ length: 50 }, (_, i) => JSON.stringify(pair(`z${i}`, SID_A, 100 + i))).join("\n") + "\n";
    const plain = join(d, "trace-p.jsonl");
    writeFileSync(plain, text);
    writeFileSync(join(d, "trace-z.jsonl.zst"), Bun.zstdCompressSync(Buffer.from(text)));
    const rp = await resolveView(plain, d);
    expect(rp.decodedBytes).toBe(text.length);
    expect(traceSizes(rp)).toEqual({ traceBytes: text.length }); // plain: the file is the trace
    const rz = await resolveView(join(d, "trace-z.jsonl.zst"), d);
    expect(rz.decodedBytes).toBe(rp.decodedBytes);
    const s = traceSizes(rz);
    expect(s.traceBytes).toBe(rz.decodedBytes);
    expect(s.traceDiskBytes).toBeGreaterThan(0);
    expect(s.traceDiskBytes!).toBeLessThan(s.traceBytes);
    rmSync(d, { recursive: true, force: true });
  });
});
