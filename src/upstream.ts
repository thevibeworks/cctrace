import { termWrite } from "./termlog";
import type { TransportFailure } from "./types";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const MESSAGES: Record<TransportFailure["kind"], string> = {
  connect: "upstream connection could not be established",
  dns: "upstream name resolution failed",
  tls: "upstream TLS handshake or certificate verification failed",
  reset: "upstream connection was reset; delivery state is unknown",
  timeout: "upstream timed out; delivery state is unknown",
  aborted: "upstream request was cancelled",
  unknown: "upstream transport failed; delivery state is unknown",
};

/** Fetch errors do not generally establish whether a POST reached the API. */
export function classifyUpstreamError(error: unknown): Pick<TransportFailure, "kind" | "code" | "message"> {
  const e = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  const raw = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "UNKNOWN";
  const code = /^[a-zA-Z0-9_]{1,64}$/.test(raw) ? raw : "UNKNOWN";
  let kind: TransportFailure["kind"] = "unknown";
  if (/^(ECONNREFUSED|ConnectionRefused|ENETUNREACH|EHOSTUNREACH)$/.test(code)) kind = "connect";
  else if (/^(ENOTFOUND|EAI_AGAIN|DNS_ENOTFOUND|DNS_ESERVFAIL|DNS_ETIMEOUT)$/.test(code)) kind = "dns";
  else if (/CERT|SSL|TLS/.test(code) || (typeof e?.message === "string" && /certificate verification/i.test(e.message))) kind = "tls";
  else if (/^(ECONNRESET|EPIPE|ConnectionClosed|SocketClosed)$/.test(code)) kind = "reset";
  else if (/^(ETIMEDOUT|TimeoutError)$/.test(code)) kind = "timeout";
  else if (code === "AbortError" || code === "ABORT_ERR") kind = "aborted";
  return { kind, code, message: MESSAGES[kind] };
}

export function upstreamRoute(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = new URL(url);
  const bypass = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase());
  if (bypass.some((s) => s === "*" || s === target.hostname || s === target.host ||
    (s.startsWith(".") && (target.hostname === s.slice(1) || target.hostname.endsWith(s))))) return "direct";
  const raw = target.protocol === "https:"
    ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
    : env.HTTP_PROXY || env.http_proxy;
  if (!raw) return "direct";
  try { return new URL(raw).origin; } catch { return "configured proxy"; }
}

export class UpstreamError extends Error {
  constructor(readonly detail: TransportFailure) {
    super(`cctrace: ${detail.message} (${detail.code}, via ${detail.via}, ${detail.attempts} attempt(s)).`);
    this.name = "UpstreamError";
  }
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** A per-capturer retry/diagnostic state; no request bodies are retained here. */
export function createUpstream(opts: {
  retryMs?: number;
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  report?: (line: string) => void;
} = {}) {
  const send = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? delay;
  const report = (line: string) => { try { (opts.report ?? termWrite)(line); } catch {} };
  const failures = new Map<string, { since: number; count: number }>();
  let recorderFailed = false;

  return {
    async fetch(url: string, init: RequestInit, modelCall: boolean): Promise<Response> {
      const start = now();
      const via = upstreamRoute(url);
      const route = `${new URL(url).host} via ${via}`;
      let attempts = 0;
      for (;;) {
        attempts++;
        const controller = new AbortController();
        const abort = () => controller.abort(init.signal?.reason);
        init.signal?.addEventListener("abort", abort, { once: true });
        try {
          init.signal?.throwIfAborted();
          const response = await send(url, { ...init, signal: controller.signal, ...(attempts > 1 ? { keepalive: false } : {}) });
          // Once streaming starts, captureTee owns disconnect/drain behavior.
          init.signal?.removeEventListener("abort", abort);
          const streak = failures.get(route);
          if (streak) {
            failures.delete(route);
            report(`[cctrace] Upstream HTTP response received: ${route}; ${streak.count} failed attempt(s) over ${Math.round((now() - streak.since) / 1000)}s`);
          }
          return response;
        } catch (error) {
          init.signal?.removeEventListener("abort", abort);
          const failure = classifyUpstreamError(init.signal?.aborted ? { name: "AbortError" } : error);
          const detail = { ...failure, elapsedMs: now() - start, attempts, via };
          if (failure.kind !== "aborted") {
            const streak = failures.get(route);
            if (streak) streak.count++;
            else {
              // Bound diagnostics for sessions contacting many distinct hosts.
              if (failures.size >= 64) failures.delete(failures.keys().next().value!);
              failures.set(route, { since: now(), count: 1 });
              report(`[cctrace] ${failure.message}: ${route} (${failure.code})`);
            }
          }
          const remaining = (opts.retryMs ?? 0) - detail.elapsedMs;
          const pause = Math.min(1000 * 2 ** (attempts - 1), 8000);
          // Manual redirects establish that a later TLS failure cannot be
          // from a redirect after the original POST was already processed.
          // Reset, timeout and TLS labels alone cannot prove pre-send state.
          const retry = modelCall && init.redirect === "manual" &&
            (/^(ECONNREFUSED|ConnectionRefused)$/.test(failure.code) || failure.kind === "dns") &&
            attempts < 6 && remaining > pause && !init.signal?.aborted;
          if (!retry) throw new UpstreamError(detail);
          try { await sleep(pause, init.signal); }
          catch { throw new UpstreamError({ ...detail, ...classifyUpstreamError({ name: "AbortError" }), elapsedMs: now() - start }); }
        }
      }
    },
    record(write: () => void) {
      try {
        write();
        if (recorderFailed) report("[cctrace] Recording resumed after a capture gap");
        recorderFailed = false;
      } catch {
        if (!recorderFailed) report("[cctrace] Recording failed; forwarding continues with a capture gap");
        recorderFailed = true;
      }
    },
  };
}
