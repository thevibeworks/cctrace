export interface RequestData {
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Request body bytes on the wire, pre-decode (codex zstd: compressed size). */
  bodyBytes?: number;
}

export interface ResponseData {
  timestamp: number;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyRaw?: string;
  /** Response body bytes as received (identity encoding, so decoded size). */
  bodyBytes?: number;
  /** ms from request arrival to the first response body byte. */
  firstByteMs?: number;
  /** ms from request arrival to the first streamed token event (model calls). */
  firstTokenMs?: number;
  /** The upstream stream errored before finishing; body holds what arrived. */
  truncated?: boolean;
}

export interface TracePair {
  id: string;
  request: RequestData;
  response: ResponseData | null;
  duration: number;
  loggedAt: string;
  /** CLI that produced this traffic: claude | codex | grok. Absent pre-0.13. */
  client?: string;
  /** Source file base name when merged in from a previous run's trace. */
  prior?: string;
}

/**
 * A model call that has been FORWARDED and has no response yet — the live
 * "the model is thinking now" signal (docs/design/replay-stage.md). `id` is
 * the id the eventual TracePair carries, so a page drops the start when the
 * pair lands. Never written to the trace: it is live state, not a wire pair.
 */
export interface TraceStart {
  id: string;
  url: string;
  method: string;
  /** Request timestamp in epoch SECONDS — same unit as RequestData.timestamp. */
  ts: number;
  /** CLI that produced this traffic, stamped by the log sink like pair.client. */
  client?: string;
}

export interface TraceConfig {
  logDir: string;
  logName?: string;
  traceAll: boolean;
  includeAllRequests: boolean;
  openBrowser: boolean;
  serverPort?: number;
  serverMode?: boolean;
}

export const ANTHROPIC_HOSTS = [
  "api.anthropic.com",
  "platform.claude.com",
  "mcp-proxy.anthropic.com",
  "claude.ai",
  "downloads.claude.ai",
] as const;
