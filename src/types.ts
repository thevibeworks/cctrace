export interface RequestData {
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ResponseData {
  timestamp: number;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  bodyRaw?: string;
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
