import { extractCallInfo } from "./summarize";
import { harnessPrompt, harnessNoteKind, turnContentSig, loopTurns, buildToolResultIndex } from "./session";
import {
  wireDialect,
  openaiInput,
  openaiBlocks,
  openaiSystemText,
  openaiTools,
  normalizeOpenaiTurns,
} from "./dialects/openai";

// The context layer (docs/design/context-view.md): what the model's context
// window was assembled from, request by request. Inspired by dsh-context's
// Context tab (reference/dsh-context) — with cctrace's structural advantage:
// every captured request body IS the fully assembled context, so per-step
// composition is EXACT (no event-log fold, no removed-node archive, no
// "approximate reconstruction"), and every step carries the provider's own
// prompt-token count (usage) to anchor the estimate against.
//
// Like session.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — self-contained, cross-calls only to other
// inlined functions by name (harnessPrompt, openaiInput, extractCallInfo, …).

/**
 * The six context categories, in stacking order (envelope first, then the
 * conversation surface). Colors are data colors (same rule as
 * src/categorize.ts CATEGORIES): fixed hex, readable on both themes, one
 * each of the six hues CDS ships for git status.
 */
export const CTX_CATS = [
  { id: "system", label: "system prompt", color: "#8e6bd9" },
  { id: "tools", label: "tool schemas", color: "#c39b2b" },
  { id: "user", label: "user messages", color: "#1e9e3c" },
  { id: "inject", label: "injected context", color: "#c5621b" },
  { id: "assistant", label: "assistant replies", color: "#4a8fdb" },
  { id: "toolResult", label: "tool results", color: "#1baf7a" },
] as const;

/**
 * chars -> estimated tokens. The same fixed-density heuristic every harness
 * meter uses (~4 chars/token for English + code); figures render with "≈"
 * and sit next to the provider-reported actuals, never instead of them.
 */
export function estTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

/**
 * Rough per-image estimate. Anthropic vision prices (w*h)/750 tokens capped
 * around ~1.6k; dimensions aren't recoverable from the wire copy, so a flat
 * mid-range figure — marked "≈" wherever it renders.
 */
export const CTX_IMG_EST = 1500;

/**
 * Category of one TEXT block inside a user-role turn: harness-injected
 * context ("inject") vs the human's own words ("user"). Injected shapes:
 * <system-reminder> blocks, harness-authored prompts (recap / tool loads /
 * notifications / reminders — harnessPrompt), continuation summaries, and
 * the OpenAI-side harness wrappers (AGENTS.md digest, environment context,
 * mode banners). Command wrappers (<command-name>…) stay "user" — they ARE
 * the human's action.
 */
export function ctxTextCat(text: any): string {
  const s = String(text || "");
  if (s.lastIndexOf("<system-reminder>", 0) === 0) return "inject";
  // The per-turn banners Claude Code appends to the user role: the budget
  // line (+ whatever output-style reminder rides with it) and SessionStart
  // hook output. Measured on a real 91-step session, these were 97 of 99
  // "user" blocks — read as the human's words they invert the whole
  // composition, which is the one thing this view exists to get right.
  if (s.lastIndexOf("<total_tokens>", 0) === 0) return "inject";
  if (s.lastIndexOf("SessionStart hook additional context:", 0) === 0) return "inject";
  if (harnessPrompt(s)) return "inject";
  if (s.lastIndexOf("This session is being continued from a previous conversation", 0) === 0) return "inject";
  if (s.lastIndexOf("The conversation so far has been compacted", 0) === 0) return "inject";
  if (/^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<permissions instructions>|<collaboration_mode>|<plugins_instructions>|<multi_agent_mode>)/.test(s)) return "inject";
  // A file the harness delivered as a plain user message ("Contents of
  // /path/CLAUDE.md:" — what entering a worktree injects, unwrapped).
  // Measured 2026-09-11: three 11k copies of one CLAUDE.md read as the
  // human's words until this line.
  if (/^Contents of \/\S+/.test(s)) return "inject";
  return "user";
}

/** Estimated tokens of one normalized content block. */
export function ctxBlockTokens(b: any): number {
  if (!b) return 0;
  if (b.type === "text") return estTokens(String(b.text || "").length);
  if (b.type === "thinking") return estTokens(String(b.thinking || "").length);
  if (b.type === "redacted_thinking") return estTokens(String(b.data || "").length);
  if (b.type === "tool_use" || b.type === "server_tool_use") {
    let inp = "";
    try { inp = JSON.stringify(b.input) || ""; } catch { inp = ""; }
    return estTokens(inp.length + String(b.name || "").length + 8);
  }
  if (b.type === "tool_result") {
    const c = b.content;
    if (typeof c === "string") return estTokens(c.length);
    if (Array.isArray(c)) {
      let n = 0;
      for (const x of c) n += ctxBlockTokens(x);
      return n;
    }
    let s = "";
    try { s = JSON.stringify(c) || ""; } catch { s = ""; }
    return estTokens(s.length);
  }
  if (b.type === "image") return CTX_IMG_EST;
  let raw = "";
  try { raw = JSON.stringify(b) || ""; } catch { raw = ""; }
  return estTokens(raw.length);
}

/**
 * System prompt + tool schemas of a request body, per dialect — the request
 * ENVELOPE (everything that isn't the conversation surface). Returns
 * { systemChars, tools: [{name, tokens}] } — tool entries keep their own
 * estimate so "top tool schemas" can rank them.
 */
export function ctxEnvelope(body: any, dialect: string): any {
  let systemChars = 0;
  let tools: any[] = [];
  if (dialect === "openai") {
    systemChars = openaiSystemText(openaiInput(body)).length;
    tools = openaiTools(body);
  } else {
    const sys = body && body.system;
    if (typeof sys === "string") systemChars = sys.length;
    else if (Array.isArray(sys)) for (const blk of sys) systemChars += String((blk && blk.text) || "").length;
    tools = (body && Array.isArray(body.tools)) ? body.tools : [];
  }
  const toolList = [];
  for (const t of tools) {
    let s = "";
    try { s = JSON.stringify(t) || ""; } catch { s = ""; }
    toolList.push({ name: (t && (t.name || t.type)) || "?", tokens: estTokens(s.length) });
  }
  return { systemChars, tools: toolList };
}

/**
 * Follow a folded body's keeper chain to the request that still carries the
 * history. A stub folded as "superseded" was folded BECAUSE a later request
 * in the same thread re-sent its whole history, so that request's body holds
 * this one as a prefix; `keptPairId` names it. The keeper may itself have
 * been folded later, so the walk repeats — bounded (64 hops) and
 * cycle-guarded, because a page's pair set is whatever the wire produced.
 * Returns the keeper pair, or null when none is loaded (a budgeted stub
 * names no keeper, and a prior run's keeper may not be on this page).
 */
export function ctxKeeperPair(pair: any, pairOf: any): any {
  if (!pairOf) return null;
  let body = (pair && pair.request && pair.request.body) || null;
  const seen: any = {};
  for (let hop = 0; hop < 64; hop++) {
    const id = body && body.keptPairId;
    if (!id || seen[id]) return null;
    seen[id] = 1;
    const next = pairOf(id);
    const nb = next && next.request && next.request.body;
    if (!nb) return null;
    if (!nb._cctrace_stub) return next;
    body = nb;
  }
  return null;
}

/**
 * How many `input[]` items of an OpenAI request make up its first `turns`
 * normalized turns — the cut that slices a keeper's conversation back to a
 * folded request's history length. Mirrors normalizeOpenaiTurns' rules
 * (leading system/developer prefix skipped, empty items open no turn, a
 * turn continues while the role holds), so the two cannot drift.
 *
 * A turn count is the only length a stub keeps, so the cut lands on turn
 * boundaries: where the keeper CONTINUED the folded request's last turn
 * (consecutive same-role items — a tool result the next user message runs
 * straight into), the derived window carries that continuation too. Same
 * class of approximation as the anthropic side, and the reason the fold
 * stamps the exact sums it measured (contextComposition reads those first).
 */
export function ctxOpenaiCut(input: any[], turns: number): number {
  const items = input || [];
  let n = 0;
  let role = "";
  let inSystemPrefix = true;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.type === "additional_tools") continue;
    if (inSystemPrefix && item.type === "message" && (item.role === "system" || item.role === "developer")) continue;
    inSystemPrefix = false;
    if (!openaiBlocks(item).length) continue;
    const r = item.type === "message"
      ? (item.role === "assistant" ? "assistant" : "user")
      : (item.type === "function_call_output" || item.type === "custom_tool_call_output") ? "user" : "assistant";
    if (r !== role) {
      if (n >= turns) return i;
      n++;
      role = r;
    }
  }
  return items.length;
}

/**
 * The body to read this request's context out of — its own, or the one
 * DERIVED from the request that kept its history.
 *
 * The fold (src/live-bodies.ts, src/fold.ts) and `cctrace compact` drop a
 * request body only when a later request re-sent the same conversation. So
 * the bytes are gone from this pair but not from the page: the keeper's
 * body, cut back to this request's `historyLen`, IS this request's window.
 * The cut SHARES the keeper's block objects (a slice, never a copy), so
 * deriving costs one array and no memory.
 *
 * Returns { body, derivedFrom } — derivedFrom is the keeper's pair id, or
 * null when the body is the pair's own. body is null when the fold left
 * nothing to derive from: no keeper on the page, a budgeted stub that names
 * none, or a stub with no history length.
 */
export function ctxEffectiveBody(pair: any, pairOf?: any): any {
  const own = (pair && pair.request && pair.request.body) || null;
  if (!own || !own._cctrace_stub) return { body: own, derivedFrom: null };
  const memo = pair._ctxBody;
  if (memo !== undefined) return memo;
  const miss = { body: null, derivedFrom: null };
  const n = typeof own.historyLen === "number" ? own.historyLen : 0;
  if (n <= 0) return miss;
  const keeper = ctxKeeperPair(pair, pairOf);
  if (!keeper) return miss;
  const kb = keeper.request.body;
  let body: any = null;
  if (wireDialect(keeper) === "openai") {
    // Chat Completions carry messages[]; openaiInput normalizes both shapes
    // to input[] items, and reads `input` first — so the derived body is
    // the sliced items, whichever shape the keeper was.
    const items = openaiInput(kb);
    body = { ...kb, input: items.slice(0, ctxOpenaiCut(items, n)) };
  } else if (Array.isArray(kb.messages)) {
    body = { ...kb, messages: kb.messages.slice(0, n) };
  }
  if (!body) return miss;
  const out = { body, derivedFrom: keeper.id };
  // Only a hit is memoized: a miss can become a hit when the keeper lands
  // (a continuity merge, an explicitly loaded body) and must re-resolve.
  pair._ctxBody = out;
  return out;
}

/**
 * Per-category composition of ONE request's assembled context. Cheap on
 * purpose (length arithmetic over strings already in memory — the timeline
 * calls this once per request): sums only, no item lists (contextItems is
 * the detailed walk for the browser). Reads a folded body's composition
 * from the stub when the fold stamped it (exact — it was measured on the
 * real body), else derives it from the keeper (ctxEffectiveBody). Returns
 * null only when neither is available, and for non-model-call pairs.
 * Shape: { sums: {system,tools,user,inject,assistant,toolResult}, est,
 *          histLen, toolCount, images }
 */
export function contextComposition(pair: any, pairOf?: any): any {
  const dialect = wireDialect(pair);
  if (!dialect) return null;
  const memo = pair._ctxc;
  if (memo !== undefined) return memo;
  const raw = (pair.request && pair.request.body) || {};
  // Stamped at fold time from the body that was dropped: the sums the page
  // would have computed, for the price of ten numbers on the stub.
  if (raw._cctrace_stub && raw.composition) {
    pair._ctxc = raw.composition;
    return raw.composition;
  }
  const body = ctxEffectiveBody(pair, pairOf).body;
  if (!body) return null;
  const env = ctxEnvelope(body, dialect);
  const turns = dialect === "openai"
    ? normalizeOpenaiTurns(openaiInput(body))
    : ctxNormalizeTurns(body.messages);
  const sums: any = { system: estTokens(env.systemChars), tools: 0, user: 0, inject: 0, assistant: 0, toolResult: 0 };
  for (const t of env.tools) sums.tools += t.tokens;
  let images = 0;
  for (const turn of turns) {
    for (const b of turn.blocks || []) {
      if (!b) continue;
      if (b.type === "image") images++;
      const tok = ctxBlockTokens(b);
      if (turn.role === "assistant") sums.assistant += tok;
      else if (b.type === "tool_result") sums.toolResult += tok;
      else if (b.type === "text") sums[ctxTextCat(b.text)] += tok;
      else sums.user += tok;
    }
  }
  const est = sums.system + sums.tools + sums.user + sums.inject + sums.assistant + sums.toolResult;
  const out = { sums, est, histLen: turns.length, toolCount: env.tools.length, images };
  pair._ctxc = out;
  return out;
}

/**
 * Local normalizeTurns twin (messages[] -> {role, blocks}), so context.ts
 * stays callable when session.ts isn't in scope (unit tests import both;
 * the page inlines both — the duplication is three lines).
 */
export function ctxNormalizeTurns(messages: any): any[] {
  const out: any[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const blocks = typeof m.content === "string"
      ? [{ type: "text", text: m.content }]
      : Array.isArray(m.content) ? m.content : [];
    out.push({ role: m.role, blocks });
  }
  return out;
}

/** First human-readable line of a wire text — reminder/wrapper tags stripped. */
export function ctxSnippet(text: any, n: number): string {
  let s = String(text || "");
  s = s.replace(/<\/?system-reminder>/g, " ").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * The detailed per-item walk of one request — the Context browser's data.
 * One entry per system block / tool schema / content block, each with its
 * estimate and a label. EXACT by construction when the pair carries its own
 * body: the request body is the assembled context. A folded body walks the
 * keeper's copy of the same history (ctxEffectiveBody). Returns
 * { cats: {catId: [item…]}, est } or null (nothing to derive from / not a
 * model call). Item: { label, tokens, ti (history turn index,
 * -1 = envelope), kind, err?, toolName?, b } — b is a REFERENCE to the
 * source block (or tool schema object), so the browser can render the full
 * content lazily without a second walk.
 */
export function contextItems(pair: any, pairOf?: any): any {
  const dialect = wireDialect(pair);
  if (!dialect) return null;
  const body = ctxEffectiveBody(pair, pairOf).body;
  if (!body) return null;
  const cats: any = { system: [], tools: [], user: [], inject: [], assistant: [], toolResult: [] };
  const env = ctxEnvelope(body, dialect);
  if (dialect === "openai") {
    const sys = openaiSystemText(openaiInput(body));
    if (sys) cats.system.push({ label: ctxSnippet(sys, 110), tokens: estTokens(sys.length), ti: -1, kind: "text", b: { type: "text", text: sys } });
  } else {
    const sys = body.system;
    const blocks = typeof sys === "string" ? [{ text: sys }] : Array.isArray(sys) ? sys : [];
    for (const blk of blocks) {
      const text = String((blk && blk.text) || "");
      if (text) cats.system.push({ label: ctxSnippet(text, 110), tokens: estTokens(text.length), ti: -1, kind: "text", b: { type: "text", text } });
    }
  }
  const rawTools = dialect === "openai" ? openaiTools(body) : (Array.isArray(body.tools) ? body.tools : []);
  for (let i = 0; i < env.tools.length; i++) {
    cats.tools.push({ label: env.tools[i].name, tokens: env.tools[i].tokens, ti: -1, kind: "tool", b: rawTools[i] });
  }
  const turns = dialect === "openai"
    ? normalizeOpenaiTurns(openaiInput(body))
    : ctxNormalizeTurns(body.messages);
  // tool_use id -> name, so a tool_result row can say WHICH tool produced it.
  const callNames: any = {};
  for (const turn of turns) {
    for (const b of turn.blocks || []) {
      if (b && (b.type === "tool_use" || b.type === "server_tool_use") && b.id) callNames[b.id] = b.name || "?";
    }
  }
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    for (const b of turn.blocks || []) {
      if (!b) continue;
      const tokens = ctxBlockTokens(b);
      if (turn.role === "assistant") {
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          cats.assistant.push({ label: (b.name || "?") + "(…)", tokens, ti, kind: "tool_use", toolName: b.name || "?", b });
        } else if (b.type === "thinking") {
          cats.assistant.push({ label: ctxSnippet(b.thinking, 110), tokens, ti, kind: "thinking", b });
        } else if (b.type === "image") {
          cats.assistant.push({ label: "[image]", tokens, ti, kind: "image", b });
        } else {
          cats.assistant.push({ label: ctxSnippet(b.text, 110), tokens, ti, kind: "text", b });
        }
      } else if (b.type === "tool_result") {
        const name = (b.tool_use_id && callNames[b.tool_use_id]) || "";
        // The preview reads array content too (text blocks, [image] for a
        // screenshot) — a string-only read left every image-bearing result
        // (browser tools) as a blank row under its group.
        cats.toolResult.push({
          label: (name ? name + " → " : "") + ctxSnippet(trajResultPreview(b), 100),
          tokens, ti, kind: "tool_result", err: !!b.is_error, toolName: name, b,
        });
      } else if (b.type === "text") {
        const cat = ctxTextCat(b.text);
        const item: any = { label: ctxSnippet(b.text, 110), tokens, ti, kind: "text", b };
        // Injected text carries its PRODUCER (the same vocabulary the events
        // list speaks) — that is what the graph groups by: "which injector
        // is eating my window", not "which of the 90 reminder blocks".
        if (cat === "inject") item.src = ctxInjectLabel(b.text);
        cats[cat].push(item);
      } else if (b.type === "image") {
        cats.user.push({ label: "[image]", tokens, ti, kind: "image", b });
      } else {
        cats.user.push({ label: String(b.type || "block"), tokens, ti, kind: "block", b });
      }
    }
  }
  let est = 0;
  for (const k in cats) for (const it of cats[k]) est += it.tokens;
  return { cats, est };
}

/**
 * Which GROUP an item belongs to inside its category — the middle level of
 * the context graph. The grouping is the question each category answers:
 *
 *   toolResult  by tool name      "Bash x31 ~62k" — the usual window hog
 *   tools       by origin         built-ins vs one node per MCP server
 *   inject      by producer       system-reminder / AGENTS.md / recap / ...
 *   system      by block          the system prompt's own parts
 *   user        by turn           one node per human message
 *   assistant   by turn           a reply and its tool calls read together
 *
 * Returns { key, label } — key is stable across steps (fold state survives
 * scrubbing the history chart), label is what the row says.
 */
export function ctxGroupOf(catId: string, it: any, idx: number): any {
  if (catId === "toolResult") {
    const n = it.toolName || "";
    return { key: "t:" + (n || "?"), label: n || "unattributed result" };
  }
  if (catId === "tools") {
    const n = String(it.label || "");
    if (n.lastIndexOf("mcp__", 0) === 0) {
      const srv = n.slice(5).split("__")[0] || "?";
      return { key: "mcp:" + srv, label: "mcp \u00b7 " + srv };
    }
    return { key: "builtin", label: "built-in tools" };
  }
  if (catId === "inject") {
    const src = it.src || it.label || "context";
    return { key: "i:" + src, label: src };
  }
  // The system prompt's blocks are distinct chunks (the harness preamble,
  // the billing header, the project instructions) — one node each, never
  // one "system" lump: which BLOCK grew is the whole question there.
  if (catId === "system") return { key: "sys:" + idx, label: it.label };
  // The conversation groups by history turn — a message and the tool calls
  // it made read as one node, in wire order.
  return { key: catId + ":" + it.ti, label: it.label };
}

/**
 * The CONTEXT GRAPH of one request: the assembled window as a weighted tree
 * — category -> group -> item, every node carrying its estimate and share.
 * (Was called the "context browser"; it is not a browser, it is the shape
 * of the window: three levels, sized, so "what is eating my context" is a
 * scan, not an audit.)
 *
 * Built on contextItems, so there is ONE walk of the body. Groups come back
 * in FIRST-APPEARANCE (wire) order with their totals; ranking by size is
 * the view's job (the graph has a size/order toggle) — the data layer does
 * not pick a lens.
 *
 * Shape: { est, cats: [{ id, label, color, tokens, count, groups: [
 *          { key, label, tokens, count, err, items: [item, ...] } ] }] }
 * Returns null when its source does: a folded body with no keeper on the
 * page, or a non-model-call pair.
 */
export function contextGraph(pair: any, pairOf?: any): any {
  const items = contextItems(pair, pairOf);
  if (!items) return null;
  const cats: any[] = [];
  for (const c of CTX_CATS) {
    const list = items.cats[c.id] || [];
    const byKey: any = {};
    const groups: any[] = [];
    let tokens = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      tokens += it.tokens;
      const g = ctxGroupOf(c.id, it, i);
      let node = byKey[g.key];
      if (!node) {
        node = byKey[g.key] = { key: g.key, label: g.label || "", tokens: 0, count: 0, err: 0, items: [] };
        groups.push(node);
      }
      // A turn that opens with an empty text block would otherwise be an
      // unnamed node; take the first label the group actually has (the
      // tool call it made, the thinking it did).
      if (!node.label && it.label) node.label = it.label;
      node.tokens += it.tokens;
      node.count++;
      if (it.err) node.err++;
      node.items.push(it);
    }
    for (const node of groups) {
      if (!node.label) node.label = c.id === "user" ? "message" : c.id === "assistant" ? "reply" : c.label;
    }
    cats.push({ id: c.id, label: c.label, color: c.color, tokens, count: list.length, groups });
  }
  return { cats, est: items.est };
}

/**
 * The context graph as a TREE, uniform node shape, ready to lay out.
 *
 * Categories keep CTX_CATS order ALWAYS — the composition bar directly
 * above the graph is the same six segments in the same order, and the
 * graph is that bar growing downward into its parts. Re-ranking the top
 * row would break the one thing that makes this ours instead of a chart
 * bolted on. The size/order lens applies INSIDE a category, which is
 * where the "which tool" question actually lives.
 *
 * A one-item group IS its item, promoted a level (no rung for a lone
 * node). Node: { key, label, tokens, depth, cat, color, n, err, item?,
 * kids }.
 */
export function ctxFlameTree(graph: any, bySize: boolean): any {
  const cats: any[] = [];
  for (const cat of graph.cats) {
    if (!cat.count) continue;
    const src = bySize
      ? cat.groups.slice().sort((a: any, b: any) => b.tokens - a.tokens || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
      : cat.groups;
    const groups: any[] = [];
    for (const g of src) {
      const items: any[] = [];
      // A child never repeats its parent's name: under a node labelled
      // "Bash", "Bash -> const tmp = ..." spends the narrowest column in
      // the chart saying what the column above already says.
      const dedupe = (g.label || "") + " \u2192 ";
      for (let i = 0; i < g.items.length; i++) {
        const it = g.items[i];
        const raw = it.label || it.kind;
        items.push({
          key: "i:" + cat.id + "/" + g.key + "/" + i,
          label: raw.lastIndexOf(dedupe, 0) === 0 ? raw.slice(dedupe.length) : raw,
          tokens: it.tokens, depth: 3,
          cat: cat.id, color: cat.color, n: 0, err: !!it.err, item: it, kids: [],
        });
      }
      if (bySize) items.sort((a, b) => b.tokens - a.tokens);
      if (g.count === 1 && items.length === 1) {
        groups.push({
          key: "g:" + cat.id + "/" + g.key, label: g.label || items[0].label,
          tokens: g.tokens, depth: 2, cat: cat.id, color: cat.color,
          n: 1, err: items[0].err, item: items[0].item, kids: [],
        });
      } else {
        groups.push({
          key: "g:" + cat.id + "/" + g.key, label: g.label, tokens: g.tokens,
          depth: 2, cat: cat.id, color: cat.color, n: g.count, err: g.err, kids: items,
        });
      }
    }
    cats.push({
      key: "c:" + cat.id, label: cat.label, tokens: cat.tokens, depth: 1,
      cat: cat.id, color: cat.color, n: cat.count, err: 0, kids: groups,
    });
  }
  return { key: "root", label: "assembled context", tokens: graph.est, depth: 0, cat: "", color: "", n: 0, err: 0, kids: cats };
}

/** The ancestor chain down to `key` (the breadcrumb), or null. */
export function ctxFlameFind(node: any, key: any): any[] | null {
  if (!key || key === node.key) return [node];
  for (const k of node.kids || []) {
    const sub = ctxFlameFind(k, key);
    if (sub) return [node].concat(sub);
  }
  return null;
}

/**
 * ICICLE LAYOUT — the context graph as an actual graph.
 *
 * Rows top-down, width proportional to tokens: row 0 is the focused node
 * at full width, each row below it one level of its children, every child
 * sitting inside its parent's span. The flame-graph idiom, because "what
 * is eating my context window" IS a profiling question and this audience
 * reads profiles natively. Chosen over a treemap because the LABELS are
 * the answer here (Bash, Read, token budget) and a treemap can only
 * whisper them on hover; over a sunburst because that is the reflex.
 *
 * Zoom is the focus key: pass a node's key and its subtree is laid out
 * across the full width, with `path` as the breadcrumb home. A key that
 * no longer exists (the picked step changed) falls back to the root
 * rather than rendering nothing.
 *
 * Slivers do not become sub-pixel confetti: children narrower than
 * `minW` percent collapse into ONE labeled "+N smaller" node at the end
 * of their parent's span — visible, countable, and zoomable, never
 * silently dropped. Only in a CROWD though (`tailMin` siblings): merging
 * three things into "+3 smaller" saves nothing, and it would break the
 * category row, whose six segments must stay the same six the
 * composition bar above shows. Width is never floored — a thin node is
 * thin because it is small, and zoom is how you reach it.
 *
 * Percentages are always of the WHOLE request, never of the zoom, so a
 * number cannot change meaning when you drill in.
 */
export function ctxFlameLayout(graph: any, opts?: any): any {
  const o = opts || {};
  const root = ctxFlameTree(graph, o.sort !== "order");
  const path = ctxFlameFind(root, o.focus) || [root];
  const focus = path[path.length - 1];
  const total = graph.est || 0;
  const minW = typeof o.minW === "number" ? o.minW : 0.6;
  const tailMin = typeof o.tailMin === "number" ? o.tailMin : 9;
  const maxRow = typeof o.maxRow === "number" ? o.maxRow : 3;
  const rows: any[][] = [];
  const push = (row: number, n: any) => {
    while (rows.length <= row) rows.push([]);
    rows[row].push(n);
  };
  const place = (node: any, x: number, w: number, row: number) => {
    push(row, {
      key: node.key, label: node.label, tokens: node.tokens, cat: node.cat,
      color: node.color, err: node.err, n: node.n, item: node.item,
      hasKids: (node.kids || []).length > 0, x, w,
      pct: total ? (node.tokens / total) * 100 : 0,
      // A label needs room to say something; under ~4% of the width it
      // would clip to two characters, which is noise. The hover has it.
      lbl: w >= 4,
    });
    if (!(node.kids || []).length || row >= maxRow) return;
    let cx = x, tail = 0, tailN = 0;
    const crowd = node.kids.length >= tailMin;
    for (const k of node.kids) {
      const kw = node.tokens ? (k.tokens / node.tokens) * w : 0;
      if (crowd && kw < minW) { tail += k.tokens; tailN++; continue; }
      place(k, cx, kw, row + 1);
      cx += kw;
    }
    if (tailN) {
      const tw = x + w - cx;
      if (tw > 0.01) {
        push(row + 1, {
          key: node.key + "/~", label: "+" + tailN + " smaller", tokens: tail,
          cat: node.cat, color: node.color, err: 0, n: tailN, hasKids: false,
          x: cx, w: tw, pct: total ? (tail / total) * 100 : 0, lbl: tw >= 6, tail: tailN,
        });
      }
    }
  };
  place(focus, 0, 100, 0);
  return { rows, focus, path, total, root };
}

/**
 * The node the section opens on: the heaviest GROUP that holds items —
 * the answer to "what is eating my window", already selected, so the
 * detail pane has content the moment the view renders instead of asking
 * the reader to go find it.
 */
export function ctxFlameDefault(graph: any): string {
  let best = "";
  let bestTok = -1;
  for (const cat of graph.cats) {
    for (const g of cat.groups) {
      if (g.tokens > bestTok) { bestTok = g.tokens; best = "g:" + cat.id + "/" + g.key; }
    }
  }
  return best;
}

/**
 * The per-thread context timeline: one step per model-call request (wire
 * order — the exact requests this thread sent), with composition sums,
 * provider-anchored actuals, and the context EVENTS between consecutive
 * steps (model switches, compaction-scale drops, tool/system envelope
 * changes, injections found in the newly appended turns).
 *
 * `compactions` (optional) is buildSession's t.compactions — richer labels
 * (fold/rewrite/rewind, from→to turns) for drops the session layer already
 * classified; drops it didn't (≥10 turns below the running max, the same
 * rule buildSession uses) are still marked, honestly unlabeled.
 *
 * `stub` says the request body was FOLDED, which is no longer the same
 * question as "is there a composition": `stamped` marks sums the fold
 * measured on the real body before dropping it, `derived` names the pair
 * whose retained body this step's composition and detail were read from.
 *
 * Steps: { pairId, t, model, sums|null, est, actualIn|null, out, histLen,
 *          stub, stamped, derived|null, failed,
 *          mark? ('compact'|'rewind'|'rewrite') }
 * Events: { kind: 'inject'|'compact'|'model'|'tools'|'system',
 *           t, pairId, label?, tokens?, from?, to?, fromTurns?, toTurns?,
 *           mode? }
 */
export function contextTimeline(threadPairs: any[], compactions?: any[], pairOf?: any): any {
  const steps: any[] = [];
  const events: any[] = [];
  const compByPair: any = {};
  for (const c of compactions || []) if (c && c.pairId) compByPair[c.pairId] = c;
  let prev: any = null;        // previous step with a composition
  let prevTurns: any[] = [];   // its normalized turns (for injection diffing)
  let maxHist = 0;
  let maxTotal = 0;
  for (const p of threadPairs || []) {
    if (!p || !p.request) continue;
    const dialect = wireDialect(p);
    if (!dialect) continue;
    const body = p.request.body || {};
    const stub = !!body._cctrace_stub;
    const eff = ctxEffectiveBody(p, pairOf);
    const comp = contextComposition(p, pairOf);
    const ci = p._ci || (p._ci = extractCallInfo(p));
    const failed = !p.response || p.response.status >= 400;
    const actualIn = !failed && ((ci.input || 0) + (ci.cacheRead || 0) + (ci.cacheWrite || 0)) > 0
      ? (ci.input || 0) + (ci.cacheRead || 0) + (ci.cacheWrite || 0)
      : null;
    const histLen = comp ? comp.histLen : (typeof body.historyLen === "number" ? body.historyLen : 0);
    const step: any = {
      pairId: p.id,
      t: p.request.timestamp || 0,
      model: body.model || ci.model || "",
      sums: comp ? comp.sums : null,
      est: comp ? comp.est : 0,
      actualIn,
      cacheRead: failed ? 0 : ci.cacheRead || 0,
      out: failed ? 0 : ci.output || 0,
      histLen,
      stub,
      stamped: stub && !!body.composition,
      derived: eff.derivedFrom,
      failed,
    };
    // ---- events between the previous step and this one ----
    if (prev) {
      if (step.model && prev.model && step.model !== prev.model) {
        events.push({ kind: "model", t: step.t, pairId: p.id, from: prev.model, to: step.model });
      }
      // Compaction-scale drop below the running max (buildSession's rule) —
      // or a boundary the session layer already classified for this pair.
      const known = compByPair[p.id];
      if (known || (histLen > 0 && maxHist - histLen >= 10)) {
        step.mark = known ? (known.mode === "rewind" ? "rewind" : known.mode === "rewrite" ? "rewrite" : "compact") : "compact";
        const before = prev.actualIn != null ? prev.actualIn : prev.est;
        const after = actualIn != null ? actualIn : step.est;
        events.push({
          kind: "compact", t: step.t, pairId: p.id,
          mode: step.mark,
          tokens: before && after ? after - before : 0,
          fromTurns: known ? known.fromTurns : maxHist,
          toTurns: known ? known.toTurns : histLen,
        });
      }
      if (comp && prev.sums) {
        // Envelope changes: the tool schemas / system prompt the harness
        // sends changed between requests (deferred-tool loads, mode flips).
        if (comp.toolCount !== prev.toolCount || Math.abs(comp.sums.tools - prev.sums.tools) > 25) {
          events.push({
            kind: "tools", t: step.t, pairId: p.id,
            tokens: comp.sums.tools - prev.sums.tools,
            from: prev.toolCount, to: comp.toolCount,
          });
        }
        if (Math.abs(comp.sums.system - prev.sums.system) > 25) {
          events.push({ kind: "system", t: step.t, pairId: p.id, tokens: comp.sums.system - prev.sums.system });
        }
      }
    }
    // Injections: inject-category text blocks in the turns this request
    // APPENDED (indices past the previous request's history) — plus, on the
    // very first step, the injections its opening turns carry. After a
    // repack (mark set) indices shift; skip diffing that boundary rather
    // than mis-attribute rows. A folded request diffs on the keeper's copy
    // of its history; one with no keeper leaves the baseline alone rather
    // than reset it to nothing (the next step would re-report every
    // injection it ever carried).
    if (comp && eff.body) {
      const turns = dialect === "openai"
        ? normalizeOpenaiTurns(openaiInput(eff.body))
        : ctxNormalizeTurns(eff.body.messages);
      if (!step.mark) {
        const from = prev ? Math.min(prevTurns.length, turns.length) : 0;
        for (let ti = from; ti < turns.length; ti++) {
          const turn = turns[ti];
          if (!turn || turn.role === "assistant") continue;
          for (const b of turn.blocks || []) {
            if (!b || b.type !== "text") continue;
            if (ctxTextCat(b.text) !== "inject") continue;
            events.push({
              kind: "inject", t: step.t, pairId: p.id,
              label: ctxInjectLabel(b.text),
              tokens: ctxBlockTokens(b),
            });
          }
        }
      }
      prevTurns = turns;
    }
    if (histLen > maxHist) maxHist = histLen;
    const total = actualIn != null ? actualIn : step.est;
    if (total > maxTotal) maxTotal = total;
    if (comp) { prev = { ...step, toolCount: comp.toolCount }; }
    steps.push(step);
  }
  return { steps, events, maxTotal };
}

/**
 * A short producer label for an injected text: the reminder's own opening
 * words, or the harness-prompt kind. What dsh reads off `source.form`,
 * recovered here from content shape (the wire has no source envelope).
 */
export function ctxInjectLabel(text: any): string {
  const s = String(text || "");
  const kind = harnessPrompt(s);
  if (kind) return kind;
  // A reminder-wrapped note names its family (project instructions,
  // notification, file contents, ...); the wrapper tags are not the label.
  if (s.lastIndexOf("<system-reminder>", 0) === 0) {
    const bare = s.replace(/<\/?system-reminder>/g, "").trim();
    const nk = harnessNoteKind(bare);
    if (nk && nk !== "note") return nk;
    const hp = harnessPrompt(bare);
    if (hp) return hp;
  }
  if (/^Contents of \/\S+/.test(s)) return "file contents";
  // Stable producer names for the per-turn banners: their text carries a
  // changing number, so the snippet fallback would make one group each.
  if (s.lastIndexOf("<total_tokens>", 0) === 0) return "token budget";
  if (s.lastIndexOf("SessionStart hook additional context:", 0) === 0) return "SessionStart hook";
  if (s.lastIndexOf("This session is being continued", 0) === 0) return "continuation summary";
  if (s.lastIndexOf("The conversation so far has been compacted", 0) === 0) return "compaction summary";
  if (/^# AGENTS\.md instructions/.test(s)) return "AGENTS.md";
  if (/^<environment_context>/.test(s)) return "environment context";
  if (/^<user_instructions>/.test(s)) return "user instructions";
  if (/^<permissions instructions>/.test(s)) return "permissions";
  if (/^<collaboration_mode>/.test(s)) return "collaboration mode";
  if (/^<plugins_instructions>/.test(s)) return "plugins";
  if (/^<multi_agent_mode>/.test(s)) return "multi-agent mode";
  return ctxSnippet(s, 60) || "context";
}

/**
 * Aggregate timeline steps to one bar per TURN (the outline's working-loop
 * unit): each turn shows its LAST step's composition — the deepest context
 * that turn reached. stepAddr maps pairId -> {ord, step} (built by the page
 * from loopTurns); steps without an address (failed, unattributed) group
 * under the nearest preceding addressed turn.
 */
export function ctxAggregateTurns(steps: any[], stepAddr: any): any[] {
  const out: any[] = [];
  let cur: any = null;
  let curOrd: any = null;
  for (const s of steps || []) {
    const a = stepAddr && stepAddr[s.pairId];
    const ord = a ? a.ord : curOrd;
    if (cur && ord === curOrd) {
      cur.steps++;
      if (!s.failed) cur.last = s;
      if (s.mark && !cur.mark) cur.mark = s.mark;
      if (s.failed) cur.failed++;
    } else {
      cur = { ord, steps: 1, last: s, mark: s.mark || "", failed: s.failed ? 1 : 0 };
      curOrd = ord;
      out.push(cur);
    }
  }
  return out;
}

/** The window's history turns as the request body carries them — the same
 * normalization contextItems walks, dialect-aware, so an item's `ti`
 * indexes into this list. A folded body reads the keeper's copy; empty for
 * non-model-call pairs and folds with nothing to derive from. */
export function ctxWindowTurns(pair: any, pairOf?: any): any[] {
  const dialect = wireDialect(pair);
  if (!dialect) return [];
  const body = ctxEffectiveBody(pair, pairOf).body;
  if (!body) return [];
  return dialect === "openai" ? normalizeOpenaiTurns(openaiInput(body)) : ctxNormalizeTurns(body.messages);
}

/** A turn's identity for matching a window turn to the session's spine:
 * turnContentSig (text, else the first tool_use), and for a turn that is
 * only tool results — which turnContentSig leaves blank — the first
 * result's tool_use id, unique per call. */
export function ctxTurnSig(blocks: any[]): string {
  const s = turnContentSig(blocks || []);
  if (s) return s;
  for (const b of blocks || []) if (b && b.type === "tool_result" && b.tool_use_id) return "r:" + b.tool_use_id;
  return "";
}

/**
 * PROVENANCE: which turn of the session's spine a window turn IS — so the
 * view can say since when an item has been in the window (semantica's
 * provenance trail, in cctrace's terms: an item's origin is the wire
 * request that first carried it). Content-verified, nearest index first,
 * the same discipline as buildSession's attribution — never index-only,
 * because Claude Code repacks ephemeral turns between requests and a bare
 * index drifts by one to three. Returns the spine index, or -1.
 * `sigs` = precomputed ctxTurnSig per spine turn (the caller renders many
 * rows against one spine; computing them once is the whole cost).
 * `end` = the spine index the window ends at (exclusive) — the position of
 * the reply this request produced. The window is the spine's history UP TO
 * that request, so identical content (a repeated "continue", the same
 * system-reminder opening two turns, a nudge) is disambiguated by distance
 * from the window's END, not from its start: after a compaction the window
 * is a handful of turns while the spine is hundreds, and start-anchoring
 * sent every repeat to its FIRST occurrence in the session. Without `end`
 * (no request known) it falls back to start-anchoring.
 */
export function ctxOriginTurn(spine: any[], win: any[], ti: number, sigs?: string[], end?: number): number {
  const w = win && ti >= 0 ? win[ti] : null;
  if (!w) return -1;
  const sig = ctxTurnSig(w.blocks);
  if (!sig) return -1;
  const n = (spine || []).length;
  const fromEnd = end != null && end >= 0 ? win.length - ti : null;
  const anchor = end != null && end >= 0 ? Math.min(end, n) : 0;
  let best = -1;
  let cost = Infinity;
  for (let i = 0; i < n; i++) {
    const s = spine[i];
    if (!s || s.role !== w.role) continue;
    const ss = sigs ? sigs[i] : ctxTurnSig(s.blocks);
    if (ss !== sig) continue;
    const c = fromEnd != null ? Math.abs((anchor - i) - fromEnd) : Math.abs(i - ti);
    if (c < cost) { best = i; cost = c; }
  }
  return best;
}

/**
 * The CARRY: how many wire requests re-sent something that entered the
 * window with `fromPairId` — the inspector's origin facet. Counted forward
 * through the timeline's steps (every request sent it, failed ones
 * included: the bar shows what was SENT):
 *   - to `toPairId` when given — the item is KNOWN to be in that step's
 *     window (the icicle's content-verified provenance), so it rode every
 *     request between, compactions notwithstanding (a compaction removes
 *     older turns; a turn still present after one was in every request);
 *   - else up to the next compaction/rewind boundary (a marked step),
 *     exclusive — the window was rewritten there, and whether the item
 *     survived is that step's own reading, not this count's.
 * Returns { n, from, to, boundary } or null when fromPairId is not a step.
 */
export function ctxCarrySpan(steps: any[], fromPairId: string, toPairId?: string | null): any {
  const list = steps || [];
  const i0 = list.findIndex((s: any) => s && s.pairId === fromPairId);
  if (i0 < 0) return null;
  let i1 = i0;
  let boundary: any = null;
  if (toPairId) {
    const j = list.findIndex((s: any) => s && s.pairId === toPairId);
    if (j >= i0) i1 = j;
  } else {
    for (let i = i0 + 1; i < list.length; i++) {
      if (list[i] && list[i].mark) { boundary = list[i]; break; }
      i1 = i;
    }
  }
  return { n: i1 - i0 + 1, from: list[i0], to: list[i1], boundary };
}

// ============================================================================
// The TRAJECTORY — the whole thread as a linear, time-anchored stream of
// RECORDS (dsh's Trajectory tab, in cctrace's terms). Where the Sessions
// convo reads the conversation and the Context graph reads one request's
// window, the trajectory reads the agent's PATH: every record the run
// produced, one row, in order — system prompt, the human's turns, the
// CONTEXT the harness injected (inline, first-class, at the moment it
// entered), the model's thinking, each tool call fused with its result,
// the reply. cctrace's advantage over a harness event log: this is built
// from the reconstructed spine (buildSession's t.turns), so it is exact
// and every record carries its wire pair.
//
// Record kinds mirror CTX_CATS, as a linear stream:
//   system | user | context | assistant (think|reply) | tool (call->result)
// A record: { kind, think, tool, ord, step, label, detail, tokens, pairId,
//   t, err, block, result, toolName }.  Pure; unit-tested; inlined into
// the page like session.ts.

/** One-line preview of a normalized block, tag-wrappers stripped. */
export function trajLabel(b: any): string {
  if (!b) return "";
  if (b.type === "text") return ctxSnippet(b.text, 200);
  if (b.type === "thinking") return ctxSnippet(b.thinking, 200);
  if (b.type === "redacted_thinking") return "[redacted thinking]";
  if (b.type === "tool_use" || b.type === "server_tool_use") return b.name || "tool";
  if (b.type === "image") return "[image]";
  return ctxSnippet(typeof b.text === "string" ? b.text : "", 200);
}

/** The tool_result's content as a one-line preview (the "-> result" side). */
export function trajResultPreview(res: any): string {
  if (!res) return "";
  const c = res.content;
  let s = "";
  if (typeof c === "string") s = c;
  else if (Array.isArray(c)) s = c.map((x: any) => (x && x.type === "text" ? x.text : x && x.type === "image" ? "[image]" : "")).join(" ");
  else if (c != null) { try { s = JSON.stringify(c); } catch { s = ""; } }
  return ctxSnippet(s, 200);
}

/**
 * The thread's records, in spine order. `t` is a built thread (buildSession);
 * loops/results are recomputed from t.turns so this stays a pure function of
 * the thread. Turn/step addressing matches the Sessions outline and the
 * Context view (loopTurns): a record's `ord` is its working-loop ordinal
 * (0-based; +1 for display), `step` the step within the loop.
 */
export function trajectoryRecords(t: any): any[] {
  const out: any[] = [];
  if (!t) return out;
  const turns: any[] = t.turns || [];
  const results = buildToolResultIndex(turns);

  // Working-loop address per VISIBLE turn (same numbering as the outline).
  const vis = turns.filter((x: any) => x && !x.toolResultsOnly);
  const loops = loopTurns(vis);
  const addr: any = {}; // visible-index -> { ord, step, pair }
  for (let li = 0; li < loops.length; li++) {
    const L = loops[li];
    // An assistant member IS a step. A user-role member (a tool result, an
    // injection, a nudge) entered the window with the NEXT request, so it
    // takes that request's step AND that request's pair — the address the
    // Context pane's provenance already gives it ("since turn 04 · step
    // 2"); one turn, one name and one wire pair on every surface. Without
    // the pair a user/context record answers to no request at all, and a
    // range brushed over the wire steps cannot scope it. Injected after
    // the final reply: step 0, no pair (nothing carried it yet).
    let next = 0;
    let nextPair: string | null = null;
    for (let m = L.members.length - 1; m >= 0; m--) {
      const v = L.members[m];
      const own = L.steps && L.steps[v];
      const vt: any = vis[v];
      if (own) { next = own; nextPair = (vt && vt.pairId) || null; }
      addr[v] = { ord: li, step: own || next, pair: (vt && vt.pairId) || nextPair };
    }
    // The loop's head is the human's prompt: step 0 (it opens the turn,
    // it is not a step), but it entered on the loop's FIRST request —
    // which is what nextPair holds after the backwards walk. Members win
    // if the head is also one.
    if (L.head != null && addr[L.head] == null) {
      const ht: any = vis[L.head];
      addr[L.head] = { ord: li, step: 0, pair: (ht && ht.pairId) || nextPair };
    }
  }

  // The system prompt opens the trajectory — one record, blocks in the
  // inspector (dsh's "Initial System Prompt" row).
  const sysBlocks = typeof t.system === "string" ? [{ type: "text", text: t.system }] : (Array.isArray(t.system) ? t.system : []);
  if (sysBlocks.length) {
    let tok = 0;
    for (const b of sysBlocks) tok += estTokens(String((b && b.text) || "").length);
    out.push({ kind: "system", ord: null, step: 0, label: "initial system prompt", detail: "", tokens: tok, pairId: null, t: 0, err: false, block: { type: "system", blocks: sysBlocks }, result: null, toolName: "" });
  }

  let vi = 0;
  for (const turn of turns) {
    if (!turn) continue;
    if (turn.toolResultsOnly) continue; // results are fused into their tool_use below
    const a = addr[vi] || { ord: null, step: 0, pair: null };
    vi++;
    // A user/injection turn answers to the request that carried it into
    // the window, not to none: that is what makes "wire →" resolve on a
    // CONTEXT row and what lets the overview's range scope the stream.
    const pairId = turn.pairId || a.pair || null;
    const role = turn.role;
    for (const b of turn.blocks || []) {
      if (!b) continue;
      if (role === "user") {
        // Split the human's words from the harness's injections IN ORDER.
        const text = b.type === "text" ? String(b.text || "") : "";
        if (b.type === "text") {
          const inject = ctxTextCat(text) === "inject";
          out.push({
            kind: inject ? "context" : "user",
            ord: a.ord, step: a.step,
            label: inject ? ctxInjectLabel(text) : ctxSnippet(text, 200),
            detail: inject ? ctxSnippet(text, 200) : "",
            tokens: estTokens(text.length), pairId, t: 0, err: false,
            block: b, result: null, toolName: "",
          });
        } else if (b.type === "image") {
          out.push({ kind: "user", ord: a.ord, step: a.step, label: "[image]", detail: "", tokens: CTX_IMG_EST, pairId, t: 0, err: false, block: b, result: null, toolName: "" });
        }
        // tool_result blocks that ride a user turn are handled via the
        // index on the tool_use side; a bare user turn rarely holds them.
        continue;
      }
      if (role === "assistant") {
        if (b.type === "tool_use" || b.type === "server_tool_use") {
          const res = results[b.id];
          out.push({
            kind: "tool", ord: a.ord, step: a.step,
            label: b.name || "tool", detail: trajResultPreview(res),
            tokens: ctxBlockTokens(b) + (res ? ctxBlockTokens(res) : 0),
            pairId, t: 0, err: !!(res && res.is_error),
            block: b, result: res || null, toolName: b.name || "",
          });
        } else if (b.type === "text" || b.type === "thinking" || b.type === "redacted_thinking") {
          const think = b.type !== "text";
          const label = trajLabel(b);
          if (!label && !think) continue; // empty text block, no signal
          out.push({
            kind: "assistant", think, ord: a.ord, step: a.step,
            label: label || "[thinking]", detail: "", tokens: ctxBlockTokens(b),
            pairId, t: 0, err: false, block: b, result: null, toolName: "",
          });
        }
        continue;
      }
      // A neither-user-nor-assistant turn (Claude Code sends nudges as role
      // "system"): harness-authored context by definition.
      if (b.type === "text") {
        out.push({ kind: "context", ord: a.ord, step: a.step, label: ctxInjectLabel(b.text), detail: ctxSnippet(b.text, 200), tokens: estTokens(String(b.text || "").length), pairId, t: 0, err: false, block: b, result: null, toolName: "" });
      }
    }
  }
  return out;
}

/**
 * Roll trajectory records up to a coarser DETAIL LEVEL (archify's MAP -> READ
 * -> FULL progressive disclosure). The stream is always complete; the level
 * decides what earns a row so a long run stays scannable:
 *   full — every record (the default);
 *   read — drop the token-budget/reminder banners and standalone thinking
 *          (the plumbing), keep system, the human, replies, tool calls, and
 *          the SUBSTANTIVE context (skills, AGENTS.md, watch/notice events);
 *   map  — only the skeleton: the human's turns and the tool calls (what the
 *          agent was asked and what it did), plus system.
 * Filtering, never summarizing: a hidden record is counted, not folded into a
 * lie. Returns { records, hidden } — hidden is how many the level dropped.
 */
export function trajectoryAtLevel(records: any[], level: string): any {
  if (level === "full" || !level) return { records: records.slice(), hidden: 0 };
  const NOISE = new Set(["token budget", "SessionStart hook"]);
  const keep = (r: any): boolean => {
    if (level === "map") return r.kind === "system" || r.kind === "user" || r.kind === "tool";
    // read: drop banners and bare thinking
    if (r.kind === "context" && NOISE.has(r.label)) return false;
    if (r.kind === "assistant" && r.think) return false;
    return true;
  };
  const kept = records.filter(keep);
  return { records: kept, hidden: records.length - kept.length };
}
