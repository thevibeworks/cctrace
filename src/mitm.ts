import * as http from "http";
import * as net from "net";
import { readFileSync } from "fs";
import { join } from "path";
import { isInterceptHost, hostInSet, generateHostCert } from "./certs";
import { redactPair } from "./redact";
import { captureTee, decodeBodyForTrace } from "./stream";
import type { TracePair } from "./types";

export interface MitmConfig {
  caDir: string;
  onPair: (pair: TracePair) => void;
  logAll?: boolean;
  /**
   * Host suffixes to MITM beyond the static Anthropic set — the SSL-proxying
   * include-list (buildInterceptSet in certs.ts). Hosts outside it are blind
   * -tunneled with byte counts instead of decrypted.
   */
  interceptHosts?: string[];
  /** MITM every host (the pre-0.16 behavior) — --capture-external. */
  captureExternal?: boolean;
}

export interface MitmServer {
  port: number;
  caCertPath: string;
  stop: () => void;
  flush: () => Promise<void>;
  pairCount: () => number;
}

/**
 * TLS-intercepting HTTP proxy with an SSL-proxying include-list (Charles'
 * model, devlog 2026-07-15).
 *
 * Front door: a plain http.Server answers CONNECT. Include-listed hosts
 * (the traced client's first-party infrastructure + pinned telemetry sinks
 * + base-url overrides + --intercept-host extras) are piped to a local
 * Bun.serve TLS terminator presenting a cert signed by our CA — Anthropic
 * hosts via the pre-generated static leaf, others via dynamically generated
 * per-host certs (cached on disk). Every other host is an OPAQUE tunnel:
 * bytes pass through untouched (no forged cert, so cert-pinning tools and
 * system-store readers like apt keep working) and one meta pair records
 * host, byte counts, and duration — the "claude touched X" audit trail at
 * ~100 bytes instead of megabytes of decoded third-party payload.
 * --capture-external restores MITM-everything.
 */
export function startMitm(config: MitmConfig): Promise<MitmServer> {
  const caDir = config.caDir;
  const key = readFileSync(join(caDir, "leaf-key.pem"), "utf-8");
  const cert = readFileSync(join(caDir, "leaf-cert.pem"), "utf-8");
  const caCertPath = join(caDir, "ca-cert.pem");
  const logAll = config.logAll ?? true;

  const onPair = (pair: TracePair) => config.onPair(redactPair(pair));

  let pairCount = 0;
  const pending = new Set<Promise<void>>();

  // Shared fetch handler — used by both the static Anthropic TLS server
  // and dynamically created per-host TLS servers.
  function interceptFetch(req: Request): Response | Promise<Response> {
    const hostHeader = req.headers.get("host") || "unknown";
    const targetHost = hostHeader.split(":")[0];
    const path = new URL(req.url).pathname + new URL(req.url).search;
    const targetUrl = `https://${targetHost}${path}`;
    // --messages-only means "just the model API calls" — match the same wire
    // shapes categorize.ts calls "messages", so codex/grok filtering works.
    const shouldLog = logAll || path.includes("/v1/messages") ||
      path.includes("/v1/chat/completions") || path.includes("/v1/responses") || path.includes("/codex/responses");
    const startTime = Date.now();

    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => { reqHeaders[k] = v; });
    reqHeaders["accept-encoding"] = "identity";

    // WebSocket upgrades can't be relayed yet — the terminator has no ws
    // handler, and forwarding the handshake via fetch() hands the client a
    // convincing 101 whose frames then go nowhere (codex hung ~82s per
    // attempt until upstream's ping timeout). Refuse fast instead, so the
    // client falls back to plain HTTP immediately, and log the attempt.
    if ((req.headers.get("upgrade") || "").toLowerCase().includes("websocket")) {
      if (shouldLog) {
        pairCount++;
        onPair({
          id: `${Date.now()}_${pairCount.toString(36)}`,
          request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: null },
          response: {
            timestamp: Date.now() / 1000,
            status: 501,
            headers: {},
            body: { cctrace: "websocket upgrade refused — ws interception is not supported yet; the client should fall back to HTTP" },
          },
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        });
      }
      return new Response("cctrace: websocket interception not supported", { status: 501 });
    }

    const doCapture = async (): Promise<Response> => {
      let reqBody: unknown = null;
      let fwdBody: Uint8Array | null = null;
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        // Raw bytes for the upstream, decoded copy for the trace — codex
        // zstd-compresses request JSON; a text round trip would corrupt it.
        fwdBody = new Uint8Array(await req.arrayBuffer());
        reqBody = decodeBodyForTrace(fwdBody, reqHeaders["content-encoding"]);
      }

      // fetch() recomputes the length of the body it actually sends; a stale
      // forwarded content-length can only disagree.
      const fetchHeaders = { ...reqHeaders };
      delete fetchHeaders["content-length"];

      let upstream: Response;
      try {
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers: fetchHeaders,
          body: fwdBody,
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

      const { stream: clientStream, captured } = captureTee(upstream.body);
      pairCount++;
      const captureId = `${Date.now()}_${pairCount.toString(36)}`;
      const resStatus = upstream.status;
      const resHeaders: Record<string, string> = {};
      fwdHeaders.forEach((v, k) => { resHeaders[k] = v; });
      const ct = upstream.headers.get("content-type") || "";

      const cap = captured.then(({ text, complete, firstByteAt, firstTokenAt }) => {
        let resBody: unknown = undefined;
        let resBodyRaw: string | undefined = undefined;
        try {
          if (ct.includes("application/json")) resBody = JSON.parse(text);
          else resBodyRaw = text;
        } catch { resBodyRaw = text; }

        onPair({
          id: captureId,
          request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody },
          response: {
            timestamp: Date.now() / 1000,
            status: resStatus,
            headers: resHeaders,
            ...(resBody !== undefined ? { body: resBody } : {}),
            ...(resBodyRaw !== undefined ? { bodyRaw: resBodyRaw } : {}),
            ...(firstByteAt !== undefined ? { firstByteMs: firstByteAt - startTime } : {}),
            ...(firstTokenAt !== undefined ? { firstTokenMs: firstTokenAt - startTime } : {}),
            ...(complete ? {} : { truncated: true }),
          },
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        });
      }).catch(() => {}).finally(() => { pending.delete(cap); });
      pending.add(cap);

      return new Response(clientStream, { status: upstream.status, statusText: upstream.statusText, headers: fwdHeaders });
    };

    return doCapture();
  }

  // Static TLS terminator for Anthropic hosts (pre-generated leaf cert).
  // idleTimeout 0: Bun's 10s default kills any connection with 10s of socket
  // silence — a long prompt (/compact) waits longer than that for its first
  // byte, and the resulting mid-request cancel used to crash the process.
  // A handler failure must degrade to one failed request, quietly — Bun's
  // default prints a multi-line error over Claude's TUI.
  const onServeError = (err: Error) => new Response(`cctrace capture error: ${err.message}`, { status: 502 });

  const tlsServer = Bun.serve({
    port: 0,
    idleTimeout: 0,
    tls: { key, cert },
    fetch: interceptFetch,
    error: onServeError,
  });

  const tlsPort: number = tlsServer.port ?? 0;

  // Per-host TLS servers for non-Anthropic hosts (dynamically generated certs).
  const hostServers = new Map<string, { port: number; server: ReturnType<typeof Bun.serve> }>();
  const hostCertPending = new Map<string, Promise<{ port: number }>>();

  async function getHostPort(host: string): Promise<number> {
    const cached = hostServers.get(host);
    if (cached) return cached.port;

    // Deduplicate concurrent cert generation for the same host
    let inflight = hostCertPending.get(host);
    if (!inflight) {
      inflight = generateHostCert(host, caDir).then(({ cert: hCert, key: hKey }) => {
        const server = Bun.serve({
          port: 0,
          idleTimeout: 0,
          tls: { key: hKey, cert: hCert },
          fetch: interceptFetch,
          error: onServeError,
        });
        const entry = { port: server.port ?? 0, server };
        hostServers.set(host, entry);
        hostCertPending.delete(host);
        return { port: entry.port };
      });
      hostCertPending.set(host, inflight);
    }
    return (await inflight).port;
  }

  const proxy = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end("This proxy only supports HTTPS (CONNECT).");
  });

  // Opaque pass-through for hosts outside the include-list (and the last
  // resort when per-host cert generation fails). Bytes are piped untouched;
  // one meta pair per connection keeps the audit trail: host, bytesUp/Down,
  // duration. No forged cert, so cert-pinning tools and system-trust-store
  // readers (apt, java) work through cctrace unharmed.
  function countingTunnel(host: string, port: number, clientSocket: net.Socket, head: Buffer) {
    const startTime = Date.now();
    let bytesUp = head?.length || 0;
    let bytesDown = 0;
    let logged = false;
    const finish = () => {
      if (logged || !logAll) return;
      logged = true;
      pairCount++;
      onPair({
        id: `${Date.now()}_${pairCount.toString(36)}`,
        request: {
          timestamp: startTime / 1000,
          method: "CONNECT",
          url: `https://${host}${port === 443 ? "" : ":" + port}/`,
          headers: {},
          body: null,
        },
        response: {
          timestamp: Date.now() / 1000,
          status: 200,
          headers: {},
          body: {
            cctrace: "opaque TLS tunnel — payload not captured (tunnel-by-default; --capture-external or --intercept-host " + host + " to decrypt)",
            tunneled: true,
            bytesUp,
            bytesDown,
          },
        },
        duration: Date.now() - startTime,
        loggedAt: new Date().toISOString(),
      });
    };
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.on("data", (c: Buffer) => { bytesUp += c.length; });
      upstream.on("data", (c: Buffer) => { bytesDown += c.length; });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("close", finish);
    clientSocket.on("close", finish);
    upstream.on("error", () => { clientSocket.destroy(); finish(); });
    clientSocket.on("error", () => { upstream.destroy(); finish(); });
  }

  const interceptSet = config.interceptHosts ?? [];

  proxy.on("connect", async (req, clientSocket: net.Socket, head: Buffer) => {
    const [reqHost, reqPortStr] = (req.url || "").split(":");
    const host = reqHost || "api.anthropic.com";
    const port = parseInt(reqPortStr || "443", 10);
    // Policy gate, decided on the CONNECT line BEFORE any TLS exists: the
    // path is only visible after decryption, so scope must be host-level.
    const wantsMitm = config.captureExternal || isInterceptHost(host) || hostInSet(host, interceptSet);
    if (!wantsMitm) return countingTunnel(host, port, clientSocket, head);

    let destPort: number;
    if (isInterceptHost(host)) {
      destPort = tlsPort;
    } else {
      try {
        destPort = await getHostPort(host);
      } catch {
        // Cert generation failed (no openssl?) — tunnel as last resort.
        return countingTunnel(host, port, clientSocket, head);
      }
    }

    const upstream = net.connect(destPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
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
        stop: () => {
          proxy.close();
          tlsServer.stop(true);
          for (const entry of hostServers.values()) entry.server.stop(true);
        },
        // Race a cap so an abandoned capture can never hang exit.
        flush: () => Promise.race([
          Promise.all(pending),
          new Promise((r) => setTimeout(r, 5000)),
        ]).then(() => {}),
        pairCount: () => pairCount,
      });
    });
  });
}
