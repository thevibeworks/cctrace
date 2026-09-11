import { expect, test } from "bun:test";
import { classifyUpstreamError, createUpstream, UpstreamError, upstreamRoute } from "../src/upstream";

const target = "https://api.example.test/v1/messages";
const failure = (code: string) => Object.assign(new Error("private request data"), { code });

test("retries pre-connect failures with the same body and fresh connections", async () => {
  let time = 0;
  const sent: RequestInit[] = [];
  const logs: string[] = [];
  const body = new Uint8Array([0, 1, 255]);
  const upstream = createUpstream({ retryMs: 30000, now: () => time,
    sleep: async (ms) => { time += ms; }, report: (s) => logs.push(s),
    fetch: async (_url, init) => { sent.push(init); if (sent.length < 3) throw failure("ConnectionRefused"); return new Response("ok"); },
  });
  expect(await (await upstream.fetch(target, { method: "POST", body, redirect: "manual" }, true)).text()).toBe("ok");
  expect(sent).toHaveLength(3);
  expect(sent.every((s) => s.body === body)).toBe(true);
  expect(sent[1].keepalive).toBe(false);
  expect(time).toBe(3000);
  expect(logs).toHaveLength(2);
  expect(logs.join(" ")).not.toContain("private request data");
});

test.each(["UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", "ENETUNREACH", "ENOTFOUND"])("retries pre-send %s failures", async (code) => {
  let calls = 0;
  const upstream = createUpstream({ retryMs: 30000, sleep: async () => {}, report: () => {},
    fetch: async () => { calls++; if (calls < 2) throw failure(code); return new Response("ok"); } });
  expect((await upstream.fetch(target, { method: "POST", redirect: "manual" }, true)).status).toBe(200);
  expect(calls).toBe(2);
});

test.each(["ECONNRESET", "ETIMEDOUT", "EPIPE"])("does not replay ambiguous %s failures", async (code) => {
  let calls = 0;
  const upstream = createUpstream({ retryMs: 30000, report: () => {}, fetch: async () => { calls++; throw failure(code); } });
  await expect(upstream.fetch(target, { method: "POST", redirect: "manual" }, true)).rejects.toBeInstanceOf(UpstreamError);
  expect(calls).toBe(1);
});

test("HTTP responses, telemetry, redirects and disabled retries are never replayed", async () => {
  for (const [model, redirect, budget] of [[false, "manual", 30000], [true, "follow", 30000], [true, "manual", 0]] as const) {
    let calls = 0;
    const upstream = createUpstream({ retryMs: budget, report: () => {}, fetch: async () => { calls++; throw failure("ConnectionRefused"); } });
    await expect(upstream.fetch(target, { redirect }, model)).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toBe(1);
  }
  let calls = 0;
  const upstream = createUpstream({ retryMs: 30000, fetch: async () => { calls++; return new Response("proxy rejected CONNECT", { status: 502 }); } });
  expect((await upstream.fetch(target, { redirect: "manual" }, true)).status).toBe(502);
  expect(calls).toBe(1);
});

test("retry window includes failed dial time and never imposes a model response deadline", async () => {
  let time = 0, calls = 0;
  const upstream = createUpstream({ retryMs: 12000, now: () => time, sleep: async (ms) => { time += ms; }, report: () => {},
    fetch: async () => { calls++; time += 5000; throw failure("ConnectionRefused"); } });
  try { await upstream.fetch(target, { redirect: "manual" }, true); throw new Error("expected failure"); }
  catch (e) {
    expect(e).toBeInstanceOf(UpstreamError);
    expect((e as UpstreamError).detail.elapsedMs).toBe(11000);
    expect((e as UpstreamError).detail.attempts).toBe(2);
  }
  expect(calls).toBe(2);
  const slow = createUpstream({ retryMs: 1000, now: () => time, fetch: async () => { time += 3600000; return new Response("slow inference"); } });
  expect((await slow.fetch(target, { redirect: "manual" }, true)).status).toBe(200);
});

test("client cancellation interrupts retry backoff", async () => {
  let calls = 0;
  const ac = new AbortController();
  const upstream = createUpstream({ retryMs: 30000, report: () => {}, fetch: async () => { calls++; queueMicrotask(() => ac.abort()); throw failure("ConnectionRefused"); } });
  await expect(upstream.fetch(target, { redirect: "manual", signal: ac.signal }, true)).rejects.toBeInstanceOf(UpstreamError);
  expect(calls).toBe(1);
});

test("streaming disconnect behavior stays with the response pump", async () => {
  const ac = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const upstream = createUpstream({ fetch: async (_url, init) => { upstreamSignal = init.signal; return new Response("ok"); } });
  await upstream.fetch(target, { signal: ac.signal }, true);
  ac.abort();
  expect(upstreamSignal?.aborted).toBe(false);
});

test("native fetch recovers from a refused dial and delivers the POST exactly once", async () => {
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port!;
  reserve.stop(true);
  let server: ReturnType<typeof Bun.serve> | undefined;
  const received: string[] = [];
  const upstream = createUpstream({ retryMs: 30000, report: () => {},
    sleep: async () => {
      server = Bun.serve({ port, async fetch(req) { received.push(await req.text()); return new Response("ok"); } });
    },
  });
  try {
    const result = await upstream.fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", body: "synthetic request", redirect: "manual",
    }, true);
    expect(await result.text()).toBe("ok");
    expect(received).toEqual(["synthetic request"]);
  } finally { server?.stop(true); }
});

test("diagnostics identify the layer without persisting exception secrets", () => {
  const detail = classifyUpstreamError(failure("ECONNRESET"));
  expect(detail.kind).toBe("reset");
  expect(detail.message).toContain("delivery state is unknown");
  expect(detail.message).not.toContain("private");
  expect(upstreamRoute(target, { HTTPS_PROXY: "http://user:secret@proxy.example:7890/private?token=secret" })).toBe("http://proxy.example:7890");
  expect(upstreamRoute(target, { HTTPS_PROXY: "http://proxy.example:7890", NO_PROXY: "api.example.test" })).toBe("direct");
});

test("a throwing recorder or diagnostic sink cannot fail forwarding", () => {
  const logs: string[] = [];
  const upstream = createUpstream({ report: (line) => { logs.push(line); throw new Error("logger failed"); } });
  expect(() => upstream.record(() => { throw new Error("disk full"); })).not.toThrow();
  upstream.record(() => { throw new Error("disk full"); });
  upstream.record(() => {});
  expect(logs).toHaveLength(2);
  expect(logs[0]).toContain("capture gap");
  expect(logs[1]).toContain("resumed");
});
