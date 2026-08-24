import { extractCallInfo } from "./summarize";
import { harnessPrompt } from "./session";
import {
  wireDialect,
  openaiInput,
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
 * src/categorize.ts CATEGORIES): fixed hex, readable on both themes.
 */
export const CTX_CATS = [
  { id: "system", label: "system prompt", color: "#8957e5" },
  { id: "tools", label: "tool schemas", color: "#d29922" },
  { id: "user", label: "user messages", color: "#3fb950" },
  { id: "inject", label: "injected context", color: "#db61a2" },
  { id: "assistant", label: "assistant replies", color: "#4184e4" },
  { id: "toolResult", label: "tool results", color: "#39c5cf" },
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
  if (harnessPrompt(s)) return "inject";
  if (s.lastIndexOf("This session is being continued from a previous conversation", 0) === 0) return "inject";
  if (s.lastIndexOf("The conversation so far has been compacted", 0) === 0) return "inject";
  if (/^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<permissions instructions>|<collaboration_mode>|<plugins_instructions>|<multi_agent_mode>)/.test(s)) return "inject";
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
 * Per-category composition of ONE request's assembled context. Cheap on
 * purpose (length arithmetic over strings already in memory — the timeline
 * calls this once per request): sums only, no item lists (contextItems is
 * the detailed walk for the browser). Returns null for compact-folded stub
 * bodies (their composition is gone; the pair's usage survives) and for
 * non-model-call pairs.
 * Shape: { sums: {system,tools,user,inject,assistant,toolResult}, est,
 *          histLen, toolCount, images }
 */
export function contextComposition(pair: any): any {
  const dialect = wireDialect(pair);
  if (!dialect) return null;
  const body = (pair.request && pair.request.body) || {};
  if (body._cctrace_stub) return null;
  const memo = pair._ctxc;
  if (memo !== undefined) return memo;
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
 * estimate and a label. EXACT by construction: the request body is the
 * assembled context. Returns { cats: {catId: [item…]}, est } or null
 * (stub / not a model call). Item: { label, tokens, ti (history turn index,
 * -1 = envelope), kind, err?, toolName?, b } — b is a REFERENCE to the
 * source block (or tool schema object), so the browser can render the full
 * content lazily without a second walk.
 */
export function contextItems(pair: any): any {
  const dialect = wireDialect(pair);
  if (!dialect) return null;
  const body = (pair.request && pair.request.body) || {};
  if (body._cctrace_stub) return null;
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
        cats.toolResult.push({
          label: (name ? name + " → " : "") + ctxSnippet(typeof b.content === "string" ? b.content : "", 100),
          tokens, ti, kind: "tool_result", err: !!b.is_error, toolName: name, b,
        });
      } else if (b.type === "text") {
        cats[ctxTextCat(b.text)].push({ label: ctxSnippet(b.text, 110), tokens, ti, kind: "text", b });
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
 * Steps: { pairId, t, model, sums|null, est, actualIn|null, out, histLen,
 *          stub, failed, mark? ('compact'|'rewind'|'rewrite') }
 * Events: { kind: 'inject'|'compact'|'model'|'tools'|'system',
 *           t, pairId, label?, tokens?, from?, to?, fromTurns?, toTurns?,
 *           mode? }
 */
export function contextTimeline(threadPairs: any[], compactions?: any[]): any {
  const steps: any[] = [];
  const events: any[] = [];
  const compByPair: any = {};
  for (const c of compactions || []) if (c && c.pairId) compByPair[c.pairId] = c;
  let prev: any = null;        // previous non-stub step (composition available)
  let prevTurns: any[] = [];   // its normalized turns (for injection diffing)
  let maxHist = 0;
  let maxTotal = 0;
  for (const p of threadPairs || []) {
    if (!p || !p.request) continue;
    const dialect = wireDialect(p);
    if (!dialect) continue;
    const body = p.request.body || {};
    const stub = !!body._cctrace_stub;
    const comp = stub ? null : contextComposition(p);
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
    // than mis-attribute rows.
    if (comp && !step.mark) {
      const turns = dialect === "openai"
        ? normalizeOpenaiTurns(openaiInput(body))
        : ctxNormalizeTurns(body.messages);
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
      prevTurns = turns;
    } else if (comp) {
      prevTurns = dialect === "openai"
        ? normalizeOpenaiTurns(openaiInput(body))
        : ctxNormalizeTurns(body.messages);
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
