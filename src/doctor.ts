// `cctrace doctor`: the DATA layer for context health — what one session's
// context window is made of, what in it is dead weight, what is duplicated,
// what the harness injected, and where the window went over time. Same
// division of labor as title/insights: cctrace computes the wire facts and
// applies fixed, named thresholds (the findings); the cctrace-doctor skill
// reads the JSON, drills into items with --show, and writes the
// recommendations. cctrace never calls a model.
//
// Every figure here is an ESTIMATE from the request body (≈4 chars/token,
// the same rule the Context view uses), anchored against the provider's
// own prompt-token count for the diagnosed step (`window.actual`,
// `window.calibration`). The window is exact by construction: the request
// body IS the assembled context.
import { createHash } from "crypto";
import { buildSession, mainThread, harnessNotes, harnessNoteKind, harnessPrompt } from "./session";
import { contextItems, contextTimeline, estTokens, ctxSnippet } from "./context";
import { modelWindow } from "./pricing";
import { costEvents } from "./cost";

/** The five harness nudges that repeat every step (session.ts harnessNotes). */
export const RECURRING_NOTES = new Set(["terminal caveat", "idle nudge", "tokens left", "output style", "date"]);

/** The thresholds behind every finding — named, fixed, printed with the
 * finding so a reader can argue with the rule instead of the verdict. */
export const DOCTOR_RULES = {
  overheadPct: 35,        // system + tool schemas + injections share of the window
  unusedToolTokens: 2000, // schema tokens of tools the thread never called
  unusedToolCount: 5,
  bigSystemSection: 4000, // one markdown section of the system prompt
  bigInjection: 3000,     // one one-off injected block
  recurringPct: 2,        // recurring nudges' share of the window
  dupWasted: 2000,        // exact-duplicate tokens beyond the first copy
  nearTokens: 3000,       // near-duplicate redundant tokens
  rereadCount: 3,         // same tool + same target, this many times
  bigResult: 8000,        // one tool result
  errorResults: 5,        // error results still in the window
  resultsPct: 60,         // tool results' share of the window
  windowPct: 80,          // the peak's share of the model's context window
  cacheHitPct: 85,        // cache hit share over the thread
  calibration: 0.4,       // |actual/est - 1| beyond this = the estimate is off
  nearJaccard: 0.5,       // line-set similarity to call two blocks near-duplicates
  nearMinTokens: 300,     // blocks below this are not worth a near-dup check
  dupMinTokens: 25,       // exact-dup groups below this per copy are noise
} as const;

export interface DoctorFinding {
  id: string;
  level: "high" | "warn" | "info";
  title: string;
  detail: string;
  tokens?: number;
  /** A --show key that opens the evidence, when one item is the evidence. */
  show?: string;
  rule?: string;
}

export interface DoctorOpts {
  /** Diagnose the step whose pair id starts with this (default: the latest). */
  step?: string;
  /** Diagnose the heaviest step instead of the latest. */
  peak?: boolean;
  /** Pick the thread whose key contains this (default: the main chat). */
  thread?: string;
  /** Wall-clock for `generatedAt`. */
  nowMs?: number;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** An image block as text: a short hash of its bytes, so two screenshots
 * never read as the same block (they did — every image was "[image]"). */
function imageMark(b: any): string {
  const data = b && b.source && typeof b.source.data === "string" ? b.source.data : "";
  return data ? `[image ${sha(data)} ${data.length}b64]` : "[image]";
}

/** The full text behind one context item — what --show prints. */
export function itemText(b: any): string {
  if (!b) return "";
  if (b.type === "text") return String(b.text || "");
  if (b.type === "thinking") return String(b.thinking || "");
  if (b.type === "tool_result") {
    const c = b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((x: any) => (x && x.type === "text" ? String(x.text || "") : x && x.type === "image" ? imageMark(x) : "")).join("\n");
    }
    try { return JSON.stringify(c) || ""; } catch { return ""; }
  }
  if (b.type === "tool_use" || b.type === "server_tool_use") {
    try { return JSON.stringify(b.input, null, 1) || ""; } catch { return ""; }
  }
  if (b.type === "image") return imageMark(b);
  // A tool schema (no `type`), or an unknown block: its JSON.
  try { return JSON.stringify(b, null, 1) || ""; } catch { return ""; }
}

/**
 * A system prompt split on its markdown headings (#, ##, ###) — the
 * breakdown of the big block: which SECTION is the weight. Text before the
 * first heading is "(preamble)". One section = the block has no headings.
 */
export function systemSections(text: string): { heading: string; chars: number; tokens: number }[] {
  const out: { heading: string; chars: number }[] = [];
  let cur = { heading: "(preamble)", chars: 0 };
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur.chars) out.push(cur);
      cur = { heading: m[2]!, chars: 0 };
    }
    cur.chars += line.length + (i < lines.length - 1 ? 1 : 0); // sections sum to text.length
  }
  if (cur.chars) out.push(cur);
  return out.map((s) => ({ ...s, tokens: estTokens(s.chars) }));
}

/**
 * The files inside a "project instructions" / memory injection: Claude
 * Code concatenates them as "Contents of <path> (<what>):" runs. One
 * entry per file with its size, so "CLAUDE.md is 12k of the 14k" reads
 * off the report. Empty when the text carries no such run.
 */
export function injectionParts(text: string): { file: string; chars: number; tokens: number }[] {
  const re = /^Contents of (.+?) \([^)]*\):?\s*$/gm;
  const marks: { file: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ file: m[1]!, at: m.index });
  if (!marks.length) return [];
  return marks.map((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.at : text.length;
    const chars = end - mk.at;
    return { file: mk.file, chars, tokens: estTokens(chars) };
  });
}

/** The target a tool call names — what "the same thing again" means per
 * tool. "" = the tool has no re-readable target (Edit, Write, Agent...). */
export function toolTarget(name: string, input: any): string {
  const inp = input || {};
  const s = (v: any) => (typeof v === "string" ? v.trim() : "");
  switch (name) {
    case "Read": case "read_file": case "view_file": return s(inp.file_path || inp.path || inp.target_file);
    case "Bash": case "shell": case "run_terminal_cmd": return s(inp.command || (Array.isArray(inp.command) ? inp.command.join(" ") : "")).slice(0, 400);
    case "Grep": case "grep_search": return s(inp.pattern) + (inp.path ? " " + s(inp.path) : "");
    case "Glob": case "file_search": return s(inp.pattern) + (inp.path ? " " + s(inp.path) : "");
    case "WebFetch": case "fetch": return s(inp.url);
    case "WebSearch": return s(inp.query);
    case "LS": case "list_dir": return s(inp.path);
    default:
      if (/^mcp__/.test(name)) return s(inp.path || inp.file_path || inp.url || inp.uri || inp.query || "");
      return "";
  }
}

/**
 * Near-duplicate blocks by line-set Jaccard: two blocks that share most of
 * their lines (a file read twice with a small edit between, a command's
 * output re-run, a partially overlapping Read range) without being
 * byte-identical. Inverted index over trimmed lines >= 12 chars; only pairs
 * that share at least one line are compared, so a window with hundreds of
 * big results stays cheap. Returns pairs with similarity >= threshold,
 * best first.
 */
export function nearDuplicates(
  blocks: { key: string; text: string; tokens: number }[],
  threshold = DOCTOR_RULES.nearJaccard,
): { a: string; b: string; similarity: number; shared: number; tokens: number }[] {
  const lineIds = new Map<string, number>();
  const sets: Set<number>[] = [];
  const index = new Map<number, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const set = new Set<number>();
    const lines = blocks[i]!.text.split("\n");
    for (let li = 0; li < lines.length && li < 5000; li++) {
      const l = lines[li]!.trim();
      if (l.length < 12) continue;
      let id = lineIds.get(l);
      if (id === undefined) { id = lineIds.size; lineIds.set(l, id); }
      set.add(id);
    }
    sets.push(set);
    for (const id of set) {
      const arr = index.get(id);
      if (arr) arr.push(i); else index.set(id, [i]);
    }
  }
  const co = new Map<number, number>(); // (i * n + j) -> shared lines
  const n = blocks.length;
  for (const arr of index.values()) {
    if (arr.length < 2 || arr.length > 64) continue; // a line in >64 blocks is boilerplate, not evidence
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const k = arr[x]! * n + arr[y]!;
        co.set(k, (co.get(k) || 0) + 1);
      }
    }
  }
  const out: { a: string; b: string; similarity: number; shared: number; tokens: number }[] = [];
  for (const [k, shared] of co) {
    const i = Math.floor(k / n), j = k % n;
    const union = sets[i]!.size + sets[j]!.size - shared;
    if (union <= 0) continue;
    const sim = shared / union;
    if (sim < threshold) continue;
    if (sets[i]!.size < 3 || sets[j]!.size < 3) continue;
    out.push({ a: blocks[i]!.key, b: blocks[j]!.key, similarity: Math.round(sim * 100) / 100, shared, tokens: Math.min(blocks[i]!.tokens, blocks[j]!.tokens) });
  }
  out.sort((p, q) => q.tokens - p.tokens || q.similarity - p.similarity);
  return out;
}

/**
 * Diagnose one session. `pairs` is the session's pair set (what view
 * resolves — every run of the session, folded or not); the report reads
 * the main chat thread (or `opts.thread`), diagnoses its latest request
 * window (or `opts.step` / `opts.peak`), and folds the thread's whole
 * timeline for the over-time facts. Returns null when no model call
 * reconstructs. `show(key)` opens the text behind any item the report
 * names by `key` — the drill-down the skill uses.
 */
export function diagnoseSession(pairs: any[], wire?: any, opts: DoctorOpts = {}): { report: any; show: (key: string) => string | null } | null {
  const session = buildSession(pairs, wire);
  const threads: any[] = session.threads || [];
  if (!threads.length) return null;
  const main = opts.thread
    ? threads.find((t) => String(t.key || "").indexOf(opts.thread!) !== -1 || String(t.label || "").indexOf(opts.thread!) !== -1)
    : mainThread(threads);
  if (!main) return null;
  const byId: Record<string, any> = {};
  for (const p of pairs) if (p && p.id) byId[p.id] = p;
  const pairOf = (id: string) => byId[id];
  const threadPairs: any[] = (main.pairIds || []).map(pairOf).filter(Boolean);
  const tl = contextTimeline(threadPairs, main.compactions, pairOf);
  const stepsWithComp = tl.steps.filter((s: any) => s.sums);
  if (!stepsWithComp.length) return null;

  // ---- which step ----
  const weight = (s: any) => (s.actualIn != null ? s.actualIn : s.est);
  // The heaviest step; on a tie the deeper (later) one — the provider
  // count is the same, the body holds more.
  const heavier = (a: any, b: any) => (weight(b) > weight(a) || (weight(b) === weight(a) && b.est >= a.est) ? b : a);
  let step: any = stepsWithComp[stepsWithComp.length - 1];
  let pick = "latest";
  if (opts.step) {
    const hit = stepsWithComp.find((s: any) => String(s.pairId).indexOf(opts.step!) === 0);
    if (hit) { step = hit; pick = "step"; }
  } else if (opts.peak) {
    step = stepsWithComp.reduce(heavier, stepsWithComp[0]);
    pick = "peak";
  }
  const peakStep = stepsWithComp.reduce(heavier, stepsWithComp[0]);
  const pair = pairOf(step.pairId);
  const items = contextItems(pair, pairOf);
  if (!items) return null;

  // ---- keys: every item addressable for --show ----
  const keyed: Record<string, any> = {};
  const perTurnOrd: Record<string, number> = {};
  const prefixOf: Record<string, string> = { system: "sys", tools: "tool", user: "user", inject: "inj", assistant: "asst", toolResult: "res" };
  for (const cat in items.cats) {
    const list = items.cats[cat];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      let key: string;
      if (cat === "system") key = "sys:" + i;
      else if (cat === "tools") key = "tool:" + it.label;
      else {
        const slot = cat + ":" + it.ti;
        const ord = perTurnOrd[slot] || 0;
        perTurnOrd[slot] = ord + 1;
        key = prefixOf[cat] + ":" + it.ti + (ord ? "." + ord : "");
      }
      it.key = key;
      keyed[key] = it;
    }
  }

  const actual = step.actualIn != null
    ? { input: (pair._ci && pair._ci.input) || 0, cacheRead: step.cacheRead || 0, cacheWrite: (pair._ci && pair._ci.cacheWrite) || 0, total: step.actualIn }
    : null;
  const total = items.est;
  const sums = step.sums;

  // ---- system prompt ----
  const rawSys = (pair.request && pair.request.body && pair.request.body.system) || null;
  const sysBlocks = items.cats.system.map((it: any, i: number) => {
    const text = String(it.b.text || "");
    const secs = systemSections(text);
    const raw = Array.isArray(rawSys) ? rawSys[i] : null;
    return {
      key: it.key,
      tokens: it.tokens,
      chars: text.length,
      head: clip(ctxSnippet(text, 90), 90),
      hash: sha(norm(text)),
      cacheControl: !!(raw && raw.cache_control),
      // Claude Code's leading billing block mutates every request by design
      // (session.ts compares identity on the first NON-billing block); its
      // versions are counted, never flagged.
      billing: text.lastIndexOf("x-anthropic-billing-header", 0) === 0,
      sections: secs.length > 1 ? secs.map((s, j) => ({ key: it.key + "/" + j, heading: s.heading, tokens: s.tokens })) : [],
    };
  });
  // Versions across the thread: how many distinct texts each block index
  // carried over every full-body request — a changing system prompt is a
  // cache miss every time it changes.
  const versions: Set<string>[] = sysBlocks.map(() => new Set<string>());
  let sysChanges = 0;
  {
    let prevSig = "";
    for (const p of threadPairs) {
      const b = p.request && p.request.body;
      if (!b || b._cctrace_stub) continue;
      const sys = typeof b.system === "string" ? [{ text: b.system }] : Array.isArray(b.system) ? b.system : [];
      const sig: string[] = [];
      for (let i = 0; i < sys.length; i++) {
        const text = String((sys[i] && sys[i].text) || "");
        const h = sha(norm(text));
        if (versions[i]) versions[i]!.add(h);
        if (text.lastIndexOf("x-anthropic-billing-header", 0) !== 0) sig.push(h);
      }
      const s = sig.join(",");
      if (prevSig && s !== prevSig) sysChanges++;
      prevSig = s;
    }
  }
  for (let i = 0; i < sysBlocks.length; i++) sysBlocks[i].versions = versions[i]!.size || 1;

  // ---- tool schemas ----
  const calls: Record<string, number> = {};
  for (const turn of main.turns || []) {
    if (turn.role !== "assistant") continue;
    for (const b of turn.blocks || []) {
      if (b && (b.type === "tool_use" || b.type === "server_tool_use") && b.name) calls[b.name] = (calls[b.name] || 0) + 1;
    }
  }
  // A tool marked defer_loading (Claude Code's MCP tools, and the
  // DeferredToolPlaceholder that keeps the mechanism on) is not in the
  // prompt until the model searches for it — its schema is on the wire but
  // not paid for on every request, so it is never "dead weight".
  const toolRows = items.cats.tools.map((it: any) => ({ key: it.key, name: it.label, tokens: it.tokens, calls: calls[it.label] || 0, deferred: !!(it.b && it.b.defer_loading) || it.label === "DeferredToolPlaceholder" }));
  const byOrigin: Record<string, any> = {};
  for (const t of toolRows) {
    const okey = /^mcp__/.test(t.name) ? "mcp:" + t.name.slice(5).split("__")[0] : "builtin";
    let g = byOrigin[okey];
    if (!g) g = byOrigin[okey] = { origin: okey, count: 0, tokens: 0, called: 0, unused: [] as string[] };
    g.count++; g.tokens += t.tokens;
    if (t.deferred) g.deferred = (g.deferred || 0) + 1;
    if (t.calls) g.called++; else if (!t.deferred) g.unused.push(t.name);
  }
  const unusedTools = toolRows.filter((t: any) => !t.calls && !t.deferred);
  const deferredTools = toolRows.filter((t: any) => t.deferred);
  const tools = {
    count: toolRows.length,
    tokens: sums.tools,
    byOrigin: Object.values(byOrigin).sort((a: any, b: any) => b.tokens - a.tokens),
    unused: { count: unusedTools.length, tokens: unusedTools.reduce((n: number, t: any) => n + t.tokens, 0), names: unusedTools.map((t: any) => t.name) },
    deferred: { count: deferredTools.length, tokens: deferredTools.reduce((n: number, t: any) => n + t.tokens, 0) },
    top: toolRows.slice().sort((a: any, b: any) => b.tokens - a.tokens).slice(0, 10),
  };

  // ---- injections in the window ----
  const recurring: Record<string, { kind: string; count: number; tokens: number }> = {};
  const oneOff: any[] = [];
  let reminderBlocks = 0;
  for (const it of items.cats.inject) {
    const text = String(it.b.text || "");
    if (text.indexOf("<system-reminder>") !== -1) reminderBlocks++;
    // The wrapper tags are not the note: classify the words inside them.
    const bare = text.replace(/<\/?system-reminder>/g, "").trim();
    const notes = harnessNotes(bare);
    if (!notes.injection) {
      for (const n of notes.notes) {
        const r = recurring[n.kind] || (recurring[n.kind] = { kind: n.kind, count: 0, tokens: 0 });
        r.count++; r.tokens += estTokens(n.chars);
      }
      continue;
    }
    const n = notes.notes[0];
    const kind = n.kind !== "note" ? n.kind : harnessPrompt(bare) || (it.src && it.src.length <= 24 ? it.src : "note");
    const parts = injectionParts(bare);
    oneOff.push({
      key: it.key, ti: it.ti, kind, tokens: it.tokens, head: n.head, src: it.src,
      ...(parts.length ? { parts } : {}),
    });
  }
  oneOff.sort((a, b) => b.tokens - a.tokens);
  const recurringList = Object.values(recurring).sort((a, b) => b.tokens - a.tokens);
  const recurringTokens = recurringList.reduce((n, r) => n + r.tokens, 0);
  const injections = {
    count: items.cats.inject.length,
    tokens: sums.inject,
    reminderBlocks,
    recurring: recurringList,
    recurringTokens,
    oneOff: oneOff.slice(0, 30),
    oneOffTokens: oneOff.reduce((n, o) => n + o.tokens, 0),
  };
  // Over the whole thread (every step's appended injections), by producer.
  const byProducer: Record<string, { label: string; count: number; tokens: number }> = {};
  for (const ev of tl.events) {
    if (ev.kind !== "inject") continue;
    const r = byProducer[ev.label] || (byProducer[ev.label] = { label: ev.label, count: 0, tokens: 0 });
    r.count++; r.tokens += ev.tokens || 0;
  }

  // ---- conversation ----
  let asstText = 0, asstThink = 0, asstCalls = 0;
  for (const it of items.cats.assistant) {
    if (it.kind === "thinking") asstThink += it.tokens;
    else if (it.kind === "tool_use") asstCalls += it.tokens;
    else asstText += it.tokens;
  }
  const userTokens = sums.user;
  const conversation = {
    userMessages: items.cats.user.filter((it: any) => it.kind === "text").length,
    userTokens,
    assistant: { text: asstText, thinking: asstThink, toolCalls: asstCalls, total: sums.assistant },
  };

  // ---- tool results ----
  const byTool: Record<string, any> = {};
  let errCount = 0, errTokens = 0, overCount = 0, overTokens = 0;
  for (const it of items.cats.toolResult) {
    const name = it.toolName || "?";
    const g = byTool[name] || (byTool[name] = { name, count: 0, tokens: 0, errors: 0 });
    g.count++; g.tokens += it.tokens; if (it.err) g.errors++;
    if (it.err) { errCount++; errTokens += it.tokens; }
    if (it.tokens >= DOCTOR_RULES.bigResult) { overCount++; overTokens += it.tokens; }
  }
  const largest = items.cats.toolResult.slice().sort((a: any, b: any) => b.tokens - a.tokens).slice(0, 12)
    .map((it: any) => ({ key: it.key, ti: it.ti, tool: it.toolName || "?", tokens: it.tokens, label: clip(it.label, 100), err: !!it.err }));
  const results = {
    count: items.cats.toolResult.length,
    tokens: sums.toolResult,
    byTool: Object.values(byTool).sort((a: any, b: any) => b.tokens - a.tokens),
    largest,
    errors: { count: errCount, tokens: errTokens },
    over: { threshold: DOCTOR_RULES.bigResult, count: overCount, tokens: overTokens },
  };

  // ---- duplicates ----
  // textTokens = the words alone: a screenshot result is ~1.5k of image and
  // 100 chars of caption, and two captions sharing their lines are not a
  // near-duplicate of anything worth 3k.
  const dupCandidates: { key: string; cat: string; label: string; ti: number; text: string; tokens: number; textTokens: number }[] = [];
  for (const cat of ["toolResult", "inject", "user", "system"]) {
    for (const it of items.cats[cat]) {
      const text = itemText(it.b);
      if (!text) continue;
      dupCandidates.push({ key: it.key, cat, label: clip(it.label, 100), ti: it.ti, text, tokens: it.tokens, textTokens: estTokens(text.length) });
    }
  }
  const groups: Record<string, any> = {};
  for (const c of dupCandidates) {
    if (c.tokens < DOCTOR_RULES.dupMinTokens) continue;
    const h = sha(norm(c.text));
    const g = groups[h] || (groups[h] = { hash: h, cat: c.cat, label: c.label, tokens: c.tokens, count: 0, keys: [] as string[], turns: [] as number[] });
    g.count++; g.keys.push(c.key); g.turns.push(c.ti);
  }
  const exact = Object.values(groups).filter((g: any) => g.count > 1)
    .map((g: any) => ({ ...g, wasted: (g.count - 1) * g.tokens }))
    .sort((a: any, b: any) => b.wasted - a.wasted);
  const exactWasted = exact.reduce((n: number, g: any) => n + g.wasted, 0);
  const exactKeys = new Set<string>();
  for (const g of exact) for (const k of g.keys.slice(1)) exactKeys.add(k);
  const nearIn = dupCandidates.filter((c) => c.cat !== "system" && c.textTokens >= DOCTOR_RULES.nearMinTokens && !exactKeys.has(c.key))
    .sort((a, b) => b.textTokens - a.textTokens).slice(0, 800)
    .map((c) => ({ ...c, tokens: c.textTokens }));
  const nearRaw = nearDuplicates(nearIn);
  const labelOf: Record<string, any> = {};
  for (const c of nearIn) labelOf[c.key] = c;
  const near = nearRaw.slice(0, 20).map((p) => ({
    a: { key: p.a, label: labelOf[p.a].label, ti: labelOf[p.a].ti, tokens: labelOf[p.a].tokens },
    b: { key: p.b, label: labelOf[p.b].label, ti: labelOf[p.b].ti, tokens: labelOf[p.b].tokens },
    similarity: p.similarity, sharedLines: p.shared, tokens: p.tokens,
  }));
  const nearTokens = nearRaw.reduce((n, p) => n + p.tokens, 0);
  // Pairs fold into CLUSTERS (union-find): "one CLAUDE.md, three copies"
  // reads as one row, not three pairs.
  const parent: Record<string, string> = {};
  const find = (x: string): string => (parent[x] === x || parent[x] === undefined ? (parent[x] = x) : (parent[x] = find(parent[x]!)));
  for (const p of nearRaw) { parent[find(p.a)] = find(p.b); }
  const clusters: Record<string, { keys: string[]; minSim: number }> = {};
  for (const p of nearRaw) {
    const root = find(p.a);
    const c = clusters[root] || (clusters[root] = { keys: [], minSim: 1 });
    for (const kk of [p.a, p.b]) if (c.keys.indexOf(kk) === -1) c.keys.push(kk);
    if (p.similarity < c.minSim) c.minSim = p.similarity;
  }
  const nearGroups = Object.values(clusters).map((c) => {
    const first = labelOf[c.keys[0]!];
    const toks = c.keys.map((kk) => labelOf[kk].tokens);
    return { keys: c.keys, copies: c.keys.length, label: first.label, cat: first.cat, tokens: Math.max(...toks), redundant: toks.reduce((n, t) => n + t, 0) - Math.max(...toks), minSimilarity: c.minSim };
  }).sort((a, b) => b.redundant - a.redundant);
  // Re-reads: the same tool asked the same thing again — the content sits
  // in the window once per ask.
  const resultTokensByCall: Record<string, number> = {};
  for (const it of items.cats.toolResult) if (it.b && it.b.tool_use_id) resultTokensByCall[it.b.tool_use_id] = it.tokens;
  const asks: Record<string, any> = {};
  for (const it of items.cats.assistant) {
    if (it.kind !== "tool_use") continue;
    const target = toolTarget(it.toolName, it.b.input);
    if (!target) continue;
    const k = it.toolName + " " + target;
    const g = asks[k] || (asks[k] = { tool: it.toolName, target: clip(target, 160), count: 0, tokens: 0, turns: [] as number[] });
    g.count++; g.tokens += resultTokensByCall[it.b.id] || 0; g.turns.push(it.ti);
  }
  const rereads = Object.values(asks).filter((g: any) => g.count > 1).sort((a: any, b: any) => b.tokens - a.tokens || b.count - a.count);
  const duplicates = {
    exact: exact.slice(0, 30), exactGroups: exact.length, exactWasted,
    near, nearPairs: nearRaw.length, nearTokens, nearGroups: nearGroups.slice(0, 20),
    rereads: rereads.slice(0, 30), rereadTokens: rereads.reduce((n: number, g: any) => n + g.tokens - g.tokens / g.count, 0) | 0,
  };

  // ---- timeline ----
  let cacheRead = 0, promptIn = 0;
  for (const s of tl.steps) { if (s.actualIn != null) { promptIn += s.actualIn; cacheRead += s.cacheRead || 0; } }
  const bumps = costEvents(threadPairs, tl.events);
  const bumpBy: Record<string, number> = {};
  for (const b of bumps) bumpBy[b.cause || "unknown"] = (bumpBy[b.cause || "unknown"] || 0) + 1;
  const n = stepsWithComp.length;
  const every = Math.max(1, Math.ceil(n / 48));
  const growth: any[] = [];
  for (let i = 0; i < n; i++) {
    const s = stepsWithComp[i];
    if (i % every === 0 || i === n - 1 || s.mark) growth.push({ i, pairId: s.pairId, t: s.t, est: s.est, actual: s.actualIn, ...(s.mark ? { mark: s.mark } : {}) });
  }
  const window = modelWindow(step.model);
  const timeline = {
    steps: tl.steps.length,
    firstAt: tl.steps[0] ? tl.steps[0].t : 0,
    lastAt: tl.steps[tl.steps.length - 1] ? tl.steps[tl.steps.length - 1].t : 0,
    peak: { pairId: peakStep.pairId, t: peakStep.t, tokens: weight(peakStep), est: peakStep.est, actual: peakStep.actualIn },
    modelWindow: window || null,
    peakPct: window ? pct(weight(peakStep), window) : null,
    compactions: (main.compactions || []).map((c: any) => ({ pairId: c.pairId, mode: c.mode, fromTurns: c.fromTurns, toTurns: c.toTurns })),
    events: tl.events.reduce((acc: any, ev: any) => { acc[ev.kind] = (acc[ev.kind] || 0) + 1; return acc; }, {}),
    injectionsByProducer: Object.values(byProducer).sort((a, b) => b.tokens - a.tokens).slice(0, 20),
    cache: { hitPct: promptIn ? pct(cacheRead, promptIn) : null, promptTokens: promptIn, cacheRead, bumps: bumps.length, bumpsByCause: bumpBy },
    systemChanges: sysChanges,
    growth,
  };

  // ---- the split the attention question needs ----
  const overhead = sums.system + sums.tools + sums.inject;
  const task = sums.user + asstText;
  const work = sums.toolResult + asstCalls + asstThink;
  const signal = {
    task: { tokens: task, pct: pct(task, total) },
    overhead: { tokens: overhead, pct: pct(overhead, total) },
    work: { tokens: work, pct: pct(work, total) },
  };

  // ---- findings ----
  const F: DoctorFinding[] = [];
  const R = DOCTOR_RULES;
  const k = (t: number) => (t >= 1000 ? (t / 1000).toFixed(1) + "k" : String(t));
  if (signal.overhead.pct > R.overheadPct) {
    F.push({ id: "overhead", level: signal.overhead.pct > R.overheadPct * 1.5 ? "high" : "warn", title: `envelope + injections are ${signal.overhead.pct}% of the window`, detail: `system ${k(sums.system)} + tool schemas ${k(sums.tools)} + injections ${k(sums.inject)} of ≈${k(total)}; the task itself is ${signal.task.pct}%`, tokens: overhead, rule: `> ${R.overheadPct}%` });
  }
  if (tools.unused.tokens >= R.unusedToolTokens || tools.unused.count >= R.unusedToolCount) {
    F.push({ id: "unused-tools", level: "warn", title: `${tools.unused.count} of ${tools.count} tool schemas never called (≈${k(tools.unused.tokens)} per request)`, detail: tools.unused.names.slice(0, 12).join(", ") + (tools.unused.count > 12 ? ", …" : ""), tokens: tools.unused.tokens, rule: `>= ${R.unusedToolTokens} tokens or >= ${R.unusedToolCount} tools` });
  }
  for (const g of tools.byOrigin) {
    if (g.origin !== "builtin" && g.called === 0 && g.tokens >= 1000) {
      F.push({ id: "idle-mcp:" + g.origin, level: "warn", title: `${g.origin}: ${g.count} tools, ≈${k(g.tokens)} of schemas, zero calls this thread`, detail: g.unused.slice(0, 8).join(", "), tokens: g.tokens, rule: ">= 1000 tokens, 0 calls" });
    }
  }
  for (const b of sysBlocks) {
    for (const s of b.sections) {
      if (s.tokens >= R.bigSystemSection) F.push({ id: "system-section:" + s.key, level: "info", title: `system prompt section "${clip(s.heading, 50)}" is ≈${k(s.tokens)}`, detail: `${pct(s.tokens, total)}% of the window on every request`, tokens: s.tokens, show: s.key, rule: `>= ${R.bigSystemSection}` });
    }
    if (b.versions > 1 && !b.billing) F.push({ id: "system-versions:" + b.key, level: "warn", title: `system block ${b.key} changed ${b.versions - 1}x during the thread`, detail: `"${b.head}" — each change invalidates the cached prefix from that block on`, show: b.key, rule: "> 1 version" });
  }
  if (recurringTokens && pct(recurringTokens, total) >= R.recurringPct) {
    F.push({ id: "recurring-nudges", level: "info", title: `recurring harness nudges: ${recurringList.reduce((n, r) => n + r.count, 0)} notes, ≈${k(recurringTokens)} (${pct(recurringTokens, total)}%)`, detail: recurringList.map((r) => `${r.kind} ×${r.count}`).join(", "), tokens: recurringTokens, rule: `>= ${R.recurringPct}%` });
  }
  for (const o of oneOff) {
    if (o.tokens >= R.bigInjection) F.push({ id: "injection:" + o.key, level: "info", title: `${o.kind}: ≈${k(o.tokens)} injected at turn ${o.ti}`, detail: o.parts && o.parts.length ? o.parts.map((p: any) => `${p.file} ${k(p.tokens)}`).join(", ") : clip(o.head, 100), tokens: o.tokens, show: o.key, rule: `>= ${R.bigInjection}` });
  }
  if (exactWasted >= R.dupWasted) {
    F.push({ id: "exact-dups", level: "warn", title: `${exact.length} exact-duplicate groups, ≈${k(exactWasted)} beyond the first copy`, detail: exact.slice(0, 4).map((g: any) => `${g.cat === "toolResult" ? "result" : g.cat} ×${g.count} ≈${k(g.tokens)} "${clip(g.label, 50)}"`).join("; "), tokens: exactWasted, show: exact[0] ? "dup:" + exact[0].hash : undefined, rule: `>= ${R.dupWasted}` });
  }
  if (nearTokens >= R.nearTokens) {
    F.push({ id: "near-dups", level: "info", title: `${nearGroups.length} near-duplicate cluster(s) (line overlap >= ${R.nearJaccard}), ≈${k(nearGroups.reduce((n, g) => n + g.redundant, 0))} redundant`, detail: nearGroups.slice(0, 3).map((g) => `${g.copies} copies ≈${k(g.tokens)} each (${Math.round(g.minSimilarity * 100)}%+) "${clip(g.label, 50)}"`).join("; "), tokens: nearTokens, show: nearGroups[0] ? nearGroups[0].keys[0] : undefined, rule: `>= ${R.nearTokens}` });
  }
  for (const g of rereads) {
    if (g.count >= R.rereadCount) F.push({ id: "reread:" + g.tool + ":" + g.target, level: "warn", title: `${g.tool} asked the same thing ${g.count}x: ${clip(g.target, 70)}`, detail: `≈${k(g.tokens)} of results in the window for one target`, tokens: g.tokens, rule: `>= ${R.rereadCount}x` });
  }
  for (const r of largest) {
    if (r.tokens >= R.bigResult) F.push({ id: "big-result:" + r.key, level: "warn", title: `one ${r.tool} result is ≈${k(r.tokens)} (turn ${r.ti})`, detail: r.label, tokens: r.tokens, show: r.key, rule: `>= ${R.bigResult}` });
  }
  if (errCount >= R.errorResults) {
    F.push({ id: "error-results", level: "info", title: `${errCount} error results still in the window (≈${k(errTokens)})`, detail: "every failed call's output rides along until compaction", tokens: errTokens, rule: `>= ${R.errorResults}` });
  }
  if (pct(sums.toolResult, total) > R.resultsPct) {
    F.push({ id: "results-share", level: "info", title: `tool results are ${pct(sums.toolResult, total)}% of the window`, detail: results.byTool.slice(0, 4).map((g: any) => `${g.name} ×${g.count} ≈${k(g.tokens)}`).join(", "), tokens: sums.toolResult, rule: `> ${R.resultsPct}%` });
  }
  if (timeline.peakPct != null && timeline.peakPct >= R.windowPct) {
    F.push({ id: "near-limit", level: "high", title: `the peak reached ${timeline.peakPct}% of the model's ${k(window)} window`, detail: `step ${peakStep.pairId} · ${timeline.compactions.length} compaction(s) so far`, tokens: weight(peakStep), rule: `>= ${R.windowPct}%` });
  }
  if (timeline.cache.hitPct != null && timeline.cache.hitPct < R.cacheHitPct && tl.steps.length >= 5) {
    F.push({ id: "cache-hit", level: "warn", title: `prompt cache served ${timeline.cache.hitPct}% of prompt tokens over the thread`, detail: `${bumps.length} bump(s)` + (Object.keys(bumpBy).length ? ": " + Object.entries(bumpBy).map(([c, n]) => `${c} ×${n}`).join(", ") : ""), rule: `< ${R.cacheHitPct}%` });
  }
  if (actual && total) {
    const ratio = actual.total / total;
    if (Math.abs(ratio - 1) > R.calibration) F.push({ id: "calibration", level: "info", title: `the estimate is off: provider counted ${k(actual.total)}, the body estimates ≈${k(total)} (×${ratio.toFixed(2)})`, detail: ratio > 1 ? `≈${k(actual.total - total)} the body does not show at 4 chars/token: dense content (code, JSON, CJK run 1-3 chars/token) and anything the provider expands server-side. Shares still rank; absolute figures do not.` : "the body holds more than the provider billed — shares still rank; absolute figures do not", rule: `|ratio-1| > ${R.calibration}` });
  }
  const order = { high: 0, warn: 1, info: 2 };
  F.sort((a, b) => order[a.level] - order[b.level] || (b.tokens || 0) - (a.tokens || 0));

  const threadRows = threads.map((t: any) => {
    let peakIn = 0;
    for (const turn of t.turns || []) {
      const u = turn.usage;
      if (u) peakIn = Math.max(peakIn, (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0));
    }
    return { key: t.key, kind: t.kind, label: t.label, model: t.model, sessionId: t.sessionId || "", turns: (t.turns || []).filter((x: any) => !x.toolResultsOnly).length, steps: (t.pairIds || []).length, peakIn, main: t === main };
  });

  const report = {
    generatedAt: new Date(opts.nowMs || Date.now()).toISOString(),
    session: {
      sid: main.sessionId || "",
      client: (pair && pair.client) || "",
      thread: { key: main.key, label: main.label, model: main.model, turns: (main.turns || []).filter((x: any) => !x.toolResultsOnly).length, steps: threadPairs.length },
      threads: threadRows,
    },
    window: {
      pick, pairId: step.pairId, t: step.t, model: step.model, histLen: step.histLen,
      est: { ...sums, total },
      share: { system: pct(sums.system, total), tools: pct(sums.tools, total), user: pct(sums.user, total), inject: pct(sums.inject, total), assistant: pct(sums.assistant, total), toolResult: pct(sums.toolResult, total) },
      actual,
      calibration: actual && total ? Math.round((actual.total / total) * 100) / 100 : null,
      unaccounted: actual && total ? actual.total - total : null,
      derived: step.derived || null,
    },
    signal,
    system: { tokens: sums.system, blocks: sysBlocks, changes: sysChanges },
    tools,
    injections,
    conversation,
    results,
    duplicates,
    timeline,
    findings: F,
    rules: DOCTOR_RULES,
  };

  const show = (key: string): string | null => {
    const m = /^(sys:\d+)\/(\d+)$/.exec(key);
    if (m) {
      const it = keyed[m[1]!];
      if (!it) return null;
      const secs = systemSections(String(it.b.text || ""));
      const s = secs[parseInt(m[2]!, 10)];
      if (!s) return null;
      // Re-slice the block to that section's text.
      const text = String(it.b.text || "");
      let at = 0;
      for (let j = 0; j < parseInt(m[2]!, 10); j++) at += secs[j]!.chars;
      return text.slice(at, at + s.chars);
    }
    if (key.indexOf("dup:") === 0) {
      const g = groups[key.slice(4)];
      if (!g) return null;
      const it = keyed[g.keys[0]];
      return it ? itemText(it.b) : null;
    }
    const it = keyed[key];
    return it ? itemText(it.b) : null;
  };
  return { report, show };
}

/** The terminal report — the glance; --json is the skill's input. */
export function renderDoctor(r: any): string {
  const k = (t: number) => (t >= 1000 ? (t / 1000).toFixed(1) + "k" : String(t | 0));
  const out: string[] = [];
  const hms = (ts: number) => (ts ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z" : "");
  const sub = r.session.threads.filter((t: any) => t.kind === "agent").length;
  out.push(`Doctor · session ${r.session.sid ? r.session.sid.slice(0, 8) : "(no id)"}${r.session.client ? " · " + r.session.client : ""} · ${r.session.thread.turns} turns, ${r.session.thread.steps} steps${sub ? ` · ${sub} subagent thread(s)` : ""}`);
  const w = r.window;
  const actual = w.actual ? `${k(w.actual.total)} actual (est ×${w.calibration})` : "no provider count";
  out.push(`Window (${w.pick} step ${String(w.pairId).slice(0, 8)}, ${hms(w.t)}) · ≈${k(w.est.total)} est · ${actual} · ${w.model}${r.timeline.modelWindow ? ` · ${k(r.timeline.modelWindow)} window` : ""}`);
  out.push("");
  const row = (label: string, tok: number, share: number, note: string) => out.push(`  ${label.padEnd(16)}${k(tok).padStart(7)}  ${String(share).padStart(5)}%  ${note}`);
  const sysNote = `${r.system.blocks.length} block(s)` + (r.system.blocks[0] ? `, largest ${k(Math.max(...r.system.blocks.map((b: any) => b.tokens)))}` : "") + (r.system.changes ? `, changed ${r.system.changes}x` : "");
  row("system prompt", w.est.system, w.share.system, sysNote);
  row("tool schemas", w.est.tools, w.share.tools, `${r.tools.count} tools · ${r.tools.unused.count} never called (${k(r.tools.unused.tokens)})` + (r.tools.deferred.count ? ` · ${r.tools.deferred.count} deferred (loaded on search)` : ""));
  row("user messages", w.est.user, w.share.user, `${r.conversation.userMessages} message(s)`);
  const inj = r.injections;
  const topOne = inj.oneOff[0] ? `${inj.oneOff[0].kind} ${k(inj.oneOff[0].tokens)}` : "";
  row("injections", w.est.inject, w.share.inject, `${inj.count} block(s) · recurring ${k(inj.recurringTokens)} · one-off ${k(inj.oneOffTokens)}${topOne ? ` (top: ${topOne})` : ""}`);
  const a = r.conversation.assistant;
  row("assistant", w.est.assistant, w.share.assistant, `text ${k(a.text)} · thinking ${k(a.thinking)} · tool calls ${k(a.toolCalls)}`);
  const res = r.results;
  row("tool results", w.est.toolResult, w.share.toolResult, `${res.count} result(s) · ${res.errors.count} error(s) · largest ${res.largest[0] ? k(res.largest[0].tokens) + " " + res.largest[0].tool : "-"}`);
  out.push("");
  const s = r.signal;
  out.push(`Signal · task ${k(s.task.tokens)} (${s.task.pct}%) · overhead ${k(s.overhead.tokens)} (${s.overhead.pct}%) · work ${k(s.work.tokens)} (${s.work.pct}%)`);
  const d = r.duplicates;
  const rr = d.rereads.slice(0, 3).map((g: any) => `${g.tool} ${g.target.length > 28 ? g.target.slice(0, 27) + "…" : g.target} ×${g.count}`).join(", ");
  out.push(`Duplicates · exact ${d.exactGroups} group(s) ≈${k(d.exactWasted)} wasted · near ${d.nearGroups.length} cluster(s) ≈${k(d.nearGroups.reduce((n: number, g: any) => n + g.redundant, 0))} redundant · re-reads ${d.rereads.length}${rr ? ` (${rr})` : ""}`);
  const t = r.timeline;
  out.push(`Timeline · ${t.steps} steps · peak ${k(t.peak.tokens)}${t.peakPct != null ? ` (${t.peakPct}% of window)` : ""} at ${hms(t.peak.t)} · ${t.compactions.length} compaction(s) · cache ${t.cache.hitPct != null ? t.cache.hitPct + "% hit" : "n/a"} · ${t.cache.bumps} bump(s)`);
  if (t.injectionsByProducer.length) {
    out.push(`Injected over the thread · ` + t.injectionsByProducer.slice(0, 6).map((p: any) => `${p.label} ×${p.count} ${k(p.tokens)}`).join(" · "));
  }
  out.push("");
  if (!r.findings.length) out.push("Findings · none past the rules (see --json rules)");
  else {
    out.push(`Findings (${r.findings.length})`);
    for (const f of r.findings) {
      out.push(`  ${f.level.toUpperCase().padEnd(4)}  ${f.title}${f.show ? `   [--show ${f.show}]` : ""}`);
      if (f.detail) out.push(`        ${f.detail}`);
    }
  }
  return out.join("\n");
}
