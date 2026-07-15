import { gunzipSync, inflateSync, brotliDecompressSync } from "zlib";

/**
 * Fork a response body into (a) a stream forwarded to the client and (b) an
 * in-memory capture — without ReadableStream.tee().
 *
 * tee() was abandoned deliberately: when a proxied connection is cancelled
 * mid-stream (client abort, socket timeout), Bun's native tee internals can
 * throw "TypeError: null is not an object" from a builtin — an uncatchable
 * process-fatal crash that takes the proxy (and the Claude session behind it)
 * down. tee() also buffers unboundedly when one branch is slower.
 *
 * This pump keeps every controller call behind a guard so a dead client can
 * never throw into native code, and reads upstream only as fast as the client
 * consumes (real backpressure). Semantics:
 * - Client cancel/disconnect: the remainder is still drained into the capture,
 *   so an aborted request logs its complete response.
 * - Upstream error: the client stream errors; `captured` resolves with what
 *   arrived so far (complete: false). The promise never rejects.
 */
export interface CapturedBody {
  text: string;
  complete: boolean;
  /** Epoch ms when the first body chunk arrived. Absent for empty bodies. */
  firstByteAt?: number;
  /** Epoch ms when the first streamed token event arrived (model calls). */
  firstTokenAt?: number;
}

/**
 * True when streamed body text contains a "token" event — the model actually
 * producing output, as opposed to stream setup (message_start,
 * response.created, ping). Covers the wire shapes cctrace proxies:
 * Anthropic SSE (content_block_delta), OpenAI Responses (response.*.delta),
 * and chat completions chunks. Must be detected live in the pump — SSE
 * events carry no timestamps, so this cannot be derived from a saved trace.
 */
export function isTokenChunk(text: string): boolean {
  return /content_block_delta|response\.[a-z_.]+delta|"chat\.completion\.chunk"/.test(text);
}

/**
 * Decode a captured request body for the trace: undo the declared
 * content-encoding (codex zstd-compresses its request JSON), then parse.
 * The bytes forwarded upstream must always be the raw ones — a lossy UTF-8
 * round trip of compressed data corrupts it irreversibly (observed as
 * chatgpt.com 400s). Binary that survives no decode is summarized, never
 * mangled into replacement characters.
 */
export function decodeBodyForTrace(bytes: Uint8Array, encoding?: string): unknown {
  let buf: Uint8Array = bytes;
  try {
    if (encoding === "zstd") buf = Bun.zstdDecompressSync(bytes);
    else if (encoding === "gzip") buf = gunzipSync(bytes);
    else if (encoding === "deflate") buf = inflateSync(bytes);
    else if (encoding === "br") buf = brotliDecompressSync(bytes);
  } catch {
    buf = bytes; // mis-declared encoding — try the raw bytes below
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return `<binary body: ${bytes.length} bytes${encoding ? `, content-encoding: ${encoding}` : ""}>`;
  }
  try { return JSON.parse(text); } catch { return text; }
}

export function captureTee(source: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  captured: Promise<CapturedBody>;
} {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let settle: (r: CapturedBody) => void;
  const captured = new Promise<CapturedBody>((res) => { settle = res; });
  let settled = false;
  let draining = false;

  // First-byte / first-token timing. Chunks are scanned only until the first
  // token event is seen, with a small carry so a marker split across chunk
  // boundaries still matches; after that the scan is a no-op.
  let firstByteAt: number | undefined;
  let firstTokenAt: number | undefined;
  const scanDecoder = new TextDecoder(); // non-fatal: binary yields no marker
  let scanCarry = "";
  const sawChunk = (chunk: Uint8Array) => {
    if (firstByteAt === undefined) firstByteAt = Date.now();
    if (firstTokenAt !== undefined) return;
    const text = scanCarry + scanDecoder.decode(chunk, { stream: true });
    if (isTokenChunk(text)) firstTokenAt = Date.now();
    else scanCarry = text.slice(-40);
  };

  const finish = (complete: boolean) => {
    if (settled) return;
    settled = true;
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    settle({ text: new TextDecoder().decode(merged), complete, firstByteAt, firstTokenAt });
  };

  // The client is gone — finish reading upstream for the capture alone.
  const drainRest = () => {
    if (draining || settled) return;
    draining = true;
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) { chunks.push(value); sawChunk(value); }
        }
        finish(true);
      } catch {
        finish(false);
      }
    })();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await reader.read();
        if (r.done) {
          finish(true);
          try { controller.close(); } catch {}
          return;
        }
        chunks.push(r.value);
        sawChunk(r.value);
        try {
          controller.enqueue(r.value);
        } catch {
          drainRest();
        }
      } catch (err) {
        finish(false);
        try { controller.error(err); } catch {}
      }
    },
    cancel() {
      drainRest();
    },
  });

  return { stream, captured };
}
