import * as http from "http";
import * as net from "net";
import { readFileSync } from "fs";
import { join } from "path";
import { isInterceptHost, hostInSet, generateHostCert } from "./certs";
import { categorizeUrl, isModelCallPath } from "./categorize";
import { redactPair } from "./redact";
import { captureTee, decodeBodyForTrace } from "./stream";
import type { TracePair, TraceStart } from "./types";

export interface MitmConfig {
  caDir: string;
  onPair: (pair: TracePair) => void;
  /**
   * A model call was forwarded and has no response yet — the live "thinking
   * now" signal, carrying the id the eventual pair will have. Fail-soft: a
   * throwing sink can never cost the forward.
   */
  onStart?: (start: TraceStart) => void;
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
 * Bodies of intercepted-but-external hosts are capped at capture time: an
 * external host only gets MITM'd under --capture-external, and the point
 * there is the audit trail (url/status/sizes/timing/headers), not payloads —
 * a 52MB npm tarball or a token-authed gh API response body in the trace is
 * a liability, not signal. Small bodies (the interesting JSON) survive
 * intact; anything larger is summarized with exact byte counts. Explicitly
 * enrolled hosts (--intercept-host) always capture in full — the user named
 * them. Same stub shape `cctrace compact` uses, so the UI needs no new case.
 */
export const EXTERNAL_BODY_CAP = 64 * 1024;

export function externalBodyStub(droppedBytes: number, contentType?: string): unknown {
  return {
    _cctrace_stub: 1,
    kind: "meta",
    droppedBytes,
    ...(contentType ? { contentType } : {}),
    cctrace: `external body over ${EXTERNAL_BODY_CAP / 1024}KB not stored — enroll the host with --intercept-host for full capture`,
  };
}

/**
 * The upstream HTTP proxy the opaque tunnel chains through, parsed from the
 * standard env vars. Returns null when unset or non-http scheme (socks/https
 * proxies aren't chained — the tunnel falls back to a direct connect, its
 * historical behavior). `auth` is a ready-to-send Proxy-Authorization value
 * when the URL carries credentials.
 */
export function parseUpstreamProxy(): { host: string; port: number; auth?: string } | null {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:") return null;
    const port = u.port ? parseInt(u.port, 10) : 80;
    const auth = u.username
      ? "Basic " + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")
      : undefined;
    return { host: u.hostname, port, ...(auth ? { auth } : {}) };
  } catch {
    return null;
  }
}

/**
 * Parse a CONNECT target or Host header ("host:8443", "[::1]:443", bare
 * host) into host + port. Bracket-aware: "[::1]:443" must yield host "::1",
 * not "[" (#82). The returned host is unbracketed — what net.connect, cert
 * SANs, and the include-list match against. A bare IPv6 literal without
 * brackets is returned whole rather than mangled at its last colon.
 */
export function parseConnectTarget(target: string, defaultPort = 443): { host: string; port: number } {
  const t = (target || "").trim();
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!, port: v6[2] ? parseInt(v6[2], 10) : defaultPort };
  const i = t.indexOf(":");
  if (i > -1 && i === t.lastIndexOf(":") && /^\d+$/.test(t.slice(i + 1))) {
    return { host: t.slice(0, i), port: parseInt(t.slice(i + 1), 10) };
  }
  return { host: t, port: defaultPort };
}

/** Re-bracket an IPv6 host for URL/authority use. */
function authorityOf(host: string, port: number): string {
  return (host.includes(":") ? `[${host}]` : host) + (port === 443 ? "" : `:${port}`);
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

  // Live state, not a pair: only a MESSAGES-category request is a "the model
  // is thinking" moment (a count_tokens probe, oauth or telemetry is not).
  // categorizeUrl needs no client/wire here — it decides model-call WIRE
  // SHAPE before any host/client rule, so no client label can turn a
  // non-messages URL into "messages" or vice versa. Fail-soft by
  // construction: the hint must never cost the request it precedes.
  const emitStart = (id: string, method: string, url: string, ts: number) => {
    if (!config.onStart || categorizeUrl(url) !== "messages") return;
    try { config.onStart({ id, url, method, ts }); } catch {}
  };

  let pairCount = 0;
  const pending = new Set<Promise<void>>();

  const interceptSet = config.interceptHosts ?? [];

  // CONNECT-line ports per host: the terminator rebuilds the upstream URL
  // from the Host header, but some clients omit a non-default port there —
  // the CONNECT target is the transport truth, so it rides through (#82).
  const connectPorts = new Map<string, number>();

  // Upstream proxy chaining. In environments where the machine reaches the
  // internet ONLY through an HTTP proxy (containers with no direct egress,
  // corporate proxies), a raw net.connect to the origin goes nowhere — the
  // opaque tunnel would silently break every tunneled host (remote MCP
  // servers, external hosts, the Claude-in-Chrome bridge), sending the
  // client's ClientHello into a black hole. The MITM path already chains
  // transparently — Bun's fetch() honors HTTPS_PROXY in OUR own env — and the
  // tunnel must chain the same way. We read the proxy from OUR process env:
  // Claude's child env has HTTPS_PROXY rewritten to point at us, but this
  // process still points at the real upstream (capture.ts sets the child env,
  // never process.env). Only http-scheme proxies are chained; socks/https
  // proxies fall through to a direct connect (unchanged pre-existing
  // behavior). NO_PROXY hosts always connect directly.
  const upstreamProxy = parseUpstreamProxy();
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bypassProxy = (host: string) => {
    if (!upstreamProxy) return true;
    const h = host.toLowerCase();
    return noProxy.some((e) => e === "*" || h === e || h === e.replace(/^\./, "") || h.endsWith("." + e.replace(/^\./, "")));
  };

  // Shared fetch handler — used by both the static Anthropic TLS server
  // and dynamically created per-host TLS servers.
  function interceptFetch(req: Request): Response | Promise<Response> {
    const hostHeader = req.headers.get("host") || "unknown";
    const parsedHost = parseConnectTarget(hostHeader, 0); // 0 = no port in the header
    const targetHost = parsedHost.host || "unknown";
    // Port precedence: Host header, then the CONNECT line's target (some
    // clients omit non-default ports from Host), then 443 (#82).
    const targetPort = parsedHost.port || connectPorts.get(targetHost) || 443;
    // On the include-list = the traced client's own infrastructure or a host
    // the user explicitly enrolled: full-body capture. Anything else is only
    // here because of --capture-external: bodies cap at EXTERNAL_BODY_CAP.
    const enrolled = isInterceptHost(targetHost) || hostInSet(targetHost, interceptSet);
    const path = new URL(req.url).pathname + new URL(req.url).search;
    const targetUrl = `https://${authorityOf(targetHost, targetPort)}${path}`;
    // --messages-only means "just the model API calls" — the SAME predicate
    // categorize.ts calls "messages", or the filter drops pairs the page
    // would have shown (a custom provider mounting {base}/responses did).
    const shouldLog = logAll || isModelCallPath(path);
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
      // The pair id is minted BEFORE the forward, so the live `start` event
      // and the pair that eventually lands carry the SAME id (the page drops
      // the open start when the pair arrives). pairCount counts the requests
      // that will be logged — a filtered-out one mints nothing — and stays
      // the uniqueness suffix, so ids can't collide within a millisecond.
      let captureId = "";
      if (shouldLog) {
        pairCount++;
        captureId = `${Date.now()}_${pairCount.toString(36)}`;
      }
      let reqBody: unknown = null;
      let fwdBody: Uint8Array | null = null;
      if (req.body && req.method !== "GET" && req.method !== "HEAD") {
        // Raw bytes for the upstream, decoded copy for the trace — codex
        // zstd-compresses request JSON; a text round trip would corrupt it.
        fwdBody = new Uint8Array(await req.arrayBuffer());
        reqBody = enrolled || fwdBody.length <= EXTERNAL_BODY_CAP
          ? decodeBodyForTrace(fwdBody, reqHeaders["content-encoding"])
          : externalBodyStub(fwdBody.length, reqHeaders["content-type"]);
      }
      const reqBytes = fwdBody && fwdBody.length ? { bodyBytes: fwdBody.length } : {};

      // fetch() recomputes the length of the body it actually sends; a stale
      // forwarded content-length can only disagree.
      const fetchHeaders = { ...reqHeaders };
      delete fetchHeaders["content-length"];

      let upstream: Response;
      if (shouldLog) emitStart(captureId, req.method, targetUrl, startTime / 1000);
      try {
        upstream = await fetch(targetUrl, {
          method: req.method,
          headers: fetchHeaders,
          body: fwdBody,
          redirect: "manual",
        });
      } catch (err) {
        if (shouldLog) {
          onPair({
            id: captureId,
            request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody, ...reqBytes },
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
          const resHeaders: Record<string, string> = {};
          fwdHeaders.forEach((v, k) => { resHeaders[k] = v; });
          onPair({
            id: captureId,
            request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody, ...reqBytes },
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
      const resStatus = upstream.status;
      const resHeaders: Record<string, string> = {};
      fwdHeaders.forEach((v, k) => { resHeaders[k] = v; });
      const ct = upstream.headers.get("content-type") || "";

      const cap = captured.then(({ text, complete, bytes, firstByteAt, firstTokenAt }) => {
        let resBody: unknown = undefined;
        let resBodyRaw: string | undefined = undefined;
        if (!enrolled && bytes > EXTERNAL_BODY_CAP) {
          resBody = externalBodyStub(bytes, ct);
        } else {
          try {
            if (ct.includes("application/json")) resBody = JSON.parse(text);
            else resBodyRaw = text;
          } catch { resBodyRaw = text; }
        }

        onPair({
          id: captureId,
          request: { timestamp: startTime / 1000, method: req.method, url: targetUrl, headers: reqHeaders, body: reqBody, ...reqBytes },
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
    let established = false;
    const finish = () => {
      if (logged || !logAll) return;
      logged = true;
      pairCount++;
      onPair({
        id: `${Date.now()}_${pairCount.toString(36)}`,
        request: {
          timestamp: startTime / 1000,
          method: "CONNECT",
          url: `https://${authorityOf(host, port)}/`,
          headers: {},
          body: null,
        },
        response: {
          timestamp: Date.now() / 1000,
          status: established ? 200 : 502,
          headers: {},
          body: {
            cctrace: established
              ? "opaque TLS tunnel — payload not captured (tunnel-by-default; --capture-external or --intercept-host " + host + " to decrypt)"
              : "tunnel could not reach " + authorityOf(host, port) + " — origin connect failed or upstream proxy refused",
            tunneled: true,
            bytesUp,
            bytesDown,
          },
        },
        duration: Date.now() - startTime,
        loggedAt: new Date().toISOString(),
      });
    };
    // Splice upstream <-> client once the upstream can carry bytes to the
    // origin (directly, or through the chained proxy's established tunnel).
    // `preface` is any origin bytes already read past the proxy's CONNECT
    // reply — normally empty, since the client waits for our 200 before it
    // sends anything. Byte counts stay payload-only: the proxy's CONNECT
    // request/reply is transport overhead, not tunneled bytes.
    const splice = (up: net.Socket, preface: Buffer | null) => {
      established = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      if (preface?.length) { bytesDown += preface.length; clientSocket.write(preface); }
      clientSocket.on("data", (c: Buffer) => { bytesUp += c.length; });
      up.on("data", (c: Buffer) => { bytesDown += c.length; });
      clientSocket.pipe(up);
      up.pipe(clientSocket);
    };

    let upstream: net.Socket;
    if (!upstreamProxy || bypassProxy(host)) {
      upstream = net.connect(port, host, () => splice(upstream, null));
    } else {
      const p = upstreamProxy;
      upstream = net.connect(p.port, p.host, () => {
        const hostport = (host.includes(":") ? `[${host}]` : host) + ":" + port;
        upstream.write(
          `CONNECT ${hostport} HTTP/1.1\r\nHost: ${hostport}\r\n` +
          (p.auth ? `Proxy-Authorization: ${p.auth}\r\n` : "") + "\r\n",
        );
      });
      // Consume the proxy's CONNECT reply, then splice. Removing the sole data
      // listener and attaching the splice listeners happen in one synchronous
      // tick, so no origin byte slips through while the socket is unpaused.
      let buf = Buffer.alloc(0);
      const onReply = (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        upstream.removeListener("data", onReply);
        const status = parseInt(buf.slice(0, buf.indexOf("\r\n")).toString().split(" ")[1] || "0", 10);
        if (status >= 200 && status < 300) {
          splice(upstream, buf.slice(end + 4));
        } else {
          // Proxy refused (auth, blocklist) — answer, then close.
          upstream.destroy();
          refuse();
        }
      };
      upstream.on("data", onReply);
    }
    // A connect failure must ANSWER the CONNECT before closing: a bare
    // socket reset is indistinguishable from cctrace itself dying (#82).
    const refuse = () => {
      if (!established && clientSocket.writable) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      } else {
        clientSocket.destroy();
      }
      finish();
    };
    upstream.on("close", finish);
    clientSocket.on("close", finish);
    upstream.on("error", refuse);
    clientSocket.on("error", () => { upstream.destroy(); finish(); });
  }

  proxy.on("connect", async (req, clientSocket: net.Socket, head: Buffer) => {
    const target = parseConnectTarget(req.url || "");
    const host = target.host || "api.anthropic.com";
    const port = target.port;
    // Policy gate, decided on the CONNECT line BEFORE any TLS exists: the
    // path is only visible after decryption, so scope must be host-level.
    const wantsMitm = config.captureExternal || isInterceptHost(host) || hostInSet(host, interceptSet);
    if (!wantsMitm) return countingTunnel(host, port, clientSocket, head);
    connectPorts.set(host, port);

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

    let established = false;
    const upstream = net.connect(destPort, "127.0.0.1", () => {
      established = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => {
      // Same honesty as the tunnel path: answer the CONNECT, don't reset.
      if (!established && clientSocket.writable) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      else clientSocket.destroy();
    });
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
