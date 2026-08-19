import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanTraceText, parseTraceText, loadPriorPairs, loadTraceFiles, newestPriorSessionId } from "../src/history";

const SID_A = "70683b4f-e779-414c-bcdb-9b22361a0232";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function messagesPair(id: string, sessionId: string, ts: number) {
  return {
    id,
    request: {
      timestamp: ts,
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      headers: {},
      body: {
        model: "claude-opus-4-6",
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionId }) },
      },
    },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: {} },
    duration: 1000,
    loggedAt: "x",
  };
}

function oauthPair(id: string, ts: number) {
  return {
    id,
    request: { timestamp: ts, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {}, body: null },
    response: { timestamp: ts, status: 200, headers: {}, body: {} },
    duration: 50,
    loggedAt: "x",
  };
}

const toJsonl = (pairs: unknown[]) => pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";

describe("scanTraceText", () => {
  test("keeps only pairs of wanted sessions", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10), messagesPair("2_b", SID_B, 20), oauthPair("3_c", 30)]);
    const got = scanTraceText(text, new Set([SID_A]));
    expect(got.map((p) => p.id)).toEqual(["1_a"]);
  });

  test("skips torn tail lines and blanks", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10)]) + '\n{"id":"torn';
    expect(scanTraceText(text, new Set([SID_A])).length).toBe(1);
  });

  test("empty wanted set matches nothing", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10)]);
    expect(scanTraceText(text, new Set())).toEqual([]);
  });
});

describe("parseTraceText", () => {
  test("keeps all pairs regardless of session", () => {
    const text = toJsonl([messagesPair("1_a", SID_A, 10), oauthPair("2_b", 20)]);
    expect(parseTraceText(text).length).toBe(2);
  });
});

describe("loadPriorPairs / loadTraceFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cctrace-history-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("finds matching session pairs across files, excluding the current log, sorted by time", async () => {
    writeFileSync(join(dir, "trace-old1.jsonl"), toJsonl([messagesPair("2_b", SID_A, 200)]));
    writeFileSync(join(dir, "trace-old2.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100), messagesPair("9_z", SID_B, 150)]));
    writeFileSync(join(dir, "trace-current.jsonl"), toJsonl([messagesPair("3_c", SID_A, 300)]));
    writeFileSync(join(dir, "notes.txt"), "not a trace");

    const got = await loadPriorPairs(dir, join(dir, "trace-current.jsonl"), new Set([SID_A]));
    expect(got.map((p) => p.id)).toEqual(["1_a", "2_b"]);
    expect(got[0]?.prior).toBe("trace-old2.jsonl");
    expect(got[1]?.prior).toBe("trace-old1.jsonl");
  });

  test("dedupes a pair present in both its trace and a merge output", async () => {
    writeFileSync(join(dir, "trace-old.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100)]));
    writeFileSync(join(dir, "session-2d5c.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100), messagesPair("2_b", SID_A, 200)]));
    const got = await loadPriorPairs(dir, join(dir, "trace-current.jsonl"), new Set([SID_A]));
    expect(got.map((p) => p.id)).toEqual(["1_a", "2_b"]);
  });

  test("no sessions or missing dir returns empty", async () => {
    expect(await loadPriorPairs(dir, "", new Set())).toEqual([]);
    expect(await loadPriorPairs(join(dir, "nope"), "", new Set([SID_A]))).toEqual([]);
  });

  // Upgrade day: the store dir is new and empty, the legacy ./.cctrace holds
  // the session so far — readers take both dirs (store first) so --continue
  // still finds every prior turn; a missing dir in the list is just empty.
  test("reads across several dirs, store first, tolerating a missing one", async () => {
    const store = join(dir, "store");
    const legacy = join(dir, "legacy");
    require("fs").mkdirSync(store);
    require("fs").mkdirSync(legacy);
    writeFileSync(join(legacy, "trace-old.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100)]));
    writeFileSync(join(store, "trace-prev.jsonl"), toJsonl([messagesPair("2_b", SID_A, 200)]));
    writeFileSync(join(store, "trace-current.jsonl"), toJsonl([messagesPair("3_c", SID_A, 300)]));
    const got = await loadPriorPairs([store, legacy, join(dir, "nope")], join(store, "trace-current.jsonl"), new Set([SID_A]));
    expect(got.map((p) => [p.id, p.prior])).toEqual([["1_a", "trace-old.jsonl"], ["2_b", "trace-prev.jsonl"]]);
    expect((await newestPriorSessionId([store, legacy], join(store, "trace-current.jsonl")))?.file).toBe("trace-prev.jsonl");
  });

  test("loadTraceFiles loads everything from named files, marked prior", async () => {
    const f = join(dir, "manual.jsonl");
    writeFileSync(f, toJsonl([oauthPair("5_e", 50), messagesPair("4_d", SID_B, 40)]));
    const got = await loadTraceFiles([f, join(dir, "missing.jsonl")]);
    expect(got.map((p) => p.id)).toEqual(["4_d", "5_e"]);
    expect(got.every((p) => p.prior === "manual.jsonl")).toBe(true);
  });
});

describe("newestPriorSessionId", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cctrace-newest-sid-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("picks the last session id in the newest trace file", async () => {
    const oldF = join(dir, "trace-old.jsonl");
    const newF = join(dir, "trace-new.jsonl");
    writeFileSync(oldF, toJsonl([messagesPair("1_a", SID_A, 100)]));
    writeFileSync(newF, toJsonl([messagesPair("2_b", SID_A, 200), messagesPair("3_c", SID_B, 300)]));
    utimesSync(oldF, new Date(1000000), new Date(1000000));
    utimesSync(newF, new Date(2000000), new Date(2000000));
    expect(await newestPriorSessionId(dir, join(dir, "trace-current.jsonl"))).toEqual({ sid: SID_B, file: "trace-new.jsonl" });
  });

  test("skips the current run's own file and sid-less files", async () => {
    const cur = join(dir, "trace-current.jsonl");
    writeFileSync(cur, toJsonl([messagesPair("9_z", SID_B, 900)]));
    writeFileSync(join(dir, "trace-noise.jsonl"), toJsonl([oauthPair("5_e", 500)]));
    writeFileSync(join(dir, "trace-old.jsonl"), toJsonl([messagesPair("1_a", SID_A, 100)]));
    utimesSync(join(dir, "trace-old.jsonl"), new Date(1000000), new Date(1000000));
    expect((await newestPriorSessionId(dir, cur))?.sid).toBe(SID_A);
  });

  test("survives a torn tail line on a live file", async () => {
    const f = join(dir, "trace-live.jsonl");
    writeFileSync(f, toJsonl([messagesPair("1_a", SID_A, 100)]) + '{"id":"torn","request":{"url":"htt');
    expect((await newestPriorSessionId(dir, ""))?.sid).toBe(SID_A);
  });

  test("empty or missing dir returns null", async () => {
    expect(await newestPriorSessionId(dir, "")).toBeNull();
    expect(await newestPriorSessionId(join(dir, "nope"), "")).toBeNull();
  });
});

describe("streaming readers", () => {
  const { traceLines, readTracePairs, TAIL_BYTES } = require("../src/history");
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cctrace-history-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  test("traceLines streams plain / .zst / .gz identically, torn tail included; early break tears down", async () => {
    const lines = ["a", "", "b".repeat(3000), '{"torn":'];
    const text = lines.join("\n");
    const plain = join(dir, "t.jsonl");
    writeFileSync(plain, text);
    writeFileSync(plain + ".zst", Bun.zstdCompressSync(Buffer.from(text)));
    writeFileSync(plain + ".gz", require("zlib").gzipSync(Buffer.from(text)));
    for (const f of [plain, plain + ".zst", plain + ".gz"]) {
      const got: string[] = [];
      for await (const l of traceLines(f)) got.push(l);
      expect(got).toEqual(lines);
    }
    const first: string[] = [];
    for await (const l of traceLines(plain + ".zst")) { first.push(l); break; }
    expect(first).toEqual(["a"]);
    expect(TAIL_BYTES).toBe(256 * 1024 * 1024);
  });

  test("readTracePairs: usable pairs, damage stats, needles + filter, and a tail budget that keeps the newest", async () => {
    const pairs = Array.from({ length: 20 }, (_, i) => messagesPair(`p${i}`, i % 2 ? SID_A : SID_B, i * 10));
    const f = join(dir, "trace-r.jsonl");
    writeFileSync(f, toJsonl(pairs) + "not json\n" + JSON.stringify({ nope: 1 }) + "\n");
    const stats = { torn: 0, invalid: 0 };
    const all = await readTracePairs(f, { stats });
    expect(all.pairs.map((p: any) => p.id)).toEqual(pairs.map((p) => p.id));
    expect(all.dropped).toBe(0);
    expect(stats).toEqual({ torn: 1, invalid: 1 });
    // needles pre-filter lines, filter decides on parsed pairs
    const a = await readTracePairs(f, { needles: [SID_A], filter: (p: any) => JSON.stringify(p).includes(SID_A) });
    expect(a.pairs.every((p: any) => JSON.stringify(p).includes(SID_A))).toBe(true);
    expect(a.pairs).toHaveLength(10);
    // tail budget: roughly the last third of the lines survive, newest last
    const lineLen = JSON.stringify(pairs[0]).length + 1;
    const tail = await readTracePairs(f, { tailBytes: lineLen * 6 });
    expect(tail.pairs.length).toBeGreaterThanOrEqual(5);
    expect(tail.pairs.length).toBeLessThanOrEqual(7);
    expect(tail.pairs[tail.pairs.length - 1].id).toBe("p19");
    expect(tail.dropped + tail.pairs.length).toBeGreaterThanOrEqual(20);
    expect(tail.seenBytes).toBeGreaterThan(tail.keptBytes);
    // a budget below one line still keeps the newest line
    const one = await readTracePairs(f, { tailBytes: 1 });
    expect(one.pairs.map((p: any) => p.id)).toEqual([]); // the newest line is the invalid {"nope":1}
    expect(one.dropped).toBe(21);
  });
});
