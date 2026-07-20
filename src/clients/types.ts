// Client plugin layer: one self-describing module per traced client.
// The mitm capture core is client-agnostic — TLS interception + the combined
// CA bundle (#17) work for any CLI that honors HTTPS_PROXY and the standard
// cert env vars. What differs per client is how to find the binary and what
// its wire traffic means; both live here, so adding a client is one new file
// plus a registry entry — zero core edits.

/**
 * Declarative wire knowledge for one client. JSON-safe by design (string
 * prefixes, no regexes or functions): the merged tables are embedded into
 * the web UI page as data, the same way META/__PAIRS__ are.
 */
export interface ClientWire {
  /** Model-call wire shape: Anthropic /v1/messages vs OpenAI Responses. */
  dialect: "anthropic" | "openai";
  /** Host suffixes that are this client's own infrastructure. */
  firstPartyHosts: string[];
  /**
   * "host/path-prefix" -> category pins, first match wins. Applied after the
   * shape-first rules in categorizeUrl, before the first-party fallback.
   * Includes third-party analytics hosts the client is known to call
   * (mixpanel, otlp): they pin to telemetry so `purge --drop telemetry`
   * can sweep them.
   */
  hostCategories: Array<[string, string]>;
  /** Request header carrying the session id ("" = Anthropic body metadata). */
  sessionHeader: string;
  /**
   * Request BODY field carrying the session id, for clients that send it in
   * the payload instead of a header (kimi: prompt_cache_key). Checked after
   * sessionHeader. A "session_<uuid>" value yields the bare uuid.
   */
  sessionBodyField?: string;
  /** Request header carrying the thread/conversation id. */
  threadHeader: string;
}

export interface ClientPlugin {
  /** Selector word on the CLI: `cctrace codex -- ...` */
  name: string;
  /** Executable name for the $PATH fallback. */
  bin: string;
  /** Well-known install locations, tried before $PATH. */
  candidates: (home: string) => string[];
  /** Shown when the binary can't be found. */
  installHint: string;
  wire: ClientWire;
}

/** Back-compat alias — pre-plugin code imported ClientProfile. */
export type ClientProfile = ClientPlugin;
