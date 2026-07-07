import * as http from "http";
import * as net from "net";
import { readFileSync } from "fs";
import { join } from "path";
import { isInterceptHost } from "./certs";
import { redactPair } from "./redact";
import type { TracePair } from "./types";

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

export interface MitmConfig {
  caDir: string;
  onPair: (pair: TracePair) => void;
  logAll?: boolean;
}

export interface MitmServer {
  port: number;
  caCertPath: string;
  stop: () => void;
  flush: () => Promise<void>;
  pairCount: () => number;
}

/**
 * TLS-intercepting HTTP proxy (Charles/mitmproxy style).
 *
 * Front door: a plain http.Server that only answers CONNECT. It writes
 * "200 Connection Established", then pipes the raw tunnel bytes to a local
 * Bun.serve TLS listener. Bun terminates TLS with our leaf cert (Claude trusts
 * the CA via NODE_EXTRA_CA_CERTS), decrypts the request, and we forward it to
 * the real upstream host from the Host header. Because interception happens at
 * the transport layer, it captures every https call to Anthropic hosts,
 * regardless of how Claude built the URL -- including /api/oauth/usage, which
 * ignores ANTHROPIC_BASE_URL.
 */
export function startMitm(config: MitmConfig): Promise<MitmServer> {
  const caDir = config.caDir;
  const key = readFileSync(join(caDir, "leaf-key.pem"), "utf-8");
  const cert = readFileSync(join(caDir, "leaf-cert.pem"), "utf-8");
  const caCertPath = join(caDir, "ca-cert.pem");
  const logAll = config.logAll ?? true;

  // Every emitted pair passes through redaction here, so no branch can leak a
  // credential to disk/HTML/WebSocket. This is the single choke point.
  const onPair = (pair: TracePair) => config.onPair(redactPair(pair));

  let pairCount = 0;
  const pending = new Set<Promise<void>>();

  // TLS terminator: Bun.serve handles the handshake natively (robust in Bun),
  // then forwards the decrypted request to the real host.
  const tlsServer = Bun.serve({
    port: 0,
    tls: { key, cert },
    async fetch(req) {
      // req.url arrives as https://<our-listener-host>/<path>; the real target
      // host is in the Host header (set by Claude for the original request).
      const hostHeader = req.headers.get("host") || "api.anthropic.com";
      const targetHost = hostHeader.split(":")[0];
      const path = new URL(req.url).pathname + new URL(req.url).search;
      const targetUrl = `https://${targetHost}${path}`;
      const shouldLog = logAll || path.includes("/v1/messages");
      const startTime = Date.now();

      const reqHeaders: Record<string, string> = {};
      req.headers.forEach((v, k) => { reqHeaders[k] = v; });
      reqHeaders["accept-encoding"] = "identity";

      let reqBody: unknown = null;
      let rawReqBody: string | null = null;
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        rawReqBody = await req.text();
        try { reqBody = JSON.parse(rawReqBody); } catch { reqBody = rawReqBody; }
      }

      let upstream: Response;
      try {
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers: reqHeaders,
          body: rawReqBody,
          redirect: "manual",
        });
      } catch (err) {
        if (shouldLog) {
          pairCount++;
          onPair({
            id: `${Date.now()}_${pairCount.toString(36)}`,
            request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody },
            response: null,
            duration: Date.now() - startTime,
            loggedAt: new Date().toISOString(),
          });
        }
        return new Response(`Proxy error: ${err}`, { status: 502 });
      }

      const fwdHeaders = new Headers(upstream.headers);
      fwdHeaders.delete("content-encoding");
      fwdHeaders.delete("content-length");

      if (!upstream.body) {
        // Empty-body success (204/304, or a 3xx under redirect:"manual"). Still
        // record it so "capture everything" is honest about redirect hops.
        if (shouldLog) {
          pairCount++;
          const resHeaders: Record<string, string> = {};
          fwdHeaders.forEach((v, k) => { resHeaders[k] = v; });
          onPair({
            id: `${Date.now()}_${pairCount.toString(36)}`,
            request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody },
            response: { timestamp: Date.now() / 1000, status: upstream.status, headers: resHeaders },
            duration: Date.now() - startTime,
            loggedAt: new Date().toISOString(),
          });
        }
        return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: fwdHeaders });
      }
      if (!shouldLog) {
        return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: fwdHeaders });
      }

      const [clientStream, captureStream] = upstream.body.tee();
      pairCount++;
      const captureId = `${Date.now()}_${pairCount.toString(36)}`;
      const resStatus = upstream.status;
      const resHeaders: Record<string, string> = {};
      fwdHeaders.forEach((v, k) => { resHeaders[k] = v; });
      const ct = upstream.headers.get("content-type") || "";

      const cap = drainStream(captureStream).then((captured) => {
        let resBody: unknown = undefined;
        let resBodyRaw: string | undefined = undefined;
        try {
          if (ct.includes("application/json")) resBody = JSON.parse(captured);
          else resBodyRaw = captured;
        } catch { resBodyRaw = captured; }

        onPair({
          id: captureId,
          request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody },
          response: {
            timestamp: Date.now() / 1000,
            status: resStatus,
            headers: resHeaders,
            ...(resBody !== undefined ? { body: resBody } : {}),
            ...(resBodyRaw !== undefined ? { bodyRaw: resBodyRaw } : {}),
          },
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        });
      }).catch(() => {}).finally(() => { pending.delete(cap); });
      pending.add(cap);

      return new Response(clientStream, { status: upstream.status, statusText: upstream.statusText, headers: fwdHeaders });
    },
  });

  const tlsPort: number = tlsServer.port ?? 0;

  // Front door: plain HTTP proxy that only handles CONNECT by piping the raw
  // tunnel to the Bun TLS listener above.
  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end("This proxy only supports HTTPS (CONNECT).");
  });

  proxy.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    const [reqHost, reqPortStr] = (req.url || "").split(":");
    const host = reqHost || "api.anthropic.com";
    const port = parseInt(reqPortStr || "443", 10);
    const intercept = isInterceptHost(host);

    // Anthropic hosts → TLS-terminate via our leaf cert for full capture.
    // Everything else → tunnel through but still log the CONNECT so it's
    // visible in the UI for categorization and filtering.
    const dest = intercept
      ? { port: tlsPort, host: "127.0.0.1" }
      : { port, host };

    if (!intercept && logAll) {
      pairCount++;
      onPair({
        id: `${Date.now()}_${pairCount.toString(36)}`,
        request: {
          timestamp: Date.now() / 1000,
          method: "CONNECT",
          url: `https://${host}:${port}`,
          headers: {},
          body: null,
        },
        response: { timestamp: Date.now() / 1000, status: 200, headers: {} },
        duration: 0,
        loggedAt: new Date().toISOString(),
      });
    }

    const upstream = net.connect(dest.port, dest.host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    proxy.on("error", reject);
    proxy.listen(0, "127.0.0.1", () => {
      const addr = proxy.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        caCertPath,
        stop: () => { proxy.close(); tlsServer.stop(true); },
        flush: () => Promise.all(pending).then(() => {}),
        pairCount: () => pairCount,
      });
    });
  });
}
