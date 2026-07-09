import { describe, test, expect, afterEach } from "bun:test";
import { startProxy } from "../src/proxy";
import { isNativeBinary } from "../src/detect";
import type { TracePair } from "../src/types";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

let servers: Array<{ stop: () => void }> = [];

function track<T extends { stop: () => void }>(s: T): T {
  servers.push(s);
  return s;
}

afterEach(() => {
  for (const s of servers) { try { s.stop(); } catch {} }
  servers = [];
});

describe("proxy: JSON forwarding", () => {
  test("forwards request and captures pair", async () => {
    const upstream = track(Bun.serve({
      port: 0,
      fetch(req) {
        return Response.json({
          id: "msg_test",
          type: "message",
          content: [{ type: "text", text: "hello from upstream" }],
        });
      },
    }));

    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
    }));

    const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-1234567890abcdef" },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("msg_test");

    await Bun.sleep(50);

    expect(pairs.length).toBe(1);
    expect(pairs[0].request.method).toBe("POST");
    expect(pairs[0].request.url).toContain("/v1/messages");
    expect(pairs[0].response?.status).toBe(200);
    expect(pairs[0].response?.body).toBeTruthy();
    expect((pairs[0].response?.body as any).id).toBe("msg_test");
    expect(pairs[0].duration).toBeGreaterThan(0);
  });

  test("redacts authorization header", async () => {
    const upstream = track(Bun.serve({
      port: 0,
      fetch() { return Response.json({ ok: true }); },
    }));

    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
    }));

    await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-api03-very-long-secret-key-here",
      },
      body: "{}",
    });

    await Bun.sleep(50);
    expect(pairs.length).toBe(1);

    const apiKeyHeader = pairs[0].request.headers["x-api-key"];
    expect(apiKeyHeader).not.toContain("very-long-secret");
    expect(apiKeyHeader).toContain("...");
  });
});

describe("proxy: SSE streaming", () => {
  test("streams SSE chunks without buffering", async () => {
    const ssePayload = [
      "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hello\"}}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\" world\"}}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];

    const upstream = track(Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            for (const chunk of ssePayload) {
              controller.enqueue(new TextEncoder().encode(chunk));
              await Bun.sleep(10);
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      },
    }));

    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
    }));

    const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const receivedChunks: string[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedChunks.push(decoder.decode(value));
    }

    const fullText = receivedChunks.join("");
    expect(fullText).toContain("message_start");
    expect(fullText).toContain("Hello");
    expect(fullText).toContain(" world");
    expect(fullText).toContain("message_stop");

    await Bun.sleep(50);
    expect(pairs.length).toBe(1);
    expect(pairs[0].response?.bodyRaw).toContain("Hello");
    expect(pairs[0].response?.bodyRaw).toContain(" world");
  });

  test("client receives first chunk before stream ends", async () => {
    let streamClosed = false;

    const upstream = track(Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("event: start\ndata: {}\n\n"));
            await Bun.sleep(200);
            controller.enqueue(new TextEncoder().encode("event: end\ndata: {}\n\n"));
            controller.close();
            streamClosed = true;
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    }));

    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: () => {},
    }));

    const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const firstChunk = new TextDecoder().decode(value);

    expect(firstChunk).toContain("event: start");
    expect(streamClosed).toBe(false);

    reader.cancel();
  });

  // Regression: a client aborting mid-SSE (dropped /compact connection) used
  // to cancel one branch of ReadableStream.tee() and crash the whole process
  // in Bun's stream builtins ("TypeError: null is not an object"). The proxy
  // must survive, log the complete pair anyway, and keep serving.
  test("client abort mid-stream: proxy survives and captures the full body", async () => {
    const upstream = track(Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("event: a\ndata: {}\n\n"));
            await Bun.sleep(30);
            controller.enqueue(new TextEncoder().encode("event: b\ndata: {}\n\n"));
            await Bun.sleep(30);
            controller.enqueue(new TextEncoder().encode("event: c\ndata: {}\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      },
    }));

    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
    }));

    const ac = new AbortController();
    const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read(); // first event arrives...
    ac.abort(); // ...then the client walks away mid-stream

    await proxy.flush();
    expect(pairs.length).toBe(1);
    expect(pairs[0].response?.bodyRaw).toContain("event: a");
    expect(pairs[0].response?.bodyRaw).toContain("event: c");

    // and the proxy still serves the next request
    const again = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(again.status).toBe(200);
    await again.text();
  });
});

describe("proxy: error handling", () => {
  test("returns error when upstream unreachable", async () => {
    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: "localhost:1",
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
    }));

    const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.ok).toBe(false);

    await Bun.sleep(50);
    expect(pairs.length).toBe(1);
  });

  test("non-message paths skipped when logAll=false", async () => {
    const upstream = track(Bun.serve({
      port: 0,
      fetch() { return Response.json({ ok: true }); },
    }));

    const pairs: TracePair[] = [];
    const proxy = track(startProxy({
      targetHost: `localhost:${upstream.port}`,
      targetScheme: "http",
      onPair: (p) => pairs.push(p),
      logAll: false,
    }));

    await fetch(`http://localhost:${proxy.port}/v1/models`, {
      method: "GET",
    });

    await Bun.sleep(50);
    expect(pairs.length).toBe(0);

    await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    await Bun.sleep(50);
    expect(pairs.length).toBe(1);
  });
});

describe("binary detection", () => {
  const tmpDir = join(import.meta.dir, "..", ".cache");

  test("detects ELF binary", () => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "test-elf");
    writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]));
    expect(isNativeBinary(p)).toBe(true);
    unlinkSync(p);
  });

  test("detects Mach-O binary", () => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "test-macho");
    writeFileSync(p, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00, 0x00]));
    expect(isNativeBinary(p)).toBe(true);
    unlinkSync(p);
  });

  test("detects PE binary", () => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "test-pe");
    writeFileSync(p, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00]));
    expect(isNativeBinary(p)).toBe(true);
    unlinkSync(p);
  });

  test("rejects shell script", () => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "test-script");
    writeFileSync(p, "#!/bin/bash\nexec node something\n");
    expect(isNativeBinary(p)).toBe(false);
    unlinkSync(p);
  });

  test("rejects JavaScript file", () => {
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, "test-js");
    writeFileSync(p, "#!/usr/bin/env node\nconsole.log('hi');\n");
    expect(isNativeBinary(p)).toBe(false);
    unlinkSync(p);
  });

  test("returns false for nonexistent file", () => {
    expect(isNativeBinary("/nonexistent/path/to/binary")).toBe(false);
  });
});
