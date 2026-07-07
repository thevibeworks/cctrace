import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { startMitm } from "../src/mitm";
import { ensureCerts, isInterceptHost } from "../src/certs";
import { createCapturer } from "../src/capture";
import type { TracePair } from "../src/types";
import { join } from "path";
import { existsSync, rmSync } from "fs";
import * as net from "net";
import * as tls from "tls";

const caDir = join(import.meta.dir, "..", ".cache", "test-mitm");

beforeAll(async () => {
  await ensureCerts(caDir);
});

let servers: Array<{ stop: () => void }> = [];
function track<T extends { stop: () => void }>(s: T): T { servers.push(s); return s; }
afterEach(() => { for (const s of servers) { try { s.stop(); } catch {} } servers = []; });

describe("certs", () => {
  test("ensureCerts generates all four files", () => {
    expect(existsSync(join(caDir, "ca-cert.pem"))).toBe(true);
    expect(existsSync(join(caDir, "ca-key.pem"))).toBe(true);
    expect(existsSync(join(caDir, "leaf-cert.pem"))).toBe(true);
    expect(existsSync(join(caDir, "leaf-key.pem"))).toBe(true);
  });

  test("ensureCerts is idempotent (returns same paths, no throw)", async () => {
    const a = await ensureCerts(caDir);
    const b = await ensureCerts(caDir);
    expect(a.caCertPath).toBe(b.caCertPath);
  });
});

describe("isInterceptHost", () => {
  test("matches Anthropic hosts", () => {
    expect(isInterceptHost("api.anthropic.com")).toBe(true);
    expect(isInterceptHost("statsig.anthropic.com")).toBe(true);
    expect(isInterceptHost("claude.ai")).toBe(true);
    expect(isInterceptHost("platform.claude.com")).toBe(true);
    expect(isInterceptHost("claude.com")).toBe(true);
  });

  test("rejects non-Anthropic hosts (blind-tunneled)", () => {
    expect(isInterceptHost("sentry.io")).toBe(false);
    expect(isInterceptHost("google.com")).toBe(false);
    expect(isInterceptHost("evil-anthropic.com.attacker.net")).toBe(false);
    expect(isInterceptHost("notanthropic.com")).toBe(false);
  });
});

// Perform CONNECT then TLS, return the peer cert's issuer Organization.
// For intercepted hosts this is "cctrace" (our leaf); for blind-tunneled hosts
// it's the real public CA.
async function connectAndGetIssuer(port: number, host: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        sock.removeListener("data", onData);
        const tlsSock = tls.connect(
          { socket: sock, servername: host, rejectUnauthorized: false },
          () => {
            const cert = tlsSock.getPeerCertificate();
            const issuerO = (cert && cert.issuer && (cert.issuer.O || cert.issuer.CN)) || "";
            resolve(issuerO);
            tlsSock.destroy();
          }
        );
        tlsSock.on("error", () => resolve("<error>"));
      }
    };
    sock.on("data", onData);
    sock.on("error", () => resolve("<error>"));
    setTimeout(() => resolve("<timeout>"), 8000);
  });
}

describe("mitm proxy tunnel mechanics", () => {
  test("intercepted host is served our leaf cert (issuer = cctrace)", async () => {
    const mitm = track(await startMitm({ caDir, onPair: () => {} }));
    const issuer = await connectAndGetIssuer(mitm.port, "api.anthropic.com");
    expect(issuer).toBe("cctrace");
  });

  test("non-Anthropic host gets a dynamically generated cert (issuer = cctrace)", async () => {
    const mitm = track(await startMitm({ caDir, onPair: () => {} }));
    const issuer = await connectAndGetIssuer(mitm.port, "example.com");
    expect(issuer).toBe("cctrace");
  });
});

describe("capture abstraction", () => {
  test("base-url capturer exposes ANTHROPIC_BASE_URL env", async () => {
    const cap = track(await createCapturer("base-url", {
      onPair: () => {}, logAll: true, cacheDir: caDir,
    }));
    expect(cap.mode).toBe("base-url");
    expect(cap.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(cap.env.HTTPS_PROXY).toBeUndefined();
  });

  test("mitm capturer exposes HTTPS_PROXY + CA env", async () => {
    const cap = track(await createCapturer("mitm", {
      onPair: () => {}, logAll: true, cacheDir: caDir,
    }));
    expect(cap.mode).toBe("mitm");
    expect(cap.env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(cap.env.NODE_EXTRA_CA_CERTS).toContain("ca-cert.pem");
    // We must NOT set SSL_CERT_FILE / HTTP_PROXY: they leak into Claude's
    // subprocesses (curl/python/MCP) and break their public TLS / http calls.
    expect(cap.env.SSL_CERT_FILE).toBeUndefined();
    expect(cap.env.HTTP_PROXY).toBeUndefined();
    expect(cap.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
