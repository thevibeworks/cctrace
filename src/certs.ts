import { existsSync, mkdirSync } from "fs";
import { join } from "path";

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
export async function ensureCerts(caDir: string): Promise<Certs> {
  const c = paths(caDir);
  if (
    existsSync(c.caCertPath) && existsSync(c.caKeyPath) &&
    existsSync(c.leafCertPath) && existsSync(c.leafKeyPath)
  ) {
    return c;
  }

  if (!existsSync(caDir)) mkdirSync(caDir, { recursive: true });

  // 1. CA key + self-signed CA cert (10y)
  await run(["openssl", "genrsa", "-out", c.caKeyPath, "2048"]);
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

  return c;
}

/**
 * Hosts cctrace terminates TLS for. Must be a subset of the leaf SANs.
 * Everything else is blind-tunneled through untouched.
 */
export function isInterceptHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "anthropic.com" || h.endsWith(".anthropic.com") ||
    h === "claude.ai" || h.endsWith(".claude.ai") ||
    h === "claude.com" || h.endsWith(".claude.com")
  );
}
