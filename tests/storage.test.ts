import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync, gzipSync } from "zlib";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress, human,
} from "../src/storage";
import { parseTraceText } from "../src/history";

const SID_A = "2d5c0d3b-1111-2222-3333-444444444444";
const SID_B = "6fae9380-aaaa-bbbb-cccc-dddddddddddd";

function convPair(id: string, sid: string, ts: number) {
  return {
    id, request: {
      timestamp: ts, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
      body: { model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: JSON.stringify({ session_id: sid }) } },
    }, response: { timestamp: ts + 1, status: 200, headers: {}, body: {} }, duration: 1, loggedAt: "x",
  };
}
function utilityPair(id: string, ts: number) {
  return {
    id, request: { timestamp: ts, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", headers: {}, body: {} },
    response: { timestamp: ts + 1, status: 200, headers: {}, body: {} }, duration: 1, loggedAt: "x",
  };
}
const jl = (...pairs: object[]) => pairs.map((p) => JSON.stringify(p)).join("\n") + "\n";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cctrace-storage-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("clean", () => {
  test("plans html snapshots and 0-byte traces, spares real traces", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    writeFileSync(join(dir, "trace-1.html"), "<html>big</html>");
    writeFileSync(join(dir, "trace-aborted.jsonl"), "");
    const plan = planClean(dir);
    expect(plan.htmls.map((f) => f.name)).toEqual(["trace-1.html"]);
    expect(plan.empties.map((f) => f.name)).toEqual(["trace-aborted.jsonl"]);
  });

  test("apply deletes only html + empties", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    writeFileSync(join(dir, "trace-1.html"), "x");
    writeFileSync(join(dir, "trace-aborted.jsonl"), "");
    applyClean(planClean(dir));
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-1.html"))).toBe(false);
    expect(existsSync(join(dir, "trace-aborted.jsonl"))).toBe(false);
  });

  // Regression: "regenerable" is checked, not assumed — an .html whose source
  // trace is gone (or never existed) may be the only record left.
  test("spares an .html with no source trace to rebuild from", () => {
    writeFileSync(join(dir, "orphan.html"), "the only surviving record");
    writeFileSync(join(dir, "report.html"), "not ours at all");
    const plan = planClean(dir);
    expect(plan.htmls).toHaveLength(0);
    expect(plan.kept.map((f) => f.name).sort()).toEqual(["orphan.html", "report.html"]);
    applyClean(plan);
    expect(existsSync(join(dir, "orphan.html"))).toBe(true);
  });

  test("a .jsonl.gz sibling counts as a source (clean after compress)", () => {
    writeFileSync(join(dir, "trace-1.jsonl.gz"), gzipSync(jl(convPair("a", SID_A, 1))));
    writeFileSync(join(dir, "trace-1.html"), "x");
    const plan = planClean(dir);
    expect(plan.htmls.map((f) => f.name)).toEqual(["trace-1.html"]);
  });

  // Regression: a 0-byte file at plan time may be a live run's sink that has
  // since received pairs — apply must re-stat before deleting.
  test("apply skips an empty trace that grew since the plan", () => {
    writeFileSync(join(dir, "trace-live.jsonl"), "");
    const plan = planClean(dir);
    appendFileSync(join(dir, "trace-live.jsonl"), jl(convPair("a", SID_A, 1)));
    const res = applyClean(plan);
    expect(existsSync(join(dir, "trace-live.jsonl"))).toBe(true);
    expect(res.skipped).toEqual(["trace-live.jsonl"]);
  });
});

describe("merge", () => {
  beforeEach(() => {
    // Session A spans two runs; session B one; a utility trace has no session.
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100), convPair("a2", SID_A, 200)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200), convPair("a3", SID_A, 300))); // a2 dup across runs
    writeFileSync(join(dir, "trace-B.jsonl"), jl(convPair("b1", SID_B, 400), utilityPair("u1", 401)));
  });

  test("groups by session, dedupes, sorts by time", () => {
    const plan = planMerge(dir);
    const a = plan.sessions.find((s) => s.id === SID_A)!;
    expect(a.pairCount).toBe(3);
    expect(a.dupes).toBe(1);
    expect(a.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(a.sources.sort()).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
    expect(plan.unattributable).toBe(1);
  });

  test("only fully-attributed sources are prune-able (utility trace spared)", () => {
    const plan = planMerge(dir);
    const names = plan.subsumed.map((f) => f.name).sort();
    expect(names).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
    expect(names).not.toContain("trace-B.jsonl"); // carries the utility pair
  });

  test("apply writes merged files; --prune removes subsumed sources", () => {
    const plan = planMerge(dir);
    const res = applyMerge(plan, { prune: true });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(existsSync(out)).toBe(true);
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "trace-B.jsonl"))).toBe(true); // spared
    expect(res.pruned.sort()).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
  });

  test("apply without --prune keeps all sources", () => {
    applyMerge(planMerge(dir), { prune: false });
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(true);
  });

  // Regression: a previous merge's output is an input — a re-run after
  // --prune must union with it, never overwrite it with the new subset.
  test("re-merge after --prune keeps the previously merged pairs", () => {
    applyMerge(planMerge(dir), { prune: true }); // session A -> a1,a2,a3; sources pruned
    writeFileSync(join(dir, "trace-A3.jsonl"), jl(convPair("a4", SID_A, 400)));
    const plan2 = planMerge(dir);
    const a = plan2.sessions.find((s) => s.id === SID_A)!;
    expect(a.existing).toBe(3);
    applyMerge(plan2, { prune: true });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("unions with a gzip-archived previous output", () => {
    rmSync(join(dir, "trace-A1.jsonl"));
    rmSync(join(dir, "trace-A2.jsonl"));
    rmSync(join(dir, "trace-B.jsonl"));
    writeFileSync(join(dir, "session-2d5c0d3b.jsonl.gz"), gzipSync(jl(convPair("a1", SID_A, 100))));
    writeFileSync(join(dir, "trace-new.jsonl"), jl(convPair("a2", SID_A, 200)));
    applyMerge(planMerge(dir), { prune: false });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  test("prefix-colliding session ids get distinct output files", () => {
    const SID_A2 = "2d5c0d3b-9999-8888-7777-666666666666"; // shares SID_A's first 8 chars
    writeFileSync(join(dir, "trace-C.jsonl"), jl(convPair("c1", SID_A2, 500)));
    const plan = planMerge(dir);
    const names = plan.sessions.map((s) => s.outName);
    expect(new Set(names).size).toBe(names.length);
  });

  // Regression: a live capture may append pairs between plan and apply —
  // those exist in no merged output, so the source must survive --prune.
  test("prune keeps a source that grew since the plan", () => {
    const plan = planMerge(dir);
    appendFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a9", SID_A, 900)));
    const res = applyMerge(plan, { prune: true });
    expect(existsSync(join(dir, "trace-A2.jsonl"))).toBe(true);
    expect(res.skipped).toEqual(["trace-A2.jsonl"]);
    expect(res.pruned).toEqual(["trace-A1.jsonl"]);
  });
});

describe("compress", () => {
  test("gzips .jsonl, removes original, round-trips", () => {
    const body = jl(convPair("a", SID_A, 1), convPair("b", SID_A, 2));
    writeFileSync(join(dir, "trace-1.jsonl"), body);
    const res = applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    expect(res.archived).toHaveLength(1);
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(false);
    const gz = join(dir, "trace-1.jsonl.gz");
    expect(existsSync(gz)).toBe(true);
    expect(gunzipSync(readFileSync(gz)).toString("utf8")).toBe(body);
  });

  test("--older-than skips recent traces", () => {
    writeFileSync(join(dir, "trace-recent.jsonl"), jl(convPair("a", SID_A, 1)));
    const now = statSync(join(dir, "trace-recent.jsonl")).mtimeMs + 1000;
    const plan = planCompress(dir, now, 7); // 7 days; file is seconds old
    expect(plan.files).toHaveLength(0);
  });

  test("--keep-jsonl leaves the original", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    applyCompress(planCompress(dir, 1_000_000), { keepJsonl: true });
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-1.jsonl.gz"))).toBe(true);
  });

  // Regression: an archive must never lose pairs it already holds — a trace
  // recreated after an earlier compress (live run, --log NAME reuse) used to
  // clobber the .gz with only the new pairs.
  test("unions with an existing archive instead of overwriting it", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("b", SID_A, 2))); // recreated
    applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    const text = gunzipSync(readFileSync(join(dir, "trace-1.jsonl.gz"))).toString("utf8");
    expect(parseTraceText(text).map((p) => p.id)).toEqual(["a", "b"]);
  });

  // Regression: a file that changed since the plan is a live capture — skip it.
  test("skips a trace that changed since the plan", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    const plan = planCompress(dir, 1_000_000);
    appendFileSync(join(dir, "trace-1.jsonl"), jl(convPair("b", SID_A, 2)));
    const res = applyCompress(plan, { keepJsonl: false });
    expect(res.archived).toHaveLength(0);
    expect(res.skipped).toEqual(["trace-1.jsonl"]);
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-1.jsonl.gz"))).toBe(false);
  });
});

describe("human", () => {
  test("formats bytes", () => {
    expect(human(512)).toBe("512 B");
    expect(human(1536)).toBe("1.5 KB");
    expect(human(60 * 1024 * 1024)).toBe("60.0 MB");
  });
});
