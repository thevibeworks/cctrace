import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLiveBodies } from "../src/live-bodies";
import { createTraceLog } from "../src/trace-log";
import { createServer } from "../src/server";
import { buildSession } from "../src/session";
import { extractCallInfo } from "../src/summarize";
import { contextComposition } from "../src/context";
import { wireTables } from "../src/clients";
import type { TracePair } from "../src/types";

const wire = wireTables();
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function logFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cctrace-retention-")); dirs.push(dir);
  const path = join(dir, "trace.jsonl"); writeFileSync(path, "");
  return { dir, path, log: createTraceLog(path) };
}
const messages: any[] = [{ role: "user", content: "Synthetic prompt" }];
function pair(i: number): TracePair {
  const history = [...messages];
  for (let n = 0; n < i; n++) history.push({ role: "assistant", content: `reply ${n}` }, { role: "user", content: `continue ${n}` });
  return { id: `synthetic-${i}`, client: "claude", request: {
    timestamp: i + 1, method: "POST", url: "https://api.anthropic.com/v1/messages", headers: {},
    body: { model: "claude-sonnet-4-6", stream: true, max_tokens: 2048,
      metadata: { user_id: JSON.stringify({ session_id: "synthetic-session" }) }, messages: history } },
    response: { timestamp: i + 2, status: 200, headers: {}, body: { type: "message", role: "assistant",
      content: [{ type: "text", text: `reply ${i}` }], usage: { input_tokens: 100, output_tokens: 10 } } },
    duration: 1000, loggedAt: "2026-01-01T00:00:00.000Z" };
}

test("folding releases repeated request bodies while preserving reconstruction, usage and disk bytes", async () => {
  const { path, log } = logFixture();
  const bodies = createLiveBodies(1024 * 1024, wire);
  const originals = Array.from({ length: 20 }, (_, i) => pair(i));
  const live = structuredClone(originals);
  for (const p of live) { log.append(p); bodies.add(p); }
  expect(live.slice(0, -1).every((p) => (p.request.body as any)._cctrace_stub)).toBe(true);
  expect((live.at(-1)!.request.body as any).messages).toHaveLength(39);
  expect(buildSession(live, wire)).toEqual(buildSession(originals, wire));
  expect(extractCallInfo(live[0])).toEqual(extractCallInfo(originals[0]));
  expect(readFileSync(path, "utf8")).toBe(originals.map((p) => JSON.stringify(p) + "\n").join(""));
  expect(await log.read(originals[0]!.id)).toEqual(originals[0]);
});

// The live fold stamps what the body was made of before dropping it: the
// Context view then reads an EXACT composition for a folded step instead of
// deriving one (src/context.ts contextComposition prefers the stamp).
test("a live fold stamps the composition of the body it drops", () => {
  const bodies = createLiveBodies(1024 * 1024, wire);
  const originals = Array.from({ length: 4 }, (_, i) => pair(i));
  const live = structuredClone(originals);
  for (const p of live) bodies.add(p);
  for (const [i, p] of live.entries()) {
    const stub = p.request.body as any;
    if (i === live.length - 1) { expect(stub._cctrace_stub).toBeUndefined(); continue; }
    expect(stub.composition).toEqual(contextComposition(structuredClone(originals[i]!)));
    expect((p as any)._ctxc).toBeUndefined(); // a page memo, never wire data
  }
});

test("retained request bytes stay within budget across separate threads and rewinds", () => {
  const bodies = createLiveBodies(8192, wire);
  const held: TracePair[] = [];
  for (let i = 0; i < 200; i++) {
    const p = pair(i % 3); p.id = `budget-${i}`;
    p.request.headers["x-claude-code-agent-id"] = `agent-${i % 4}`;
    (p.request.body as any).system = "x".repeat(4096);
    held.push(p); bodies.add(p);
    expect(bodies.retainedBytes()).toBeLessThanOrEqual(8192);
  }
  expect(held.filter((p) => !(p.request.body as any)._cctrace_stub).length).toBeLessThan(3);
  expect(held.every((p) => p.response?.body)).toBe(true);
});

test("a rewind and a late completion never supersede the wrong history", () => {
  const bodies = createLiveBodies(Infinity, wire);
  const long = pair(3), rewind = pair(1), late = pair(0);
  rewind.request.timestamp = 10;
  bodies.add(long); bodies.add(rewind); bodies.add(late);
  // the rewound branch and the longer packing before it both keep their
  // bodies — neither history is contained in the other
  expect((long.request.body as any).messages).toBeDefined();
  expect((rewind.request.body as any).messages).toBeDefined();
  // the late arrival IS inside the newer packing, so it folds against it
  // rather than waiting for the budget to drop it with no keeper
  expect((late.request.body as any).keptPairId).toBe(rewind.id);
});

test("a body that arrives out of order folds against the request that already re-sent it", () => {
  const bodies = createLiveBodies(Infinity, wire);
  const newest = pair(4), older = pair(2);
  // newest-file-first is exactly how the prior-session preload reads
  bodies.add(newest);
  const changed = bodies.add(older);
  expect(changed.map((p) => p.id)).toEqual([older.id]);
  expect((older.request.body as any).kind).toBe("superseded");
  expect((older.request.body as any).keptPairId).toBe(newest.id);
  expect((newest.request.body as any).messages).toBeDefined();
  // and the same pair handed over twice is not taken twice
  expect(bodies.add(newest)).toEqual([]);
  const held = bodies.retainedBytes();
  expect(bodies.add(structuredClone(newest))).toEqual([]);
  expect(bodies.retainedBytes()).toBe(held);
});

test("offsets verify identity after a trace rewrite", async () => {
  const { path, log } = logFixture();
  log.append(pair(0)); log.append(pair(1));
  writeFileSync(path, JSON.stringify(pair(1)) + "\n");
  expect(await log.read("synthetic-0")).toBeNull();
  expect(await log.read("synthetic-1")).toBeNull();
});

test("live folding updates connected pages, survives reconnect, and exports full bodies", async () => {
  const { dir, path, log } = logFixture();
  const server = createServer({ port: 0, logDir: dir, logFile: path, noHistory: true,
    liveBodies: "folded", readPair: log.read });
  const base = `http://127.0.0.1:${server.port}`;
  const frames: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100; i++) { if (fn()) return; await Bun.sleep(5); }
    throw new Error("missing websocket event");
  };
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  try {
    await waitFor(() => frames.length > 0);
    for (const original of [pair(0), pair(1)]) { log.append(original); server.ingest(original); }
    await waitFor(() => frames.some((f) => f.type === "fold"));
    expect(frames.find((f) => f.type === "fold").requests[0].id).toBe("synthetic-0");
    const retained = await (await fetch(`${base}/api/pairs`)).json() as any[];
    expect(retained[0].request.body._cctrace_stub).toBe(1);
    const original = await (await fetch(`${base}/api/pair/synthetic-0`)).json();
    expect(original).toEqual(pair(0));
    const exported = await (await fetch(`${base}/api/session.jsonl?sid=synthetic-session`)).text();
    expect(exported.trim().split("\n").map((line) => JSON.parse(line))).toEqual([pair(0), pair(1)]);
    const reconnect = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    try {
      // A connect now opens with the tiny "loading" frame; init follows.
      const init = await new Promise<any>((resolve) => {
        reconnect.onmessage = (event) => {
          const m = JSON.parse(String(event.data));
          if (m.type === "init") resolve(m);
        };
      });
      expect(init.pairs[0].request.body._cctrace_stub).toBe(1);
    } finally { reconnect.close(); }
    rmSync(path);
    expect((await fetch(`${base}/api/pair/synthetic-0`)).status).toBe(404);
  } finally { ws.close(); server.stop(); }
});

// Cross-run continuity through the fold: the preload used to hand back the
// whole parsed tail and fold afterwards. It folds as it reads now, so what
// reaches the page is the folded history, keeper links and all.
test("a prior-session preload arrives folded, linked and composed", async () => {
  const { dir, path, log } = logFixture();
  writeFileSync(join(dir, "trace-prior.jsonl"), [0, 1, 2, 3].map((i) => JSON.stringify(pair(i))).join("\n") + "\n");
  const server = createServer({ port: 0, logDir: dir, logFile: path, liveBodies: "folded", readPair: log.read });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: any[] = [];
  ws.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  try {
    for (let i = 0; i < 100 && !frames.length; i++) await Bun.sleep(5);
    const live = pair(9);
    log.append(live);
    server.ingest(live);
    for (let i = 0; i < 200 && !frames.some((f) => f.type === "history"); i++) await Bun.sleep(5);
    const history = frames.find((f) => f.type === "history");
    expect(history.pairs).toHaveLength(4);
    for (const p of history.pairs) {
      const body = p.request.body;
      expect(body._cctrace_stub).toBe(1);
      expect(body.kind).toBe("superseded");
      expect(body.keptPairId).toBeTruthy();
      expect(body.composition.est).toBeGreaterThan(0);
      expect(p._ctxc).toBeUndefined();
    }
    // the live request that superseded them keeps its body
    const held = await (await fetch(`http://127.0.0.1:${server.port}/api/pairs`)).json() as any[];
    expect(held.find((p) => p.id === live.id).request.body.messages).toBeDefined();
  } finally { ws.close(); server.stop(); }
});

test("full live mode retains every body and server state is isolated per instance", async () => {
  const { dir } = logFixture();
  const full = createServer({ port: 0, logDir: dir, noHistory: true, liveBodies: "full" });
  const other = createServer({ port: 0, logDir: dir, noHistory: true });
  try {
    full.ingest(pair(0)); full.ingest(pair(1));
    const list = await (await fetch(`http://127.0.0.1:${full.port}/api/pairs`)).json() as any[];
    expect(list.every((p) => p.request.body.messages)).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${other.port}/api/pairs`)).json()).toEqual([]);
  } finally { full.stop(); other.stop(); }
});
