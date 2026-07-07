import { parseSse, assembleAssistant, extractMessageInfo, shortModel } from "./summarize";

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

/** Stable signature of a thread's first message (djb2 over its content). */
export function threadSig(firstMessage: any): string {
  let s = "";
  try {
    const c = firstMessage && firstMessage.content;
    s = typeof c === "string" ? c : JSON.stringify(c) || "";
  } catch {
    s = String(firstMessage);
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

/** Assistant content blocks from a pair's response (JSON body or SSE). */
export function responseBlocks(pair: any): any[] {
  const r = pair && pair.response;
  if (!r) return [];
  if (r.body && Array.isArray(r.body.content)) return r.body.content;
  if (r.bodyRaw) return assembleAssistant(parseSse(r.bodyRaw));
  return [];
}

/**
 * Group /v1/messages pairs into conversation threads and reconstruct each
 * thread's turns from its spine request + streamed response. Returns
 * { threads } in wire order; each thread: { key, kind, label, model, system,
 * tools, pairIds, turns, usage, agentOf? }.
 */
export function buildSession(pairs: any[]): any {
  const threads: any[] = [];
  const byKey: Record<string, any> = {};

  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    let path = "";
    try {
      path = new URL(p.request.url).pathname.toLowerCase();
    } catch {
      path = String(p.request.url || "").toLowerCase();
    }
    if (path.indexOf("/v1/messages") === -1 || path.indexOf("count_tokens") !== -1) continue;
    const req = p.request.body || {};
    if (!Array.isArray(req.messages) || !req.messages.length) continue;
    const key = threadSig(req.messages[0]);
    let t = byKey[key];
    if (!t) {
      t = { key, kind: "chat", label: "", model: "", reqs: [] };
      byKey[key] = t;
      threads.push(t);
    }
    t.reqs.push(p);
    if (req.model) t.model = req.model;
  }

  for (const t of threads) {
    // Spine: the request carrying the longest history (ties -> latest).
    let spine = t.reqs[0];
    for (const p of t.reqs) {
      if ((p.request.body.messages || []).length >= (spine.request.body.messages || []).length) spine = p;
    }
    const sreq = spine.request.body || {};
    t.system = sreq.system || null;
    t.tools = Array.isArray(sreq.tools) ? sreq.tools : [];
    t.turns = normalizeTurns(sreq.messages);
    const rblocks = responseBlocks(spine);
    if (rblocks.length) t.turns.push({ role: "assistant", blocks: rblocks, toolResultsOnly: false, pairId: null, usage: null });

    // A request with n history messages produced the assistant turn at index
    // n; wire order means later (retried/injected) requests win the slot.
    for (const p of t.reqs) {
      const turn = t.turns[(p.request.body.messages || []).length];
      if (turn && turn.role === "assistant") {
        turn.pairId = p.id;
        turn.usage = extractMessageInfo(p);
      }
    }

    const agg = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: t.reqs.length };
    for (const p of t.reqs) {
      const m = extractMessageInfo(p);
      agg.input += m.input;
      agg.output += m.output;
      agg.cacheRead += m.cacheRead;
      agg.cacheWrite += m.cacheWrite;
    }
    t.usage = agg;

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
    }

    t.pairIds = t.reqs.map((p: any) => p.id);
    t.firstAt = t.reqs[0].request.timestamp || 0;
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
    if (t.kind !== "chat") continue;
    let firstText = "";
    for (const turn of t.turns) {
      if (turn.role !== "user") continue;
      for (const b of turn.blocks) if (b && b.type === "text" && b.text) { firstText = b.text; break; }
      break;
    }
    if (!firstText) continue;
    for (const d of dispatches) {
      if (d.from === t.key) continue;
      const head = d.prompt.slice(0, 300);
      if (firstText === d.prompt || firstText.indexOf(head) !== -1 || d.prompt.indexOf(firstText.slice(0, 300)) !== -1) {
        t.kind = "agent";
        t.agentOf = { thread: d.from, toolUseId: d.toolUseId, agentType: d.agentType, description: d.description };
        break;
      }
    }
  }

  for (const t of threads) {
    if (!t.label) {
      const n = t.turns.filter((x: any) => !x.toolResultsOnly).length;
      t.label = shortModel(t.model) + " · " + n + " turn" + (n === 1 ? "" : "s");
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
