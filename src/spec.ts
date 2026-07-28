// `cctrace spec` — the observed-wire catalog: what the traced CLI actually
// calls, stated as observations with provenance, never as inferred truth.
// The catalog names endpoints, methods, statuses, header NAMES, body field
// SHAPES (key + type + presence count), and SSE event types — each stamped
// with sample counts and first/last-seen timestamps. It deliberately is NOT
// an OpenAPI generator: "field x optional" is an inference; "x present in
// 940 of 1000 observed bodies" is a fact. An OpenAPI projection can be
// derived from the catalog later, once the catalog is trusted.
//
// Redaction is the gate, not a feature: no wire VALUES enter the catalog at
// all, except two allowlists whose values ARE the API surface — negotiation
// headers (content-type, anthropic-version, anthropic-beta, ...) and the
// body's `model` field. Auth material, prompts, ids, and everything else
// reduce to names, types, and counts. spec.test.ts asserts this.

import type { TracePair } from "./types";

export const CATALOG_FORMAT = "cctrace-wire-catalog/1";

/** Header names whose observed VALUES are part of the API surface (content
 * negotiation / feature flags). Everything else keeps the name only. */
const HEADER_VALUE_ALLOWLIST = new Set([
  "content-type",
  "accept",
  "accept-encoding",
  "content-encoding",
  "anthropic-version",
  "anthropic-beta",
]);

/** Body fields whose observed string values are enum-like surface facts. */
const BODY_VALUE_ALLOWLIST = new Set(["model"]);

const MAX_VALUES = 12; // per header/field — enum capture, not a data dump
const MAX_DEPTH = 5; // body shape recursion cap
const MAX_KEYS = 64; // per object node
const MAX_ARRAY_SAMPLE = 20; // array items merged per occurrence

export interface SpecShape {
  /** JSON types observed at this node ("string", "number", "object", ...). */
  types: string[];
  /** How many times this node was present. */
  seen: number;
  /** Allowlisted enum-like values (the `model` field), capped. */
  values?: string[];
  /** Object children — presence counted against the parent's `seen`. */
  fields?: Record<string, SpecShape>;
  /** Merged element shape for arrays. */
  items?: SpecShape;
  /** Set when an object had more keys than the catalog records. */
  truncated?: boolean;
}

export interface SpecHeader {
  seen: number;
  values?: string[];
}

export interface SpecEndpoint {
  host: string;
  /** Path with volatile segments normalized: {uuid}, {hex}, {n}. */
  path: string;
  method: string;
  samples: number;
  firstSeen: string; // ISO, from pair timestamps — never "now"
  lastSeen: string;
  statuses: Record<string, number>;
  requestHeaders: Record<string, SpecHeader>;
  responseHeaders: Record<string, SpecHeader>;
  requestBody?: SpecShape;
  responseBody?: SpecShape;
  /** SSE event type -> occurrence count, when responses stream. */
  sseEvents?: Record<string, number>;
}

export interface SpecCatalog {
  format: typeof CATALOG_FORMAT;
  generator: string; // "cctrace <version>"
  /** Observed client user-agents -> request count (provenance). */
  clients: Record<string, number>;
  pairsScanned: number;
  firstSeen?: string;
  lastSeen?: string;
  endpoints: SpecEndpoint[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{16,}$/i;
const NUM_RE = /^\d+$/;

/** Random-token segments (per-install eval ids like "sdk-zAZezfDKGoZu"):
 * an API word is one case ("count_tokens", "claude_code_grove"); three or
 * more lower->upper flips inside one segment is generated randomness, and
 * leaving it verbatim makes every diff churn on someone's install id. */
function looksRandom(seg: string): boolean {
  if (seg.length < 12 || !/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  let flips = 0;
  for (let i = 1; i < seg.length; i++) {
    if (/[a-z]/.test(seg[i - 1]!) && /[A-Z]/.test(seg[i]!)) flips++;
  }
  return flips >= 3;
}

/** /api/oauth/organizations/3f9a.../credits -> .../organizations/{uuid}/credits */
export function normalizePath(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      if (UUID_RE.test(seg)) return "{uuid}";
      if (HEX_RE.test(seg)) return "{hex}";
      if (NUM_RE.test(seg) && seg.length > 3) return "{n}";
      if (looksRandom(seg)) return "{token}";
      // embedded uuid, e.g. session_<uuid>
      return seg.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{uuid}");
    })
    .join("/");
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function mergeShape(shape: SpecShape | undefined, value: unknown, depth: number, key?: string): SpecShape {
  const t = jsonType(value);
  const s: SpecShape = shape ?? { types: [], seen: 0 };
  s.seen++;
  if (!s.types.includes(t)) s.types.push(t);
  if (
    key !== undefined &&
    BODY_VALUE_ALLOWLIST.has(key) &&
    typeof value === "string" &&
    value.length < 80
  ) {
    s.values = s.values ?? [];
    if (!s.values.includes(value) && s.values.length < MAX_VALUES) s.values.push(value);
  }
  if (depth >= MAX_DEPTH) return s;
  if (t === "object") {
    s.fields = s.fields ?? {};
    for (const k of Object.keys(value as object)) {
      if (Object.keys(s.fields).length >= MAX_KEYS && !(k in s.fields)) {
        s.truncated = true;
        continue;
      }
      s.fields[k] = mergeShape(s.fields[k], (value as Record<string, unknown>)[k], depth + 1, k);
    }
  } else if (t === "array") {
    for (const item of (value as unknown[]).slice(0, MAX_ARRAY_SAMPLE)) {
      s.items = mergeShape(s.items, item, depth + 1);
    }
  }
  return s;
}

function mergeHeaders(into: Record<string, SpecHeader>, headers: Record<string, unknown> | undefined) {
  if (!headers || typeof headers !== "object") return;
  for (const rawName of Object.keys(headers)) {
    const name = rawName.toLowerCase();
    const h = (into[name] = into[name] ?? { seen: 0 });
    h.seen++;
    if (HEADER_VALUE_ALLOWLIST.has(name)) {
      const v = String(headers[rawName] ?? "");
      if (v && v.length < 200) {
        h.values = h.values ?? [];
        if (!h.values.includes(v) && h.values.length < MAX_VALUES) h.values.push(v);
      }
    }
  }
}

/** Count `event: <type>` lines of an SSE response body. */
export function sseEventCounts(body: unknown): Record<string, number> | undefined {
  if (typeof body !== "string" || !/^(event|data):/m.test(body)) return undefined;
  const out: Record<string, number> = {};
  for (const m of body.matchAll(/^event:[ \t]*(\S+)/gm)) {
    out[m[1]!] = (out[m[1]!] ?? 0) + 1;
  }
  return Object.keys(out).length ? out : undefined;
}

function isoOf(ts: number | undefined): string | undefined {
  if (!ts || !isFinite(ts)) return undefined;
  return new Date(ts * 1000).toISOString();
}

export interface BuildSpecOptions {
  /** cctrace version string for the generator stamp. */
  generator?: string;
  /** Include pairs from foreign hosts (default: everything captured — the
   * caller pre-filters; tunnels are always skipped, nothing was decrypted). */
  includeTunnels?: boolean;
}

export interface SpecAccumulator {
  /** Fold one batch of pairs into the catalog — call per trace file so a
   * multi-GB log dir never has to fit in memory at once (a full-dir scan
   * holding every decoded body OOM'd on real data; exit 137). */
  add(pairs: TracePair[]): void;
  finish(): SpecCatalog;
}

export function createSpecAccumulator(opts: BuildSpecOptions = {}): SpecAccumulator {
  const endpoints = new Map<string, SpecEndpoint>();
  const clients: Record<string, number> = {};
  let scanned = 0;
  let t0 = Infinity;
  let t1 = 0;

  const add = (pairs: TracePair[]) => {
    for (const pair of pairs) {
      const req = pair?.request;
      if (!req?.url) continue;
      const resp = pair.response;
      // Opaque tunnels observed nothing — a CONNECT meta pair is transport
      // bookkeeping, not API surface.
      const respBody = resp?.body as { tunneled?: boolean } | null | undefined;
      if (req.method === "CONNECT" || (respBody && typeof respBody === "object" && respBody.tunneled)) continue;
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        continue;
      }
      scanned++;
      const method = (req.method || "GET").toUpperCase();
      const path = normalizePath(url.pathname);
      const key = `${url.hostname} ${method} ${path}`;
      const ep = endpoints.get(key) ?? {
        host: url.hostname,
        path,
        method,
        samples: 0,
        firstSeen: "",
        lastSeen: "",
        statuses: {},
        requestHeaders: {},
        responseHeaders: {},
      };
      endpoints.set(key, ep);
      ep.samples++;

      const ts = req.timestamp;
      if (ts) {
        t0 = Math.min(t0, ts);
        t1 = Math.max(t1, ts);
        const iso = isoOf(ts)!;
        if (!ep.firstSeen || iso < ep.firstSeen) ep.firstSeen = iso;
        if (!ep.lastSeen || iso > ep.lastSeen) ep.lastSeen = iso;
      }

      const ua = (req.headers as Record<string, string> | undefined)?.["user-agent"];
      if (ua) clients[ua] = (clients[ua] ?? 0) + 1;

      mergeHeaders(ep.requestHeaders, req.headers as Record<string, unknown>);
      if (req.body !== undefined && req.body !== null && typeof req.body === "object") {
        ep.requestBody = mergeShape(ep.requestBody, req.body, 0);
      }

      if (resp) {
        ep.statuses[String(resp.status ?? "none")] = (ep.statuses[String(resp.status ?? "none")] ?? 0) + 1;
        mergeHeaders(ep.responseHeaders, resp.headers as Record<string, unknown>);
        const sse = sseEventCounts(resp.body);
        if (sse) {
          ep.sseEvents = ep.sseEvents ?? {};
          for (const [ev, n] of Object.entries(sse)) ep.sseEvents[ev] = (ep.sseEvents[ev] ?? 0) + n;
        } else if (resp.body !== undefined && resp.body !== null && typeof resp.body === "object") {
          ep.responseBody = mergeShape(ep.responseBody, resp.body, 0);
        }
      } else {
        ep.statuses["none"] = (ep.statuses["none"] ?? 0) + 1;
      }
    }
  };

  const finish = (): SpecCatalog => {
    const list = [...endpoints.values()].sort(
      (a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    );
    return {
      format: CATALOG_FORMAT,
      generator: opts.generator ?? "cctrace",
      clients,
      pairsScanned: scanned,
      firstSeen: isoOf(t0 === Infinity ? undefined : t0),
      lastSeen: isoOf(t1 || undefined),
      endpoints: list,
    };
  };

  return { add, finish };
}

export function buildSpecCatalog(pairs: TracePair[], opts: BuildSpecOptions = {}): SpecCatalog {
  const acc = createSpecAccumulator(opts);
  acc.add(pairs);
  return acc.finish();
}

// ---- diff ----
// The catalog's killer output: what changed between two observations.
// "cc 2.1.30 added header x-claude-code-agent-id" is a changelog nobody
// else can produce.

export interface SpecDiff {
  addedEndpoints: string[];
  removedEndpoints: string[];
  changed: Array<{ endpoint: string; notes: string[] }>;
}

function epKey(e: SpecEndpoint): string {
  return `${e.method} ${e.host}${e.path}`;
}

/** Every "name: type" path of a shape tree, e.g. "messages[].role". */
function shapePaths(s: SpecShape | undefined, prefix: string, out: Set<string>) {
  if (!s) return;
  if (s.fields) {
    for (const [k, child] of Object.entries(s.fields)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      shapePaths(child, p, out);
    }
  }
  if (s.items) shapePaths(s.items, prefix + "[]", out);
}

export function diffSpecCatalogs(prev: SpecCatalog, next: SpecCatalog): SpecDiff {
  const prevByKey = new Map(prev.endpoints.map((e) => [epKey(e), e]));
  const nextByKey = new Map(next.endpoints.map((e) => [epKey(e), e]));
  const diff: SpecDiff = { addedEndpoints: [], removedEndpoints: [], changed: [] };

  for (const k of nextByKey.keys()) if (!prevByKey.has(k)) diff.addedEndpoints.push(k);
  for (const k of prevByKey.keys()) if (!nextByKey.has(k)) diff.removedEndpoints.push(k);

  for (const [k, n] of nextByKey) {
    const p = prevByKey.get(k);
    if (!p) continue;
    const notes: string[] = [];
    const addedIn = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      Object.keys(b).filter((x) => !(x in a));
    for (const h of addedIn(p.requestHeaders, n.requestHeaders)) notes.push(`+ request header ${h}`);
    for (const h of addedIn(n.requestHeaders, p.requestHeaders)) notes.push(`- request header ${h}`);
    for (const s of addedIn(p.statuses, n.statuses)) notes.push(`+ status ${s}`);
    for (const ev of addedIn(p.sseEvents ?? {}, n.sseEvents ?? {})) notes.push(`+ sse event ${ev}`);
    for (const ev of addedIn(n.sseEvents ?? {}, p.sseEvents ?? {})) notes.push(`- sse event ${ev}`);
    const pPaths = new Set<string>();
    const nPaths = new Set<string>();
    shapePaths(p.requestBody, "", pPaths);
    shapePaths(n.requestBody, "", nPaths);
    for (const path of nPaths) if (!pPaths.has(path)) notes.push(`+ request field ${path}`);
    for (const path of pPaths) if (!nPaths.has(path)) notes.push(`- request field ${path}`);
    if (notes.length) diff.changed.push({ endpoint: k, notes });
  }
  return diff;
}

export function renderSpecDiff(d: SpecDiff): string {
  const lines: string[] = [];
  for (const e of d.addedEndpoints) lines.push(`+ endpoint ${e}`);
  for (const e of d.removedEndpoints) lines.push(`- endpoint ${e}`);
  for (const c of d.changed) {
    lines.push(`~ ${c.endpoint}`);
    for (const nt of c.notes) lines.push(`    ${nt}`);
  }
  return lines.length ? lines.join("\n") : "no changes";
}

// ---- markdown ----

function shapeMd(s: SpecShape, name: string, of: number, indent: string, out: string[]) {
  const t = s.types.join("|");
  const vals = s.values?.length ? ` = ${s.values.join(", ")}` : "";
  const presence = of > 0 && s.seen < of ? ` (${s.seen}/${of})` : "";
  out.push(`${indent}- ${name}: ${t}${presence}${vals}`);
  if (out.length > 400) return; // a doc, not a dump
  if (s.fields) {
    for (const [k, child] of Object.entries(s.fields)) shapeMd(child, k, s.seen, indent + "  ", out);
    if (s.truncated) out.push(`${indent}  - ... more keys observed`);
  }
  if (s.items) shapeMd(s.items, "[]", s.seen, indent + "  ", out);
}

export function renderSpecMarkdown(c: SpecCatalog): string {
  const out: string[] = [];
  out.push(`# Observed wire catalog`);
  out.push("");
  out.push(
    `Generated by ${c.generator} from ${c.pairsScanned} captured request/response pairs` +
      (c.firstSeen ? `, observed ${c.firstSeen.slice(0, 10)} to ${(c.lastSeen ?? c.firstSeen).slice(0, 10)}` : "") +
      ".",
  );
  out.push("");
  out.push(
    "Every entry is an observation with a sample count, not a claim of the full API. " +
      "Header and body values are redacted except content-negotiation headers and model ids.",
  );
  const uas = Object.entries(c.clients).sort((a, b) => b[1] - a[1]);
  if (uas.length) {
    out.push("");
    out.push("Observed clients:");
    for (const [ua, n] of uas.slice(0, 10)) out.push(`- ${ua} (${n} requests)`);
  }
  for (const ep of c.endpoints) {
    out.push("");
    out.push(`## ${ep.method} ${ep.host}${ep.path}`);
    out.push("");
    const statuses = Object.entries(ep.statuses)
      .map(([s, n]) => `${s} x${n}`)
      .join(", ");
    out.push(`${ep.samples} samples, ${ep.firstSeen.slice(0, 10)} to ${ep.lastSeen.slice(0, 10)}. Status: ${statuses}.`);
    const hdr = (title: string, hs: Record<string, SpecHeader>, of: number) => {
      const names = Object.keys(hs).sort();
      if (!names.length) return;
      out.push("");
      out.push(`${title}:`);
      for (const nm of names) {
        const h = hs[nm]!;
        const presence = h.seen < of ? ` (${h.seen}/${of})` : "";
        out.push(`- ${nm}${presence}${h.values?.length ? `: ${h.values.join(", ")}` : ""}`);
      }
    };
    hdr("Request headers", ep.requestHeaders, ep.samples);
    if (ep.requestBody) {
      out.push("");
      out.push("Request body:");
      const body: string[] = [];
      if (ep.requestBody.fields) {
        for (const [k, child] of Object.entries(ep.requestBody.fields)) {
          shapeMd(child, k, ep.requestBody.seen, "", body);
        }
      }
      out.push(...body.slice(0, 200));
    }
    if (ep.sseEvents) {
      out.push("");
      out.push("SSE events:");
      for (const [ev, n] of Object.entries(ep.sseEvents).sort((a, b) => b[1] - a[1])) {
        out.push(`- ${ev} x${n}`);
      }
    }
  }
  out.push("");
  return out.join("\n");
}
