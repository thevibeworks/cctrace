import { describe, test, expect, afterAll } from "bun:test";
import { createServer } from "../src/server";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  // 0.39.0: the root is a bookmark/hostname entry point (cctrace.localhost),
  // so it hands over the all-runs dashboard; the live trace moved to /trace.
  test("/ and /index.html redirect to /dashboard on the host the request arrived at", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await fetch(`${base}${path}`, { redirect: "manual" });
      expect(res.status).toBe(302);
      // Built from req.url, never a hardcoded localhost: behind a container
      // or host port forward the bound host:port is not the browser's.
      expect(res.headers.get("location")).toBe(`${base}/dashboard`);
    }
  });

  test("/trace serves the live page; unknown paths still 404", async () => {
    const res = await fetch(`${base}/trace`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="inst"');
    expect(html).toContain("const IS_SNAPSHOT");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("the page wires its WebSocket origin-relative — no baked port", async () => {
    const html = await (await fetch(`${base}/trace`)).text();
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

describe("dashboard", () => {
  test("/dashboard serves the central page; /api/runs lists tombstones with traceExists", async () => {
    const html = await (await fetch(`${base}/dashboard`)).text();
    expect(html).toContain("dashboard");
    expect(html).toContain("/api/runs");
    // this file's shared server has no dataDir: runs list is empty
    expect(await (await fetch(`${base}/api/runs`)).json()).toEqual([]);

    const dataDir = mkdtempSync(join(tmpdir(), "cctrace-dash-"));
    mkdirSync(join(dataDir, "instances"), { recursive: true });
    writeFileSync(join(dataDir, "instances", "t1.json"), JSON.stringify({
      id: "t1", pid: 1, port: 9999, project: "proj", projectPath: "/x/proj",
      logFile: join(dataDir, "trace-x.jsonl"), mode: "mitm",
      startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z",
      client: "codex", firstPrompt: "hello world",
    }));
    const s2 = createServer({ port: 0, logDir: ".cctrace-test-none", noHistory: true, dataDir });
    try {
      const runs = (await (await fetch(`http://127.0.0.1:${s2.port}/api/runs`)).json()) as any[];
      expect(runs.length).toBe(1);
      expect(runs[0].client).toBe("codex");
      expect(runs[0].traceExists).toBe(false); // path not on this host yet
      writeFileSync(join(dataDir, "trace-x.jsonl"), "");
      const runs2 = (await (await fetch(`http://127.0.0.1:${s2.port}/api/runs`)).json()) as any[];
      expect(runs2[0].traceExists).toBe(true);
      expect(runs2[0].traceBytes).toBe(0);
    } finally {
      s2.stop();
    }
  });

  // Sibling links must name the trace view: the root would redirect the
  // click straight back to a dashboard (this one, or the sibling's).
  test("live-instance rows link to the sibling's /trace, not its root", async () => {
    const html = await (await fetch(`${base}/dashboard`)).text();
    expect(html).toContain("Number(i.port) + '/trace'");
  });

  test("/view/<run-id> renders a past run's snapshot; unknown ids 404", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "cctrace-dashview-"));
    mkdirSync(join(dataDir, "instances"), { recursive: true });
    const trace = join(dataDir, "trace-y.jsonl");
    writeFileSync(trace, JSON.stringify(pair("vp1")) + "\n");
    writeFileSync(join(dataDir, "instances", "r1.json"), JSON.stringify({
      id: "r1", pid: 1, port: 9999, project: "proj", projectPath: "/x/proj",
      logFile: trace, mode: "mitm",
      startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z",
      pairs: 1, tokensIn: 10, tokensOut: 5,
    }));
    const s3 = createServer({ port: 0, logDir: ".cctrace-test-none", noHistory: true, dataDir });
    try {
      const res = await fetch(`http://127.0.0.1:${s3.port}/view/r1`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("cctrace");
      expect(html).toContain("vp1"); // the trace's pair made it into the snapshot
      expect((await fetch(`http://127.0.0.1:${s3.port}/view/nope`)).status).toBe(404);
      // a registry path that doesn't resolve on this host is a 404, not a crash
      writeFileSync(join(dataDir, "instances", "r2.json"), JSON.stringify({
        id: "r2", pid: 1, port: 9999, project: "p", projectPath: "/x/p",
        logFile: "/not/here.jsonl", mode: "mitm",
        startedAt: "2026-08-01T00:00:00.000Z", endedAt: "2026-08-01T01:00:00.000Z",
      }));
      expect((await fetch(`http://127.0.0.1:${s3.port}/view/r2`)).status).toBe(404);
    } finally {
      s3.stop();
    }
  });
});
