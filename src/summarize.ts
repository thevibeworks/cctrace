import { pairCost, fmtCost, costTitle } from "./pricing";
import { wireDialect, extractOpenaiInfo } from "./dialects/openai";

// Pure extraction/summary helpers shared by the web UI and unit tests.
//
// Every function here is ALSO inlined into the live web UI via
// Function.prototype.toString() (same pattern as categorize.ts), so each must
// be self-contained: no captured module state, and calls only to other
// inlined functions by name (pricing.ts helpers are inlined alongside).

/** Parse an SSE stream ("data: {...}" lines) into an array of JSON events. */
export function parseSse(raw: unknown): any[] {
  const events: any[] = [];
  for (const line of String(raw || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    try {
      events.push(JSON.parse(t.slice(5)));
    } catch {
      // partial or non-JSON data line - skip
    }
  }
  return events;
}

/** 19635 -> "19.6k". Compact counts for one-line labels. */
export function fmtCompact(n: unknown): string {
  if (typeof n !== "number" || !isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1000000) {
    const k = n / 1000;
    return (k >= 100 ? String(Math.round(k)) : k.toFixed(1)) + "k";
  }
  return (n / 1000000).toFixed(2) + "m";
}

/** 850 -> "850ms", 8412 -> "8.41s" — same wall-clock format as the UI. */
export function fmtMs(ms: unknown): string {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(2) + "s";
}

/**
 * First-token latency for a captured pair. firstTokenMs is measured live by
 * the proxy pump (SSE events carry no timestamps, so it cannot be derived
 * from a saved body): time from request arrival to the first streamed token
 * event. firstByteMs (first response body byte) is the fallback when no
 * token event was seen. Returns null for pairs captured before 0.15.
 * pct = the delay's share of the pair's whole wall-clock duration.
 */
export function extractLatency(pair: any): any {
  const resp = pair && pair.response;
  if (!resp) return null;
  const ttft = typeof resp.firstTokenMs === "number" ? resp.firstTokenMs : null;
  const ttfb = typeof resp.firstByteMs === "number" ? resp.firstByteMs : null;
  if (ttft == null && ttfb == null) return null;
  const ms = ttft != null ? ttft : ttfb;
  const total = typeof pair.duration === "number" && pair.duration > 0 ? pair.duration : null;
  return {
    ms,
    isToken: ttft != null,
    ttftMs: ttft,
    ttfbMs: ttfb,
    totalMs: total,
    pct: total != null && ms != null ? Math.round((ms / total) * 100) : null,
  };
}

/** 850 -> "850B", 53000 -> "51.8KB", 54700000 -> "52.2MB". */
export function fmtBytes(b: unknown): string {
  if (typeof b !== "number" || !isFinite(b) || b < 0) return "0B";
  if (b < 1024) return Math.round(b) + "B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + "KB";
  return (b / (1024 * 1024)).toFixed(1) + "MB";
}

/**
 * Request/response body sizes for a pair, DevTools-style. Wire byte counts
 * are stamped at capture time (0.17+): request.bodyBytes is the body as sent
 * (compressed when the client compressed it — codex zstd), response.bodyBytes
 * as received (the proxy asks for identity encoding, so ~decoded size).
 * Older traces fall back to an estimate from the decoded trace body
 * (exact: false). Opaque tunnel meta pairs report whole-connection byte
 * counts instead (tunneled: true — TLS + headers included, not just bodies).
 */
export function extractSizes(pair: any): any {
  const req = pair && pair.request;
  if (!req) return null;
  const resp = pair.response;
  const tb = resp && resp.body && resp.body.tunneled ? resp.body : null;
  if (tb) {
    return {
      up: typeof tb.bytesUp === "number" ? tb.bytesUp : 0,
      down: typeof tb.bytesDown === "number" ? tb.bytesDown : 0,
      exact: true,
      tunneled: true,
    };
  }
  const est = (v: any) => {
    if (v == null) return 0;
    const s = typeof v === "string" ? v : JSON.stringify(v) || "";
    return s.length;
  };
  // Absent bodies are exactly zero bytes — "estimated" only when we had to
  // measure a decoded trace body instead of the wire.
  const upExact = typeof req.bodyBytes === "number" || req.body == null;
  const downExact = !resp || typeof resp.bodyBytes === "number" || (resp.body == null && resp.bodyRaw == null);
  let down = 0;
  if (resp) {
    if (typeof resp.bodyBytes === "number") down = resp.bodyBytes;
    else if (typeof resp.bodyRaw === "string") down = resp.bodyRaw.length;
    else down = est(resp.body);
  }
  return {
    up: typeof req.bodyBytes === "number" ? req.bodyBytes : est(req.body),
    down,
    exact: upExact && downExact,
    tunneled: false,
  };
}

/** "claude-haiku-4-5-20251001" -> "haiku-4-5" */
export function shortModel(model: unknown): string {
  return String(model || "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * Usage + request params for a /v1/messages pair. Handles both non-streaming
 * JSON bodies and streamed SSE (bodyRaw): input/cache counts come from
 * message_start, final output/thinking/stop_reason from message_delta.
 */
export function extractMessageInfo(pair: any): any {
  const req = (pair && pair.request && pair.request.body) || {};
  const resp = (pair && pair.response) || null;
  let start: any = null; // message_start message, or the full JSON body
  let usage: any = null; // final usage (message_delta wins over message_start)
  let stopReason: any = null;
  let error: any = null;

  if (resp && resp.body && typeof resp.body === "object") {
    const b: any = resp.body;
    if (b.type === "error" || b.error) {
      error = (b.error && b.error.type) || "error";
    } else {
      start = b;
      usage = b.usage || null;
      stopReason = b.stop_reason || null;
    }
  } else if (resp && resp.bodyRaw) {
    for (const ev of parseSse(resp.bodyRaw)) {
      if (ev.type === "message_start") start = ev.message;
      else if (ev.type === "message_delta") {
        if (ev.usage) usage = ev.usage;
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        error = (ev.error && ev.error.type) || "error";
      }
    }
  }

  const u0 = (start && start.usage) || {};
  const u = usage || u0;
  const n = (v: any) => (typeof v === "number" ? v : 0);
  const pick = (a: any, b: any) => (typeof a === "number" ? a : n(b));
  const input = pick(u.input_tokens, u0.input_tokens);
  const output = pick(u.output_tokens, u0.output_tokens);
  const cacheRead = pick(u.cache_read_input_tokens, u0.cache_read_input_tokens);
  const cacheWrite = pick(u.cache_creation_input_tokens, u0.cache_creation_input_tokens);
  const cc = u.cache_creation || u0.cache_creation || {};
  const totalIn = input + cacheRead + cacheWrite;
  return {
    model: req.model || (start && start.model) || null,
    stream: req.stream === true,
    maxTokens: typeof req.max_tokens === "number" ? req.max_tokens : null,
    temperature: typeof req.temperature === "number" ? req.temperature : null,
    turns: Array.isArray(req.messages) ? req.messages.length : 0,
    toolCount: Array.isArray(req.tools) ? req.tools.length : 0,
    systemBlocks: Array.isArray(req.system) ? req.system.length : typeof req.system === "string" ? 1 : 0,
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite5m: n(cc.ephemeral_5m_input_tokens),
    cacheWrite1h: n(cc.ephemeral_1h_input_tokens),
    thinking: n(u.output_tokens_details && u.output_tokens_details.thinking_tokens),
    cachePct: totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : null,
    stopReason: stopReason || null,
    serviceTier: u.service_tier || u0.service_tier || null,
    error,
  };
}

/** Usage/params for ANY model-call pair — dispatches on the wire dialect. */
export function extractCallInfo(pair: any): any {
  return wireDialect(pair) === "openai" ? extractOpenaiInfo(pair) : extractMessageInfo(pair);
}

/**
 * Requested reasoning effort for a model-call request body, across every wire
 * shape observed in real traces: Anthropic current (output_config.effort,
 * with thinking.type "adaptive"/"disabled" beside it), the transitional shape
 * Anthropic and Kimi both send (thinking.effort), classic extended thinking
 * (thinking.budget_tokens), OpenAI Responses (reasoning.effort — codex/grok),
 * and Chat Completions (reasoning_effort). Returns {v, title} — v the chip
 * value, title naming the wire field it came from — or null when the request
 * doesn't ask for reasoning.
 */
export function extractEffort(req: any): any {
  if (!req || typeof req !== "object") return null;
  const oc = req.output_config;
  if (oc && typeof oc === "object" && typeof oc.effort === "string")
    return { v: oc.effort, title: "requested reasoning effort — output_config.effort" };
  const th = req.thinking;
  if (th && typeof th === "object") {
    if (typeof th.effort === "string") return { v: th.effort, title: "requested reasoning effort — thinking.effort" };
    if (typeof th.budget_tokens === "number")
      return {
        v: fmtCompact(th.budget_tokens) + " budget",
        title: th.budget_tokens.toLocaleString() + "-token thinking budget — thinking.budget_tokens",
      };
    if (th.type === "adaptive") return { v: "adaptive", title: "model decides how much to reason — thinking.type = adaptive" };
  }
  const r = req.reasoning;
  if (r && typeof r === "object" && typeof r.effort === "string")
    return { v: r.effort, title: "requested reasoning effort — reasoning.effort" };
  if (typeof req.reasoning_effort === "string")
    return { v: req.reasoning_effort, title: "requested reasoning effort — reasoning_effort" };
  return null;
}

/** True when any system/tools/messages block sets cache_control. */
export function hasCacheControl(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  const blocks: any[] = [];
  if (Array.isArray(body.system)) blocks.push(...body.system);
  if (Array.isArray(body.tools)) blocks.push(...body.tools);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) if (msg && Array.isArray(msg.content)) blocks.push(...msg.content);
  }
  return blocks.some((b) => b && typeof b === "object" && b.cache_control);
}

/**
 * Prompt-cache verdict for one /v1/messages pair, as one compact chip:
 *   hit  — prompt prefix served from cache (cacheRead > 0)        [green]
 *   cold — nothing read, prefix (re)written: first request of a
 *          conversation, or the cached prefix changed/expired     [amber]
 *   miss — cache_control was set but nothing read OR written
 *          (cacheable prefix below the ~1k-token minimum)         [amber]
 * Returns {kind, v, c, title, expiresAt} — v is the compact value
 * ("↓116.9k 97% ↑1.2k"), title the spelled-out tooltip — or null when the
 * request doesn't use the cache at all. Takes extractMessageInfo's result +
 * the request body. With endMs (response wall-clock, ms) the tooltip adds
 * the ABSOLUTE hold-until time (5m / 1h TTL from this request; absolute so
 * it can never go stale in a rendered page — every later hit refreshes the
 * clock, so only the newest request's expiry means anything) and expiresAt
 * carries the latest of those deadlines in epoch ms.
 */
export function summarizeCache(m: any, body: any, endMs?: any): any {
  if (!m || m.error) return null;
  const read = m.cacheRead || 0;
  const write = m.cacheWrite || 0;
  if (!read && !write) {
    if (!hasCacheControl(body)) return null;
    return {
      kind: "miss",
      v: "miss",
      c: "warn",
      title:
        "prompt cache: cache_control is set but nothing was read or written — " +
        "the cacheable prefix is likely below the ~1k-token minimum",
    };
  }
  const bits: string[] = [];
  const tip: string[] = [];
  if (read) {
    bits.push("↓" + fmtCompact(read) + (m.cachePct != null ? " " + m.cachePct + "%" : ""));
    tip.push(
      read.toLocaleString() + " tokens read from cache" +
        (m.cachePct != null ? " (" + m.cachePct + "% of prompt, billed at 0.1x input)" : ""),
    );
  }
  if (write) {
    let w = "↑" + fmtCompact(write);
    const ttl: string[] = [];
    if (m.cacheWrite5m > 0) ttl.push(fmtCompact(m.cacheWrite5m) + " 5m");
    if (m.cacheWrite1h > 0) ttl.push(fmtCompact(m.cacheWrite1h) + " 1h");
    if (m.cacheWrite1h > 0) w += " (" + ttl.join(" + ") + ")";
    bits.push(w);
    tip.push(write.toLocaleString() + " tokens written to cache" + (ttl.length ? " (" + ttl.join(" + ") + ")" : ""));
  }
  const kind = read > 0 ? "hit" : "cold";
  // A hit that covers <90% of the prompt is a warning, not a win: most of
  // the context was re-billed at full input price (prefix changed early).
  const weak = kind === "hit" && typeof m.cachePct === "number" && m.cachePct < 90;
  // Hold-until deadlines, absolute wall-clock. Writes without a TTL split
  // are assumed 5m (same convention as pricing); a pure read refreshed the
  // entry's TTL, guaranteeing at least another 5m from this request.
  let expiresAt: any = null;
  const hold: string[] = [];
  if (typeof endMs === "number" && isFinite(endMs) && endMs > 0) {
    const hhmm = (t: number) => {
      const d = new Date(t);
      const p = (x: number) => (x < 10 ? "0" : "") + x;
      return p(d.getHours()) + ":" + p(d.getMinutes());
    };
    if (write) {
      if (m.cacheWrite5m > 0 || m.cacheWrite1h === 0) hold.push("~" + hhmm(endMs + 300000) + " (5m)");
      if (m.cacheWrite1h > 0) hold.push("~" + hhmm(endMs + 3600000) + " (1h)");
      expiresAt = endMs + (m.cacheWrite1h > 0 ? 3600000 : 300000);
    } else {
      hold.push("at least ~" + hhmm(endMs + 300000) + " (read refreshed the TTL)");
      expiresAt = endMs + 300000;
    }
  }
  return {
    kind,
    v: bits.join(" "),
    c: kind === "hit" && !weak ? "ok" : "warn",
    expiresAt,
    title:
      "prompt cache: " + tip.join(" · ") +
      (read
        ? (weak ? " — low hit rate: under 90% of the prompt came from cache, the rest was re-billed at full input price" : "")
        : " — cold: no prefix reuse (conversation start, or the cached prefix changed/expired)") +
      (hold.length ? " — held until " + hold.join(" / ") + "; every later hit refreshes the clock" : ""),
  };
}

/**
 * The traced client's session id for a model-call pair. Claude Code carries
 * it in request.body.metadata.user_id — current builds send a JSON string
 * ({"device_id":...,"session_id":"<uuid>"}), older ones an underscored form
 * (..._session_<uuid>). Other clients carry it in a request header named by
 * their wire table (codex "session-id", grok "x-grok-session-id") or a body
 * field (kimi "prompt_cache_key": "session_<uuid>" — stable across
 * compaction and --resume) — pass the merged tables from src/clients as
 * `wire` to read it; the pair's own `client` label picks the row. Returns
 * "" when absent.
 */
export function extractSessionId(pair: any, wire?: any): string {
  const w = wire && pair && pair.client ? wire[pair.client] : null;
  if (w && w.sessionHeader) {
    const hid = ((pair.request && pair.request.headers) || {})[w.sessionHeader];
    if (typeof hid === "string" && hid) return hid;
  }
  if (w && w.sessionBodyField) {
    const bid = ((pair.request && pair.request.body) || {})[w.sessionBodyField];
    if (typeof bid === "string" && bid) {
      const um = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(bid);
      return (um && um[1]) || bid;
    }
  }
  const meta = pair && pair.request && pair.request.body && pair.request.body.metadata;
  const uid = meta && meta.user_id;
  if (typeof uid !== "string" || !uid) return "";
  try {
    const parsed = JSON.parse(uid);
    if (parsed && typeof parsed.session_id === "string") return parsed.session_id;
  } catch {
    // not JSON — fall through to the underscored legacy form
  }
  const m = /session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(uid);
  return (m && m[1]) || "";
}

/** Model + counted-token result for a count_tokens pair. */
export function extractTokenCount(pair: any): any {
  const req = (pair && pair.request && pair.request.body) || {};
  const body = pair && pair.response && pair.response.body;
  return {
    model: req.model || null,
    tokens: body && typeof body.input_tokens === "number" ? body.input_tokens : null,
  };
}

/**
 * Rate-limit windows + credits from an /api/oauth/usage response. Prefers the
 * limits[] array (session -> 5h, weekly_all -> 7d, weekly_scoped -> model
 * name); falls back to the flat five_hour/seven_day fields.
 */
export function extractUsageInfo(pair: any): any {
  const b = pair && pair.response && pair.response.body;
  if (!b || typeof b !== "object") return null;
  const limits: any[] = [];
  if (Array.isArray(b.limits) && b.limits.length) {
    for (const l of b.limits) {
      if (!l || typeof l.percent !== "number") continue;
      let label = String(l.kind || "limit");
      if (l.kind === "session") label = "5h";
      else if (l.kind === "weekly_all") label = "7d";
      else if (l.kind === "weekly_scoped") label = (l.scope && l.scope.model && l.scope.model.display_name) || "7d scoped";
      limits.push({ label, percent: l.percent, severity: l.severity || "normal", resetsAt: l.resets_at || null });
    }
  } else {
    if (b.five_hour && typeof b.five_hour.utilization === "number")
      limits.push({ label: "5h", percent: b.five_hour.utilization, severity: "normal", resetsAt: b.five_hour.resets_at || null });
    if (b.seven_day && typeof b.seven_day.utilization === "number")
      limits.push({ label: "7d", percent: b.seven_day.utilization, severity: "normal", resetsAt: b.seven_day.resets_at || null });
  }
  let credits: any = null;
  const x = b.extra_usage;
  if (x && x.is_enabled) {
    credits = {
      used: typeof x.used_credits === "number" ? x.used_credits : 0,
      limit: typeof x.monthly_limit === "number" ? x.monthly_limit : 0,
      currency: x.currency || "USD",
      decimalPlaces: typeof x.decimal_places === "number" ? x.decimal_places : 2,
    };
  }
  return { limits, credits };
}

/**
 * Rebuild assistant content blocks (text/thinking/tool_use) from streamed SSE
 * events, accumulating deltas per block index.
 */
export function assembleAssistant(events: any[]): any[] {
  const blocks: any[] = [];
  for (const ev of events || []) {
    if (!ev) continue;
    if (ev.type === "content_block_start") {
      blocks[ev.index] = ev.content_block ? JSON.parse(JSON.stringify(ev.content_block)) : {};
    } else if (ev.type === "content_block_delta") {
      const b = blocks[ev.index];
      const d = ev.delta;
      if (!b || !d) continue;
      if (d.type === "text_delta") b.text = (b.text || "") + (d.text || "");
      else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + (d.thinking || "");
      else if (d.type === "input_json_delta") b.__json = (b.__json || "") + (d.partial_json || "");
    }
  }
  const out: any[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (typeof b.__json === "string" && b.__json) {
      try {
        b.input = JSON.parse(b.__json);
      } catch {
        // incomplete stream - keep whatever content_block_start carried
      }
    }
    delete b.__json;
    out.push(b);
  }
  return out;
}

/**
 * One-line, human-first summary chips for an index row, in reading order:
 * model · effort · think · in/out · ≡cache · cost, then state (stop/error)
 * chips. Wire transport facts (sizes, ttft, duration) are the row's
 * right-side COLUMNS, not chips. Returns [{t, c?, title?}].
 * opts.newest + opts.now: when this is the trace's newest model call and its
 * cache hold deadline has passed, the ≡ chip says "expired" — computed at
 * render, never a ticking countdown (a per-request countdown would lie:
 * every later hit refreshes the TTL).
 */
export function summarizePair(pair: any, cat: string, opts?: any): any[] {
  const chips: any[] = [];
  const resp = pair && pair.response;
  if (!resp) return [{ t: "no response", c: "err" }];

  if (cat === "messages") {
    const m = extractCallInfo(pair);
    if (m.model) chips.push({ t: shortModel(m.model), c: "model", title: String(m.model) });
    const eff = extractEffort(pair.request && pair.request.body);
    if (eff) chips.push({ t: "effort " + eff.v, title: eff.title });
    if (m.error) {
      chips.push({ t: m.error, c: "err" });
      return chips;
    }
    if (m.thinking > 0) chips.push({ t: "think " + fmtCompact(m.thinking), title: m.thinking.toLocaleString() + " thinking tokens" });
    chips.push({ t: "in " + fmtCompact(m.input), title: m.input.toLocaleString() + " uncached input tokens" });
    chips.push({ t: "out " + fmtCompact(m.output), title: m.output.toLocaleString() + " output tokens" });
    const endMs = resp && typeof resp.timestamp === "number" ? resp.timestamp * 1000 : null;
    const cache = summarizeCache(m, pair.request && pair.request.body, endMs);
    if (cache) {
      let v = "≡ " + cache.v;
      let c = cache.c;
      let title = cache.title;
      const now = opts && typeof opts.now === "number" ? opts.now : null;
      if (opts && opts.newest && now != null && cache.expiresAt != null && now > cache.expiresAt) {
        v += " · expired";
        c = "warn";
        title += " — this is the newest request and its hold deadline has passed: resuming now re-writes the prefix";
      }
      chips.push({ t: v, c, title });
    }
    const cost = pairCost(m);
    if (cost && cost.total > 0) chips.push({ t: fmtCost(cost.total), title: costTitle(cost) });
    if (m.stopReason && m.stopReason !== "end_turn" && m.stopReason !== "tool_use")
      chips.push({ t: m.stopReason, c: "warn", title: "stop reason" });
    if (resp.truncated)
      chips.push({
        t: "stopped early",
        c: "warn",
        title:
          "stream ended before completion — the partial response up to that point was captured (cctrace keeps capturing after a CLI abort)",
      });
  } else if (cat === "tokens") {
    const t = extractTokenCount(pair);
    if (t.model) chips.push({ t: shortModel(t.model), c: "model", title: String(t.model) });
    if (t.tokens != null) chips.push({ t: "= " + t.tokens.toLocaleString() + " tok", c: "ok", title: "counted input tokens" });
  } else if (cat === "usage") {
    const u = extractUsageInfo(pair);
    if (u) {
      for (const l of u.limits) {
        const c = l.severity !== "normal" || l.percent >= 90 ? "err" : l.percent >= 75 ? "warn" : "";
        chips.push({ t: l.label + " " + l.percent + "%", c, title: l.resetsAt ? "resets " + l.resetsAt : "" });
      }
      if (u.credits) {
        const d = Math.pow(10, u.credits.decimalPlaces);
        chips.push({ t: "credits " + u.credits.used / d + "/" + u.credits.limit / d + " " + u.credits.currency });
      }
    }
  } else if (cat === "telemetry") {
    const ev = pair.request && pair.request.body && pair.request.body.events;
    if (Array.isArray(ev)) chips.push({ t: ev.length + " event" + (ev.length === 1 ? "" : "s") });
  } else if (cat === "bootstrap") {
    const mm = String((pair.request && pair.request.url) || "").match(/[?&]model=([^&]+)/);
    if (mm) chips.push({ t: shortModel(decodeURIComponent(mm[1])), c: "model" });
  }

  // Opaque tunnel meta rows (tunnel-by-default): show the byte counts, and
  // say honestly that the payload was never captured.
  if (resp.body && resp.body.tunneled) {
    chips.push({
      t: "tunnel ↑" + fmtBytes(resp.body.bytesUp) + " ↓" + fmtBytes(resp.body.bytesDown),
      title: "opaque TLS tunnel — payload not captured (use --capture-external or --intercept-host to decrypt this host)",
    });
  }

  if (resp.status >= 400 && !chips.some((c) => c.c === "err")) {
    const et = resp.body && resp.body.error && resp.body.error.type;
    chips.push({ t: et ? String(et) : "HTTP " + resp.status, c: "err" });
  }
  return chips;
}
