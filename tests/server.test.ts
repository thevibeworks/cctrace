import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../src/server";
import type { TracePair } from "../src/types";

// The live server's ingestion surface. Regression territory (containers
// sharing $HOME + forwarded localhost ports, see instances.ts): the page
// must never bake an absolute ws URL — a forwarded port number means a
// different server on the host than in the namespace that bound it — and
// /api/pair must reject injection that can't prove it's this run's capture.

const pair = (id: string): TracePair => ({
  id,
  request: { timestamp: 1, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {}, body: {} },
  response: { timestamp: 2, status: 200, headers: {} },
  duration: 1,
  loggedAt: "2026-01-01T00:00:00.000Z",
});

// One server for the file: server.ts holds pairs at module level.
const INSTANCE_ID = "test-instance-0000";
const server = createServer({ port: 0, logDir: ".cctrace-test-none", noHistory: true, instanceId: INSTANCE_ID });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop());

describe("live server ingestion", () => {
  test("the page wires its WebSocket origin-relative — no baked port", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("location.host");
    expect(html).not.toContain("ws://localhost:");
  });

  test("/api/pair rejects a post without this run's instance id", async () => {
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pair("intruder")),
    });
    expect(res.status).toBe(403);
    const listed = (await (await fetch(`${base}/api/pairs`)).json()) as TracePair[];
    expect(listed.some((p) => p.id === "intruder")).toBe(false);
  });

  test("/api/pair accepts the authenticated child-process post (legacy node mode)", async () => {
    const res = await fetch(`${base}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cctrace-instance": INSTANCE_ID },
      body: JSON.stringify(pair("child-post")),
    });
    expect(res.status).toBe(200);
    const listed = (await (await fetch(`${base}/api/pairs`)).json()) as TracePair[];
    expect(listed.some((p) => p.id === "child-post")).toBe(true);
  });

  test("in-process ingest lands without any HTTP hop", async () => {
    server.ingest(pair("in-process"));
    const listed = (await (await fetch(`${base}/api/pairs`)).json()) as TracePair[];
    expect(listed.some((p) => p.id === "in-process")).toBe(true);
  });
});
