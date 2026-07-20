import { parseSse } from "../summarize";

// OpenAI dialect (codex, grok, kimi — #20): pure adapters that normalize the
// wire shape into the same turn/block model session.ts builds for Anthropic,
// so the session view, folds, replay, and usage chips work unchanged. Wire
// facts from real traces, 2026-07-14 devlog entry: full-history resend per
// call (input[] is the conversation), and the final SSE `response.completed`
// event carries the COMPLETE response object — output blocks and usage — so no
// delta assembly is needed (output_item.done events remain as the
// truncated-stream fallback).
//
// TWO SUB-SHAPES share this dialect. Responses (codex/grok): request `input[]`,
// response `response.completed` object. Chat Completions (kimi, 2026-07-20):
// request `messages[]`, response `chat.completion.chunk` deltas + `usage`
// {prompt_tokens,completion_tokens,prompt_tokens_details.cached_tokens}. Rather
// than a third dialect, Chat Completions is ADAPTED INTO the Responses object
// model at two seams — `openaiInput` (messages[] -> input[] items) and a chat
// branch in `openaiCompleted` (chunk deltas -> {output,usage}) — so every
// downstream consumer (openaiBlocks, normalizeOpenaiTurns, extractOpenaiInfo,
// attribution, compaction, the UI) stays identical and wireDialect stays
// two-valued. Callers read the conversation via openaiInput(req), never
// req.input directly.
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
 * The conversation as Responses `input[]` items. Responses pairs already carry
 * `input`; Chat Completions pairs (kimi) carry `messages[]` — an OpenAI-chat
 * message maps to the same item vocabulary openaiBlocks/normalizeOpenaiTurns
 * already speak: system/user/assistant text -> `message`, `reasoning_content`
 * -> `reasoning`, `tool_calls` -> `function_call`, a `tool` role message ->
 * `function_call_output`. One seam; every other function is shape-agnostic.
 */
export function openaiInput(req: any): any[] {
  if (!req) return [];
  if (Array.isArray(req.input)) return req.input;
  const msgs = req.messages;
  if (!Array.isArray(msgs)) return [];
  const items: any[] = [];
  for (const m of msgs) {
    if (!m || !m.role) continue;
    if (m.role === "tool") {
      let content = m.content;
      // Parts arrays (kimi media tool results: text + image_url parts) pass
      // through — openaiBlocks turns them into text/image blocks; flattening
      // here would drop the images on the floor.
      if (typeof content !== "string" && !Array.isArray(content)) content = content == null ? "" : JSON.stringify(content);
      items.push({ type: "function_call_output", call_id: m.tool_call_id || "", output: content });
      continue;
    }
    if (m.role === "assistant") {
      if (typeof m.reasoning_content === "string" && m.reasoning_content) items.push({ type: "reasoning", summary: [{ type: "summary_text", text: m.reasoning_content }] });
      const hasText = typeof m.content === "string" ? m.content.length > 0 : Array.isArray(m.content) && m.content.length > 0;
      if (hasText) items.push({ type: "message", role: "assistant", content: m.content });
      for (const tc of m.tool_calls || []) {
        const fn = (tc && tc.function) || {};
        items.push({ type: "function_call", call_id: (tc && tc.id) || "", id: (tc && tc.id) || "", name: fn.name || "tool", arguments: typeof fn.arguments === "string" ? fn.arguments : "" });
      }
      continue;
    }
    // system, developer, user — a plain message item (openaiBlocks reads
    // string or parts[] content the same for both sub-shapes).
    items.push({ type: "message", role: m.role, content: m.content });
  }
  return items;
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
  // Chat Completions (kimi): assemble the streamed chat.completion.chunk
  // deltas (or a non-stream {choices:[{message}]} body) into a Responses-shape
  // { output, usage, status } so openaiBlocks / extractOpenaiInfo see the same
  // object model as codex/grok. Detect by the choices array / chunk marker;
  // Responses never carries either.
  const looksChat = (r.body && typeof r.body === "object" && Array.isArray(r.body.choices)) ||
    (typeof r.bodyRaw === "string" && r.bodyRaw.indexOf("chat.completion") !== -1);
  if (looksChat) {
    let content = "";
    let reasoning = "";
    let finish: any = null;
    let model: any = null;
    const toolBuf: any[] = [];
    const byIdx: Record<string, any> = {};
    const usage: any = { input_tokens: 0, output_tokens: 0, input_tokens_details: {}, output_tokens_details: {} };
    let sawUsage = false;
    const applyUsage = (u: any) => {
      if (!u || typeof u !== "object") return;
      sawUsage = true;
      if (typeof u.prompt_tokens === "number") usage.input_tokens = u.prompt_tokens;
      if (typeof u.completion_tokens === "number") usage.output_tokens = u.completion_tokens;
      const pd = u.prompt_tokens_details || {};
      const cd = u.completion_tokens_details || {};
      if (typeof pd.cached_tokens === "number") usage.input_tokens_details.cached_tokens = pd.cached_tokens;
      if (typeof cd.reasoning_tokens === "number") usage.output_tokens_details.reasoning_tokens = cd.reasoning_tokens;
    };
    const addTool = (tc: any) => {
      if (!tc) return;
      const k = typeof tc.index === "number" ? String(tc.index) : String(Object.keys(byIdx).length);
      let b = byIdx[k];
      if (!b) { b = { id: "", name: "", args: "" }; byIdx[k] = b; toolBuf.push(b); }
      if (tc.id) b.id = tc.id;
      const fn = tc.function || {};
      if (fn.name) b.name = fn.name;
      if (typeof fn.arguments === "string") b.args += fn.arguments;
    };
    if (r.body && typeof r.body === "object" && Array.isArray(r.body.choices)) {
      const ch = r.body.choices[0] || {};
      const msg = ch.message || {};
      content = typeof msg.content === "string" ? msg.content : "";
      reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
      finish = ch.finish_reason || null;
      model = r.body.model || null;
      for (const tc of msg.tool_calls || []) addTool(tc);
      applyUsage(r.body.usage);
    } else {
      for (const ev of parseSse(r.bodyRaw)) {
        if (!ev || typeof ev !== "object") continue;
        if (ev.model) model = ev.model;
        if (ev.usage) applyUsage(ev.usage);
        const choices = ev.choices;
        if (!Array.isArray(choices) || !choices.length) continue;
        const ch = choices[0];
        if (!ch) continue;
        if (ch.usage) applyUsage(ch.usage);
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta;
        if (!d) continue;
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
        if (typeof d.content === "string") content += d.content;
        for (const tc of d.tool_calls || []) addTool(tc);
      }
    }
    const output: any[] = [];
    if (reasoning) output.push({ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
    if (content) output.push({ type: "message", role: "assistant", content });
    for (const b of toolBuf) output.push({ type: "function_call", call_id: b.id, id: b.id, name: b.name, arguments: b.args });
    const res: any = { output, model };
    if (sawUsage) res.usage = usage;
    // finish_reason "length" = capped, null = stream cut off before its final
    // chunk; "stop"/"tool_calls" are healthy completions.
    if (finish === "length") res.status = "incomplete";
    else if (finish == null && !sawUsage) res.status = "truncated";
    return res;
  }
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
  // image_url parts (kimi media messages/tool results) become Anthropic-shape
  // image blocks — the UI renders a media-type note. The base64 data itself
  // stays on the wire copy; the block keeps only the mime from the data URL.
  const imgBlock = (part: any) => {
    const url = part && part.image_url && typeof part.image_url.url === "string" ? part.image_url.url : "";
    const m = /^data:([^;,]+)/.exec(url);
    return { type: "image", source: { media_type: m ? m[1] : "" } };
  };
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
        else if (b.type === "image_url") out.push(imgBlock(b));
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
    if (Array.isArray(content)) {
      if (content.some((b: any) => b && b.type === "image_url")) {
        // Media tool results keep their parts: text parts -> text blocks,
        // image_url parts -> image blocks (the tool_result renderer walks
        // content arrays, Anthropic-style).
        const parts: any[] = [];
        for (const b of content) {
          if (!b) continue;
          if (typeof b.text === "string" && b.text) parts.push({ type: "text", text: b.text });
          else if (b.type === "image_url") parts.push(imgBlock(b));
        }
        content = parts;
      } else {
        content = content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("");
      }
    } else if (typeof content !== "string") {
      content = content == null ? "" : JSON.stringify(content);
    }
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

  // Chat Completions caps completion via max_completion_tokens / the legacy
  // max_tokens alias; Responses uses max_output_tokens.
  const maxTokens = typeof req.max_output_tokens === "number" ? req.max_output_tokens
    : typeof req.max_completion_tokens === "number" ? req.max_completion_tokens
    : typeof req.max_tokens === "number" ? req.max_tokens : null;
  const inputItems = openaiInput(req);
  return {
    model: req.model || (done && done.model) || null,
    stream: req.stream === true,
    maxTokens,
    temperature: typeof req.temperature === "number" ? req.temperature : null,
    turns: inputItems.length,
    toolCount: openaiTools(req).length,
    systemBlocks: openaiSystemText(inputItems) ? 1 : 0,
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
