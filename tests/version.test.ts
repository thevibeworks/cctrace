import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CCTRACE_VERSION,
  isNewer,
  readUpdateCache,
  writeUpdateCache,
  refreshUpdateCache,
  availableUpdate,
  UPDATE_CHECK_TTL_MS,
} from "../src/version";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cctrace-ver-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const okFetch = (version: string) =>
  (async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch;

describe("CCTRACE_VERSION", () => {
  test("matches package.json", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(CCTRACE_VERSION).toBe(pkg.version);
  });
});

describe("isNewer", () => {
  test("compares numeric dot-parts", () => {
    expect(isNewer("0.9.0", "0.8.0")).toBe(true);
    expect(isNewer("0.8.1", "0.8.0")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.8.0", "0.8.0")).toBe(false);
    expect(isNewer("0.7.9", "0.8.0")).toBe(false);
  });

  test("tolerates v-prefix, prerelease tags, and short versions", () => {
    expect(isNewer("v0.9.0", "0.8.0")).toBe(true);
    expect(isNewer("0.9.0-beta.1", "0.8.0")).toBe(true);
    expect(isNewer("0.9", "0.8.5")).toBe(true);
    expect(isNewer("garbage", "0.8.0")).toBe(false);
  });
});

describe("update cache", () => {
  test("round-trips and rejects junk", () => {
    expect(readUpdateCache(dir)).toBeNull();
    writeUpdateCache(dir, { latest: "0.9.0", checkedAt: "2026-07-12T00:00:00Z", snoozed: "0.9.0" });
    expect(readUpdateCache(dir)).toEqual({ latest: "0.9.0", checkedAt: "2026-07-12T00:00:00Z", snoozed: "0.9.0" });
    expect(readUpdateCache(join(dir, "nope"))).toBeNull();
  });

  test("availableUpdate: newer -> version, same/older/none -> null", () => {
    expect(availableUpdate(null)).toBeNull();
    expect(availableUpdate({ latest: "99.0.0", checkedAt: "x" }, "0.8.0")).toBe("99.0.0");
    expect(availableUpdate({ latest: "0.8.0", checkedAt: "x" }, "0.8.0")).toBeNull();
  });
});

describe("refreshUpdateCache", () => {
  const now = new Date("2026-07-12T12:00:00Z");

  test("fresh cache short-circuits without touching the network", async () => {
    writeUpdateCache(dir, { latest: "0.9.0", checkedAt: now.toISOString() });
    const explode = (async () => { throw new Error("no network expected"); }) as unknown as typeof fetch;
    const c = await refreshUpdateCache(dir, new Date(now.getTime() + UPDATE_CHECK_TTL_MS - 1000), explode);
    expect(c?.latest).toBe("0.9.0");
  });

  test("stale cache refreshes from the registry and persists", async () => {
    writeUpdateCache(dir, { latest: "0.8.5", checkedAt: "2026-01-01T00:00:00Z", snoozed: "0.8.5" });
    const c = await refreshUpdateCache(dir, now, okFetch("0.9.1"));
    expect(c?.latest).toBe("0.9.1");
    expect(c?.snoozed).toBe("0.8.5"); // snooze survives a refresh
    expect(JSON.parse(readFileSync(join(dir, "update-check.json"), "utf8")).latest).toBe("0.9.1");
  });

  test("first run populates the cache", async () => {
    const c = await refreshUpdateCache(dir, now, okFetch("0.9.0"));
    expect(c?.latest).toBe("0.9.0");
    expect(existsSync(join(dir, "update-check.json"))).toBe(true);
  });

  test("network failure keeps the previous cache and never throws", async () => {
    writeUpdateCache(dir, { latest: "0.8.5", checkedAt: "2026-01-01T00:00:00Z" });
    const boom = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await refreshUpdateCache(dir, now, boom))?.latest).toBe("0.8.5");
    const bad = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    expect((await refreshUpdateCache(dir, now, bad))?.latest).toBe("0.8.5");
    const http500 = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect((await refreshUpdateCache(dir, now, http500))?.latest).toBe("0.8.5");
  });
});
