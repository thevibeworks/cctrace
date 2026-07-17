import { parseSse, assembleAssistant, extractCallInfo, shortModel, extractSessionId } from "./summarize";
import { pairCost } from "./pricing";
import {
  wireDialect,
  openaiCompleted,
  openaiBlocks,
  normalizeOpenaiTurns,
  openaiSystemText,
  openaiTools,
  openaiFirstUserText,
} from "./dialects/openai";

// Reconstruct Claude Code conversations from captured /v1/messages wire pairs.
//
// Each API request carries the full conversation-so-far, so a session's last
// request per thread (the "spine") contains the whole history; the streamed
// response appended to it is the final assistant turn. Requests group into
// threads by the signature of their FIRST message: the main chat, subagent
// (Task) runs, and utility calls (quota probes, title generation) all have
// distinct first turns.
//
// Like categorize.ts/summarize.ts, every exported function is inlined into
// the web UI via toString() — keep them self-contained (cross-calls only to
// other inlined functions by name).

/**
 * The user-authored text of a message content: the first text block that is
 * NOT an injected <system-reminder> context block. Claude Code prepends the
 * same claudeMd / hook-context reminder to the first user message of EVERY
 * thread — main chat and all subagent runs alike — so anything keyed on
 * "first text block" sees the reminder, not the prompt.
 */
export function firstUserText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let fallback = "";
  for (const b of content) {
    if (!b || b.type !== "text" || typeof b.text !== "string") continue;
    if (!fallback) fallback = b.text;
    if (b.text.lastIndexOf("<system-reminder>", 0) !== 0) return b.text;
  }
  return fallback;
}

/** Stable signature of a thread's first message (djb2 over its user text —
 * never over the shared reminder prefix, which would collide every thread). */
export function threadSig(firstMessage: any): string {
  let s = firstUserText(firstMessage && firstMessage.content);
  if (!s) {
    try {
      const c = firstMessage && firstMessage.content;
      s = typeof c === "string" ? c : JSON.stringify(c) || "";
    } catch {
      s = String(firstMessage);
    }
  }
  s = s.slice(0, 400);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Request messages[] -> turn objects with normalized block arrays. */
export function normalizeTurns(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages || []) {
    if (!m) continue;
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : Array.isArray(m.content)
          ? m.content
          : [];
    const toolResultsOnly = blocks.length > 0 && blocks.every((b: any) => b && b.type === "tool_result");
    out.push({ role: m.role, blocks, toolResultsOnly, pairId: null, usage: null });
  }
  return out;
}

/** tool_use_id -> tool_result block, across all user turns of a thread. */
export function buildToolResultIndex(turns: any[]): Record<string, any> {
  const map: Record<string, any> = {};
  for (const t of turns || []) {
    if (!t || t.role !== "user") continue;
    for (const b of t.blocks || []) {
      if (b && b.type === "tool_result" && b.tool_use_id) map[b.tool_use_id] = b;
    }
  }
  return map;
}

/**
 * Capped content signature of a turn's blocks, comparable between a pair's
 * assembled response and a spine turn's packing (Claude Code packs replies
 * back verbatim). First non-empty text block wins; tool-only replies fall
 * back to the first tool_use name + input prefix. "" = nothing to compare
 * (errored/empty responses, stub metadata) — callers treat that as
 * unverifiable, never as a match.
 */
export function turnContentSig(blocks: any[]): string {
  for (const b of blocks || []) {
    if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      return "t:" + b.text.trim().slice(0, 200);
    }
  }
  for (const b of blocks || []) {
    if (b && (b.type === "tool_use" || b.type === "server_tool_use")) {
      let inp = "";
      try {
        inp = JSON.stringify(b.input) || "";
      } catch {
        inp = "";
      }
      return "u:" + (b.name || "") + ":" + inp.slice(0, 160);
    }
  }
  return "";
}

/** Assistant content blocks from a pair's response (JSON body or SSE). */
export function responseBlocks(pair: any): any[] {
  if (wireDialect(pair) === "openai") {
    const done = openaiCompleted(pair);
    const out: any[] = [];
    for (const item of (done && done.output) || []) {
      for (const b of openaiBlocks(item)) out.push(b);
    }
    return out;
  }
  const r = pair && pair.response;
  if (!r) return [];
  if (r.body && Array.isArray(r.body.content)) return r.body.content;
  if (r.bodyRaw) return assembleAssistant(parseSse(r.bodyRaw));
  return [];
}

/**
 * Group model-call pairs into conversation threads and reconstruct each
 * thread's turns from its spine request + streamed response. Handles both
 * wire dialects: Anthropic /v1/messages and OpenAI Responses (codex, grok) —
 * normalized into the same turn/block model. `wire` is the merged per-client
 * table from src/clients (embedded as CLIENT_WIRE in the page); it names the
 * thread-id header for labeled OpenAI pairs. Returns { threads } in wire
 * order; each thread: { key, kind, label, model, system, tools, pairIds,
 * turns, usage, agentOf? }.
 */
export function buildSession(pairs: any[], wire?: any): any {
  const threads: any[] = [];
  const byKey: Record<string, any> = {};
  // History length in normalized turns — the attribution index. Anthropic
  // messages map 1:1; OpenAI input[] folds (reasoning/tool items join turns).
  // Stubs (`cctrace compact` folded the superseded request body) remember
  // theirs in historyLen, so attribution survives compaction.
  const histLen = (p: any, dialect: string) => {
    const b = p.request.body || {};
    if (b._cctrace_stub) return typeof b.historyLen === "number" ? b.historyLen : 0;
    return dialect === "openai" ? normalizeOpenaiTurns(b.input || []).length : (b.messages || []).length;
  };

  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    const dialect = wireDialect(p);
    const req = p.request.body || {};
    const stub = !!req._cctrace_stub && req.kind === "superseded";
    let key = "";
    if (dialect === "anthropic") {
      if (!stub && (!Array.isArray(req.messages) || !req.messages.length)) continue;
      // cc >= ~2.1.2xx stamps every sidechain request with a stable per-run
      // agent id — exact, collision-proof grouping. Older versions fall back
      // to the first-user-text signature (a stub carries its firstUserText,
      // pre-extracted, so it keys identically to the request it replaced).
      const agentId = (p.request.headers || {})["x-claude-code-agent-id"] || "";
      key = agentId ? "agent:" + agentId
        : stub ? threadSig({ content: req.firstUserText || "" })
        : threadSig(req.messages[0]);
    } else if (dialect === "openai") {
      if (!stub && (!Array.isArray(req.input) || !req.input.length)) continue;
      // Thread identity is on the wire in a header (codex thread-id, grok
      // x-grok-conv-id — named by the client's wire table); a few calls
      // carry none and fall back to the first-user-text signature.
      const w = wire && p.client ? wire[p.client] : null;
      const convId = (w && w.threadHeader && (p.request.headers || {})[w.threadHeader]) || "";
      key = convId ? "conv:" + convId
        : "osig:" + threadSig({ content: stub ? req.firstUserText || "" : openaiFirstUserText(req.input) });
    } else {
      continue;
    }
    // Threads are scoped WITHIN their session (session-tab design): two
    // sessions whose first message is identical (e.g. after /clear) must
    // never merge into one thread. "" = no session id — an honest bucket.
    const sid = extractSessionId(p, wire) || "";
    key = sid + "|" + key;
    let t = byKey[key];
    if (!t) {
      t = { key, kind: "chat", label: "", model: "", dialect, sessionId: sid, reqs: [] };
      byKey[key] = t;
      threads.push(t);
    }
    t.reqs.push(p);
    // t.model is finalized per-thread below (primary = most output tokens);
    // this is just a seed so threads whose every request errors still name
    // the model they asked for.
    if (req.model && !t.model) t.model = req.model;
  }

  for (const t of threads) {
    // Spine: the request carrying the longest history (ties -> latest).
    // Stubbed requests can't rebuild turns, so they never anchor the spine
    // (compact keeps each epoch's longest request full for exactly this).
    let spine = t.reqs[0];
    let spineLen = -1;
    for (const p of t.reqs) {
      if ((p.request.body || {})._cctrace_stub) continue;
      const len = histLen(p, t.dialect);
      if (len >= spineLen) {
        spine = p;
        spineLen = len;
      }
    }
    const sreq = spine.request.body || {};
    if (t.dialect === "openai") {
      t.system = openaiSystemText(sreq.input) || null;
      t.tools = openaiTools(sreq);
      t.turns = normalizeOpenaiTurns(sreq.input);
    } else {
      t.system = sreq.system || null;
      t.tools = Array.isArray(sreq.tools) ? sreq.tools : [];
      t.turns = normalizeTurns(sreq.messages);
    }
    const rblocks = responseBlocks(spine);
    if (rblocks.length) t.turns.push({ role: "assistant", blocks: rblocks, toolResultsOnly: false, pairId: null, usage: null });

    // Per-turn attribution (devlog 2026-07-17): index-first, content-
    // verified. A request with n history turns produced the assistant turn
    // at index n — but Claude Code repacks history between requests
    // (ephemeral notice turns come and go), so the index can land on the
    // wrong turn. Verify the landing turn against the pair's own response;
    // scan for the true turn on mismatch; classify what matches nothing
    // (rewound vs unattributed) instead of dropping it silently.
    // claim strength: 1 = index-only (unverifiable pair), 2 = content-verified.
    const claimed: Record<number, number> = {};
    t.rewound = [];
    t.unattributed = [];
    for (const p of t.reqs) {
      const idx = histLen(p, t.dialect);
      const landing = t.turns[idx];
      const attach = (i: number, strength: number) => {
        t.turns[i].pairId = p.id;
        t.turns[i].usage = extractCallInfo(p);
        claimed[i] = strength;
      };
      const rsig = turnContentSig(responseBlocks(p));
      if (!rsig) {
        // Nothing to verify against (stubbed body's response was collapsed,
        // errored/empty stream): index attribution stays primary, but never
        // over a verified claim.
        if (landing && landing.role === "assistant" && (claimed[idx] || 0) < 2) attach(idx, 1);
        continue;
      }
      if (landing && landing.role === "assistant" && turnContentSig(landing.blocks) === rsig) {
        attach(idx, 2);
        continue;
      }
      // Index landed wrong — find the reply in the spine, nearest turn
      // first, preferring unclaimed slots (identical short replies exist).
      let found = -1;
      let foundCost = Infinity;
      for (let i = 0; i < t.turns.length; i++) {
        const tt = t.turns[i];
        if (!tt || tt.role !== "assistant") continue;
        if (turnContentSig(tt.blocks) !== rsig) continue;
        const cost = Math.abs(i - idx) + (claimed[i] ? 1000 : 0);
        if (cost < foundCost) {
          found = i;
          foundCost = cost;
        }
      }
      if (found >= 0) {
        if ((claimed[found] || 0) < 2 || !t.turns[found].pairId) attach(found, 2);
        continue;
      }
      // The reply exists on the wire but nowhere in the spine's history: the
      // exchange was erased. Prefix-divergence decides the class — if the
      // pair's final history turn differs from the spine's packing at that
      // index, /rewind rewrote history (keep + mark, never lose); otherwise
      // we just can't place it.
      let cls = "unattributed";
      const body = p.request.body || {};
      const hist = t.dialect === "openai"
        ? (Array.isArray(body.input) ? normalizeOpenaiTurns(body.input) : [])
        : (Array.isArray(body.messages) ? normalizeTurns(body.messages) : []);
      if (hist.length) {
        const lastSig = turnContentSig(hist[hist.length - 1].blocks);
        const spineAt = t.turns[idx - 1];
        const spineSig = spineAt ? turnContentSig(spineAt.blocks) : "";
        if (lastSig && spineSig && lastSig !== spineSig) cls = "rewound";
      }
      if (cls === "rewound") t.rewound.push({ pairId: p.id, at: idx });
      else t.unattributed.push(p.id);
    }

    const agg = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: t.reqs.length,
      // Error metrics, reported separately (they mean different things):
      // wireErrors = the request itself failed (no response, HTTP 4xx/5xx,
      // or an in-stream error event); truncated = upstream died mid-stream;
      // toolErrors/toolUses = tool_result blocks flagged is_error, with the
      // denominator for a rate.
      wireErrors: 0, truncated: 0, toolErrors: 0, toolUses: 0,
      rewound: t.rewound.length, unattributed: t.unattributed.length,
    };
    // A thread is not one model: /model switches mid-session at will. Track
    // the set (model -> requests/tokens/cost); the thread's face model is
    // the one that did the most output work — last-used was the bug
    // (devlog 2026-07-17), not a rule.
    const models: Record<string, any> = {};
    for (const p of t.reqs) {
      const m = extractCallInfo(p);
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      agg.cacheWrite += m.cacheWrite;
      const c = pairCost(m);
      if (c) agg.cost += c.total;
      const r = p.response;
      if (!r || r.status >= 400 || m.error) agg.wireErrors++;
      if (r && r.truncated) agg.truncated++;
      const mid = (p.request.body || {}).model || m.model || "";
      if (mid) {
        const mm = models[mid] || (models[mid] = { requests: 0, input: 0, output: 0, cost: 0 });
        mm.requests++;
        mm.input += m.input;
        mm.output += m.output;
        if (c) mm.cost += c.total;
      }
    }
    t.models = models;
    let primary = t.model || "";
    let primaryOut = -1;
    for (const mid in models) {
      if (models[mid].output > primaryOut) {
        primary = mid;
        primaryOut = models[mid].output;
      }
    }
    t.model = primary;
    for (const turn of t.turns) {
      for (const b of turn.blocks || []) {
        if (!b) continue;
        if (b.type === "tool_use" || b.type === "server_tool_use") agg.toolUses++;
        else if (b.type === "tool_result" && b.is_error) agg.toolErrors++;
      }
    }
    t.usage = agg;

    if (t.dialect === "openai") {
      // Harness noise on the OpenAI wire: codex prewarm probes self-identify
      // in the x-codex-turn-metadata JSON header; grok recap utilities in
      // their conv id.
      const meta = (spine.request.headers || {})["x-codex-turn-metadata"] || "";
      const w2 = wire && spine.client ? wire[spine.client] : null;
      const conv = (w2 && w2.threadHeader && (spine.request.headers || {})[w2.threadHeader]) || "";
      if (String(meta).indexOf('"request_kind":"prewarm"') !== -1) {
        t.kind = "utility";
        t.label = "prewarm";
      } else if (String(conv).lastIndexOf("recap-", 0) === 0) {
        t.kind = "utility";
        t.label = "recap";
      }
    } else {
      // Utility classification: quota probes and title generation are harness
      // noise, not conversation.
      let sysText = "";
      const sys = sreq.system;
      if (typeof sys === "string") sysText = sys;
      else if (Array.isArray(sys)) sysText = sys.map((b: any) => (b && b.text) || "").join("\n");
      if (sreq.max_tokens === 1) {
        t.kind = "utility";
        t.label = "quota probe";
      } else if (!t.tools.length && t.turns.length <= 2 && /concise[^.]*title/i.test(sysText)) {
        t.kind = "utility";
        t.label = "title generation";
      } else if (
        // Sidechain markers: the agent-id header (cc >= ~2.1.2xx), the billing
        // block's cc_is_subagent flag, or the subagent system prompt. A
        // sidechain must never compete as "chat" — mainThread() picks chats —
        // even when its Task dispatch isn't on the wire to link against.
        (spine.request.headers || {})["x-claude-code-agent-id"] ||
        sysText.indexOf("cc_is_subagent=true") !== -1 ||
        /You are (a Claude agent|an agent for Claude Code)/.test(sysText)
      ) {
        t.kind = "agent";
      }
    }

    t.pairIds = t.reqs.map((p: any) => p.id);
    t.firstAt = t.reqs[0].request.timestamp || 0;
    t.lastAt = t.reqs[t.reqs.length - 1].request.timestamp || 0;
  }

  // Agent linking: a thread whose first user text matches a Task-style
  // tool_use prompt from another thread is that dispatch's subagent run.
  const dispatches: any[] = [];
  for (const t of threads) {
    for (const turn of t.turns) {
      if (turn.role !== "assistant") continue;
      for (const b of turn.blocks) {
        if (b && b.type === "tool_use" && /^(Task|Agent|TaskCreate)$/.test(b.name || "") && b.input && typeof b.input.prompt === "string") {
          dispatches.push({
            prompt: b.input.prompt,
            from: t.key,
            toolUseId: b.id || "",
            agentType: b.input.subagent_type || "",
            description: b.input.description || "",
          });
        }
      }
    }
  }
  for (const t of threads) {
    if (t.kind !== "chat" && t.kind !== "agent") continue;
    // The dispatch prompt lands verbatim as the subagent's first user text —
    // AFTER the injected reminder block, which firstUserText skips.
    let firstText = "";
    for (const turn of t.turns) {
      if (turn.role !== "user") continue;
      firstText = firstUserText(turn.blocks);
      break;
    }
    if (!firstText) continue;
    for (const d of dispatches) {
      if (d.from === t.key) continue;
      const head = d.prompt.slice(0, 300);
      if (firstText === d.prompt || firstText.indexOf(head) !== -1 || d.prompt.indexOf(firstText.slice(0, 300)) !== -1) {
        t.kind = "agent";
        t.agentOf = { thread: d.from, toolUseId: d.toolUseId, agentType: d.agentType, description: d.description };
        if (d.agentType || d.description) {
          t.label = "[" + (d.agentType || "agent") + "] " + (d.description || "");
        }
        break;
      }
    }
  }

  for (const t of threads) {
    if (!t.label) {
      const n = t.turns.filter((x: any) => !x.toolResultsOnly).length;
      const extra = Math.max(0, Object.keys(t.models || {}).length - 1);
      t.label = shortModel(t.model)
        + (extra ? " +" + extra + " model" + (extra === 1 ? "" : "s") : "")
        + " · " + n + " turn" + (n === 1 ? "" : "s");
    }
    delete t.reqs;
  }

  return { threads };
}

/** The thread to select by default: the chat thread with the most turns. */
export function mainThread(threads: any[]): any {
  let best = null;
  for (const t of threads || []) {
    if (t.kind !== "chat") continue;
    if (!best || t.turns.length > best.turns.length) best = t;
  }
  return best || (threads && threads[0]) || null;
}

/** ccx-style one-line preview for a tool_use, keyed by tool name. */
export function toolPreview(name: string, input: any): string {
  const i = input || {};
  switch (name) {
    case "Bash": return "$ " + (i.command || "");
    case "Read": case "Write": case "Edit": case "NotebookEdit": return i.file_path || "";
    case "Grep": return "/" + (i.pattern || "") + "/" + (i.path ? " in " + i.path : "");
    case "Glob": return i.pattern || "";
    case "Task": case "Agent": case "TaskCreate": return "[" + (i.subagent_type || "agent") + "] " + (i.description || "");
    case "WebFetch": return i.url || "";
    case "WebSearch": return i.query || "";
    case "Skill": return i.skill || i.command || "";
    case "TodoWrite": return Array.isArray(i.todos) ? i.todos.length + " todos" : "";
    default: return "";
  }
}
