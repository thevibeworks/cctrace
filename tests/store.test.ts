import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  projectKey, projectTraceDir, ensureProjectDir, projectPathOf, legacyLocalDir, resolveTraceDirs,
  listStoreProjects, registryLegacyDirs, scanLegacyDirs, planAdopt, applyAdopt, liveLogFiles, storeRoot, parseRebase, rebasePath,
} from "../src/store";
import { instancesDir } from "../src/instances";

let root: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cctrace-store-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const trace = (dir: string, name: string, body = '{"id":"x","request":{"url":"u","timestamp":1}}\n') => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  return join(dir, name);
};
/** Push a file's mtime into the past so it doesn't read as "just written". */
const age = (path: string, ms: number) => {
  const t = (Date.now() - ms) / 1000;
  utimesSync(path, t, t);
};
const registryEntry = (id: string, fields: Record<string, unknown>) => {
  mkdirSync(instancesDir(dataDir), { recursive: true });
  writeFileSync(join(instancesDir(dataDir), `${id}.json`), JSON.stringify({ id, pid: 1, port: 8722, project: "p", projectPath: "/p", logFile: "", mode: "mitm", startedAt: "2026-01-01T00:00:00Z", ...fields }));
};

describe("layout", () => {
  test("projectKey follows Claude Code's projects/ convention", () => {
    expect(projectKey("/Users/eric/wrk/src/github.com/claude-code/cctrace")).toBe("-Users-eric-wrk-src-github-com-claude-code-cctrace");
    expect(projectKey("/tmp/a b_c.d")).toBe("-tmp-a-b-c-d");
    expect(projectTraceDir("/data", "/p/q")).toBe("/data/traces/-p-q");
  });

  test("ensureProjectDir creates the dir once and stamps the exact path", () => {
    const dir = ensureProjectDir(dataDir, "/some/proj.x");
    expect(dir).toBe(join(storeRoot(dataDir), "-some-proj-x"));
    expect(projectPathOf(dir)).toBe("/some/proj.x");
    // idempotent, marker untouched
    writeFileSync(join(dir, "project.json"), JSON.stringify({ path: "/kept" }));
    ensureProjectDir(dataDir, "/some/proj.x");
    expect(projectPathOf(dir)).toBe("/kept");
    expect(projectPathOf(join(root, "nowhere"))).toBeNull();
  });

  test("resolveTraceDirs: --dir is absolute; default = store + legacy read source", () => {
    const cwd = join(root, "proj");
    mkdirSync(cwd);
    const explicit = resolveTraceDirs({ dataDir, cwd, dirFlag: join(root, "elsewhere") });
    expect(explicit).toEqual({ writeDir: join(root, "elsewhere"), readDirs: [join(root, "elsewhere")], legacy: null });
    const plain = resolveTraceDirs({ dataDir, cwd });
    expect(plain.writeDir).toBe(projectTraceDir(dataDir, cwd));
    expect(plain.readDirs).toEqual([plain.writeDir]);
    expect(plain.legacy).toBeNull();
    // an empty legacy dir does not count; one with a trace does
    mkdirSync(join(cwd, ".cctrace"));
    expect(legacyLocalDir(cwd)).toBeNull();
    trace(join(cwd, ".cctrace"), "trace-1.jsonl");
    const withLegacy = resolveTraceDirs({ dataDir, cwd });
    expect(withLegacy.legacy).toBe(join(cwd, ".cctrace"));
    expect(withLegacy.readDirs).toEqual([withLegacy.writeDir, join(cwd, ".cctrace")]);
  });

  test("listStoreProjects: sizes, raw counts, marker paths, biggest first", () => {
    const a = ensureProjectDir(dataDir, "/a");
    const b = ensureProjectDir(dataDir, "/b");
    trace(a, "trace-1.jsonl", "x".repeat(10));
    trace(a, "trace-2.jsonl.zst", "x".repeat(5));
    trace(b, "trace-1.jsonl", "x".repeat(100));
    writeFileSync(join(b, "notes.txt"), "ignored");
    const list = listStoreProjects(dataDir);
    expect(list.map((p) => [p.projectPath, p.traces, p.raw, p.bytes])).toEqual([["/b", 1, 1, 100], ["/a", 2, 1, 15]]);
    expect(listStoreProjects(join(root, "empty-data"))).toEqual([]);
  });
});

describe("adopt", () => {
  test("registryLegacyDirs: distinct .cctrace parents of registry logFiles", () => {
    registryEntry("r1", { logFile: "/x/proj/.cctrace/trace-1.jsonl", endedAt: "2026-01-02T00:00:00Z" });
    registryEntry("r2", { logFile: "/x/proj/.cctrace/trace-2.jsonl", endedAt: "2026-01-02T00:00:00Z" });
    registryEntry("r3", { logFile: "/data/traces/-x-other/trace-3.jsonl" }); // already in a store
    registryEntry("r4", { logFile: "/y/.cctrace/trace-4.jsonl" });
    expect(registryLegacyDirs(dataDir)).toEqual(["/x/proj/.cctrace", "/y/.cctrace"]);
  });

  test("scanLegacyDirs finds .cctrace dirs holding traces, skips heavy trees", () => {
    trace(join(root, "w", "p1", ".cctrace"), "trace-1.jsonl");
    mkdirSync(join(root, "w", "p2", ".cctrace"), { recursive: true }); // empty: not listed
    trace(join(root, "w", "node_modules", "dep", ".cctrace"), "trace-1.jsonl"); // skipped tree
    trace(join(root, "w", "deep", "a", "b", ".cctrace"), "trace-1.jsonl");
    expect(scanLegacyDirs(join(root, "w"))).toEqual([join(root, "w", "deep", "a", "b", ".cctrace"), join(root, "w", "p1", ".cctrace")]);
    expect(scanLegacyDirs(join(root, "w"), 1)).toEqual([join(root, "w", "p1", ".cctrace")]);
  });

  test("plan: moves traces + html, keeps live and fresh files, dedupes candidates", async () => {
    const proj = join(root, "proj");
    const legacy = join(proj, ".cctrace");
    const old = trace(legacy, "trace-old.jsonl");
    age(old, 3600_000);
    const zst = trace(legacy, "trace-a.jsonl.zst");
    age(zst, 3600_000);
    const html = trace(legacy, "trace-old.html", "<html>");
    age(html, 3600_000);
    const fresh = trace(legacy, "trace-fresh.jsonl"); // written just now
    const live = trace(legacy, "trace-live.jsonl");
    age(live, 3600_000);
    writeFileSync(join(legacy, "README"), "not ours");
    const plan = await planAdopt(dataDir, [proj, legacy], { liveFiles: new Set([live]) });
    expect(plan.dirs).toHaveLength(1);
    const d = plan.dirs[0]!;
    expect(d.projectPath).toBe(proj);
    expect(d.targetDir).toBe(projectTraceDir(dataDir, proj));
    expect(d.moves.map((m) => m.name)).toEqual(["trace-a.jsonl.zst", "trace-old.html", "trace-old.jsonl"]);
    expect(d.skipped).toEqual([
      { name: "trace-fresh.jsonl", reason: "written in the last 2 min" },
      { name: "trace-live.jsonl", reason: "live run" },
    ]);
    expect(plan.files).toBe(3);
    expect((await planAdopt(dataDir, [join(root, "nope")])).absent).toEqual([join(root, "nope", ".cctrace")]);
  });

  test("plan --rebase: project path, store key and live check use the other host's paths", async () => {
    // The host's ~/wrk mounted here under ./mounts; the registry (shared
    // data dir) names the live file by its host path.
    const mounts = join(root, "mounts");
    const legacy = join(mounts, "src", "proj", ".cctrace");
    const old = trace(legacy, "trace-old.jsonl");
    age(old, 3600_000);
    const live = trace(legacy, "trace-live.jsonl");
    age(live, 3600_000);
    const rebase = parseRebase(`${mounts}=/Users/me/wrk`)!;
    expect(rebase).toEqual({ from: mounts, to: "/Users/me/wrk" });
    expect(rebasePath(join(mounts, "src", "proj"), rebase)).toBe("/Users/me/wrk/src/proj");
    expect(rebasePath("/elsewhere/proj", rebase)).toBe("/elsewhere/proj");
    expect(parseRebase("nope")).toBeNull();
    expect(parseRebase("=/x")).toBeNull();
    const plan = await planAdopt(dataDir, [legacy], { rebase, liveFiles: new Set(["/Users/me/wrk/src/proj/.cctrace/trace-live.jsonl"]) });
    expect(plan.dirs).toHaveLength(1);
    const d = plan.dirs[0]!;
    expect(d.projectPath).toBe("/Users/me/wrk/src/proj");
    expect(d.targetDir).toBe(projectTraceDir(dataDir, "/Users/me/wrk/src/proj"));
    expect(d.moves.map((m) => m.name)).toEqual(["trace-old.jsonl"]);
    expect(d.moves[0]!.alias).toBe("/Users/me/wrk/src/proj/.cctrace/trace-old.jsonl");
    expect(d.skipped).toEqual([{ name: "trace-live.jsonl", reason: "live run" }]);
    // apply: the marker holds the host path; a tombstone naming the host
    // path is re-pointed at the store.
    registryEntry("host-run", { logFile: "/Users/me/wrk/src/proj/.cctrace/trace-old.jsonl", projectPath: "/Users/me/wrk/src/proj", endedAt: "2026-01-02T00:00:00Z" });
    const res = await applyAdopt(dataDir, plan);
    expect(res.moved).toHaveLength(1);
    expect(res.repointed).toBe(1);
    expect(projectPathOf(d.targetDir)).toBe("/Users/me/wrk/src/proj");
    expect(JSON.parse(readFileSync(join(instancesDir(dataDir), "host-run.json"), "utf8")).logFile).toBe(join(d.targetDir, "trace-old.jsonl"));
  });

  test("plan/apply --copy --zst: sources stay, plain traces arrive as verified .zst, archives/html as-is", async () => {
    const proj = join(root, "proj");
    const legacy = join(proj, ".cctrace");
    const body = Array.from({ length: 200 }, (_, i) => JSON.stringify({ id: "p" + i, request: { url: "https://api.anthropic.com/v1/messages", body: { messages: "x".repeat(500) } } })).join("\n") + "\n";
    const t1 = trace(legacy, "trace-1.jsonl", body);
    age(t1, 3600_000);
    const z = trace(legacy, "trace-2.jsonl.zst", "zz");
    age(z, 3600_000);
    const html = trace(legacy, "trace-1.html", "<html>");
    age(html, 3600_000);
    const empty = trace(legacy, "trace-empty.jsonl", "");
    age(empty, 3600_000);
    const plan = await planAdopt(dataDir, [proj], { copy: true, archive: true });
    expect(plan.copy).toBe(true);
    const target = projectTraceDir(dataDir, proj);
    expect(plan.dirs[0]!.skipped).toEqual([{ name: "trace-1.html", reason: "regenerable snapshot" }]);
    expect(plan.dirs[0]!.moves.map((m) => [m.name, m.to.slice(target.length + 1), !!m.archive])).toEqual([
      ["trace-1.jsonl", "trace-1.jsonl.zst", true],
      ["trace-2.jsonl.zst", "trace-2.jsonl.zst", false],
      ["trace-empty.jsonl", "trace-empty.jsonl", false],
    ]);
    const res = await applyAdopt(dataDir, plan);
    expect(res.moved).toHaveLength(3);
    expect(res.storedBytes).toBeLessThan(res.bytes / 5);
    expect(res.removedDirs).toEqual([]);
    for (const f of [t1, z, html, empty]) expect(existsSync(f)).toBe(true); // --copy: sources untouched
    expect(existsSync(join(target, "trace-1.html"))).toBe(false);
    expect(readFileSync(t1, "utf8")).toBe(body);
    const { readTraceText } = await import("../src/history");
    expect(readTraceText(join(target, "trace-1.jsonl.zst"))).toBe(body); // round-trips
    expect(existsSync(join(target, "trace-1.jsonl"))).toBe(false);
    expect(readFileSync(join(target, "trace-2.jsonl.zst"), "utf8")).toBe("zz");
    expect(projectPathOf(target)).toBe(proj);
    // re-run of a copy: everything is already in the store -> nothing to do
    const plan2 = await planAdopt(dataDir, [proj], { copy: true, archive: true });
    expect(plan2.dirs[0]!.moves).toEqual([]);
    expect(plan2.dirs[0]!.skipped.map((k) => k.reason)).toEqual(["regenerable snapshot", ...Array(3).fill("already in the store")]);
    // a move after the copy: the plain trace meets its own archive (same
    // decoded size) and is recognised, not duplicated; a grown twin and
    // genuinely different files still take .legacy1 names
    const plan3 = await planAdopt(dataDir, [proj], { archive: true });
    expect(plan3.dirs[0]!.skipped).toContainEqual({ name: "trace-1.jsonl", reason: "already archived in the store" });
    expect(plan3.dirs[0]!.moves.map((m) => m.to.slice(target.length + 1))).toEqual([
      "trace-1.html", "trace-2.legacy1.jsonl.zst", "trace-empty.legacy1.jsonl",
    ]);
    writeFileSync(t1, body + JSON.stringify({ id: "later", request: { url: "https://api.anthropic.com/v1/messages" } }) + "\n");
    age(t1, 3600_000);
    const plan4 = await planAdopt(dataDir, [proj], { archive: true });
    expect(plan4.dirs[0]!.moves.map((m) => m.to.slice(target.length + 1))).toContain("trace-1.legacy1.jsonl.zst");
  });

  test("apply: renames into the store, re-points registry entries, removes an emptied legacy dir", async () => {
    const proj = join(root, "proj");
    const legacy = join(proj, ".cctrace");
    const t1 = trace(legacy, "trace-1.jsonl", "one\n");
    const t2 = trace(legacy, "trace-2.jsonl.zst", "two");
    age(t1, 3600_000);
    age(t2, 3600_000);
    registryEntry("r1", { logFile: t1, endedAt: "2026-01-02T00:00:00Z" });
    registryEntry("r2", { logFile: "/elsewhere/.cctrace/trace-9.jsonl", endedAt: "2026-01-02T00:00:00Z" });
    const plan = await planAdopt(dataDir, [proj], { liveFiles: new Set() });
    const res = await applyAdopt(dataDir, plan);
    const target = projectTraceDir(dataDir, proj);
    expect(res.moved.map((m) => m.name)).toEqual(["trace-1.jsonl", "trace-2.jsonl.zst"]);
    expect(res.bytes).toBe(7);
    expect(readFileSync(join(target, "trace-1.jsonl"), "utf8")).toBe("one\n");
    expect(existsSync(t1)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(res.removedDirs).toEqual([legacy]);
    expect(projectPathOf(target)).toBe(proj);
    expect(res.repointed).toBe(1);
    const r1 = JSON.parse(readFileSync(join(instancesDir(dataDir), "r1.json"), "utf8"));
    expect(r1.logFile).toBe(join(target, "trace-1.jsonl"));
    const r2 = JSON.parse(readFileSync(join(instancesDir(dataDir), "r2.json"), "utf8"));
    expect(r2.logFile).toBe("/elsewhere/.cctrace/trace-9.jsonl");
  });

  // A session continued after the upgrade already has a store-side
  // session-<sid8> archive: the legacy copy must move in without touching
  // it — under a .legacyN suffix that still reads as a trace of that sid.
  test("apply never overwrites a name already in the store: the legacy copy lands as .legacy1; a stray file keeps the legacy dir", async () => {
    const proj = join(root, "proj");
    const legacy = join(proj, ".cctrace");
    const t1 = trace(legacy, "session-abcd1234.jsonl.zst", "legacy copy");
    age(t1, 3600_000);
    writeFileSync(join(legacy, "keep.txt"), "user's");
    const store = projectTraceDir(dataDir, proj);
    trace(store, "session-abcd1234.jsonl.zst", "store copy");
    trace(store, "session-abcd1234.legacy1.jsonl.zst", "an earlier adopt");
    const plan = await planAdopt(dataDir, [proj], { liveFiles: new Set() });
    expect(plan.dirs[0]!.moves.map((m) => m.to)).toEqual([join(store, "session-abcd1234.legacy2.jsonl.zst")]);
    const res = await applyAdopt(dataDir, plan);
    expect(res.moved).toHaveLength(1);
    expect(existsSync(t1)).toBe(false);
    expect(readFileSync(join(store, "session-abcd1234.jsonl.zst"), "utf8")).toBe("store copy");
    expect(readFileSync(join(store, "session-abcd1234.legacy2.jsonl.zst"), "utf8")).toBe("legacy copy");
    expect(existsSync(legacy)).toBe(true); // keep.txt is the user's
    // a target that appears between plan and apply is never clobbered
    const t2 = trace(legacy, "trace-9.jsonl", "late");
    age(t2, 3600_000);
    const plan2 = await planAdopt(dataDir, [proj], { liveFiles: new Set() });
    trace(store, "trace-9.jsonl", "raced in");
    const res2 = await applyAdopt(dataDir, plan2);
    expect(res2.skipped).toEqual([{ name: "trace-9.jsonl", reason: "target appeared since plan" }]);
    expect(readFileSync(join(store, "trace-9.jsonl"), "utf8")).toBe("raced in");
  });

  test("apply re-stats: a file that grew since the plan stays (live sink)", async () => {
    const proj = join(root, "proj");
    const legacy = join(proj, ".cctrace");
    const t1 = trace(legacy, "trace-1.jsonl", "a\n");
    age(t1, 3600_000);
    const plan = await planAdopt(dataDir, [proj], { liveFiles: new Set() });
    writeFileSync(t1, "a\nb\n");
    const res = await applyAdopt(dataDir, plan);
    expect(res.moved).toHaveLength(0);
    expect(res.skipped).toEqual([{ name: "trace-1.jsonl", reason: "changed since plan" }]);
    expect(existsSync(t1)).toBe(true);
  });

  // Live = heartbeat-fresh and not a tombstone; each live file counts under
  // its recorded path AND under this side's store dir for the project — a
  // run in another container records the same trace under its own $HOME.
  test("liveLogFiles: heartbeat-fresh, non-tombstone entries, plus the store-mapped path", () => {
    registryEntry("live", { logFile: "/Users/eric/.local/share/cctrace/traces/-p/trace-live.jsonl", projectPath: "/p" });
    registryEntry("done", { logFile: "/p/.cctrace/trace-done.jsonl", endedAt: "2026-01-02T00:00:00Z" });
    registryEntry("stale", { logFile: "/p/.cctrace/trace-stale.jsonl" });
    age(join(instancesDir(dataDir), "stale.json"), 10 * 60_000);
    expect([...liveLogFiles(dataDir)].sort()).toEqual([
      "/Users/eric/.local/share/cctrace/traces/-p/trace-live.jsonl",
      join(projectTraceDir(dataDir, "/p"), "trace-live.jsonl"),
    ].sort());
    expect(readdirSync(instancesDir(dataDir)).length).toBe(3); // reads never GC
  });
});
