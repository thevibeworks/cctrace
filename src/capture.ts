import { startProxy } from "./proxy";
import { startMitm } from "./mitm";
import { ensureCerts, buildCaBundle } from "./certs";
import type { TracePair, TraceStart } from "./types";

export type CaptureMode = "mitm" | "base-url";

export interface CaptureOptions {
  onPair: (pair: TracePair) => void;
  /**
   * A model call was forwarded and has no response yet (both proxy modes) —
   * the live page's "the model is thinking now" state. Carries the id the
   * eventual pair will have; ignored by static/legacy-node captures.
   */
  onStart?: (start: TraceStart) => void;
  logAll: boolean;
  cacheDir: string;
  /** Upstream host for base-url mode; MITM reads it from each request. */
  targetHost?: string;
  /** MITM include-list for mitm mode (buildInterceptSet in certs.ts). */
  interceptHosts?: string[];
  /** MITM every host instead of tunneling non-listed ones. */
  captureExternal?: boolean;
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

/**
 * Trace-identity vars for the spawned client, alongside the capturer's own
 * proxy/CA vars: subprocesses of a traced session (statuslines, hooks, nested
 * agents) get to KNOW they run under a capture and where — the trace file
 * always, the live UI port + run id when a live server exists. Node mode has
 * exported these names since day one; the proxy modes agree via this helper.
 */
export function traceIdentityEnv(
  logFile: string,
  instance?: { id?: string; port: number } | null,
): Record<string, string> {
  const env: Record<string, string> = { CCTRACE_TRACE_FILE: logFile };
  if (instance) {
    if (instance.id) env.CCTRACE_INSTANCE_ID = instance.id;
    env.CCTRACE_SERVER_PORT = String(instance.port);
  }
  return env;
}

/**
 * `--bypass-host` (#83): the named hosts talk DIRECT, with the tool's normal
 * non-proxy behavior. Injecting proxy env does not just change the route —
 * tools behave differently when a proxy is present (wrangler swaps undici's
 * global dispatcher for its own ProxyAgent and silently discards any
 * user-installed Agent; diagnosing that cost a traced session 4+ failed
 * attempts). Appends to the child's NO_PROXY/no_proxy, preserving any
 * inherited value. For hosts outside the intercept set the only loss is the
 * ~100-byte tunnel meta pair — they were opaque tunnels anyway.
 */
export function bypassHostEnv(
  hosts: string[],
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!hosts.length) return {};
  const inherited = env.NO_PROXY || env.no_proxy || "";
  const parts = inherited.split(",").map((s) => s.trim()).filter(Boolean);
  for (const h of hosts) if (!parts.includes(h)) parts.push(h);
  const merged = parts.join(",");
  return { NO_PROXY: merged, no_proxy: merged };
}

export async function createCapturer(mode: CaptureMode, opts: CaptureOptions): Promise<Capturer> {
  if (mode === "mitm") {
    const certs = await ensureCerts(opts.cacheDir, opts.onStatus);
    const server = await startMitm({
      caDir: certs.caDir,
      onPair: opts.onPair,
      onStart: opts.onStart,
      logAll: opts.logAll,
      interceptHosts: opts.interceptHosts,
      captureExternal: opts.captureExternal,
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
    onStart: opts.onStart,
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
