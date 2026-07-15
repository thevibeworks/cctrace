import { parseSse } from "../summarize";

// OpenAI Responses dialect (codex, grok — #20): pure adapters that normalize
// the wire shape into the same turn/block model session.ts builds for
// Anthropic, so the session view, folds, replay, and usage chips work
// unchanged. Wire facts from real traces, 2026-07-14 devlog entry:
// full-history resend per call (input[] is the conversation), and the final
// SSE `response.completed` event carries the COMPLETE response object —
// output blocks and usage — so no delta assembly is needed (output_item.done
// events remain as the truncated-stream fallback).
//
// Like summarize.ts/session.ts, every exported function is inlined into the
// web UI via toString(): self-contained, cross-calls only to other inlined
// functions by name.

/** Model-call dialect of a pair: "anthropic" | "openai" | null (not a model call). */
export function wireDialect(pair: any): string | null {
  let path = "";
  try {
    path = new URL(pair && pair.request && pair.request.url).pathname.toLowerCase();
  } catch {
    path = String((pair && pair.request && pair.request.url) || "").toLowerCase();
  }
  if (path.indexOf("/v1/messages") !== -1) return path.indexOf("count_tokens") !== -1 ? null : "anthropic";
  if (/\/(responses|chat\/completions)$/.test(path)) return "openai";
  return null;
}

/**
 * The final response object of an OpenAI Responses call: a non-streamed JSON
 * body, or the last response.completed/failed/incomplete SSE event. Falls
 * back to a synthetic { output } assembled from output_item.done events when
 * the stream was truncated before its completed event.
 */
export function openaiCompleted(pair: any): any {
  const r = pair && pair.response;
  if (!r) return null;
  if (r.body && typeof r.body === "object" && Array.isArray(r.body.output)) return r.body;
  if (!r.bodyRaw) return null;
  let done: any = null;
  const items: any[] = [];
  for (const ev of parseSse(r.bodyRaw)) {
    if (!ev) continue;
    if ((ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.incomplete") && ev.response) done = ev.response;
    else if (ev.type === "response.output_item.done" && ev.item) items.push(ev.item);
  }
  if (done) return done;
  return items.length ? { output: items, status: "truncated" } : null;
}

/** One OpenAI item (input or output) -> zero or more normalized content blocks. */
export function openaiBlocks(item: any): any[] {
  if (!item || !item.type) return [];
  if (item.type === "message") {
    const out: any[] = [];
    const c = item.content;
    if (typeof c === "string") {
      if (c) out.push({ type: "text", text: c });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (typeof b.text === "string" && b.text) out.push({ type: "text", text: b.text });
        else if (typeof b.refusal === "string") out.push({ type: "text", text: b.refusal });
      }
    }
    return out;
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const raw = typeof item.arguments === "string" ? item.arguments : typeof item.input === "string" ? item.input : "";
    let input: any = null;
    if (item.type === "function_call") {
      try {
        input = JSON.parse(raw);
      } catch {
        input = null;
      }
    }
    // custom tool input is freeform (codex exec sends JS source) — keep raw
    if (input === null || typeof input !== "object") input = { input: raw };
    return [{ type: "tool_use", id: item.call_id || item.id || "", name: item.name || "tool", input }];
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    let content = item.output;
    if (Array.isArray(content)) content = content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("");
    if (typeof content !== "string") content = content == null ? "" : JSON.stringify(content);
    return [{ type: "tool_result", tool_use_id: item.call_id || "", content }];
  }
  if (item.type === "reasoning") {
    let text = "";
    if (Array.isArray(item.summary)) text = item.summary.map((s: any) => (s && s.text) || "").filter(Boolean).join("\n\n");
    if (!text && item.encrypted_content) text = "(encrypted reasoning)";
    return text ? [{ type: "thinking", thinking: text }] : [];
  }
  return []; // additional_tools and unknown item types carry no conversation
}

/**
 * Flat OpenAI input[] -> turn objects matching normalizeTurns' shape.
 * Consecutive assistant-side items (message, reasoning, tool calls) fold into
 * one assistant turn; tool outputs ride user turns, Anthropic-style, so
 * buildToolResultIndex and the fold renderers work unchanged. The FIRST
 * system/developer message is the thread's system prompt (extracted by
 * openaiSystemText) and is skipped here; later ones are harness context
 * injections and render as user turns.
 */
export function normalizeOpenaiTurns(input: any[]): any[] {
  const turns: any[] = [];
  let cur: any = null;
  let sawSystem = false;
  const push = (role: string, blocks: any[]) => {
    if (!blocks.length) return;
    if (!cur || cur.role !== role) {
      cur = { role, blocks: [], toolResultsOnly: false, pairId: null, usage: null };
      turns.push(cur);
    }
    for (const b of blocks) cur.blocks.push(b);
  };
  for (const item of input || []) {
    if (!item || item.type === "additional_tools") continue;
    if (item.type === "message") {
      let role = item.role === "assistant" ? "assistant" : "user";
      if (item.role === "system" || item.role === "developer") {
        if (!sawSystem) {
          sawSystem = true;
          continue;
        }
        role = "user";
      }
      push(role, openaiBlocks(item));
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      push("user", openaiBlocks(item));
    } else {
      push("assistant", openaiBlocks(item));
    }
  }
  for (const t of turns) {
    t.toolResultsOnly = t.blocks.length > 0 && t.blocks.every((b: any) => b && b.type === "tool_result");
  }
  return turns;
}

/** The system prompt: text of the first system/developer message in input[]. */
export function openaiSystemText(input: any[]): string {
  for (const item of input || []) {
    if (item && item.type === "message" && (item.role === "system" || item.role === "developer")) {
      const blocks = openaiBlocks(item);
      return blocks.map((b: any) => b.text || "").filter(Boolean).join("\n");
    }
  }
  return "";
}

/** All tools a request offers: body.tools plus codex additional_tools items. */
export function openaiTools(req: any): any[] {
  const out: any[] = [];
  if (req && Array.isArray(req.tools)) for (const t of req.tools) out.push(t);
  for (const item of (req && req.input) || []) {
    if (item && item.type === "additional_tools" && Array.isArray(item.tools)) {
      for (const t of item.tools) out.push(t);
    }
  }
  return out;
}

/** First real user text in input[] — the sig-fallback key when no thread header. */
export function openaiFirstUserText(input: any[]): string {
  for (const item of input || []) {
    if (item && item.type === "message" && item.role === "user") {
      const blocks = openaiBlocks(item);
      if (blocks.length && blocks[0].text) return blocks[0].text;
    }
  }
  return "";
}

/**
 * extractMessageInfo's shape for an OpenAI Responses pair. OpenAI
 * input_tokens INCLUDES cached tokens; ours excludes them (Anthropic
 * convention, what the chips display), so cacheRead/cacheWrite are peeled
 * off. reasoning_tokens map to thinking.
 */
export function extractOpenaiInfo(pair: any): any {
  const req = (pair && pair.request && pair.request.body) || {};
  const resp = (pair && pair.response) || null;
  const done = openaiCompleted(pair);
  const u = (done && done.usage) || {};
  const n = (v: any) => (typeof v === "number" ? v : 0);
  const din = u.input_tokens_details || {};
  const dout = u.output_tokens_details || {};
  const cacheRead = n(din.cached_tokens);
  const cacheWrite = n(din.cache_write_tokens);
  const totalIn = n(u.input_tokens);
  const input = Math.max(0, totalIn - cacheRead - cacheWrite);

  let error: any = null;
  if (resp && resp.status >= 400) {
    const b = resp.body;
    const msg = b && (b.detail || (b.error && (b.error.message || b.error.type)));
    error = typeof msg === "string" ? msg.slice(0, 80) : "HTTP " + resp.status;
  }
  let stopReason: any = null;
  if (done && done.status && done.status !== "completed") stopReason = done.status;
  if (done && done.incomplete_details && done.incomplete_details.reason) stopReason = done.incomplete_details.reason;

  return {
    model: req.model || (done && done.model) || null,
    stream: req.stream === true,
    maxTokens: typeof req.max_output_tokens === "number" ? req.max_output_tokens : null,
    temperature: typeof req.temperature === "number" ? req.temperature : null,
    turns: Array.isArray(req.input) ? req.input.length : 0,
    toolCount: openaiTools(req).length,
    systemBlocks: openaiSystemText(req.input) ? 1 : 0,
    input,
    output: n(u.output_tokens),
    cacheRead,
    cacheWrite,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    thinking: n(dout.reasoning_tokens),
    cachePct: totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : null,
    stopReason,
    serviceTier: req.service_tier || null,
    error,
  };
}
