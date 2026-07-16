import { statSync, readdirSync, writeFileSync, renameSync } from "fs";
import { join, basename } from "path";
import { gzipSync } from "zlib";
import { readTraceText, isTraceFile } from "./history";
import { extractSessionId } from "./summarize";
import { threadSig, firstUserText } from "./session";
import { wireDialect, normalizeOpenaiTurns, openaiFirstUserText } from "./dialects/openai";
import type { TracePair } from "./types";

// `cctrace compact` — aggressive post-hoc trace shrinking. Measured on
// 4.3GB of real traces (52 files, 3.8k message pairs, 156 threads): 79% of
// ALL bytes were messages request bodies, and keeping only the longest
// request per thread retained everything the session view renders at 1.5%
// of the size.
//
// Two body-level folds, never whole-pair deletion (a folded pair costs ~1KB
// and keeps host/status/timing/ttft/usage — the wire story, per-turn
// attribution, error rates, and the audit trail; whole-pair purge stays
// `cctrace purge`, a privacy tool, not a size optimization):
//
//   1. Supersede-stub (messages): each turn re-sends the whole conversation,
//      so ~79% of ALL trace bytes are messages request bodies whose content
//      is a strict prefix of a later request's. Per thread-EPOCH the request
//      carrying the longest history stays full; every superseded request
//      body becomes a stub keeping exactly what reconstruction needs
//      (model, metadata/session id, historyLen for per-turn attribution,
//      firstUserText for thread grouping, a link to the kept request).
//      Epoch guard: when history length DROPS mid-thread (context
//      compaction, /clear), the epoch closes and keeps its own longest —
//      post-compaction history is not a superset. Responses are NEVER
//      touched (each exists exactly once).
//
//   2. Exemplar retention (telemetry/external/bootstrap): homogeneous noise
//      streams. Per (category, host, path): keep first + last + largest +
//      slowest + every error in full, collapse the rest to meta-only bodies
//      (byte counts). Deterministic, unlike random sampling — the one 500
//      that mattered is always an exemplar.
//
// Known loss, stated in --help too: the exact wire bytes of superseded
// request bodies. Mid-epoch system-prompt/tool-definition changes keep only
// the kept request's version; per-turn "what exactly was sent" diffing goes
// away. Capture stays lossless — compact is post-hoc only (the longest
// request isn't known until the session ends).
//
// Same safety discipline as storage.ts: plan() surveys without writing,
// apply() re-stats before every rewrite and skips files a live capture has
// appended to, tmp+rename writes, format preserved (.jsonl/.zst/.gz).
// Idempotent: stubs are recognizable (_cctrace_stub) and never re-folded.

export const COLLAPSE_CATS = new Set(["telemetry", "external", "bootstrap"]);
/** A collapse must save at least this many raw bytes to be worth the churn. */
const COLLAPSE_FLOOR = 1024;
/** Chars of first user text a stub keeps (threadSig uses the first 400). */
const STUB_TEXT_CHARS = 2000;

export type Categorize = (url: string, client?: string) => string;

export function isStubBody(v: unknown): boolean {
  return !!(v && typeof v === "object" && (v as any)._cctrace_stub);
}

/** Raw byte weight of a body value as it sits in the trace line. */
function jsonLen(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "string") return v.length;
  try { return JSON.stringify(v)?.length || 0; } catch { return 0; }
}

/** History length (turn count) of a model-call request — stubs remember theirs. */
export function histLenOf(pair: any): number {
  const body = pair?.request?.body;
  if (isStubBody(body)) return typeof body.historyLen === "number" ? body.historyLen : 0;
  if (wireDialect(pair) === "openai") {
    return Array.isArray(body?.input) ? normalizeOpenaiTurns(body.input).length : 0;
  }
  return Array.isArray(body?.messages) ? body.messages.length : 0;
}

/**
 * Thread grouping key, mirroring buildSession: session id + agent-id header
 * (Anthropic) / conv header (OpenAI) when present, else the first-user-text
 * signature. Stubs carry their firstUserText so they keep grouping equal.
 */
export function threadKeyOf(pair: any, wire?: any): string {
  const sid = extractSessionId(pair, wire);
  const headers = pair?.request?.headers || {};
  const body = pair?.request?.body || {};
  if (wireDialect(pair) === "openai") {
    const w = wire && pair.client ? wire[pair.client] : null;
    const convId = (w && w.threadHeader && headers[w.threadHeader]) || "";
    if (convId) return sid + "|conv:" + convId;
    const text = isStubBody(body) ? body.firstUserText || "" : openaiFirstUserText(body.input || []);
    return sid + "|osig:" + threadSig({ content: text });
  }
  const agentId = headers["x-claude-code-agent-id"] || "";
  if (agentId) return sid + "|agent:" + agentId;
  const first = isStubBody(body)
    ? { content: body.firstUserText || "" }
    : (Array.isArray(body.messages) && body.messages[0]) || { content: "" };
  return sid + "|sig:" + threadSig(first);
}

export interface CompactDecisions {
  /** pair index -> id of the kept (longest) request in its thread-epoch. */
  stub: Map<number, string>;
  /** pair indexes whose bodies collapse to meta-only. */
  collapse: Set<number>;
}

/**
 * Decide, for one file's pairs (aligned with its lines; null = unparseable
 * line, never touched), which request bodies to supersede-stub and which
 * noise pairs to collapse to meta-only. Pure and deterministic: apply()
 * re-runs it on fresh text and reaches the same answer.
 */
export function planDecisions(pairs: (TracePair | null)[], categorize: Categorize, wire?: any): CompactDecisions {
  const stub = new Map<number, string>();
  const collapse = new Set<number>();
  const ts = (p: any) => p?.request?.timestamp || 0;

  // ---- supersede-stub: messages, grouped by thread, split into epochs ----
  const threads = new Map<string, number[]>();
  for (let i = 0; i < pairs.length; i++) {
    const p: any = pairs[i];
    if (!p?.request?.url) continue;
    if (categorize(p.request.url, p.client) !== "messages") continue;
    if (!isStubBody(p.request.body) && histLenOf(p) === 0) continue; // not a model-call body
    const key = threadKeyOf(p, wire);
    let g = threads.get(key);
    if (!g) { g = []; threads.set(key, g); }
    g.push(i);
  }
  for (const idxs of threads.values()) {
    idxs.sort((a, b) => ts(pairs[a]) - ts(pairs[b]));
    const epochs: number[][] = [];
    let cur: number[] = [];
    let prevLen = -1;
    for (const i of idxs) {
      const len = histLenOf(pairs[i]);
      if (len < prevLen && cur.length) { epochs.push(cur); cur = []; }
      cur.push(i);
      prevLen = len;
    }
    if (cur.length) epochs.push(cur);
    for (const ep of epochs) {
      let keeper = -1;
      let keeperLen = -1;
      for (const i of ep) {
        if (isStubBody(pairs[i]!.request.body)) continue; // a stub can't anchor an epoch
        const len = histLenOf(pairs[i]);
        if (len >= keeperLen) { keeper = i; keeperLen = len; } // ties -> latest
      }
      if (keeper === -1) continue; // everything already stubbed
      for (const i of ep) {
        if (i === keeper || isStubBody(pairs[i]!.request.body)) continue;
        stub.set(i, pairs[keeper]!.id);
      }
    }
  }

  // ---- exemplar retention: noise categories, per (category, host, path) ----
  const endpoints = new Map<string, number[]>();
  for (let i = 0; i < pairs.length; i++) {
    const p: any = pairs[i];
    if (!p?.request?.url) continue;
    const cat = categorize(p.request.url, p.client);
    if (!COLLAPSE_CATS.has(cat)) continue;
    const r = p.response;
    if (r?.body?.tunneled) continue; // tunnel meta pairs are already ~100 bytes
    if (isStubBody(p.request.body) && (!r || isStubBody(r.body))) continue; // already collapsed
    let key = cat;
    try {
      const u = new URL(p.request.url);
      key = cat + "|" + u.host + "|" + u.pathname;
    } catch { /* keep category-only key */ }
    let g = endpoints.get(key);
    if (!g) { g = []; endpoints.set(key, g); }
    g.push(i);
  }
  const weight = (p: any) =>
    jsonLen(p.request.body) + jsonLen(p.response?.body) +
    (typeof p.response?.bodyRaw === "string" ? p.response.bodyRaw.length : 0);
  for (const idxs of endpoints.values()) {
    if (idxs.length < 3) continue; // nothing homogeneous to sample from
    idxs.sort((a, b) => ts(pairs[a]) - ts(pairs[b]));
    const exemplars = new Set<number>([idxs[0]!, idxs[idxs.length - 1]!]);
    let largest = idxs[0]!, slowest = idxs[0]!;
    for (const i of idxs) {
      const p: any = pairs[i];
      if (weight(p) > weight(pairs[largest])) largest = i;
      if ((p.duration || 0) > (pairs[slowest] as any).duration) slowest = i;
      const r = p.response;
      if (!r || r.status >= 400 || r.truncated) exemplars.add(i); // every error survives
    }
    exemplars.add(largest);
    exemplars.add(slowest);
    for (const i of idxs) {
      if (exemplars.has(i)) continue;
      if (weight(pairs[i]) < COLLAPSE_FLOOR) continue;
      collapse.add(i);
    }
  }

  return { stub, collapse };
}

/** Fold a superseded messages request body to its reconstruction stub. */
export function stubPair(p: TracePair, keptPairId: string): TracePair {
  const body: any = p.request.body;
  const text =
    wireDialect(p) === "openai"
      ? openaiFirstUserText(body?.input || [])
      : firstUserText(Array.isArray(body?.messages) && body.messages[0] ? body.messages[0].content : "");
  const stub: any = {
    _cctrace_stub: 1,
    kind: "superseded",
    model: body?.model ?? null,
    historyLen: histLenOf(p),
    firstUserText: String(text || "").slice(0, STUB_TEXT_CHARS),
    keptPairId,
    droppedBytes: jsonLen(body),
  };
  if (body && body.metadata !== undefined) stub.metadata = body.metadata; // session id lives here
  return { ...p, request: { ...p.request, body: stub } };
}

/** Collapse a noise pair's bodies to meta-only byte counts (envelope stays). */
export function collapsePair(p: TracePair): TracePair {
  const out: any = { ...p, request: { ...p.request } };
  if (out.request.body != null && !isStubBody(out.request.body)) {
    out.request.body = { _cctrace_stub: 1, kind: "meta", droppedBytes: jsonLen(p.request.body) };
  }
  if (p.response) {
    const r: any = { ...p.response };
    const dropped = (isStubBody(r.body) ? 0 : jsonLen(r.body)) + (typeof r.bodyRaw === "string" ? r.bodyRaw.length : 0);
    if (dropped > 0) {
      r.body = { _cctrace_stub: 1, kind: "meta", droppedBytes: dropped };
      delete r.bodyRaw;
    }
    out.response = r;
  }
  return out;
}

// ---- file plumbing: plan (survey) + apply (rewrite in place) ----

export interface CompactFilePlan {
  path: string;
  name: string;
  size: number;
  stubbed: number;
  collapsed: number;
  /** Raw line bytes saved by this file's rewrite (before re-compression). */
  savedBytes: number;
}

export interface CompactPlan {
  files: CompactFilePlan[];
  stubbed: number;
  collapsed: number;
  savedBytes: number;
}

function surveyFile(text: string, categorize: Categorize, wire?: any): { stubbed: number; collapsed: number; savedBytes: number; lines: string[] } {
  const rawLines = text.split("\n");
  const pairs: (TracePair | null)[] = rawLines.map((line) => {
    if (!line.trim()) return null;
    try { return JSON.parse(line); } catch { return null; } // torn tail: never touched
  });
  const dec = planDecisions(pairs, categorize, wire);
  let stubbed = 0, collapsed = 0, savedBytes = 0;
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (!line.trim()) continue;
    let out = line;
    if (dec.stub.has(i)) {
      out = JSON.stringify(stubPair(pairs[i]!, dec.stub.get(i)!));
      stubbed++;
    } else if (dec.collapse.has(i)) {
      out = JSON.stringify(collapsePair(pairs[i]!));
      collapsed++;
    }
    savedBytes += Math.max(0, line.length - out.length);
    lines.push(out);
  }
  return { stubbed, collapsed, savedBytes, lines };
}

export function planCompact(logDir: string, categorize: Categorize, wire?: any): CompactPlan {
  const files: CompactFilePlan[] = [];
  let stubbed = 0, collapsed = 0, savedBytes = 0;
  let names: string[];
  try { names = readdirSync(logDir); } catch { names = []; }
  for (const name of names) {
    const path = join(logDir, name);
    if (!isTraceFile(path)) continue;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    let text: string;
    try { text = readTraceText(path); } catch { continue; }
    const s = surveyFile(text, categorize, wire);
    if (s.stubbed === 0 && s.collapsed === 0) continue;
    files.push({ path, name: basename(path), size: st.size, stubbed: s.stubbed, collapsed: s.collapsed, savedBytes: s.savedBytes });
    stubbed += s.stubbed;
    collapsed += s.collapsed;
    savedBytes += s.savedBytes;
  }
  files.sort((a, b) => b.savedBytes - a.savedBytes);
  return { files, stubbed, collapsed, savedBytes };
}

const zstd = (data: string): Buffer => Buffer.from(Bun.zstdCompressSync(Buffer.from(data), { level: 19 }));

function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function applyCompact(plan: CompactPlan, categorize: Categorize, wire?: any): { rewritten: string[]; skipped: string[]; bytes: number } {
  const rewritten: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const f of plan.files) {
    // Re-stat: a live capture may have appended since the plan — replan the
    // file rather than fold lines the plan never saw.
    let st;
    try { st = statSync(f.path); } catch { skipped.push(f.name); continue; }
    if (st.size !== f.size) { skipped.push(f.name); continue; }
    let text: string;
    try { text = readTraceText(f.path); } catch { skipped.push(f.name); continue; }
    const s = surveyFile(text, categorize, wire); // deterministic re-decision on fresh text
    if (s.stubbed === 0 && s.collapsed === 0) { skipped.push(f.name); continue; }
    const out = s.lines.join("\n") + "\n";
    // Preserve the file's own format: archives stay archives.
    if (f.path.endsWith(".zst")) writeAtomic(f.path, zstd(out));
    else if (f.path.endsWith(".gz")) writeAtomic(f.path, gzipSync(out, { level: 9 }));
    else writeAtomic(f.path, out);
    let after = 0;
    try { after = statSync(f.path).size; } catch { /* report 0 */ }
    rewritten.push(f.name);
    bytes += Math.max(0, f.size - after);
  }
  return { rewritten, skipped, bytes };
}
