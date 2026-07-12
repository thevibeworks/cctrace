import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { registerInstance, listInstances, instancesDir, pidAlive, type InstanceInfo } from "../src/instances";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cctrace-inst-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const info = (over: Partial<InstanceInfo> = {}): InstanceInfo => ({
  pid: process.pid,
  port: 9317,
  project: "myproj",
  projectPath: "/w/myproj",
  logFile: ".cctrace/trace-x.jsonl",
  mode: "mitm",
  startedAt: new Date().toISOString(),
  ...over,
});

describe("pidAlive", () => {
  test("own pid is alive; an absurd pid is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});

describe("register / list / update / unregister", () => {
  test("a registered instance shows up in the list", () => {
    registerInstance(dir, info());
    const list = listInstances(dir);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ pid: process.pid, port: 9317, project: "myproj" });
  });

  test("update merges fields (session id learned later)", () => {
    const h = registerInstance(dir, info());
    h.update({ sessionId: "abc-123" });
    expect(listInstances(dir)[0].sessionId).toBe("abc-123");
    expect(listInstances(dir)[0].project).toBe("myproj"); // untouched fields survive
  });

  test("unregister removes the entry", () => {
    const h = registerInstance(dir, info());
    h.unregister();
    expect(listInstances(dir)).toEqual([]);
    h.unregister(); // idempotent
  });

  test("list sorts oldest-first by startedAt", () => {
    registerInstance(dir, info({ pid: process.pid, startedAt: "2026-07-11T02:00:00Z" }));
    // Second live entry needs a distinct pid that is alive: use ppid.
    const parent = process.ppid;
    if (parent && pidAlive(parent)) {
      registerInstance(dir, info({ pid: parent, startedAt: "2026-07-11T01:00:00Z" }));
      expect(listInstances(dir).map((i) => i.pid)).toEqual([parent, process.pid]);
    }
  });
});

describe("stale entries self-heal", () => {
  test("dead-pid entries are dropped and their files deleted", () => {
    registerInstance(dir, info({ pid: 2 ** 30 }));
    const file = join(instancesDir(dir), `${2 ** 30}.json`);
    expect(existsSync(file)).toBe(true);
    expect(listInstances(dir)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test("unparseable files are dropped", () => {
    registerInstance(dir, info()); // valid one
    writeFileSync(join(instancesDir(dir), "999.json"), "not json{");
    const list = listInstances(dir);
    expect(list.length).toBe(1);
    expect(existsSync(join(instancesDir(dir), "999.json"))).toBe(false);
  });

  test("registry file is human-readable JSON", () => {
    registerInstance(dir, info());
    const raw = readFileSync(join(instancesDir(dir), `${process.pid}.json`), "utf8");
    expect(JSON.parse(raw).project).toBe("myproj");
  });

  test("empty/missing dir lists nothing", () => {
    expect(listInstances(join(dir, "nope"))).toEqual([]);
  });
});
