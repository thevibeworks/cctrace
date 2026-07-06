import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { type TracePair, type TraceConfig, type RequestData, type ResponseData, ANTHROPIC_HOSTS } from "./types";
import { generateHtml } from "./html";
import { redactPair } from "./redact";

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function shouldTrace(url: string, config: TraceConfig): boolean {
  if (url.includes("localhost:" + (config.serverPort || 7890))) return false;
  if (config.traceAll) return true;

  const customBase = process.env.ANTHROPIC_BASE_URL?.replace(/^https?:\/\//, "");
  const hosts = customBase ? [customBase, ...ANTHROPIC_HOSTS] : ANTHROPIC_HOSTS;
  const isAnthropicHost = hosts.some((h) => url.includes(h));
  const isBedrock = url.includes("bedrock-runtime.") && url.includes(".amazonaws.com");

  if (config.includeAllRequests) {
    return isAnthropicHost || isBedrock;
  }

  return (isAnthropicHost && url.includes("/v1/messages")) || isBedrock;
}

async function parseBody(body: BodyInit | null | undefined): Promise<unknown> {
  if (!body) return null;
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return body; }
  }
  return String(body);
}

async function parseResponse(res: Response): Promise<{ body?: unknown; bodyRaw?: string }> {
  const ct = res.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      return { body: await res.json() };
    }
    return { bodyRaw: await res.text() };
  } catch {
    return {};
  }
}

export interface ExtendedTraceConfig extends TraceConfig {
  serverPort?: number;
  serverMode?: boolean;
}

export class Tracer {
  private pairs: TracePair[] = [];
  private logFile: string = "";
  private htmlFile: string = "";
  private config: ExtendedTraceConfig;
  private originalFetch: typeof fetch;

  constructor(config: Partial<ExtendedTraceConfig> = {}) {
    this.config = {
      logDir: config.logDir || ".cctrace",
      logName: config.logName,
      traceAll: config.traceAll ?? false,
      includeAllRequests: config.includeAllRequests ?? false,
      openBrowser: config.openBrowser ?? true,
      serverPort: config.serverPort || 7890,
      serverMode: config.serverMode ?? false,
    };

    this.originalFetch = globalThis.fetch;

    if (!this.config.serverMode) {
      const dir = this.config.logDir;
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const base = this.config.logName || `trace-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5)}`;
      this.logFile = `${dir}/${base}.jsonl`;
      this.htmlFile = `${dir}/${base}.html`;

      writeFileSync(this.logFile, "");
      console.log(`[cctrace] Logs: ${this.logFile}`);
      console.log(`[cctrace] HTML: ${this.htmlFile}`);
    }
  }

  instrument(): void {
    if ((globalThis.fetch as any).__cctrace) return;

    const tracer = this;

    globalThis.fetch = async function (input, init = {}) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

      if (!shouldTrace(url, tracer.config)) {
        return tracer.originalFetch(input, init);
      }

      const id = generateId();
      const startTime = Date.now();

      const headers = init.headers
        ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
        : {};

      const request: RequestData = {
        timestamp: startTime / 1000,
        method: init.method || "GET",
        url,
        headers,
        body: await parseBody(init.body),
      };

      try {
        const res = await tracer.originalFetch(input, init);
        const endTime = Date.now();
        const cloned = res.clone();

        const response: ResponseData = {
          timestamp: endTime / 1000,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          ...(await parseResponse(cloned)),
        };

        const pair: TracePair = {
          id,
          request,
          response,
          duration: endTime - startTime,
          loggedAt: new Date().toISOString(),
        };

        tracer.log(pair);
        return res;
      } catch (err) {
        const pair: TracePair = {
          id,
          request,
          response: null,
          duration: Date.now() - startTime,
          loggedAt: new Date().toISOString(),
        };
        tracer.log(pair);
        throw err;
      }
    };

    (globalThis.fetch as any).__cctrace = true;
  }

  private log(pair: TracePair): void {
    // Same redaction choke point as the proxy modes (headers, bodies, URLs) so
    // no credential reaches disk / the live server, even on this legacy path.
    const safe = redactPair(pair);
    this.pairs.push(safe);

    if (this.config.serverMode) {
      this.postToServer(safe);
    } else {
      appendFileSync(this.logFile, JSON.stringify(safe) + "\n");
      this.generateHtmlFile();
    }
  }

  private postToServer(pair: TracePair): void {
    const url = `http://localhost:${this.config.serverPort}/api/pair`;
    this.originalFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pair),
    }).catch(() => {});
  }

  private generateHtmlFile(): void {
    const html = generateHtml(this.pairs);
    writeFileSync(this.htmlFile, html);
  }

  cleanup(): void {
    if (this.pairs.length > 0) {
      console.log(`\n[cctrace] Traced ${this.pairs.length} requests`);
    }
    if (!this.config.serverMode && this.pairs.length > 0) {
      console.log(`[cctrace] Log: ${this.logFile}`);
      console.log(`[cctrace] HTML: ${this.htmlFile}`);

      if (this.config.openBrowser) {
        try {
          const { spawn } = require("child_process");
          spawn("open", [this.htmlFile], { detached: true, stdio: "ignore" }).unref();
        } catch {}
      }
    }
  }

  getStats() {
    return {
      total: this.pairs.length,
      logFile: this.logFile,
      htmlFile: this.htmlFile,
    };
  }
}

let globalTracer: Tracer | null = null;
let cleanedUp = false;

export function init(config?: Partial<ExtendedTraceConfig>): Tracer {
  if (globalTracer) return globalTracer;

  globalTracer = new Tracer(config);
  globalTracer.instrument();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    globalTracer?.cleanup();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return globalTracer;
}
