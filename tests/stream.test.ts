import { describe, test, expect } from "bun:test";
import { gzipSync } from "zlib";
import { captureTee, decodeBodyForTrace, isTokenChunk } from "../src/stream";

// Regression territory: ReadableStream.tee() crashed the whole process
// ("TypeError: null is not an object" in Bun's stream builtins) when the
// client branch was cancelled mid-stream — e.g. a /compact connection dying.
// captureTee must survive every disconnect order and still capture the body.

const enc = new TextEncoder();

function sourceOf(chunks: string[], opts?: { failAfter?: number }): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts?.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error("upstream died"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const dec = new TextDecoder();
  for await (const chunk of stream) out += dec.decode(chunk, { stream: true });
  return out;
}

describe("captureTee", () => {
  test("client reads everything: identical bytes, complete capture", async () => {
    const { stream, captured } = captureTee(sourceOf(["event: a\n\n", "event: b\n\n"]));
    expect(await readAll(stream)).toBe("event: a\n\nevent: b\n\n");
    const cap = await captured;
    expect(cap.text).toBe("event: a\n\nevent: b\n\n");
    expect(cap.complete).toBe(true);
  });

  test("client cancels mid-stream: capture still completes with the full body", async () => {
    const { stream, captured } = captureTee(sourceOf(["one", "two", "three"]));
    const reader = stream.getReader();
    await reader.read(); // consume "one"
    await reader.cancel(); // client walks away
    const cap = await captured;
    expect(cap.text).toBe("onetwothree");
    expect(cap.complete).toBe(true);
  });

  test("client cancels before reading anything: capture still completes", async () => {
    const { stream, captured } = captureTee(sourceOf(["only"]));
    await stream.cancel();
    const cap = await captured;
    expect(cap.text).toBe("only");
    expect(cap.complete).toBe(true);
  });

  test("upstream errors mid-stream: client errors, capture keeps the partial body", async () => {
    const { stream, captured } = captureTee(sourceOf(["got-this", "never-sent"], { failAfter: 1 }));
    const reader = stream.getReader();
    await reader.read(); // "got-this"
    expect(reader.read()).rejects.toThrow("upstream died");
    const cap = await captured;
    expect(cap.text).toBe("got-this");
    expect(cap.complete).toBe(false);
  });

  test("empty body resolves complete with empty text", async () => {
    const { stream, captured } = captureTee(sourceOf([]));
    expect(await readAll(stream)).toBe("");
    const cap = await captured;
    expect(cap.text).toBe("");
    expect(cap.complete).toBe(true);
    expect(cap.firstByteAt).toBeUndefined();
    expect(cap.firstTokenAt).toBeUndefined();
  });

  // First-token timing must be measured in the pump — SSE events carry no
  // timestamps, so it can never be recovered from a saved trace.
  test("records firstByteAt and firstTokenAt for a token stream", async () => {
    const before = Date.now();
    const { stream, captured } = captureTee(sourceOf([
      'data: {"type":"message_start","message":{}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    ]));
    await readAll(stream);
    const cap = await captured;
    expect(cap.firstByteAt).toBeGreaterThanOrEqual(before);
    expect(cap.firstTokenAt).toBeGreaterThanOrEqual(cap.firstByteAt!);
  });

  test("no token event: firstByteAt set, firstTokenAt absent", async () => {
    const { stream, captured } = captureTee(sourceOf(['{"ok":true,"type":"message_delta"}']));
    await readAll(stream);
    const cap = await captured;
    expect(cap.firstByteAt).toBeGreaterThan(0);
    expect(cap.firstTokenAt).toBeUndefined();
  });

  test("token marker split across chunk boundary still detected", async () => {
    const { stream, captured } = captureTee(sourceOf([
      'data: {"type":"content_bl',
      'ock_delta","index":0}\n\n',
    ]));
    await readAll(stream);
    expect((await captured).firstTokenAt).toBeGreaterThan(0);
  });

  test("client cancels early: timing still captured on the drain path", async () => {
    const { stream, captured } = captureTee(sourceOf([
      "event: ping\n\n",
      'data: {"type":"content_block_delta"}\n\n',
    ]));
    await stream.cancel();
    const cap = await captured;
    expect(cap.firstByteAt).toBeGreaterThan(0);
    expect(cap.firstTokenAt).toBeGreaterThan(0);
  });
});

// The "model started producing output" markers, per proxied wire shape.
// Stream-setup events (message_start, response.created, ping) and the final
// anthropic message_delta must NOT count as tokens.
describe("isTokenChunk", () => {
  test("anthropic content_block_delta matches", () => {
    expect(isTokenChunk('data: {"type":"content_block_delta","index":0}')).toBe(true);
  });
  test("anthropic setup/final events do not match", () => {
    expect(isTokenChunk('data: {"type":"message_start","message":{}}')).toBe(false);
    expect(isTokenChunk('data: {"type":"message_delta","usage":{}}')).toBe(false);
    expect(isTokenChunk("event: ping\n\n")).toBe(false);
  });
  test("openai responses deltas match, setup events do not", () => {
    expect(isTokenChunk("event: response.output_text.delta")).toBe(true);
    expect(isTokenChunk('{"type":"response.reasoning_summary_text.delta"}')).toBe(true);
    expect(isTokenChunk('{"type":"response.created"}')).toBe(false);
  });
  test("chat completion chunks match", () => {
    expect(isTokenChunk('data: {"object":"chat.completion.chunk","choices":[]}')).toBe(true);
  });
});

// Codex zstd-compresses its request JSON. The old text decode of the body
// corrupted the bytes both on the wire (upstream 400s) and in the trace —
// the trace-side decode must undo declared encodings and never mangle
// binary into replacement characters.
describe("decodeBodyForTrace", () => {
  const body = { model: "gpt-5", input: [{ role: "user", content: "hi" }] };
  const raw = enc.encode(JSON.stringify(body));

  test("zstd request body decodes to its JSON", () => {
    expect(decodeBodyForTrace(new Uint8Array(Bun.zstdCompressSync(raw)), "zstd")).toEqual(body);
  });

  test("gzip request body decodes to its JSON", () => {
    expect(decodeBodyForTrace(new Uint8Array(gzipSync(raw)), "gzip")).toEqual(body);
  });

  test("plain JSON and plain text pass through", () => {
    expect(decodeBodyForTrace(raw)).toEqual(body);
    expect(decodeBodyForTrace(enc.encode("hello"))).toBe("hello");
  });

  test("undecodable binary is summarized, never mangled", () => {
    // Declared zstd but truncated: decompress fails, raw bytes aren't UTF-8.
    const junk = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff]);
    const out = decodeBodyForTrace(junk, "zstd");
    expect(typeof out).toBe("string");
    expect(out as string).toContain("binary body");
    expect(out as string).not.toContain("�");
  });
});
