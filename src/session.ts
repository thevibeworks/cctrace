import { parseSse, assembleAssistant, extractCallInfo, shortModel, extractSessionId, fmtCompact } from "./summarize";
import { pairCost } from "./pricing";
import {
  wireDialect,
  openaiInput,
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
 * turns, usage, agentOf?, compactions, rewound, unattributed, failed }
 * (failed: transport/HTTP-failed requests with the turn index where their
 * reply would have landed — the outline renders them as collapsed runs).
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
    return dialect === "openai" ? normalizeOpenaiTurns(openaiInput(b)).length : (b.messages || []).length;
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
      const rinput = openaiInput(req);
      if (!stub && !rinput.length) continue;
      // Thread identity is on the wire in a header (codex thread-id, grok
      // x-grok-conv-id — named by the client's wire table); Chat Completions
      // (kimi) carries none, so it always falls back to the first-user-text
      // signature — same path as a header-less Responses call.
      const w = wire && p.client ? wire[p.client] : null;
      const convId = (w && w.threadHeader && (p.request.headers || {})[w.threadHeader]) || "";
      key = convId ? "conv:" + convId
        : "osig:" + threadSig({ content: stub ? req.firstUserText || "" : openaiFirstUserText(rinput) });
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

  // /compact continuation reunification (2026-07-20 round 9): a full
  // /compact rewrites message[0] into the continuation summary ("This
  // session is being continued from a previous conversation..."), so the
  // continuation groups under a NEW sig — a separate thread for what the
  // user experiences as one conversation. Worse, the summary QUOTES old
  // Task dispatch prompts verbatim, so the agent-linker can false-claim
  // it as a subagent. Reunify: merge such a thread into the same
  // session's conversation that started before it and carries the
  // deepest history (the packing the summary was made from). No parent
  // (trace began mid-session) = stays standalone, today's behavior.
  const contPreamble = "This session is being continued from a previous conversation";
  // Kimi auto-compaction (devlog 2026-07-20, observed live): the packing
  // restarts with the original first user message — with LATER user text
  // merged in, so the sig fallback splits the thread — followed by the
  // working summary as a USER message opening with this harness preamble.
  // The summary is resent in every post-compaction request, so any full
  // (non-stub) request of the packing witnesses it.
  const kimiContPreamble = "The conversation so far has been compacted";
  const contOf = (t: any) => {
    if (t.dialect === "openai") {
      // Marker-gated on purpose: kimi subagents share the session id (pck)
      // and plausibly the system prompt, so structural signals alone could
      // false-claim a tail subagent. One compaction shape observed so far —
      // hold the stronger gate until codex/grok compactions are captured.
      const full = t.reqs.find((r: any) => !(r.request.body || {})._cctrace_stub);
      if (!full) return false;
      const items = openaiInput(full.request.body || {}).slice(0, 6);
      for (const it of items) {
        if (!it || it.type !== "message" || it.role !== "user") continue;
        for (const b of openaiBlocks(it)) {
          if (b && typeof b.text === "string" && b.text.lastIndexOf(kimiContPreamble, 0) === 0) return true;
        }
      }
      return false;
    }
    const b = t.reqs[0].request.body || {};
    const ft = b._cctrace_stub ? b.firstUserText || ""
      : Array.isArray(b.messages) && b.messages.length ? firstUserText(b.messages[0].content) : "";
    return ft.lastIndexOf(contPreamble, 0) === 0;
  };
  // Structural continuation signals (round 11): the preamble is harness
  // text that can change or be user-customized, so it is one vote, not
  // the gate. The stable structural facts: a continuation carries the
  // SAME system identity block as its parent (subagents and utilities
  // carry different system prompts — compare the first NON-billing
  // block, the leading x-anthropic-billing-header block mutates per
  // request), it starts smaller than the parent's deepest packing, and
  // the parent goes quiet FOREVER (a compacted conversation never
  // speaks again; a parent that spawned a subagent always resumes).
  const sysIdentity = (t: any) => {
    const sys = (t.reqs[0].request.body || {}).system;
    if (typeof sys === "string") return sys.slice(0, 200);
    if (!Array.isArray(sys)) return "";
    for (const blk of sys) {
      const s = (blk && blk.text) || "";
      if (typeof s === "string" && s && s.lastIndexOf("x-anthropic-billing-header", 0) !== 0) return s.slice(0, 200);
    }
    return "";
  };
  const sidechainish = (t: any) => {
    if ((t.reqs[0].request.headers || {})["x-claude-code-agent-id"]) return true;
    const sys = (t.reqs[0].request.body || {}).system;
    const sysText = typeof sys === "string" ? sys
      : Array.isArray(sys) ? sys.map((x: any) => (x && x.text) || "").join("\n") : "";
    return sysText.indexOf("cc_is_subagent=true") !== -1 || /You are (a Claude agent|an agent for Claude Code)/.test(sysText);
  };
  for (const t of threads) {
    if ((t as any)._merged) continue;
    const pre = contOf(t);
    // openai threads reunify on the summary marker only (see contOf); the
    // structural path below stays anthropic-only until more shapes exist.
    if (t.dialect !== "anthropic" && !pre) continue;
    if (t.dialect === "anthropic" && !pre && sidechainish(t)) continue;
    const t0 = t.reqs[0].request.timestamp || 0;
    let parent = null;
    let best = -1;
    for (const p of threads) {
      if (p === t || (p as any)._merged || p.sessionId !== t.sessionId || p.dialect !== t.dialect) continue;
      if ((p.reqs[0].request.timestamp || 0) >= t0 || contOf(p)) continue;
      let maxH = 0;
      for (const r of p.reqs) maxH = Math.max(maxH, histLen(r, p.dialect));
      if (maxH > best) { best = maxH; parent = p; }
    }
    if (!parent) continue;
    // Structural needs a REAL session id: in a no-sid trace (pre-0.13)
    // two sequential distinct conversations look exactly like parent +
    // continuation (same identity block, parent quiet, smaller start).
    const structural = !pre && t.dialect === "anthropic" && !!t.sessionId &&
      !!sysIdentity(t) && sysIdentity(t) === sysIdentity(parent) &&
      best > histLen(t.reqs[0], t.dialect) &&
      !parent.reqs.some((r: any) => (r.request.timestamp || 0) > t0);
    // The openai marker can be typed by a user verbatim; require the two
    // dialect-neutral structural facts too — a compacted parent never
    // speaks again, and the continuation starts smaller than its deepest
    // packing. A mid-session false-fire fails the quiet check.
    if (pre && t.dialect !== "anthropic" &&
      (best <= histLen(t.reqs[0], t.dialect) || parent.reqs.some((r: any) => (r.request.timestamp || 0) > t0)))
      continue;
    if (pre || structural) {
      // Stamp the merged requests: a continuation's packing is a REWRITE of
      // the parent's history (summary as msg[0] / merged first message), so
      // when one of these ends up as the post-spine tail, the boundary is a
      // compaction — unlike a same-sig truncation, which is a rewind.
      for (const r of t.reqs) { (r as any)._cont = true; parent.reqs.push(r); }
      // A marker-verified continuation is a KNOWN repack: the append fallback
      // below may trust it without the 10-turn-drop heuristic (a small
      // session's manual compact drops fewer).
      if (pre) (parent as any)._contMerged = true;
      (t as any)._merged = true;
    }
  }
  for (let i = threads.length - 1; i >= 0; i--) if ((threads[i] as any)._merged) threads.splice(i, 1);

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
      const sinput = openaiInput(sreq);
      t.system = openaiSystemText(sinput) || null;
      t.tools = openaiTools(sreq);
      t.turns = normalizeOpenaiTurns(sinput);
    } else {
      t.system = sreq.system || null;
      t.tools = Array.isArray(sreq.tools) ? sreq.tools : [];
      t.turns = normalizeTurns(sreq.messages);
    }
    const rblocks = responseBlocks(spine);
    if (rblocks.length) t.turns.push({ role: "assistant", blocks: rblocks, toolResultsOnly: false, pairId: null, usage: null });
    t.compactions = [];

    // Packing epochs (auto-compact, 2026-07-20): /compact REPACKS history —
    // shorter, and REWRITTEN (old tool_use turns become text; only a recent
    // tail survives verbatim). The longest request (the spine) then predates
    // the newest turns: every post-compact exchange existed only in later,
    // shorter requests — invisible in the outline and falsely flagged as
    // superseded. If requests FOLLOW the spine in wire order, align the last
    // one's history against the spine's tail and append what comes after.
    // The anchor must be context-verified: boilerplate turns (system
    // notifications, recap prompts) have colliding sigs, so a candidate only
    // counts when its preceding turns match too. Append-only: no verified
    // anchor = no merge (a /rewind branch keeps its superseded class).
    const spineIdx = t.reqs.indexOf(spine);
    let lastReq = null;
    for (let i = t.reqs.length - 1; i > spineIdx; i--) {
      if (!(t.reqs[i].request.body || {})._cctrace_stub) { lastReq = t.reqs[i]; break; }
    }
    if (lastReq) {
      const lb = lastReq.request.body || {};
      const lastHist = t.dialect === "openai"
        ? normalizeOpenaiTurns(openaiInput(lb))
        : normalizeTurns(lb.messages || []);
      const lsigs = lastHist.map((x: any) => turnContentSig(x.blocks));
      const ssigs = t.turns.map((x: any) => turnContentSig(x.blocks));
      // Frontier: the DEEPEST post-compact turn still present in the spine —
      // everything after it is genuinely new. Walk lastHist backwards; a
      // candidate must context-verify (2 comparable preceding turns aligned
      // 1:1 — empty sigs are wildcards: tool results, empty streams)
      // because boilerplate turns (system notifications, recap prompts)
      // collide on sig alone.
      let anchor = -1;
      let anchorSpine = -1;
      outer:
      for (let j = lastHist.length - 1; j >= 0; j--) {
        if (!lsigs[j]) continue;
        for (let i = ssigs.length - 1; i >= 0; i--) {
          if (ssigs[i] !== lsigs[j]) continue;
          let ok = true;
          let checked = 0;
          for (let k = 1; k <= 6 && checked < 2; k++) {
            if (i - k < 0 || j - k < 0) break;
            const a = ssigs[i - k];
            const b = lsigs[j - k];
            if (!a || !b) continue;
            if (a !== b) { ok = false; break; }
            checked++;
          }
          // A msg[0]-to-msg[0] match with zero verified context is no
          // match at all: msg[0]'s content sig is the injected
          // <system-reminder> prefix — identical for EVERY request in the
          // session — and that degenerate hit once claimed a rewind-to-
          // start as a fold (temp/20260722_wrong-session-trace). Anchors
          // elsewhere may legitimately verify zero neighbors (wildcard
          // tool results, start-of-packing) — the real compaction fixture
          // has one — so only the (0,0) unverified hit is rejected.
          if (ok && !(i === 0 && j === 0 && checked === 0)) {
            anchor = j;
            anchorSpine = i;
            break outer;
          }
        }
      }
      // Fold vs rewind (2026-07-22): a fold's surviving tail sits at
      // SHIFTED indices (anchorSpine > anchor — the history above it shrank
      // into a summary); a /rewind's shared content is a same-index PREFIX
      // (anchorSpine === anchor — nothing above it was rewritten). With no
      // anchor at all, a compaction-sized drop still splits two ways: a
      // merged continuation tail (_cont: msg[0] became the summary / a
      // merged first message — a KNOWN rewrite) is a full compact, while a
      // same-sig truncation can't be one — every observed compact shape
      // rewrites msg[0] and splits the sig. Same sig + no surviving tail =
      // the user rewound; the packing is a truncation, not a rewrite.
      const contTail = !!(lastReq as any)._cont || (t as any)._contMerged;
      let bmode = "";
      if (anchor >= 0) bmode = anchorSpine === anchor && !contTail ? "rewind" : "fold";
      else if (lastHist.length && (contTail || spineLen - lastHist.length >= 10)) bmode = contTail ? "rewrite" : "rewind";
      // A rewrite appends the whole packing (msg[0] is the new summary — a
      // real event); a no-anchor rewind skips its verbatim shared prefix
      // (at minimum msg[0], the thread sig) so the restart point isn't
      // duplicated below the boundary. Strict same-index walk: the first
      // non-matching or unverifiable turn stops it.
      let prefixDepth = 0;
      if (bmode === "rewind" && anchor < 0) {
        while (prefixDepth < lastHist.length && lsigs[prefixDepth] && ssigs[prefixDepth] && lsigs[prefixDepth] === ssigs[prefixDepth]) prefixDepth++;
      }
      const appendFrom = anchor >= 0 ? anchor + 1 : bmode === "rewind" ? prefixDepth : bmode ? 0 : lastHist.length;
      if (appendFrom < lastHist.length) {
        // The boundary is display data (session-tab round 10): the request
        // body sent to the API changed completely here. `at` = the first
        // post-compact turn's index. The wire witness is the first request
        // of the NEW packing — NOT merely the first request after the
        // spine: pre-compact stragglers (shorter ephemeral requests) can
        // sit between the spine and the real drop. Same-packing test:
        // no longer than lastReq's history, and for a full rewrite also
        // below the compaction-sized drop.
        let firstPost = lastReq;
        for (let i = spineIdx + 1; i < t.reqs.length; i++) {
          const r = t.reqs[i];
          if ((r.request.body || {})._cctrace_stub) continue;
          const len = histLen(r, t.dialect);
          if (len <= lastHist.length && (anchor >= 0 || len < spineLen - 9 || contTail)) { firstPost = r; break; }
        }
        t.compactions.push({
          at: t.turns.length,
          pairId: firstPost.id,
          fromTurns: spineLen,
          toTurns: histLen(firstPost, t.dialect),
          mode: bmode || "fold",
        });
        for (let i = appendFrom; i < lastHist.length; i++) t.turns.push(lastHist[i]);
        const lr = responseBlocks(lastReq);
        if (lr.length) t.turns.push({ role: "assistant", blocks: lr, toolResultsOnly: false, pairId: null, usage: null });
      }
    }

    // Per-turn attribution (devlog 2026-07-17): index-first, content-
    // verified. A request with n history turns produced the assistant turn
    // at index n — but Claude Code repacks history between requests
    // (ephemeral notice turns come and go), so the index can land on the
    // wrong turn. Verify the landing turn against the pair's own response;
    // scan for the true turn on mismatch; classify what matches nothing
    // (rewound vs unattributed) instead of dropping it silently.
    // claim strength: 1 = index-only (unverifiable pair), 2 = content-verified.
    // Compaction events: a history drop of 10+ turns below the running max
    // marks a repack (/compact rewrote history); ephemeral notice turns
    // wobble lengths by 1-3, and a /rewind steps back a few — never this
    // much. lastCompactIdx = the first request of the newest packing.
    let maxLen = 0;
    let lastCompactIdx = -1;
    for (let i = 0; i < t.reqs.length; i++) {
      const len = histLen(t.reqs[i], t.dialect);
      if (maxLen - len >= 10) lastCompactIdx = i;
      if (len > maxLen) maxLen = len;
    }
    const compactGate = lastCompactIdx >= 0 && spineIdx >= lastCompactIdx;
    const claimed: Record<number, number> = {};
    t.rewound = [];
    t.unattributed = [];
    t.failed = [];
    for (let reqIdx = 0; reqIdx < t.reqs.length; reqIdx++) {
      const p = t.reqs[reqIdx];
      const idx = histLen(p, t.dialect);
      // Transport/HTTP failures produced no reply and therefore no turn.
      // Collect them WITH their timeline position (idx = where the reply
      // would have landed) so the outline can show them as collapsed error
      // runs in order — a 429 retry storm used to claim the successful
      // retry's turn at strength 1 and dump 80+ orphan rows at the tail.
      if (!p.response || p.response.status >= 400) {
        t.failed.push({ pairId: p.id, at: idx, status: p.response ? p.response.status : 0 });
        continue;
      }
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
        ? normalizeOpenaiTurns(openaiInput(body))
        : (Array.isArray(body.messages) ? normalizeTurns(body.messages) : []);
      if (hist.length) {
        const lastSig = turnContentSig(hist[hist.length - 1].blocks);
        const spineAt = t.turns[idx - 1];
        const spineSig = spineAt ? turnContentSig(spineAt.blocks) : "";
        // A pair from BEFORE a compaction can fail attribution merely
        // because the fold rewrote its exchange (indices shift, tool_use
        // turns become text) — that's repacking drift, not supersession.
        // The gate only matters when the spine itself is a post-compact
        // packing; against a contemporary spine the comparison is sound.
        const preCompact = compactGate && reqIdx < lastCompactIdx;
        if (!preCompact && lastSig && spineSig && lastSig !== spineSig) cls = "rewound";
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
    t.epochs = threadEpochs(t.turns);
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
      // One dispatch, one thread: parallel Tasks with IDENTICAL prompts
      // (fan-out on several models) would all match the first tool_use,
      // collapsing three spawns onto one id. Threads and dispatches both
      // walk in wire order, so first-unclaimed pairs them 1:1.
      if (d.claimed) continue;
      const head = d.prompt.slice(0, 300);
      if (firstText === d.prompt || firstText.indexOf(head) !== -1 || d.prompt.indexOf(firstText.slice(0, 300)) !== -1) {
        d.claimed = true;
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
      // The label names what the thread IS — a conversation of N turns.
      // The model is an attribute, not the identity (a thread can span
      // several via /model); it renders as its own chip in the UI.
      const n = t.turns.filter((x: any) => !x.toolResultsOnly).length;
      t.label = n + " turn" + (n === 1 ? "" : "s");
    }
    delete t.reqs;
  }

  return { threads };
}

/**
 * One-line preview of a user turn for the conversation outline: the first
 * text that is actually the user's — injected reminder blocks stripped,
 * local-command caveat/stdout wrappers skipped. A turn that is only a slash
 * command previews as the command itself ("/model"): that IS what the user
 * did. "" = nothing human to show.
 */
export function turnSnippet(blocks: any[]): string {
  let cmd = "";
  for (const b of blocks || []) {
    if (!b || b.type !== "text" || typeof b.text !== "string") continue;
    const s = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!s) continue;
    if (s.lastIndexOf("<local-command-caveat>", 0) === 0 || s.lastIndexOf("<local-command-stdout>", 0) === 0) continue;
    // Skill invocations expand to a harness block ("Base directory for
    // this skill: ..."); the human-meaningful preview is the command.
    if (s.lastIndexOf("Base directory for this skill", 0) === 0) continue;
    // Command/skill invocations arrive in BOTH orders on the wire:
    // /model puts <command-name> first, /codex:status and skill blocks
    // put <command-message> first — extract the name wherever it sits,
    // plus args when present ("/model claude-fable-5").
    if (s.lastIndexOf("<command-name>", 0) === 0 || s.lastIndexOf("<command-message>", 0) === 0) {
      const m = s.match(/<command-name>([^<]*)<\/command-name>/);
      if (m) {
        if (!cmd) {
          const a = s.match(/<command-args>([^<]*)<\/command-args>/);
          cmd = (m[1].trim() + " " + ((a && a[1]) || "").trim()).trim();
        }
        continue;
      }
    }
    return s;
  }
  return cmd;
}

/**
 * Model epochs: contiguous runs of a thread's visible turns answered by one
 * model, folded from attributed assistant turns. Presentation-level
 * sub-structure — thread identity stays the conversation (session-tab
 * design): a /model switch opens a new epoch, never a new thread. User
 * turns belong to the epoch of the assistant reply that answered them (the
 * prompt sent after a switch lands in the NEW epoch); unattributed
 * assistant turns extend the current epoch rather than guess a model.
 * from/to are visible-turn ordinals (toolResultsOnly rows fold away) — the
 * exact ordering the convo pane renders, so an epoch maps straight to the
 * Nth rendered turn.
 */
export function threadEpochs(turns: any[]): any[] {
  const eps: any[] = [];
  let cur: any = null;
  let pending = -1; // first visible non-assistant turn not yet claimed by a reply
  let vis = -1;
  for (const t of turns || []) {
    if (!t || t.toolResultsOnly) continue;
    vis++;
    if (t.role !== "assistant") {
      if (pending < 0) pending = vis;
      continue;
    }
    const m = (t.usage && t.usage.model) || "";
    const from = pending < 0 ? vis : pending;
    pending = -1;
    if (!cur) {
      cur = { model: m, from, to: vis };
      eps.push(cur);
    } else if (m && cur.model && m !== cur.model) {
      cur = { model: m, from, to: vis };
      eps.push(cur);
    } else {
      if (m && !cur.model) cur.model = m;
      cur.to = vis;
    }
  }
  // Trailing prompts with no reply yet (live tail) stay in the last epoch.
  if (cur && pending >= 0) cur.to = vis;
  return eps;
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

/**
 * A file path as the reader knows it: workspace-relative when it sits under
 * ws (the traced CLI's working directory), ~-relative when it sits under a
 * home dir, untouched otherwise. Never lies — a path outside both stays
 * absolute.
 */
export function wsPath(p: any, ws?: any): string {
  const s = String(p || "");
  if (!s) return s;
  if (typeof ws === "string" && ws) {
    const w = ws.charAt(ws.length - 1) === "/" ? ws : ws + "/";
    if (s === ws || s === w) return ".";
    if (s.lastIndexOf(w, 0) === 0) return s.slice(w.length);
  }
  const hm = /^\/(?:home|Users)\/[^/]+(?=\/)/.exec(s);
  if (hm) return "~" + s.slice(hm[0].length);
  return s;
}

/**
 * Relativize every workspace-root / home-dir occurrence INSIDE arbitrary
 * preview text (a Bash command line, an intent description): the sidebar
 * shows "cd .cctrace && ls", not the full container path. Display-layer
 * only — fold bodies keep the literal wire text.
 */
export function wsRelText(s: any, ws?: any): string {
  let t = String(s || "");
  if (!t) return t;
  if (typeof ws === "string" && ws && ws !== "/") {
    const w = ws.charAt(ws.length - 1) === "/" ? ws.slice(0, -1) : ws;
    t = t.split(w + "/").join("");
    // bare root mentions (no trailing slash) read as "." — boundary-checked
    // so /path never eats /path-other
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(esc + "(?![\\w@.-])", "g"), ".");
  }
  t = t.replace(/\/(?:home|Users)\/[^/\s"']+\//g, "~/");
  t = t.replace(/\/(?:home|Users)\/[^/\s"']+(?![\w@.-])/g, "~");
  return t;
}

/**
 * The traced CLI's working directory, extracted from a request's system/env
 * text. Two precise shapes only (loose "directory" matching catches prose):
 * codex's <cwd>/path</cwd> environment tag, and Claude Code's line-anchored
 * env-block entry — on the real wire that line is bulleted
 * (" - Primary working directory: /path"), so one optional list marker is
 * allowed. Returns "" when absent — callers fall back to page metadata or
 * full paths, never a guess.
 */
export function cwdFromText(s: any): string {
  const t = String(s || "");
  let m = /<cwd>(\/[^<\n]*)<\/cwd>/.exec(t);
  if (m) return m[1].trim();
  m = /^[ \t]*(?:[-*>]\s+)?(?:Primary working directory|Working directory|Current working directory)\s*:\s*(\/[^\n]+?)\s*$/m.exec(t);
  return m ? m[1] : "";
}

/**
 * CLI-injected user prompts: wire messages with role "user" that the
 * harness generated, not the human. They must never read as (or count as)
 * a human turn. Precise prefixes only — known shapes:
 *   "recap"        — the away-recap prompt, answered then dropped from
 *                    history; a side exchange INSIDE the current turn
 *   "tool-load"    — "Tool loaded." after a deferred-tool fetch; the agent
 *                    just continues its current work
 *   "notification" — "[SYSTEM NOTIFICATION - NOT USER INPUT]" automated
 *                    wakeups (task done, scheduled); these START real
 *                    agent work, so they head a turn — a CLI-authored one
 * Continuation summaries are NOT listed: they open a resumed thread and
 * are tagged separately. Returns the kind or "".
 */
export function harnessPrompt(text: any): string {
  const t = String(text || "");
  if (t.lastIndexOf("The user stepped away and is coming back.", 0) === 0) return "recap";
  if (t.lastIndexOf("Tool loaded", 0) === 0) return "tool-load";
  if (t.lastIndexOf("[SYSTEM NOTIFICATION", 0) === 0) return "notification";
  return "";
}

/**
 * harnessPrompt over a turn's BLOCKS, catching one extra shape the snippet
 * can't: a user message whose entire text is <system-reminder> blocks (the
 * harness nudges — task-tool reminders, memory recalls). turnSnippet
 * strips reminders, so such a turn snippets to "" — if it still has text
 * blocks and every one carries a reminder, it's kind "reminder".
 */
export function harnessTurnKind(blocks: any[]): string {
  const kind = harnessPrompt(turnSnippet(blocks));
  if (kind) return kind;
  if (turnSnippet(blocks)) return "";
  const txts = (blocks || []).filter((b) => b && b.type === "text" && typeof b.text === "string");
  if (txts.length && txts.every((b) => b.text.indexOf("<system-reminder>") !== -1)) return "reminder";
  return "";
}

/**
 * Group visible message-turns into working-loop TURNS — the unit a human
 * means by "turn": user request → agent work (thinking, tool calls,
 * subagents, intermediate narration) → final response. A genuine user
 * message heads a new loop; harness-injected user prompts (harnessPrompt)
 * and all assistant messages join the open loop; the loop's last assistant
 * message is its final response. Turns arriving before any user head (a
 * thread cut mid-history) collect into a headless loop. Automated
 * notifications head a turn too — a CLI-authored one (headInjected).
 * Returns [{head: idx|null, headInjected: kind|"", members: [idx...],
 * final: idx|null, injected: {idx: kind}}] over the input array's indices.
 */
export function loopTurns(vis: any[]): any[] {
  const loops: any[] = [];
  let cur: any = null;
  for (let i = 0; i < (vis || []).length; i++) {
    const turn = vis[i];
    if (!turn) continue;
    if (turn.role === "user") {
      const kind = harnessTurnKind(turn.blocks);
      if (!kind || kind === "notification") {
        cur = { head: i, headInjected: kind, members: [], final: null, injected: {} };
        loops.push(cur);
        continue;
      }
      if (!cur) { cur = { head: null, headInjected: "", members: [], final: null, injected: {} }; loops.push(cur); }
      cur.injected[i] = kind;
      cur.members.push(i);
      continue;
    }
    if (!cur) { cur = { head: null, headInjected: "", members: [], final: null, injected: {} }; loops.push(cur); }
    cur.members.push(i);
    if (turn.role === "assistant") cur.final = i;
  }
  return loops;
}

/**
 * ccx-style one-line preview for a tool_use, keyed by tool name. ws (the
 * workspace root) relativizes file paths — the fold says src/ui.ts, not the
 * full container path.
 */
export function toolPreview(name: string, input: any, ws?: any): string {
  const i = input || {};
  switch (name) {
    // Bash carries the model's own one-line intent in `description` —
    // lead with it (the "what"), keep the literal command after (the
    // ground truth; the fold body holds it in full). Paths inside the
    // command relativize for display (wsRelText).
    case "Bash": return (typeof i.description === "string" && i.description ? i.description + " · " : "") + "$ " + wsRelText(i.command || "", ws);
    case "Read": {
      let r = wsPath(i.file_path, ws);
      if (typeof i.limit === "number" && typeof i.offset === "number") r += " · " + i.limit + " lines from " + i.offset;
      else if (typeof i.limit === "number") r += " · first " + i.limit + " lines";
      else if (typeof i.offset === "number") r += " · from line " + i.offset;
      return r;
    }
    case "Write": {
      const len = typeof i.content === "string" ? i.content.length : 0;
      return wsPath(i.file_path, ws) + (len ? " · " + fmtCompact(len) + " chars" : "");
    }
    case "Edit": {
      let r = wsPath(i.file_path, ws);
      if (i.replace_all) r += " · replace all";
      return r;
    }
    case "NotebookEdit": return wsPath(i.notebook_path || i.file_path, ws);
    case "Grep": return "/" + (i.pattern || "") + "/" + (i.path ? " in " + wsPath(i.path, ws) : "");
    case "Glob": return (i.pattern || "") + (i.path ? " in " + wsPath(i.path, ws) : "");
    case "Task": case "Agent": case "TaskCreate": return "[" + (i.subagent_type || "agent") + "] " + (i.description || "");
    case "WebFetch": return i.url || "";
    case "WebSearch": return i.query || "";
    case "Skill": return i.skill || i.command || "";
    case "TodoWrite": {
      if (!Array.isArray(i.todos)) return "";
      const done = i.todos.filter((t: any) => t && t.status === "completed").length;
      return i.todos.length + " todos" + (done ? " · " + done + " done" : "");
    }
    default: return "";
  }
}
