import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, readFileSync, readdirSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gunzipSync, gzipSync } from "zlib";
import {
  planClean, applyClean, planMerge, applyMerge, planCompress, applyCompress,
  planPurge, applyPurge, purgePairsById, human, archiveTrace, planStaleSweep, sweepOrphanTmps, TMP_ORPHAN_MS,
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

  // An interrupted atomic write (kill mid-compress at exit) leaves
  // <name>.tmp; clean removes it once it's clearly orphaned, never fresh.
  test("plans idle orphaned .tmp files of our own naming, spares fresh and foreign ones", () => {
    writeFileSync(join(dir, "trace-1.jsonl.zst.4242.tmp"), "half an archive");
    writeFileSync(join(dir, "session-x.jsonl.tmp"), "half a merge (pre-0.41 name)");
    writeFileSync(join(dir, "notes.tmp"), "the user's");
    const now = statSync(join(dir, "trace-1.jsonl.zst.4242.tmp")).mtimeMs;
    expect(planClean(dir, now + 1000).tmps).toHaveLength(0);
    const plan = planClean(dir, now + 2 * 3600_000);
    expect(plan.tmps.map((f) => f.name).sort()).toEqual(["session-x.jsonl.tmp", "trace-1.jsonl.zst.4242.tmp"]);
    applyClean(plan);
    expect(existsSync(join(dir, "trace-1.jsonl.zst.4242.tmp"))).toBe(false);
    expect(existsSync(join(dir, "session-x.jsonl.tmp"))).toBe(false);
    expect(existsSync(join(dir, "notes.tmp"))).toBe(true);
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

  test("groups by session, dedupes, sorts by time", async () => {
    const plan = await planMerge(dir);
    const a = plan.sessions.find((s) => s.id === SID_A)!;
    expect(a.pairCount).toBe(3);
    expect(a.dupes).toBe(1);
    expect(a.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(a.sources.sort()).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
    expect(plan.unattributable).toBe(1);
  });

  test("only fully-attributed sources are prune-able (utility trace spared)", async () => {
    const plan = await planMerge(dir);
    const names = plan.subsumed.map((f) => f.name).sort();
    expect(names).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
    expect(names).not.toContain("trace-B.jsonl"); // carries the utility pair
  });

  test("apply writes merged files; --prune removes subsumed sources", async () => {
    const plan = await planMerge(dir);
    const res = applyMerge(plan, { prune: true });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(existsSync(out)).toBe(true);
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2", "a3"]);
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "trace-B.jsonl"))).toBe(true); // spared
    expect(res.pruned.sort()).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
  });

  test("apply without --prune keeps all sources", async () => {
    applyMerge(await planMerge(dir), { prune: false });
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(true);
  });

  // Regression: a previous merge's output is an input — a re-run after
  // --prune must union with it, never overwrite it with the new subset.
  test("re-merge after --prune keeps the previously merged pairs", async () => {
    applyMerge(await planMerge(dir), { prune: true }); // session A -> a1,a2,a3; sources pruned
    writeFileSync(join(dir, "trace-A3.jsonl"), jl(convPair("a4", SID_A, 400)));
    const plan2 = await planMerge(dir);
    const a = plan2.sessions.find((s) => s.id === SID_A)!;
    expect(a.existing).toBe(3);
    applyMerge(plan2, { prune: true });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("unions with a gzip-archived previous output", async () => {
    rmSync(join(dir, "trace-A1.jsonl"));
    rmSync(join(dir, "trace-A2.jsonl"));
    rmSync(join(dir, "trace-B.jsonl"));
    writeFileSync(join(dir, "session-2d5c0d3b.jsonl.gz"), gzipSync(jl(convPair("a1", SID_A, 100))));
    writeFileSync(join(dir, "trace-new.jsonl"), jl(convPair("a2", SID_A, 200)));
    applyMerge(await planMerge(dir), { prune: false });
    const out = join(dir, "session-2d5c0d3b.jsonl");
    expect(parseTraceText(readFileSync(out, "utf8")).map((p) => p.id)).toEqual(["a1", "a2"]);
  });

  test("prefix-colliding session ids get distinct output files", async () => {
    const SID_A2 = "2d5c0d3b-9999-8888-7777-666666666666"; // shares SID_A's first 8 chars
    writeFileSync(join(dir, "trace-C.jsonl"), jl(convPair("c1", SID_A2, 500)));
    const plan = await planMerge(dir);
    const names = plan.sessions.map((s) => s.outName);
    expect(new Set(names).size).toBe(names.length);
  });

  // Regression: parseTraceText silently skips torn/invalid lines — a file
  // carrying one must never count as "fully absorbed", or the damaged line's
  // bytes would vanish with the prune.
  test("a source with a torn line is never prune-able", async () => {
    appendFileSync(join(dir, "trace-A2.jsonl"), '{"id":"half-written');
    const plan = await planMerge(dir);
    expect(plan.subsumed.map((f) => f.name)).toEqual(["trace-A1.jsonl"]);
    const a = plan.sessions.find((s) => s.id === SID_A)!;
    expect(a.pairs.map((p) => p.id)).toEqual(["a1", "a2", "a3"]); // still merges what parsed
  });

  // Regression: an existing output the plan can't fully read must block its
  // session — applyMerge would replace it with only what the parser could see.
  test("a damaged previous output blocks the merge instead of being overwritten", async () => {
    const out = join(dir, "session-2d5c0d3b.jsonl");
    writeFileSync(out, jl(convPair("a0", SID_A, 50)) + '{"id":"torn-prior');
    const plan = await planMerge(dir);
    expect(plan.sessions.map((s) => s.id)).not.toContain(SID_A);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]!.outName).toBe("session-2d5c0d3b.jsonl");
    expect(plan.blocked[0]!.reason).toContain("damaged");
    expect(plan.subsumed).toHaveLength(0); // A's sources must survive too
    applyMerge(plan, { prune: true });
    expect(readFileSync(out, "utf8")).toContain("torn-prior"); // untouched
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(true);
  });

  test("an unreadable archived previous output blocks the merge", async () => {
    writeFileSync(join(dir, "session-2d5c0d3b.jsonl.gz"), "not gzip at all");
    const plan = await planMerge(dir);
    expect(plan.sessions.map((s) => s.id)).not.toContain(SID_A);
    expect(plan.blocked[0]!.reason).toContain("unreadable");
    expect(existsSync(join(dir, "trace-A1.jsonl"))).toBe(true);
  });

  // Regression: a live capture may append pairs between plan and apply —
  // those exist in no merged output, so the source must survive --prune.
  test("prune keeps a source that grew since the plan", async () => {
    const plan = await planMerge(dir);
    appendFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a9", SID_A, 900)));
    const res = applyMerge(plan, { prune: true });
    expect(existsSync(join(dir, "trace-A2.jsonl"))).toBe(true);
    expect(res.skipped).toEqual(["trace-A2.jsonl"]);
    expect(res.pruned).toEqual(["trace-A1.jsonl"]);
  });
});

// The exit auto-merge: same machinery, scoped to the sessions one run saw,
// and only where there is actually something to consolidate.
describe("scoped merge (exit auto-merge)", () => {
  const scoped = (...sids: string[]) => planMerge(dir, { sessionIds: new Set(sids), fragmentedOnly: true });
  const ids = (path: string) => parseTraceText(readFileSync(path, "utf8")).map((p) => p.id);

  test("merges only the scoped session; another session's files are untouched", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    writeFileSync(join(dir, "trace-B1.jsonl"), jl(convPair("b1", SID_B, 300)));
    writeFileSync(join(dir, "trace-B2.jsonl"), jl(convPair("b2", SID_B, 400)));
    const plan = await scoped(SID_A);
    expect(plan.sessions.map((s) => s.id)).toEqual([SID_A]);
    applyMerge(plan, { prune: true });
    expect(ids(join(dir, "session-2d5c0d3b.jsonl"))).toEqual(["a1", "a2"]);
    expect(existsSync(join(dir, "session-6fae9380.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "trace-B1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-B2.jsonl"))).toBe(true);
  });

  // Regression, the trap of a SCOPED plan: prune-ability means "every pair
  // lands in a session this plan writes", not "every pair has some session id".
  // A file also holding an unmerged session's pairs must survive — they would
  // exist in no output.
  test("a source holding an unmerged session's pairs is never pruned", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-mixed.jsonl"), jl(convPair("a2", SID_A, 200), convPair("b1", SID_B, 300)));
    const plan = await scoped(SID_A);
    expect(plan.subsumed.map((f) => f.name)).toEqual(["trace-A1.jsonl"]);
    const res = applyMerge(plan, { prune: true });
    expect(res.pruned).toEqual(["trace-A1.jsonl"]);
    expect(existsSync(join(dir, "trace-mixed.jsonl"))).toBe(true);
    expect(ids(join(dir, "session-2d5c0d3b.jsonl"))).toEqual(["a1", "a2"]); // still merged in
    expect(ids(join(dir, "trace-mixed.jsonl"))).toEqual(["a2", "b1"]);      // and still on disk
  });

  test("a fresh single-file session is left exactly as written", async () => {
    const path = join(dir, "trace-A1.jsonl");
    writeFileSync(path, jl(convPair("a1", SID_A, 100)));
    const before = readFileSync(path, "utf8");
    const plan = await scoped(SID_A);
    expect(plan.sessions).toHaveLength(0);
    expect(applyMerge(plan, { prune: true })).toMatchObject({ written: [], pruned: [] });
    expect(readdirSync(dir)).toEqual(["trace-A1.jsonl"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a session spanning several runs unions deduped and prunes its sources", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100), convPair("a2", SID_A, 200)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200), convPair("a3", SID_A, 300)));
    const plan = await scoped(SID_A);
    expect(plan.sessions[0]!.dupes).toBe(1);
    const res = applyMerge(plan, { prune: true });
    expect(res.written).toEqual(["session-2d5c0d3b.jsonl"]);
    expect(res.pruned.sort()).toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
    expect(ids(join(dir, "session-2d5c0d3b.jsonl"))).toEqual(["a1", "a2", "a3"]);
  });

  // One source is enough when a previous merge already claimed this session:
  // that's the resumed-session case the auto-merge exists for.
  test("an existing session file makes a single new trace worth merging", async () => {
    const out = join(dir, "session-2d5c0d3b.jsonl");
    writeFileSync(out, jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    const plan = await scoped(SID_A);
    expect(plan.sessions[0]!.existing).toBe(1);
    applyMerge(plan, { prune: true });
    expect(ids(out)).toEqual(["a1", "a2"]);
    expect(existsSync(join(dir, "trace-A2.jsonl"))).toBe(false);
  });

  test("utility pairs keep their trace out of the prune set", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200), utilityPair("u1", 201)));
    const res = applyMerge(await scoped(SID_A), { prune: true });
    expect(res.pruned).toEqual(["trace-A1.jsonl"]);
    expect(existsSync(join(dir, "trace-A2.jsonl"))).toBe(true);
  });

  // The huge-session exit fix (2026-08-06): a scoped plan substring-scans
  // before parsing, so unrelated traces are never JSON-parsed and the
  // nothing-to-consolidate case concludes without parsing anything at all —
  // the exit used to sit in a full-dir parse with zero output, looking hung.
  test("scoped plan never parses files that don't mention a target sid", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    writeFileSync(join(dir, "trace-B1.jsonl"), jl(convPair("b1", SID_B, 300)));
    const events: any[] = [];
    const plan = await planMerge(dir, { sessionIds: new Set([SID_A]), fragmentedOnly: true, onProgress: (ev) => events.push(ev) });
    expect(plan.sessions.map((s) => s.id)).toEqual([SID_A]);
    expect(events.filter((e) => e.phase === "scan").map((e) => e.name).sort())
      .toEqual(["trace-A1.jsonl", "trace-A2.jsonl", "trace-B1.jsonl"]);
    expect(events.filter((e) => e.phase === "read").map((e) => e.name).sort())
      .toEqual(["trace-A1.jsonl", "trace-A2.jsonl"]);
  });

  test("nothing-to-consolidate concludes from the scan alone — no parse, no read", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-B1.jsonl"), jl(convPair("b1", SID_B, 300)));
    const events: any[] = [];
    const plan = await planMerge(dir, { sessionIds: new Set([SID_A]), fragmentedOnly: true, onProgress: (ev) => events.push(ev) });
    expect(plan.sessions).toHaveLength(0);
    expect(events.filter((e) => e.phase === "read")).toHaveLength(0);
  });

  test("a .zst prior output keeps a single-trace session in scope", async () => {
    const prior = jl(convPair("a1", SID_A, 100));
    writeFileSync(join(dir, "session-2d5c0d3b.jsonl.zst"), Bun.zstdCompressSync(Buffer.from(prior)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    const plan = await planMerge(dir, { sessionIds: new Set([SID_A]), fragmentedOnly: true });
    expect(plan.sessions).toHaveLength(1);
    expect(plan.sessions[0]!.existing).toBe(1);
    applyMerge(plan, { prune: true });
    expect(ids(join(dir, "session-2d5c0d3b.jsonl"))).toEqual(["a1", "a2"]);
  });

  test("applyMerge reports each session write via onProgress", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    const events: any[] = [];
    applyMerge(await scoped(SID_A), { prune: true, onProgress: (ev) => events.push(ev) });
    expect(events.filter((e) => e.phase === "write")).toEqual([
      { phase: "write", name: "session-2d5c0d3b.jsonl", pairs: 2 },
    ]);
  });

  // A concurrent capture appending to a source between plan and apply: its
  // tail is in no output, so the file must survive.
  test("a source that grew since the plan is skipped, not truncated", async () => {
    writeFileSync(join(dir, "trace-A1.jsonl"), jl(convPair("a1", SID_A, 100)));
    writeFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a2", SID_A, 200)));
    const plan = await scoped(SID_A);
    appendFileSync(join(dir, "trace-A2.jsonl"), jl(convPair("a9", SID_A, 900)));
    const res = applyMerge(plan, { prune: true });
    expect(res.skipped).toEqual(["trace-A2.jsonl"]);
    expect(ids(join(dir, "trace-A2.jsonl"))).toEqual(["a2", "a9"]);
  });
});

const unzstd = (path: string) => Buffer.from(Bun.zstdDecompressSync(readFileSync(path))).toString("utf8");

describe("compress", async () => {
  test("zstd-archives .jsonl, removes original, round-trips byte-identical", async () => {
    const body = jl(convPair("a", SID_A, 1), convPair("b", SID_A, 2));
    writeFileSync(join(dir, "trace-1.jsonl"), body);
    const res = await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    expect(res.archived).toHaveLength(1);
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(false);
    const zst = join(dir, "trace-1.jsonl.zst");
    expect(existsSync(zst)).toBe(true);
    expect(unzstd(zst)).toBe(body);
  });

  test("exclude set keeps a live run's file out of the plan", () => {
    writeFileSync(join(dir, "trace-live.jsonl"), jl(convPair("a", SID_A, 1)));
    writeFileSync(join(dir, "trace-done.jsonl"), jl(convPair("b", SID_A, 2)));
    const plan = planCompress(dir, 1_000_000, undefined, new Set([join(dir, "trace-live.jsonl")]));
    expect(plan.files.map((f) => f.name)).toEqual(["trace-done.jsonl"]);
  });

  test("--older-than skips recent traces", async () => {
    writeFileSync(join(dir, "trace-recent.jsonl"), jl(convPair("a", SID_A, 1)));
    const now = statSync(join(dir, "trace-recent.jsonl")).mtimeMs + 1000;
    const plan = planCompress(dir, now, 7); // 7 days; file is seconds old
    expect(plan.files).toHaveLength(0);
  });

  test("--keep-jsonl leaves the original", async () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: true });
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-1.jsonl.zst"))).toBe(true);
  });

  // Regression: an archive must never lose pairs it already holds — a trace
  // recreated after an earlier compress (live run, --log NAME reuse) used to
  // clobber the archive with only the new pairs.
  test("unions with an existing archive instead of overwriting it", async () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("b", SID_A, 2))); // recreated
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    const text = unzstd(join(dir, "trace-1.jsonl.zst"));
    expect(parseTraceText(text).map((p) => p.id)).toEqual(["a", "b"]);
  });

  // Regression: a file that changed since the plan is a live capture — skip it.
  test("skips a trace that changed since the plan", async () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("a", SID_A, 1)));
    const plan = planCompress(dir, 1_000_000);
    appendFileSync(join(dir, "trace-1.jsonl"), jl(convPair("b", SID_A, 2)));
    const res = await applyCompress(plan, { keepJsonl: false });
    expect(res.archived).toHaveLength(0);
    expect(res.skipped).toEqual(["trace-1.jsonl"]);
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "trace-1.jsonl.zst"))).toBe(false);
  });

  test("upgrades a legacy standalone .gz archive to .zst, same lines", async () => {
    const body = jl(convPair("a", SID_A, 1), convPair("b", SID_A, 2));
    writeFileSync(join(dir, "trace-old.jsonl.gz"), gzipSync(body));
    const plan = planCompress(dir, 1_000_000);
    expect(plan.upgrades.map((f) => f.name)).toEqual(["trace-old.jsonl.gz"]);
    await applyCompress(plan, { keepJsonl: false });
    expect(existsSync(join(dir, "trace-old.jsonl.gz"))).toBe(false);
    expect(unzstd(join(dir, "trace-old.jsonl.zst"))).toBe(body);
  });

  test("a .jsonl with a legacy .gz sibling unions both into the .zst", async () => {
    writeFileSync(join(dir, "trace-1.jsonl.gz"), gzipSync(jl(convPair("a", SID_A, 1))));
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("b", SID_A, 2)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    expect(existsSync(join(dir, "trace-1.jsonl.gz"))).toBe(false);
    expect(parseTraceText(unzstd(join(dir, "trace-1.jsonl.zst"))).map((p) => p.id)).toEqual(["a", "b"]);
  });

  // The exit path: a merged session file overwrites its prior archive (the
  // merge already unioned it — planMerge blocks otherwise), streamed and
  // decode-verified; a lone trace still unions when an archive appeared.
  test("archiveTrace overwrites a superseded archive only while it is the one the plan saw", async () => {
    writeFileSync(join(dir, "session-x.jsonl"), jl(convPair("a", SID_A, 1)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    const zst = join(dir, "session-x.jsonl.zst");
    const seen = { size: statSync(zst).size, mtimeMs: statSync(zst).mtimeMs };
    // The merge rewrote the plain file as a superset (a + b) of THAT archive.
    writeFileSync(join(dir, "session-x.jsonl"), jl(convPair("a", SID_A, 1), convPair("b", SID_A, 2)));
    const res = await archiveTrace(join(dir, "session-x.jsonl"), { supersedesArchive: seen });
    expect(res.archived).toHaveLength(1);
    expect(existsSync(join(dir, "session-x.jsonl"))).toBe(false);
    expect(parseTraceText(unzstd(zst)).map((p) => p.id)).toEqual(["a", "b"]);
    // Without the stamp, an existing archive means union (never overwrite).
    writeFileSync(join(dir, "session-x.jsonl"), jl(convPair("c", SID_A, 3)));
    await archiveTrace(join(dir, "session-x.jsonl"));
    expect(parseTraceText(unzstd(zst)).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  // The stamp guards against a concurrent exit of the same session: an
  // archive that changed (or appeared) since the plan is not covered by the
  // plain file, so the verbatim overwrite downgrades to union.
  test("a stale supersedes stamp downgrades to the union path", async () => {
    const plain = join(dir, "session-x.jsonl");
    const zst = join(dir, "session-x.jsonl.zst");
    // Plan saw NO archive; a concurrent exit wrote one holding "z" meanwhile.
    writeFileSync(join(dir, "trace-z.jsonl"), jl(convPair("z", SID_A, 9)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    require("fs").renameSync(join(dir, "trace-z.jsonl.zst"), zst);
    writeFileSync(plain, jl(convPair("a", SID_A, 1)));
    await archiveTrace(plain, { supersedesArchive: null });
    expect(parseTraceText(unzstd(zst)).map((p) => p.id).sort()).toEqual(["a", "z"]);
    // Plan saw an archive, but a different one is there now.
    writeFileSync(plain, jl(convPair("b", SID_A, 2)));
    await archiveTrace(plain, { supersedesArchive: { size: 1, mtimeMs: 1 } });
    expect(parseTraceText(unzstd(zst)).map((p) => p.id).sort()).toEqual(["a", "b", "z"]);
  });

  // Merge's prune rule, applied to the automated union: a torn line in the
  // plain file (a killed run's tail) is bytes no archive would hold — the
  // plain file stays, nothing is sealed.
  test("the union path refuses to seal a damaged plain file", async () => {
    const plain = join(dir, "trace-1.jsonl");
    writeFileSync(plain, jl(convPair("a", SID_A, 1)));
    await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    writeFileSync(plain, jl(convPair("b", SID_A, 2)) + '{"id":"torn","request":{"url":');
    const res = await archiveTrace(plain);
    expect(res.skipped).toEqual(["trace-1.jsonl"]);
    expect(existsSync(plain)).toBe(true);
    expect(parseTraceText(unzstd(join(dir, "trace-1.jsonl.zst"))).map((p) => p.id)).toEqual(["a"]);
  });

  test("archiveTrace ignores non-.jsonl and empty files", async () => {
    writeFileSync(join(dir, "trace-empty.jsonl"), "");
    writeFileSync(join(dir, "trace-1.jsonl.zst"), Buffer.from("x"));
    expect((await archiveTrace(join(dir, "trace-empty.jsonl"))).archived).toHaveLength(0);
    expect((await archiveTrace(join(dir, "trace-1.jsonl.zst"))).archived).toHaveLength(0);
    expect((await archiveTrace(join(dir, "nope.jsonl"))).skipped).toEqual(["nope.jsonl"]);
  });

  test("streamed archive of a multi-MB trace round-trips byte-identical", async () => {
    // Bigger than the 1MB read chunk so several chunks flow through the encoder.
    const pairs = Array.from({ length: 1500 }, (_, i) => convPair(`p${i}`, SID_A, i));
    const body = jl(...pairs) + "x".repeat(2 * 1024 * 1024) + "\n";
    writeFileSync(join(dir, "trace-big.jsonl"), body);
    const res = await applyCompress(planCompress(dir, 1_000_000), { keepJsonl: false });
    expect(res.archived[0]!.before).toBe(body.length);
    expect(res.archived[0]!.after).toBeLessThan(body.length / 10);
    expect(unzstd(join(dir, "trace-big.jsonl.zst"))).toBe(body);
  });

  // Killed runs leave plain traces: the sweep plans those idle long enough
  // and never the excluded (live) ones.
  test("planStaleSweep picks idle minted traces only, skips excluded, fresh, and foreign .jsonl", () => {
    writeFileSync(join(dir, "trace-old.jsonl"), jl(convPair("a", SID_A, 1)));
    writeFileSync(join(dir, "session-old.jsonl"), jl(convPair("d", SID_A, 4)));
    writeFileSync(join(dir, "trace-live.jsonl"), jl(convPair("b", SID_A, 2)));
    writeFileSync(join(dir, "trace-fresh.jsonl"), jl(convPair("c", SID_A, 3)));
    writeFileSync(join(dir, "trace-done.jsonl.zst"), Buffer.from("x"));
    writeFileSync(join(dir, "train.jsonl"), "the user's dataset under --dir\n");
    const now = statSync(join(dir, "trace-old.jsonl")).mtimeMs;
    const plan = planStaleSweep(dir, new Set([join(dir, "trace-live.jsonl")]), now + 2 * 3600_000, 3600_000);
    expect(plan.files.map((f) => f.name).sort()).toEqual(["session-old.jsonl", "trace-fresh.jsonl", "trace-old.jsonl"]);
    const recent = planStaleSweep(dir, new Set(), now + 1000, 3600_000);
    expect(recent.files).toHaveLength(0);
  });
});

describe("purge", () => {
  const cat = (url: string) => url.includes("event_logging") ? "telemetry"
    : url.includes("count_tokens") ? "tokens"
    : url.includes("/v1/messages") ? "messages" : "other";
  const telemetryPair = (id: string, ts: number) => ({
    id, request: { timestamp: ts, method: "POST", url: "https://api.anthropic.com/api/event_logging/v2/batch", headers: {}, body: { big: "x".repeat(500) } },
    response: { timestamp: ts + 1, status: 202, headers: {}, body: {} }, duration: 1, loggedAt: "x",
  });
  const DROP = new Set(["telemetry", "tokens"]);

  test("plans per-category drops, keeps messages, honest byte tally", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("m1", SID_A, 1), telemetryPair("t1", 2), telemetryPair("t2", 3)));
    const plan = planPurge(dir, DROP, cat);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]!.dropped).toEqual({ telemetry: 2 });
    expect(plan.files[0]!.kept).toBe(1);
    expect(plan.droppedBytes).toBeGreaterThan(1000);
    expect(plan.keptCount).toBe(1);
  });

  test("apply rewrites kept lines byte-identical, drops the rest", () => {
    const keepLine = JSON.stringify(convPair("m1", SID_A, 1));
    writeFileSync(join(dir, "trace-1.jsonl"), keepLine + "\n" + JSON.stringify(telemetryPair("t1", 2)) + "\n");
    const plan = planPurge(dir, DROP, cat);
    const res = applyPurge(plan, cat, DROP);
    expect(res.rewritten).toEqual(["trace-1.jsonl"]);
    expect(readFileSync(join(dir, "trace-1.jsonl"), "utf8")).toBe(keepLine + "\n");
  });

  test("a file left with zero pairs is removed", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(telemetryPair("t1", 1)));
    const plan = planPurge(dir, DROP, cat);
    expect(plan.files[0]!.empty).toBe(true);
    const res = applyPurge(plan, cat, DROP);
    expect(res.removed).toEqual(["trace-1.jsonl"]);
    expect(existsSync(join(dir, "trace-1.jsonl"))).toBe(false);
  });

  test("torn lines are never purge targets and survive verbatim", () => {
    const torn = '{"id":"half-written';
    writeFileSync(join(dir, "trace-1.jsonl"), JSON.stringify(telemetryPair("t1", 1)) + "\n" + torn + "\n");
    const plan = planPurge(dir, DROP, cat);
    applyPurge(plan, cat, DROP);
    expect(readFileSync(join(dir, "trace-1.jsonl"), "utf8")).toBe(torn + "\n");
  });

  test("purges inside a .zst archive, stays a .zst archive", () => {
    const body = jl(convPair("m1", SID_A, 1), telemetryPair("t1", 2));
    writeFileSync(join(dir, "trace-1.jsonl.zst"), Buffer.from(Bun.zstdCompressSync(Buffer.from(body))));
    const plan = planPurge(dir, DROP, cat);
    applyPurge(plan, cat, DROP);
    const text = unzstd(join(dir, "trace-1.jsonl.zst"));
    expect(parseTraceText(text).map((p) => p.id)).toEqual(["m1"]);
  });

  test("skips a trace that changed since the plan", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(telemetryPair("t1", 1)));
    const plan = planPurge(dir, DROP, cat);
    appendFileSync(join(dir, "trace-1.jsonl"), jl(convPair("m1", SID_A, 2)));
    const res = applyPurge(plan, cat, DROP);
    expect(res.skipped).toEqual(["trace-1.jsonl"]);
    expect(parseTraceText(readFileSync(join(dir, "trace-1.jsonl"), "utf8"))).toHaveLength(2);
  });

  test("no matching pairs -> empty plan", () => {
    writeFileSync(join(dir, "trace-1.jsonl"), jl(convPair("m1", SID_A, 1)));
    expect(planPurge(dir, DROP, cat).files).toHaveLength(0);
  });
});

describe("purgePairsById (web select-to-purge)", () => {
  test("rewrites only files holding a named pair; torn lines survive", () => {
    const a = join(dir, "trace-a.jsonl");
    const b = join(dir, "trace-b.jsonl");
    writeFileSync(a, jl(convPair("p1", SID_A, 1), convPair("p2", SID_A, 2)) + '{"torn": tail');
    writeFileSync(b, jl(convPair("p3", SID_B, 3)));
    const untouchedBytes = readFileSync(b, "utf8");
    const res = purgePairsById([a, b], new Set(["p1"]));
    expect(res.droppedCount).toBe(1);
    expect(res.rewritten).toEqual(["trace-a.jsonl"]);
    expect(res.skipped).toEqual([]);
    const text = readFileSync(a, "utf8");
    expect(text).not.toContain('"p1"');
    expect(text).toContain('"p2"');
    expect(text).toContain('{"torn": tail'); // never a purge target
    // no matching pair -> the file is not rewritten at all
    expect(readFileSync(b, "utf8")).toBe(untouchedBytes);
  });

  test("a file emptied by the purge is removed; missing files are skipped", () => {
    const a = join(dir, "trace-a.jsonl");
    writeFileSync(a, jl(convPair("p1", SID_A, 1)));
    const res = purgePairsById([a, join(dir, "not-there.jsonl")], new Set(["p1"]));
    expect(res.removed).toEqual(["trace-a.jsonl"]);
    expect(res.skipped).toEqual(["not-there.jsonl"]);
    expect(existsSync(a)).toBe(false);
  });

  test("archives stay archives", () => {
    const gz = join(dir, "trace-a.jsonl.gz");
    writeFileSync(gz, gzipSync(jl(convPair("p1", SID_A, 1), convPair("p2", SID_A, 2))));
    const res = purgePairsById([gz], new Set(["p2"]));
    expect(res.rewritten).toEqual(["trace-a.jsonl.gz"]);
    const text = gunzipSync(readFileSync(gz)).toString("utf8");
    expect(text).toContain('"p1"');
    expect(text).not.toContain('"p2"');
  });
});

describe("human", () => {
  test("formats bytes", () => {
    expect(human(512)).toBe("512 B");
    expect(human(1536)).toBe("1.5 KB");
    expect(human(60 * 1024 * 1024)).toBe("60.0 MB");
  });
});

describe("sweepOrphanTmps", () => {
  test("removes idle cctrace-minted .tmp files, keeps fresh ones and foreign names", () => {
    const dir = mkdtempSync(join(tmpdir(), "cctrace-tmpsweep-"));
    try {
      const now = Date.now();
      const dead = join(dir, "trace-1.jsonl.zst.4242.tmp");
      const deadMerge = join(dir, "session-abcdef12.jsonl.tmp");
      const live = join(dir, "trace-2.jsonl.zst.99.tmp");
      const foreign = join(dir, "notes.tmp");
      for (const f of [dead, deadMerge, live, foreign]) writeFileSync(f, "x");
      const past = (now - TMP_ORPHAN_MS - 60_000) / 1000;
      utimesSync(dead, past, past);
      utimesSync(deadMerge, past, past);
      utimesSync(foreign, past, past);
      expect(sweepOrphanTmps(dir, now).sort()).toEqual(["session-abcdef12.jsonl.tmp", "trace-1.jsonl.zst.4242.tmp"]);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(existsSync(foreign)).toBe(true);
      expect(sweepOrphanTmps(dir, now)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("merge: in-memory union cap", () => {
  const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
  const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
  const pair = (id: string, sid: string, ts: number) => JSON.stringify({
    id, timestamp: ts,
    request: { method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: { metadata: { user_id: JSON.stringify({ device_id: "d", session_id: sid }) } }, timestamp: ts },
    response: { status: 200, headers: {}, body: {}, timestamp: ts + 1 },
  }) + "\n";
  test("a session whose source decodes past the cap is blocked with the reason; the rest still merge; nothing of it is pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cctrace-mergecap-"));
    try {
      writeFileSync(join(dir, "trace-A1.jsonl"), pair("a1", SID_A, 100));
      writeFileSync(join(dir, "trace-A2.jsonl"), pair("a2", SID_A, 200) + "x".repeat(4096) + "\n"); // over a 2 KB cap
      writeFileSync(join(dir, "trace-B1.jsonl"), pair("b1", SID_B, 300));
      writeFileSync(join(dir, "trace-B2.jsonl"), pair("b2", SID_B, 400));
      const plan = await planMerge(dir, { sessionIds: new Set([SID_A, SID_B]), fragmentedOnly: true, maxSourceBytes: 2048 });
      expect(plan.sessions.map((s) => s.shortId)).toEqual(["bbbbbbbb"]);
      expect(plan.blocked).toHaveLength(1);
      expect(plan.blocked[0]!.outName).toBe("session-aaaaaaaa.jsonl");
      expect(plan.blocked[0]!.reason).toMatch(/trace-A2\.jsonl decodes to .* over the 2\.0 KB in-memory union cap/);
      expect(plan.subsumed.map((f) => f.name).sort()).toEqual(["trace-B1.jsonl", "trace-B2.jsonl"]);
      // unscoped: the file itself is named, other files still plan
      const all = await planMerge(dir, { maxSourceBytes: 2048 });
      expect(all.blocked.map((b) => b.outName)).toEqual(["trace-A2.jsonl"]);
      expect(all.sessions.map((s) => s.shortId).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]); // A from A1 alone
      expect(all.subsumed.map((f) => f.name)).not.toContain("trace-A2.jsonl");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a scoped plan with only over-cap candidates concludes nothing to consolidate, with the block recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cctrace-mergecap2-"));
    try {
      writeFileSync(join(dir, "trace-A1.jsonl"), pair("a1", SID_A, 100) + "x".repeat(4096) + "\n");
      writeFileSync(join(dir, "trace-A2.jsonl"), pair("a2", SID_A, 200));
      const plan = await planMerge(dir, { sessionIds: new Set([SID_A]), fragmentedOnly: true, maxSourceBytes: 2048 });
      expect(plan.sessions).toEqual([]);
      expect(plan.blocked.map((b) => b.outName)).toEqual(["session-aaaaaaaa.jsonl"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
