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
const purgeCalls: TracePair[][] = [];
const server = createServer({
  port: 0, logDir: ".cctrace-test-none", noHistory: true, instanceId: INSTANCE_ID,
  onPurge: (removed) => { purgeCalls.push(removed); return { files: ["trace-x.jsonl"], skippedFiles: [] }; },
});
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

  test("/api/purge removes named pairs from memory and hands them to onPurge", async () => {
    server.ingest(pair("purge-me"));
    server.ingest(pair("keep-me"));
    const res = await fetch(`${base}/api/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["purge-me", "not-here"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: number; files: string[] };
    expect(body.removed).toBe(1);
    expect(body.files).toEqual(["trace-x.jsonl"]);
    expect(purgeCalls.length).toBe(1);
    expect(purgeCalls[0]!.map((p) => p.id)).toEqual(["purge-me"]);
    const listed = (await (await fetch(`${base}/api/pairs`)).json()) as TracePair[];
    expect(listed.some((p) => p.id === "purge-me")).toBe(false);
    expect(listed.some((p) => p.id === "keep-me")).toBe(true);
  });

  test("/api/purge rejects an empty or malformed id list", async () => {
    for (const body of [JSON.stringify({}), JSON.stringify({ ids: [] }), JSON.stringify({ ids: [42] }), "not json"]) {
      const res = await fetch(`${base}/api/purge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("slice export", () => {
  const mk = (id: string, ts: number): TracePair => {
    const p = pair(id);
    p.request.timestamp = ts;
    return p;
  };

  test("/api/slice.html returns a downloadable snapshot holding exactly the window", async () => {
    for (const p of [mk("sl-a", 5000), mk("sl-b", 6000), mk("sl-c", 7000)]) {
      await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cctrace-instance": INSTANCE_ID },
        body: JSON.stringify(p),
      });
    }
    const res = await fetch(`${base}/api/slice.html?from=sl-a&to=sl-b`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const html = await res.text();
    expect(html).toContain("sl-a");
    expect(html).toContain("sl-b");
    expect(html).not.toContain("sl-c");
  });

  test("unknown slice pair ids 404 instead of exporting the wrong window", async () => {
    expect((await fetch(`${base}/api/slice.html?from=sl-a&to=nope`)).status).toBe(404);
  });
});

describe("web actions exports", () => {
  test("/api/snapshot.html downloads the whole page; /api/spec.json is the redacted catalog", async () => {
    const snap = await fetch(`${base}/api/snapshot.html`);
    expect(snap.status).toBe(200);
    expect(snap.headers.get("content-disposition")).toContain("attachment");
    expect(await snap.text()).toContain("__PAIRS__");
    const spec = await fetch(`${base}/api/spec.json`);
    expect(spec.status).toBe(200);
    const cat = await spec.json() as any;
    expect(cat.format).toContain("cctrace-wire-catalog");
    expect(JSON.stringify(cat)).not.toContain("Bearer");
    const md = await fetch(`${base}/api/spec.md`);
    expect((await md.text())).toContain("#");
  });
});

describe("web compact", () => {
  test("/api/compact plans by default and reports apply results", async () => {
    const plan = await (await fetch(`${base}/api/compact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json() as any;
    expect(plan.ok).toBe(true);
    expect(plan.applied).toBe(false);
    expect(typeof plan.savedBytes).toBe("number"); // empty test logDir: nothing to fold
    const res = await (await fetch(`${base}/api/compact`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"apply":true}' })).json() as any;
    expect(res.applied).toBe(true);
    expect(res.rewritten).toBe(0);
  });
});

describe("session dump", () => {
  const SID = "dddd4444-eeee-ffff-0000-111122223333";
  const msg = (id: string, ts: number): TracePair => ({
    id,
    request: {
      timestamp: ts, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
      body: {
        model: "claude-opus-4-6",
        metadata: { user_id: JSON.stringify({ session_id: SID }) },
        messages: [{ role: "user", content: "dump me " + id }],
      },
    },
    response: {
      timestamp: ts + 1, status: 200, headers: {},
      body: { model: "claude-opus-4-6", content: [{ type: "text", text: "reply " + id }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" },
    },
    duration: 1000,
    loggedAt: "2026-01-01T00:00:00.000Z",
  });

  test("/api/session.jsonl returns the session's pairs, stripped of viewer markers", async () => {
    server.ingest(msg("dump1", 100));
    const withPrior = msg("dump2", 200) as TracePair & { prior?: string };
    withPrior.prior = "trace-old.jsonl";
    server.ingest(withPrior);
    const res = await fetch(`${base}/api/session.jsonl?sid=${SID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`session-${SID.slice(0, 8)}.jsonl`);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((p) => p.id)).toEqual(["dump1", "dump2"]);
    expect(lines[1].prior).toBeUndefined();
  });

  test("/api/session.md renders the transcript", async () => {
    const res = await fetch(`${base}/api/session.md?sid=${SID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(`session-${SID.slice(0, 8)}.md`);
    const md = await res.text();
    expect(md).toContain("# session " + SID);
    expect(md).toContain("> dump me dump2");
    expect(md).toContain("reply dump2");
  });

  test("sid is required and must be known", async () => {
    expect((await fetch(`${base}/api/session.jsonl`)).status).toBe(400);
    expect((await fetch(`${base}/api/session.jsonl?sid=nope`)).status).toBe(404);
  });
});
