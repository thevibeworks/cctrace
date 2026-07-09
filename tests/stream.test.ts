import { describe, test, expect } from "bun:test";
import { captureTee } from "../src/stream";

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
  });
});
