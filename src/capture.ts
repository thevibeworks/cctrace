import { startProxy } from "./proxy";
import { startMitm } from "./mitm";
import { ensureCerts, buildCaBundle } from "./certs";
import type { TracePair } from "./types";

export type CaptureMode = "mitm" | "base-url";

export interface CaptureOptions {
  onPair: (pair: TracePair) => void;
  logAll: boolean;
  cacheDir: string;
  /** Upstream host for base-url mode; MITM reads it from each request. */
  targetHost?: string;
  /** Progress messages (cert generation, proxy start) for the CLI to print. */
  onStatus?: (msg: string) => void;
}

/**
 * A capture strategy: it runs a local server, tells us which env vars to inject
 * into the spawned Claude, and lets us flush/stop it. Both the base-url reverse
 * proxy and the TLS-intercepting MITM implement this, so the CLI spawns Claude
 * the same way regardless of mode.
 */
export interface Capturer {
  readonly mode: CaptureMode;
  readonly label: string;
  /** Env vars to merge into Claude's environment. */
  readonly env: Record<string, string>;
  /** Await in-flight response captures (call before stop on exit). */
  flush(): Promise<void>;
  stop(): void;
  pairCount(): number;
}

export async function createCapturer(mode: CaptureMode, opts: CaptureOptions): Promise<Capturer> {
  if (mode === "mitm") {
    const certs = await ensureCerts(opts.cacheDir, opts.onStatus);
    const server = await startMitm({
      caDir: certs.caDir,
      onPair: opts.onPair,
      logAll: opts.logAll,
    });
    const proxyUrl = `http://127.0.0.1:${server.port}`;
    opts.onStatus?.(`MITM proxy listening on ${proxyUrl}`);
    // Subprocesses inherit HTTPS_PROXY whether we like it or not, so they must
    // inherit the trust too (issue #17: statusline curl, gh, python hooks all
    // died on TLS verify — NODE_EXTRA_CA_CERTS is Node-only). The standard
    // vars REPLACE the trust store rather than extend it, hence the combined
    // system-CAs + mitm-CA bundle: proxied requests verify via the mitm cert,
    // direct/NO_PROXY ones via the system CAs. Without a system bundle we skip
    // the vars (mitm cert alone would break all non-proxied subprocess TLS).
    const bundle = buildCaBundle(certs.caDir);
    if (!bundle) {
      opts.onStatus?.("No system CA bundle found — non-Node subprocesses (curl, gh, ...) will fail TLS through the proxy");
    }
    return {
      mode,
      label: `MITM proxy ${proxyUrl} (all Anthropic hosts)`,
      //  - HTTPS_PROXY routes TLS through us (the front door does CONNECT).
      //    HTTP_PROXY stays unset: the front door only speaks CONNECT and
      //    405s plain HTTP, which would break subprocess http:// calls.
      //  - NODE_EXTRA_CA_CERTS *appends* our CA for Claude itself (Bun/Node).
      //  - SSL_CERT_FILE (OpenSSL, Go, Ruby, Python ssl), CURL_CA_BUNDLE
      //    (curl), REQUESTS_CA_BUNDLE (python-requests), NIX_SSL_CERT_FILE
      //    (nix-built tools) carry the combined bundle to everything else.
      env: {
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        NODE_EXTRA_CA_CERTS: server.caCertPath,
        ...(bundle
          ? { SSL_CERT_FILE: bundle, CURL_CA_BUNDLE: bundle, REQUESTS_CA_BUNDLE: bundle, NIX_SSL_CERT_FILE: bundle }
          : {}),
      },
      flush: () => server.flush(),
      stop: () => server.stop(),
      pairCount: () => server.pairCount(),
    };
  }

  // base-url mode
  const server = startProxy({
    targetHost: opts.targetHost,
    onPair: opts.onPair,
    logAll: opts.logAll,
  });
  const proxyUrl = `http://127.0.0.1:${server.port}`;
  return {
    mode,
    label: `base-url proxy ${proxyUrl} (/v1/messages only)`,
    env: { ANTHROPIC_BASE_URL: proxyUrl },
    flush: () => server.flush(),
    stop: () => server.stop(),
    pairCount: () => server.pairCount(),
  };
}
