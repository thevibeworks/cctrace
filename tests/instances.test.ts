import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync, utimesSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  registerInstance, listInstances, listLiveInstances, listPastRuns, probeInstance, instancesDir,
  STALE_MS, ABANDONED_MS, TOMBSTONE_TTL_MS, type InstanceInfo, type ProbeVerdict, type SelfProbe,
} from "../src/instances";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cctrace-inst-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  id: "run-" + Math.random().toString(36).slice(2),
  pid: process.pid,
  port: 9317,
  project: "myproj",
  projectPath: "/w/myproj",
  logFile: ".cctrace/trace-x.jsonl",
  mode: "mitm",
  startedAt: new Date().toISOString(),
  ...over,
});

/** Backdate an entry's file so listLiveInstances must probe it. */
function backdate(i: InstanceInfo, ms: number) {
  const past = (Date.now() - ms) / 1000;
  utimesSync(join(instancesDir(dir), `${i.id ?? i.pid}.json`), past, past);
}
const makeStale = (i: InstanceInfo) => backdate(i, STALE_MS + 60_000);

const never: (i: InstanceInfo) => Promise<ProbeVerdict> = async () => {
  throw new Error("fresh entries must not be probed");
};
const always = (v: ProbeVerdict) => async () => v;

describe("register / list / update / unregister", () => {
  test("a registered instance shows up in the list", () => {
    registerInstance(dir, info());
    const list = listInstances(dir);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ pid: process.pid, port: 9317, project: "myproj" });
  });

  test("files are keyed by run id — same-pid runs from two namespaces coexist", () => {
    registerInstance(dir, info({ id: "run-a", pid: 84 }));
    registerInstance(dir, info({ id: "run-b", pid: 84 }));
    expect(listInstances(dir).length).toBe(2);
    expect(readdirSync(instancesDir(dir)).sort()).toEqual(["run-a.json", "run-b.json"]);
  });

  test("update merges fields (session id learned later)", () => {
    const h = registerInstance(dir, info());
    h.update({ sessionId: "abc-123" });
    expect(listInstances(dir)[0].sessionId).toBe("abc-123");
    expect(listInstances(dir)[0].project).toBe("myproj"); // untouched fields survive
    expect(h.snapshot().sessionId).toBe("abc-123");
  });

  test("unregister removes the entry", () => {
    const h = registerInstance(dir, info());
    h.unregister();
    expect(listInstances(dir)).toEqual([]);
    h.unregister(); // idempotent
  });

  test("list sorts oldest-first by startedAt", () => {
    registerInstance(dir, info({ id: "young", startedAt: "2026-07-11T02:00:00Z" }));
    registerInstance(dir, info({ id: "old", startedAt: "2026-07-11T01:00:00Z" }));
    expect(listInstances(dir).map((i) => i.id)).toEqual(["old", "young"]);
  });

  test("registry file is human-readable JSON", () => {
    const i = info();
    registerInstance(dir, i);
    const raw = readFileSync(join(instancesDir(dir), `${i.id}.json`), "utf8");
    expect(JSON.parse(raw).project).toBe("myproj");
  });

  test("heartbeat restores a vandalized entry", async () => {
    const i = info();
    const h = registerInstance(dir, i, 20); // 20ms heartbeat for the test
    const file = join(instancesDir(dir), `${i.id}.json`);
    unlinkSync(file); // a pre-0.10 reader in another pid namespace GC'd us
    await new Promise((r) => setTimeout(r, 80));
    expect(existsSync(file)).toBe(true);
    h.unregister();
  });
});

describe("tombstones", () => {
  test("tombstone() leaves a catalog entry instead of deleting", () => {
    const i = info({ agentPid: 4242 });
    const h = registerInstance(dir, i);
    h.update({ sessionId: "sess-1" });
    h.tombstone();
    const past = listPastRuns(dir);
    expect(past.length).toBe(1);
    expect(past[0]).toMatchObject({ id: i.id, sessionId: "sess-1", agentPid: 4242 });
    expect(typeof past[0]!.endedAt).toBe("string");
  });

  test("tombstones are never listed live and never GC'd by the live lister", async () => {
    const i = info();
    registerInstance(dir, i).tombstone();
    backdate(i, ABANDONED_MS + 60_000); // ancient — live GC would junk it
    const live = await listLiveInstances(dir, { probe: always("dead") });
    expect(live).toEqual([]);
    expect(listPastRuns(dir).length).toBe(1); // survived
  });

  test("tombstones past their TTL are pruned at register time", () => {
    const old = info({ id: "ancient" });
    registerInstance(dir, old).tombstone();
    // Rewrite with an endedAt beyond the TTL (tombstone() stamps now).
    const file = join(instancesDir(dir), "ancient.json");
    const entry = JSON.parse(readFileSync(file, "utf8"));
    entry.endedAt = new Date(Date.now() - TOMBSTONE_TTL_MS - 60_000).toISOString();
    writeFileSync(file, JSON.stringify(entry));
    registerInstance(dir, info()).unregister();
    expect(existsSync(file)).toBe(false);
  });

  test("listPastRuns groups project-first, newest first within", () => {
    const mk = (id: string, projectPath: string, endedAt: string) => {
      const h = registerInstance(dir, info({ id, projectPath, startedAt: endedAt }));
      h.tombstone();
      const file = join(instancesDir(dir), `${id}.json`);
      const e = JSON.parse(readFileSync(file, "utf8"));
      e.endedAt = endedAt;
      writeFileSync(file, JSON.stringify(e));
    };
    mk("b-old", "/w/beta", "2026-07-10T01:00:00Z");
    mk("a-new", "/w/alpha", "2026-07-12T01:00:00Z");
    mk("a-old", "/w/alpha", "2026-07-11T01:00:00Z");
    expect(listPastRuns(dir).map((i) => i.id)).toEqual(["a-new", "a-old", "b-old"]);
  });
});

describe("listLiveInstances", () => {
  test("heartbeat-fresh entries pass without probing", async () => {
    registerInstance(dir, info());
    const list = await listLiveInstances(dir, { probe: never });
    expect(list.length).toBe(1);
  });

  test("stale + probe alive: listed, file kept", async () => {
    const i = info();
    registerInstance(dir, i);
    makeStale(i);
    expect((await listLiveInstances(dir, { probe: always("alive") })).length).toBe(1);
    expect(existsSync(join(instancesDir(dir), `${i.id}.json`))).toBe(true);
  });

  test("stale + probe dead: hidden, file GC'd", async () => {
    const i = info();
    registerInstance(dir, i);
    makeStale(i);
    expect(await listLiveInstances(dir, { probe: always("dead") })).toEqual([]);
    expect(existsSync(join(instancesDir(dir), `${i.id}.json`))).toBe(false);
  });

  test("stale + probe inconclusive: hidden, file KEPT for the next reader", async () => {
    const i = info();
    registerInstance(dir, i);
    makeStale(i);
    expect(await listLiveInstances(dir, { probe: always("unknown") })).toEqual([]);
    expect(existsSync(join(instancesDir(dir), `${i.id}.json`))).toBe(true);
  });

  test("abandoned (no heartbeat for a day) + inconclusive probe: GC'd", async () => {
    // Where closed ports hang instead of refusing, "dead" never fires — the
    // heartbeat's long silence is the fallback death certificate.
    const i = info();
    registerInstance(dir, i);
    backdate(i, ABANDONED_MS + 60_000);
    expect(await listLiveInstances(dir, { probe: always("unknown") })).toEqual([]);
    expect(existsSync(join(instancesDir(dir), `${i.id}.json`))).toBe(false);
  });

  test("a dead pid alone is NOT a death sentence (cross-namespace registry)", async () => {
    // The pid is meaningless from another pid namespace; only the port speaks.
    const i = info({ pid: 2 ** 30 });
    registerInstance(dir, i);
    makeStale(i);
    expect((await listLiveInstances(dir, { probe: always("alive") })).length).toBe(1);
  });

  test("unparseable files are dropped", async () => {
    registerInstance(dir, info()); // valid one
    writeFileSync(join(instancesDir(dir), "999.json"), "not json{");
    expect((await listLiveInstances(dir, { probe: never })).length).toBe(1);
    expect(existsSync(join(instancesDir(dir), "999.json"))).toBe(false);
  });

  test("empty/missing dir lists nothing", async () => {
    expect(await listLiveInstances(join(dir, "nope"), { probe: never })).toEqual([]);
  });
});

// The registry can be incomplete through no fault of its own: a pre-0.10
// reader sharing the dir deletes entries whose pid it can't see (other pid
// namespaces). The port sweep makes the listing truthful anyway.
describe("port sweep", () => {
  const scanOf = (map: Record<number, SelfProbe>) =>
    async (port: number): Promise<SelfProbe> => map[port] ?? { kind: "closed" };

  test("an unregistered live instance is discovered from /api/self", async () => {
    const ghost = info({ id: "ghost", port: 9420 });
    const list = await listLiveInstances(dir, {
      probe: never,
      scanPorts: [9419, 9420],
      scan: scanOf({ 9420: { kind: "self", info: ghost } }),
    });
    expect(list.map((i) => i.id)).toEqual(["ghost"]);
  });

  test("ports covered by registry entries are not re-probed", async () => {
    const i = info({ port: 9317 });
    registerInstance(dir, i);
    const list = await listLiveInstances(dir, {
      probe: never,
      scanPorts: [9317],
      scan: async () => { throw new Error("covered port must not be swept"); },
    });
    expect(list.length).toBe(1);
  });

  test("an old cctrace (404) becomes a minimal row; closed/other ports don't", async () => {
    const list = await listLiveInstances(dir, {
      probe: never,
      scanPorts: [9317, 9318, 9319],
      scan: scanOf({ 9317: { kind: "old" }, 9318: { kind: "other" } }),
    });
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ port: 9317, pid: 0, project: "" });
  });

  test("a swept instance already listed by id is not duplicated", async () => {
    const i = info({ id: "dup", port: 9317 });
    registerInstance(dir, i);
    const list = await listLiveInstances(dir, {
      probe: never,
      scanPorts: [9318],
      scan: scanOf({ 9318: { kind: "self", info: { ...i, port: 9318 } } }),
    });
    expect(list.length).toBe(1);
  });
});

describe("probeInstance", () => {
  const serve = (handler: (url: URL) => Response) => {
    const srv = Bun.serve({ port: 0, fetch: (req) => handler(new URL(req.url)) });
    return { port: srv.port, stop: () => srv.stop(true) };
  };

  test("id match -> alive; mismatch -> dead (port reused by another run)", async () => {
    const s = serve((u) => u.pathname === "/api/self" ? Response.json({ id: "me" }) : new Response("nope", { status: 404 }));
    try {
      expect(await probeInstance(info({ port: s.port, id: "me" }))).toBe("alive");
      expect(await probeInstance(info({ port: s.port, id: "someone-else" }))).toBe("dead");
    } finally { s.stop(); }
  });

  test("404 -> alive (an older cctrace without /api/self)", async () => {
    const s = serve(() => new Response("Not found", { status: 404 }));
    try {
      expect(await probeInstance(info({ port: s.port }))).toBe("alive");
    } finally { s.stop(); }
  });

  test("a closed port is never alive (dead where it refuses, unknown where it hangs)", async () => {
    const s = serve(() => new Response("x"));
    const port = s.port;
    s.stop();
    // Plain hosts refuse instantly -> "dead". Containerized localhost is often
    // port-forwarded and hangs on closed ports -> timeout -> "unknown". Both
    // keep the entry out of the listing; abandonment GC handles the corpse.
    expect(await probeInstance(info({ port }))).not.toBe("alive");
  });

  test("a non-cctrace server squatting the port -> dead", async () => {
    const s = serve(() => new Response("<html>hello</html>"));
    try {
      expect(await probeInstance(info({ port: s.port }))).toBe("dead");
    } finally { s.stop(); }
  });

  test("pre-0.10 entry without id accepts any cctrace answer", async () => {
    const s = serve((u) => u.pathname === "/api/self" ? Response.json({ id: "whoever" }) : new Response("", { status: 404 }));
    try {
      expect(await probeInstance(info({ port: s.port, id: undefined }))).toBe("alive");
    } finally { s.stop(); }
  });
});
