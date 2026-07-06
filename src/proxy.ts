import type { TracePair, RequestData, ResponseData } from "./types";

const SENSITIVE_HEADERS = [
  "authorization",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
];

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  for (const [key, value] of Object.entries(result)) {
    if (SENSITIVE_HEADERS.some((s) => key.toLowerCase().includes(s))) {
      result[key] = value.length > 14
        ? `${value.slice(0, 10)}...${value.slice(-4)}`
        : "[REDACTED]";
    }
  }
  return result;
}

export interface ProxyConfig {
  port?: number;
  targetHost?: string;
  targetScheme?: string;
  onPair: (pair: TracePair) => void;
  logAll?: boolean;
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
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

  const server = Bun.serve({
    port: config.port ?? 0,

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
      let rawReqBody: string | null = null;
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        rawReqBody = await req.text();
        try { reqBody = JSON.parse(rawReqBody); } catch { reqBody = rawReqBody; }
      }

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(targetUrl, {
          method: req.method,
          headers: reqHeaders,
          body: rawReqBody,
          redirect: "follow",
        });
      } catch (err) {
        if (shouldLog) {
          pairCount++;
          config.onPair({
            id: `${Date.now()}_${pairCount.toString(36)}`,
            request: {
              timestamp: startTime / 1000,
              method: req.method,
              url: targetUrl,
              headers: redactHeaders(reqHeaders),
              body: reqBody,
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

      if (!shouldLog || !upstreamRes.body) {
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: fwdHeaders,
        });
      }

      const [clientStream, captureStream] = upstreamRes.body.tee();
      pairCount++;
      const captureId = `${Date.now()}_${pairCount.toString(36)}`;
      const resStatus = upstreamRes.status;
      const resHeaders = Object.fromEntries(fwdHeaders.entries());
      const ct = upstreamRes.headers.get("content-type") || "";

      const capture = drainStream(captureStream).then((captured) => {
        let resBody: unknown = undefined;
        let resBodyRaw: string | undefined = undefined;

        try {
          if (ct.includes("application/json")) {
            resBody = JSON.parse(captured);
          } else {
            resBodyRaw = captured;
          }
        } catch {
          resBodyRaw = captured;
        }

        const pair: TracePair = {
          id: captureId,
          request: {
            timestamp: startTime / 1000,
            method: req.method,
            url: targetUrl,
            headers: redactHeaders(reqHeaders),
            body: reqBody,
          },
          response: {
            timestamp: Date.now() / 1000,
            status: resStatus,
            headers: redactHeaders(resHeaders),
            ...(resBody !== undefined ? { body: resBody } : {}),
            ...(resBodyRaw !== undefined ? { bodyRaw: resBodyRaw } : {}),
          },
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        };

        config.onPair(pair);
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
    flush: () => Promise.all(pending).then(() => {}),
    pairCount: () => pairCount,
  };
}
