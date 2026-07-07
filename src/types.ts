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
}

export interface TracePair {
  id: string;
  request: RequestData;
  response: ResponseData | null;
  duration: number;
  loggedAt: string;
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
