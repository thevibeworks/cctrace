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

  const finish = (complete: boolean) => {
    if (settled) return;
    settled = true;
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    settle({ text: new TextDecoder().decode(merged), complete });
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
          if (value) chunks.push(value);
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
