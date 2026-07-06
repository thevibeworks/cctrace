import { startProxy } from "./proxy";
import { startMitm } from "./mitm";
import { ensureCerts } from "./certs";
import type { TracePair } from "./types";

export type CaptureMode = "mitm" | "base-url";

export interface CaptureOptions {
  onPair: (pair: TracePair) => void;
  logAll: boolean;
  cacheDir: string;
  /** Upstream host for base-url mode; MITM reads it from each request. */
  targetHost?: string;
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
    const certs = await ensureCerts(opts.cacheDir);
    const server = await startMitm({
      caDir: certs.caDir,
      onPair: opts.onPair,
      logAll: opts.logAll,
    });
    const proxyUrl = `http://127.0.0.1:${server.port}`;
    return {
      mode,
      label: `MITM proxy ${proxyUrl} (all Anthropic hosts)`,
      env: {
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NODE_EXTRA_CA_CERTS: server.caCertPath,
        SSL_CERT_FILE: server.caCertPath,
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
