import { describe, test, expect, afterEach, beforeAll, beforeEach } from "bun:test";
import { startMitm } from "../src/mitm";
import { ensureCerts, isInterceptHost, migrateCaDir, buildCaBundle, systemCaBundle } from "../src/certs";
import { createCapturer } from "../src/capture";
import type { TracePair } from "../src/types";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
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

// The CA is identity material: migration must move it (same key bits), never
// regenerate, and must never clobber a CA already at the destination.
describe("migrateCaDir", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cctrace-migrate-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const seed = (dir: string, marker: string) => {
    mkdirSync(dir, { recursive: true });
    for (const f of ["ca-cert.pem", "ca-key.pem", "leaf-cert.pem", "leaf-key.pem", "host-example.com-cert.pem"]) {
      writeFileSync(join(dir, f), `${marker}:${f}`);
    }
  };

  test("moves the whole dir, preserving contents and key perms", () => {
    const from = join(root, "cache", "mitm");
    const to = join(root, "share", "mitm");
    seed(from, "legacy");
    expect(migrateCaDir(from, to)).toBe(true);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "ca-key.pem"), "utf8")).toBe("legacy:ca-key.pem");
    expect(readFileSync(join(to, "host-example.com-cert.pem"), "utf8")).toBe("legacy:host-example.com-cert.pem");
    expect(statSync(join(to, "ca-key.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(to).mode & 0o777).toBe(0o700);
  });

  test("never clobbers a CA already at the destination", () => {
    const from = join(root, "cache", "mitm");
    const to = join(root, "share", "mitm");
    seed(from, "legacy");
    seed(to, "current");
    expect(migrateCaDir(from, to)).toBe(false);
    expect(readFileSync(join(to, "ca-key.pem"), "utf8")).toBe("current:ca-key.pem");
    expect(existsSync(join(from, "ca-key.pem"))).toBe(true); // source untouched
  });

  test("no-op when the source has no CA or paths are the same", () => {
    const to = join(root, "share", "mitm");
    expect(migrateCaDir(join(root, "nope"), to)).toBe(false);
    seed(to, "x");
    expect(migrateCaDir(to, to)).toBe(false);
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
    // Subprocesses inherit HTTPS_PROXY, so they need trust too (issue #17):
    // the standard vars carry the combined system+mitm bundle. HTTP_PROXY
    // stays unset — the front door only speaks CONNECT.
    expect(cap.env.SSL_CERT_FILE).toContain("ca-bundle.pem");
    expect(cap.env.CURL_CA_BUNDLE).toBe(cap.env.SSL_CERT_FILE);
    expect(cap.env.REQUESTS_CA_BUNDLE).toBe(cap.env.SSL_CERT_FILE);
    expect(cap.env.HTTP_PROXY).toBeUndefined();
    expect(cap.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

// Issue #17: children of the traced CLI inherit HTTPS_PROXY but (before this)
// not the trust — every non-Node subprocess (statusline curl, gh, python
// hooks) failed TLS verify. The fix exports a COMBINED bundle: replacement
// vars with only the mitm cert would break all non-proxied subprocess TLS.
describe("buildCaBundle", () => {
  test("bundle = system CAs + mitm CA appended", () => {
    const sys = join(caDir, "fake-system.pem");
    writeFileSync(sys, "-----BEGIN CERTIFICATE-----\nSYSTEMCERT\n-----END CERTIFICATE-----\n");
    const out = buildCaBundle(caDir, sys);
    expect(out).toBe(join(caDir, "ca-bundle.pem"));
    const bundle = readFileSync(out!, "utf-8");
    // System CAs first, mitm CA appended last.
    expect(bundle.startsWith("-----BEGIN CERTIFICATE-----\nSYSTEMCERT")).toBe(true);
    expect(bundle.trimEnd().endsWith(readFileSync(join(caDir, "ca-cert.pem"), "utf-8").trimEnd())).toBe(true);
  });

  test("no system bundle -> null (caller must skip the replacement vars)", () => {
    expect(buildCaBundle(caDir, null)).toBeNull();
    expect(existsSync(join(caDir, "ca-bundle.pem.999.tmp"))).toBe(false);
  });

  test("rebuild picks up a changed system store", () => {
    const sys = join(caDir, "fake-system.pem");
    writeFileSync(sys, "-----BEGIN CERTIFICATE-----\nROTATED\n-----END CERTIFICATE-----\n");
    const bundle = readFileSync(buildCaBundle(caDir, sys)!, "utf-8");
    expect(bundle).toContain("ROTATED");
    expect(bundle).not.toContain("SYSTEMCERT");
  });

  test("systemCaBundle honors an existing user bundle over platform paths", () => {
    const mine = join(caDir, "corporate.pem");
    writeFileSync(mine, "x");
    expect(systemCaBundle({ SSL_CERT_FILE: mine })).toBe(mine);
    expect(systemCaBundle({ SSL_CERT_FILE: join(caDir, "gone.pem"), CURL_CA_BUNDLE: mine })).toBe(mine);
  });
});
