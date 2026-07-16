import { redactPair } from "./redact";
import { captureTee, decodeBodyForTrace } from "./stream";
import type { TracePair } from "./types";

export interface ProxyConfig {
  port?: number;
  targetHost?: string;
  targetScheme?: string;
  onPair: (pair: TracePair) => void;
  logAll?: boolean;
}

export interface ProxyServer {
  port: number;
  stop: () => void;
  flush: () => Promise<void>;
  pairCount: () => number;
}

export function startProxy(config: ProxyConfig): ProxyServer {
  let pairCount = 0;
  const scheme = config.targetScheme ?? "https";
  const targetHost = config.targetHost ?? "api.anthropic.com";
  const logAll = config.logAll ?? true;
  const pending = new Set<Promise<void>>();

  // Single redaction choke point — no pair reaches a sink unredacted.
  const onPair = (pair: TracePair) => config.onPair(redactPair(pair));

  const server = Bun.serve({
    port: config.port ?? 0,
    // Bun's 10s idleTimeout default kills long requests (/compact waits
    // longer than that for its first byte). 0 disables it.
    idleTimeout: 0,

    // A handler failure must degrade to one failed request, quietly — Bun's
    // default prints a multi-line error over Claude's TUI.
    error: (err) => new Response(`cctrace capture error: ${err.message}`, { status: 502 }),

    async fetch(req) {
      const url = new URL(req.url);
      const targetUrl = `${scheme}://${targetHost}${url.pathname}${url.search}`;
      const shouldLog = logAll || url.pathname.includes("/v1/messages");
      const startTime = Date.now();

      const reqHeaders: Record<string, string> = {};
      req.headers.forEach((v, k) => { reqHeaders[k] = v; });
      reqHeaders["host"] = targetHost;
      reqHeaders["accept-encoding"] = "identity";

      let reqBody: unknown = null;
      let fwdBody: Uint8Array | null = null;
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        // Raw bytes for the upstream, decoded copy for the trace — a text
        // round trip corrupts compressed request bodies (see mitm.ts).
        fwdBody = new Uint8Array(await req.arrayBuffer());
        reqBody = decodeBodyForTrace(fwdBody, reqHeaders["content-encoding"]);
      }
      const reqBytes = fwdBody && fwdBody.length ? { bodyBytes: fwdBody.length } : {};

      const fetchHeaders = { ...reqHeaders };
      delete fetchHeaders["content-length"];

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(targetUrl, {
          method: req.method,
          headers: fetchHeaders,
          body: fwdBody,
          redirect: "follow",
        });
      } catch (err) {
        if (shouldLog) {
          pairCount++;
          onPair({
            id: `${Date.now()}_${pairCount.toString(36)}`,
            request: {
              timestamp: startTime / 1000,
              method: req.method,
              url: targetUrl,
              headers: reqHeaders,
              body: reqBody,
              ...reqBytes,
            },
            response: null,
            duration: Date.now() - startTime,
            loggedAt: new Date().toISOString(),
          });
        }
        return new Response(`Proxy error: ${err}`, { status: 502 });
      }

      const fwdHeaders = new Headers(upstreamRes.headers);
      fwdHeaders.delete("content-encoding");
      fwdHeaders.delete("content-length");

      if (!upstreamRes.body) {
        // Empty-body success (204/304). Record it so the trace is complete.
        if (shouldLog) {
          pairCount++;
          onPair({
            id: `${Date.now()}_${pairCount.toString(36)}`,
            request: {
              timestamp: startTime / 1000,
              method: req.method,
              url: targetUrl,
              headers: reqHeaders,
              body: reqBody,
              ...reqBytes,
            },
            response: {
              timestamp: Date.now() / 1000,
              status: upstreamRes.status,
              headers: Object.fromEntries(fwdHeaders.entries()),
            },
            duration: Date.now() - startTime,
            loggedAt: new Date().toISOString(),
          });
        }
        return new Response(null, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: fwdHeaders,
        });
      }
      if (!shouldLog) {
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: fwdHeaders,
        });
      }

      const { stream: clientStream, captured } = captureTee(upstreamRes.body);
      pairCount++;
      const captureId = `${Date.now()}_${pairCount.toString(36)}`;
      const resStatus = upstreamRes.status;
      const resHeaders = Object.fromEntries(fwdHeaders.entries());
      const ct = upstreamRes.headers.get("content-type") || "";

      const capture = captured.then(({ text, complete, bytes, firstByteAt, firstTokenAt }) => {
        let resBody: unknown = undefined;
        let resBodyRaw: string | undefined = undefined;

        try {
          if (ct.includes("application/json")) {
            resBody = JSON.parse(text);
          } else {
            resBodyRaw = text;
          }
        } catch {
          resBodyRaw = text;
        }

        const pair: TracePair = {
          id: captureId,
          request: {
            timestamp: startTime / 1000,
            method: req.method,
            url: targetUrl,
            headers: reqHeaders,
            body: reqBody,
            ...reqBytes,
          },
          response: {
            timestamp: Date.now() / 1000,
            status: resStatus,
            headers: resHeaders,
            ...(resBody !== undefined ? { body: resBody } : {}),
            ...(resBodyRaw !== undefined ? { bodyRaw: resBodyRaw } : {}),
            ...(bytes > 0 ? { bodyBytes: bytes } : {}),
            ...(firstByteAt !== undefined ? { firstByteMs: firstByteAt - startTime } : {}),
            ...(firstTokenAt !== undefined ? { firstTokenMs: firstTokenAt - startTime } : {}),
            ...(complete ? {} : { truncated: true }),
          },
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        };

        onPair(pair);
      }).catch(() => {}).finally(() => {
        pending.delete(capture);
      });

      pending.add(capture);

      return new Response(clientStream, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: fwdHeaders,
      });
    },
  });

  return {
    port: server.port ?? 0,
    stop: () => server.stop(),
    // Race a cap so an abandoned capture can never hang exit.
    flush: () => Promise.race([
      Promise.all(pending),
      new Promise((r) => setTimeout(r, 5000)),
    ]).then(() => {}),
    pairCount: () => pairCount,
  };
}
