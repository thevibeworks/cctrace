import { existsSync, mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, cpSync, rmSync } from "fs";
import { join, dirname, resolve } from "path";

// SANs the leaf cert must cover — every host cctrace intercepts must appear
// here, or its TLS handshake fails. Kept in sync with isInterceptHost().
const LEAF_SANS = [
  "api.anthropic.com",
  "*.anthropic.com",
  "anthropic.com",
  "claude.ai",
  "*.claude.ai",
  "claude.com",
  "*.claude.com",
];

export interface Certs {
  caDir: string;
  caCertPath: string;
  caKeyPath: string;
  leafCertPath: string;
  leafKeyPath: string;
}

function paths(caDir: string): Certs {
  return {
    caDir,
    caCertPath: join(caDir, "ca-cert.pem"),
    caKeyPath: join(caDir, "ca-key.pem"),
    leafCertPath: join(caDir, "leaf-cert.pem"),
    leafKeyPath: join(caDir, "leaf-key.pem"),
  };
}

async function run(cmd: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${cmd[0]} failed (${code}): ${err.slice(0, 400)}`);
  }
}

/**
 * Generate a self-signed CA and a leaf cert covering the Anthropic hosts,
 * once, under caDir. Idempotent: skips generation if all four files exist.
 * Requires the openssl CLI.
 */
export async function ensureCerts(caDir: string, onStatus?: (msg: string) => void): Promise<Certs> {
  const c = paths(caDir);
  if (
    existsSync(c.caCertPath) && existsSync(c.caKeyPath) &&
    existsSync(c.leafCertPath) && existsSync(c.leafKeyPath)
  ) {
    onStatus?.(`Using cached MITM CA: ${c.caCertPath}`);
    return c;
  }

  onStatus?.("Generating MITM CA + leaf cert (first run, needs openssl)…");

  // 0700: the CA key here can forge Anthropic certs for anyone trusting this
  // CA, so don't rely on openssl's umask — lock the dir and keys explicitly.
  if (!existsSync(caDir)) mkdirSync(caDir, { recursive: true, mode: 0o700 });

  // 1. CA key + self-signed CA cert (10y)
  await run(["openssl", "genrsa", "-out", c.caKeyPath, "2048"]);
  chmodSync(c.caKeyPath, 0o600);
  await run([
    "openssl", "req", "-x509", "-new", "-nodes", "-key", c.caKeyPath,
    "-sha256", "-days", "3650", "-subj", "/CN=cctrace MITM CA/O=cctrace",
    "-out", c.caCertPath,
  ]);

  // 2. Leaf key + CSR + cert signed by the CA, with Anthropic SANs
  const altNames = LEAF_SANS.map((d, i) => `DNS.${i + 1} = ${d}`).join("\n");
  const cnf = `[req]
distinguished_name = dn
req_extensions = v3_req
prompt = no
[dn]
CN = api.anthropic.com
[v3_req]
subjectAltName = @alt
[alt]
${altNames}
`;
  const cnfPath = join(caDir, "leaf.cnf");
  await Bun.write(cnfPath, cnf);

  await run(["openssl", "genrsa", "-out", c.leafKeyPath, "2048"]);
  chmodSync(c.leafKeyPath, 0o600);
  await run([
    "openssl", "req", "-new", "-key", c.leafKeyPath, "-out", join(caDir, "leaf.csr"),
    "-config", cnfPath,
  ]);
  await run([
    "openssl", "x509", "-req", "-in", join(caDir, "leaf.csr"),
    "-CA", c.caCertPath, "-CAkey", c.caKeyPath, "-CAcreateserial",
    "-out", c.leafCertPath, "-days", "3650", "-sha256",
    "-extfile", cnfPath, "-extensions", "v3_req",
  ]);

  onStatus?.(`MITM CA ready: ${c.caCertPath}`);
  return c;
}

/**
 * Generate a leaf cert for an arbitrary host, signed by our CA.
 * Cached on disk so subsequent connections to the same host are instant.
 */
export async function generateHostCert(host: string, caDir: string): Promise<{ cert: string; key: string }> {
  const safe = host.replace(/[^a-zA-Z0-9.\-]/g, "_");
  const certPath = join(caDir, `host-${safe}-cert.pem`);
  const keyPath = join(caDir, `host-${safe}-key.pem`);

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { cert: readFileSync(certPath, "utf-8"), key: readFileSync(keyPath, "utf-8") };
  }

  const isIP = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  const san = isIP ? `IP.1 = ${host}` : `DNS.1 = ${host}\nDNS.2 = *.${host}`;
  const cnf = `[req]\ndistinguished_name = dn\nreq_extensions = v3_req\nprompt = no\n[dn]\nCN = ${host}\n[v3_req]\nsubjectAltName = @alt\n[alt]\n${san}\n`;
  const cnfPath = join(caDir, `host-${safe}.cnf`);
  await Bun.write(cnfPath, cnf);

  await run(["openssl", "genrsa", "-out", keyPath, "2048"]);
  chmodSync(keyPath, 0o600);
  await run(["openssl", "req", "-new", "-key", keyPath, "-out", join(caDir, `host-${safe}.csr`), "-config", cnfPath]);
  await run([
    "openssl", "x509", "-req", "-in", join(caDir, `host-${safe}.csr`),
    "-CA", join(caDir, "ca-cert.pem"), "-CAkey", join(caDir, "ca-key.pem"), "-CAcreateserial",
    "-out", certPath, "-days", "3650", "-sha256",
    "-extfile", cnfPath, "-extensions", "v3_req",
  ]);

  return { cert: readFileSync(certPath, "utf-8"), key: readFileSync(keyPath, "utf-8") };
}

// Where the system trust store lives, per platform family. Checked in order;
// Debian-style first because that's what most containers are.
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu/Alpine
  "/etc/pki/tls/certs/ca-bundle.crt",   // RHEL/Fedora
  "/etc/ssl/ca-bundle.pem",             // openSUSE
  "/etc/ssl/cert.pem",                  // macOS, FreeBSD
];

/**
 * The trust bundle the machine already uses: an explicit user bundle
 * (corporate TLS inspection sets SSL_CERT_FILE/CURL_CA_BUNDLE) wins over the
 * platform store, so stacking cctrace on top of another MITM keeps working.
 */
export function systemCaBundle(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of [env.SSL_CERT_FILE, env.CURL_CA_BUNDLE]) {
    if (p && existsSync(p)) return p;
  }
  for (const p of SYSTEM_CA_BUNDLES) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Write system CAs + the mitm CA as one bundle for the env vars that REPLACE
 * the trust store (SSL_CERT_FILE and friends — unlike NODE_EXTRA_CA_CERTS,
 * which appends). The combination makes verification path-independent:
 * proxied requests verify via the mitm cert, direct/NO_PROXY ones via the
 * system CAs, so subprocesses never need to know which route a request took.
 *
 * Returns null when no system bundle can be found — exporting the mitm cert
 * alone would break every non-proxied TLS connection in every subprocess, so
 * the caller must skip those vars instead. Rebuilt on every startup (a cheap
 * concat) so system store updates are picked up; written via rename so
 * concurrent cctrace runs can't tear the file.
 */
export function buildCaBundle(caDir: string, sysBundle: string | null = systemCaBundle()): string | null {
  if (!sysBundle) return null;
  const caCert = readFileSync(join(caDir, "ca-cert.pem"), "utf-8");
  const out = join(caDir, "ca-bundle.pem");
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, readFileSync(sysBundle, "utf-8").trimEnd() + "\n" + caCert);
  renameSync(tmp, out);
  return out;
}

/**
 * Move a CA dir generated at a legacy location (pre-0.6: XDG cache) to its
 * current home. The CA is identity material — regenerating it would break any
 * trust the user exported with --print-ca — so it is moved, not recreated.
 * Per-host certs live flat in the same dir and move with it.
 *
 * No-op (returns false) when the source has no CA, the target already has
 * one, or the paths are the same. Throws only on hard filesystem errors.
 */
export function migrateCaDir(from: string, to: string): boolean {
  if (resolve(from) === resolve(to)) return false;
  if (!existsSync(join(from, "ca-cert.pem"))) return false;
  if (existsSync(join(to, "ca-cert.pem"))) return false;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    // Cross-device, or the target dir already exists — copy then remove.
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  chmodSync(to, 0o700);
  for (const key of ["ca-key.pem", "leaf-key.pem"]) {
    const p = join(to, key);
    if (existsSync(p)) chmodSync(p, 0o600);
  }
  return true;
}

/**
 * Hosts the pre-generated static leaf cert covers.
 * Other intercepted hosts get dynamically generated certs via generateHostCert.
 */
export function isInterceptHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "anthropic.com" || h.endsWith(".anthropic.com") ||
    h === "claude.ai" || h.endsWith(".claude.ai") ||
    h === "claude.com" || h.endsWith(".claude.com")
  );
}

/**
 * The SSL-proxying include-list (Charles' model, devlog 2026-07-15): only
 * these host suffixes get MITM'd; every other CONNECT is an opaque
 * byte-counted tunnel. Union of the traced client's own infrastructure
 * (firstPartyHosts), its pinned third-party hosts (hostCategories — the
 * telemetry sinks the UI reads), hosts from base-url env overrides found in
 * the spawn env, and --intercept-host extras.
 */
export function buildInterceptSet(
  wire: { firstPartyHosts: string[]; hostCategories: Array<[string, string]> },
  opts: { env?: Record<string, string | undefined>; extraHosts?: string[] } = {},
): string[] {
  const suffixes = new Set<string>();
  for (const h of wire.firstPartyHosts) suffixes.add(h.toLowerCase());
  for (const [hostPath] of wire.hostCategories) {
    const host = hostPath.split("/")[0];
    if (host) suffixes.add(host.toLowerCase());
  }
  const env = opts.env || {};
  for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"]) {
    const v = env[key];
    if (!v) continue;
    try {
      suffixes.add(new URL(v).hostname.toLowerCase());
    } catch {
      // not a URL — nothing to enroll
    }
  }
  for (const h of opts.extraHosts || []) {
    if (h) suffixes.add(h.toLowerCase().replace(/^\*\./, ""));
  }
  return [...suffixes];
}

/** True when host equals a set entry or is a subdomain of one. */
export function hostInSet(host: string, suffixes: Iterable<string>): boolean {
  const h = host.toLowerCase();
  for (const s of suffixes) {
    if (h === s || h.endsWith("." + s)) return true;
  }
  return false;
}
