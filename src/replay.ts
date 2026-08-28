import {
  loopTurns,
  threadTimeSplit,
  buildToolResultIndex,
  turnSnippet,
  toolPreview,
  isSpawnTool,
} from "./session";
import { extractCallInfo } from "./summarize";

// Session replay: a time cursor over captured pairs.
//
// The trace IS the timeline — every pair carries request.timestamp (seconds)
// and duration (ms), so replay is a viewer-side feature (see
// docs/design/session-replay.md). These are the pure primitives: the wire as
// of a cursor, the event boundaries playback walks, and the tick scheduler —
// plus the STAGE layer below them (docs/design/replay-stage.md): the trace as
// lanes over time, the observed state at the cursor (stateAt) read into one
// NOW line (nowAt), the tally behind it (soFar), the beat (what the agent did
// at this step) and the strip's clock ruler (axisTicks). Every mark is a wire
// timestamp or a wire fact; nothing here estimates.
//
// Like summarize.ts, every exported function is inlined into the web UI via
// Function.prototype.toString() — keep them self-contained (cross-calls only
// to other inlined functions by name; no module state).

/** A pair's start on the wall clock, in ms epoch. */
export function pairStartMs(p: any): number {
  return ((p && p.request && p.request.timestamp) || 0) * 1000;
}

/** When a pair's response finished — the moment it becomes "visible". */
export function pairEndMs(p: any): number {
  return pairStartMs(p) + ((p && p.duration) || 0);
}

/** Conversation-bearing pair: /v1/messages or an OpenAI Responses call,
 * excluding count_tokens probes. */
export function isTurnPair(p: any): boolean {
  let path = "";
  try {
    path = new URL(p.request.url).pathname.toLowerCase();
  } catch {
    path = String((p && p.request && p.request.url) || "").toLowerCase();
  }
  if (path.indexOf("/v1/messages") !== -1 && path.indexOf("count_tokens") === -1) return true;
  return /\/(responses|chat\/completions)$/.test(path);
}

/**
 * The event boundaries playback steps through: one per pair, at response end,
 * sorted by time. `turn` marks conversation pairs (the ←/→ stepper's stops);
 * everything else is a minor tick (count_tokens, usage probes, telemetry).
 */
export function replayEvents(pairs: any[]): any[] {
  const out: any[] = [];
  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    out.push({ t: pairEndMs(p), id: p.id, turn: isTurnPair(p) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Wall-clock span of a capture: first request start to last response end. */
export function replaySpan(pairs: any[]): any {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of pairs || []) {
    if (!p || !p.request) continue;
    const s = pairStartMs(p);
    const e = pairEndMs(p);
    if (s < t0) t0 = s;
    if (e > t1) t1 = e;
  }
  return t0 === Infinity ? null : { t0, t1 };
}

/** The wire as of the cursor: every pair whose response had completed. */
export function visibleAt(pairs: any[], cursor: number): any[] {
  return (pairs || []).filter((p) => p && p.request && pairEndMs(p) <= cursor + 0.5);
}

/** First boundary strictly after the cursor (turn boundaries only if asked). */
export function nextBoundary(events: any[], cursor: number, turnsOnly?: boolean): any {
  for (const e of events || []) {
    if (e.t > cursor + 0.5 && (!turnsOnly || e.turn)) return e;
  }
  return null;
}

/** Last boundary strictly before the cursor (turn boundaries only if asked). */
export function prevBoundary(events: any[], cursor: number, turnsOnly?: boolean): any {
  let last: any = null;
  for (const e of events || []) {
    if (e.t >= cursor - 0.5) break;
    if (!turnsOnly || e.turn) last = e;
  }
  return last;
}

/** The boundary at or before the cursor — the deep-link anchor for a moment. */
export function anchorAt(events: any[], cursor: number): any {
  let last: any = null;
  for (const e of events || []) {
    if (e.t > cursor + 0.5) break;
    last = e;
  }
  return last;
}

/**
 * The slice window: pairs whose response completed inside [a, b] (either
 * order). A slice is a shareable range of the timeline — the export
 * artifact contains exactly these pairs, every category, nothing else.
 */
export function sliceWindow(pairs: any[], a: number, b: number): any[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return (pairs || []).filter((p) => {
    if (!p || !p.request) return false;
    const e = pairEndMs(p);
    return e >= lo - 0.5 && e <= hi + 0.5;
  });
}

/**
 * Playback scheduler: from `cursor` at `speed`, when and where is the next
 * tick? Returns {cursor, delay, compressed} or null at the end of the tape.
 * Idle compression caps the on-screen wait at `capMs` (default 2000) — real
 * sessions have 20-minute thinking gaps nobody wants to sit through.
 */
export function nextTick(events: any[], cursor: number, speed: number, capMs?: number): any {
  const e = nextBoundary(events, cursor, false);
  if (!e) return null;
  const cap = capMs == null ? 2000 : capMs;
  const wait = (e.t - cursor) / (speed > 0 ? speed : 1);
  return { cursor: e.t, delay: Math.min(wait, cap), compressed: wait > cap };
}

/**
 * What one step of the agentic loop DID, read off its reply and its pair:
 * the calls it made, the subagents it spawned, why the model stopped, and
 * therefore which edge it took out of `model` (the observed state machine in
 * docs/design/replay-stage.md). `turn` is an attributed assistant turn from
 * buildSession, `isFinal` whether loopTurns made it its loop's final, `pair`
 * the wire pair that carried it.
 *
 * The `next` order is the truth order: a failed request went nowhere (its
 * retry is the next request); a spawn outranks a plain call because the lane
 * wants the coarser fact (a Task beside a Bash is `agents`); calls outrank
 * `final` so a live tail's in-flight tool step reads as tools instead of a
 * reply that never came; a call-less step inside a loop is `waiting` — the
 * harness came back on its own. Same rule threadTimeSplit puts on the gap.
 */
export function stepOutcome(turn: any, isFinal: boolean, pair: any): any {
  const calls: any[] = [];
  const spawns: any[] = [];
  for (const b of (turn && turn.blocks) || []) {
    if (!b || (b.type !== "tool_use" && b.type !== "server_tool_use")) continue;
    calls.push({ name: b.name || "", id: b.id || "", input: b.input });
    // The dispatch SHAPE, not just the name: task-tracking TaskCreate
    // ({subject}) spawns nothing. Gated exactly as buildSession's linker
    // is (a string prompt), so a step that says `agents` always has a
    // child thread the agents lane can draw.
    const i = b.input || {};
    if (isSpawnTool(b.name) && typeof i.prompt === "string") {
      spawns.push({
        id: b.id || "",
        name: b.name || "",
        agentType: i.subagent_type || "",
        description: i.description || "",
      });
    }
  }
  const err = !!pair && (!pair.response || pair.response.status >= 400);
  const u = (turn && turn.usage) || (pair ? extractCallInfo(pair) : null);
  return {
    next: err ? "failed" : spawns.length ? "agents" : calls.length ? "tools" : isFinal ? "reply" : "waiting",
    stop: (u && u.stopReason) || null,
    calls,
    spawns,
    err,
  };
}

/**
 * The trace as LANES over wall-clock — the trajectory strip's whole data
 * model. `threads` are buildSession threads (the caller decides which: pass
 * the utility threads in and they get lanes too), `pairOf(id)` resolves a
 * pair. Returns { t0, t1, human, model, tools, waiting, agents, cuts, failed }
 * with every lane sorted by time; t0/t1 are 0 when nothing resolved.
 *
 * Every span is a wire timestamp: model = [pair start, pair end], tools /
 * waiting = threadTimeSplit's own gap window (byPair — this function never
 * re-derives gap time), agents = the child thread's first request start to
 * its last response end, points sit at the pair moment the strip already
 * marks (the response end, where visibleAt makes a pair visible).
 * Failed and superseded requests are spanned by the gaps and counted by
 * nobody — the `failed` lane marks them, the model lane never does (they
 * produced no turn to attribute).
 */
export function sessionLanes(threads: any[], pairOf: any): any {
  const out: any = { t0: 0, t1: 0, human: [], model: [], tools: [], waiting: [], agents: [], cuts: [], failed: [] };
  let lo = Infinity;
  let hi = -Infinity;
  const mark = (a: number, b: number) => {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  };
  const label = (s: any) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 200);
  const byKey: any = {};
  for (const t of threads || []) if (t && t.key) byKey[t.key] = t;

  for (const t of threads || []) {
    if (!t || !t.turns) continue;
    // Utility threads (title probes, quota checks) are not the agent's
    // path — the rail segregates them and the lanes leave them out.
    if (t.kind === "utility") continue;
    const vis = t.turns.filter((x: any) => x && !x.toolResultsOnly);
    const loops = loopTurns(vis);
    const split = threadTimeSplit(t, pairOf);
    for (let li = 0; li < loops.length; li++) {
      const L = loops[li];
      let headPair: any = null;
      for (const v of L.members) {
        const turn = vis[v];
        if (!turn || turn.role !== "assistant" || !turn.pairId) continue;
        const p = pairOf(turn.pairId);
        if (!p || !p.request) continue;
        if (!headPair) headPair = p;
        const t0 = pairStartMs(p);
        const t1 = pairEndMs(p);
        const oc = stepOutcome(turn, v === L.final, p);
        out.model.push({
          t0, t1, threadKey: t.key, pairId: p.id, ord: li, step: L.steps[v] || 0,
          err: oc.err, stop: oc.stop, next: oc.next,
        });
        mark(t0, t1);
        // The gap after this reply, exactly as threadTimeSplit counted it.
        // names carries EVERY call in wire order (three Bash calls are three
        // entries) — one gap covers them all, so count is names.length and
        // never a per-call duration.
        const g = split.byPair[p.id];
        if (g && g.tools != null) {
          const names: string[] = [];
          for (const c of oc.calls) names.push(c.name);
          out.tools.push({ t0: g.t0, t1: g.t1, threadKey: t.key, pairId: p.id, names, count: names.length });
          mark(g.t0, g.t1);
        } else if (g && g.waiting != null) {
          out.waiting.push({ t0: g.t0, t1: g.t1, threadKey: t.key, pairId: p.id });
          mark(g.t0, g.t1);
        }
      }
      // The human's prompt is a POINT at the start of the request that
      // carried it — the only wire timestamp a typed line ever gets. A head
      // whose loop produced no captured request has no honest time, so it
      // is not a point (the chapter still lists it). A subagent's head is
      // the parent MODEL's dispatch prompt, not a person's — it rides the
      // agents lane, never the human one (TASTE: name the observed fact).
      if (L.head != null && !L.headInjected && headPair && !t.agentOf) {
        out.human.push({
          t: pairStartMs(headPair), threadKey: t.key, ord: li,
          label: label(turnSnippet((vis[L.head] || {}).blocks || [])), pairId: headPair.id,
        });
      }
    }
    for (const c of t.compactions || []) {
      if (!c || !c.pairId) continue;
      const p = pairOf(c.pairId);
      if (!p || !p.request) continue;
      const t1 = pairEndMs(p);
      out.cuts.push({ t: t1, threadKey: t.key, pairId: c.pairId, mode: c.mode || "" });
      mark(t1, t1);
    }
    for (const f of t.failed || []) {
      if (!f || !f.pairId) continue;
      const p = pairOf(f.pairId);
      if (!p || !p.request) continue;
      const t1 = pairEndMs(p);
      out.failed.push({ t: t1, threadKey: t.key, pairId: f.pairId, status: f.status || 0 });
      mark(t1, t1);
    }
    // A subagent thread is a span on the parent's clock: its own first
    // request start to its last response end (the spawn edge is verified by
    // tool_use id in buildSession — never inferred here).
    if (t.agentOf && t.pairIds && t.pairIds.length) {
      let a0 = Infinity;
      let a1 = -Infinity;
      for (const id of t.pairIds) {
        const p = pairOf(id);
        if (!p || !p.request) continue;
        const s = pairStartMs(p);
        const e = pairEndMs(p);
        if (s < a0) a0 = s;
        if (e > a1) a1 = e;
      }
      if (a0 !== Infinity) {
        const parent = byKey[t.agentOf.thread];
        let parentPairId = "";
        for (const turn of (parent && parent.turns) || []) {
          if (!turn || turn.role !== "assistant" || !turn.pairId) continue;
          for (const b of turn.blocks || []) {
            if (b && b.id && b.id === t.agentOf.toolUseId) parentPairId = turn.pairId;
          }
          if (parentPairId) break;
        }
        out.agents.push({
          t0: a0, t1: a1, threadKey: t.key, label: label(t.label),
          agentType: t.agentOf.agentType || "", parentKey: t.agentOf.thread || "",
          parentPairId, row: 0,
        });
        mark(a0, a1);
      }
    }
  }

  // Greedy row stacking by start time: overlapping children never share a
  // row, and a row is reused the moment its last child ended (the strip caps
  // the visible rows and folds the rest).
  out.agents.sort((a: any, b: any) => a.t0 - b.t0 || a.t1 - b.t1);
  const rowEnds: number[] = [];
  for (const a of out.agents) {
    let r = 0;
    while (r < rowEnds.length && rowEnds[r] > a.t0) r++;
    a.row = r;
    rowEnds[r] = a.t1;
  }
  out.model.sort((a: any, b: any) => a.t0 - b.t0);
  out.tools.sort((a: any, b: any) => a.t0 - b.t0);
  out.waiting.sort((a: any, b: any) => a.t0 - b.t0);
  out.human.sort((a: any, b: any) => a.t - b.t);
  out.cuts.sort((a: any, b: any) => a.t - b.t);
  out.failed.sort((a: any, b: any) => a.t - b.t);
  out.t0 = lo === Infinity ? 0 : lo;
  out.t1 = hi === -Infinity ? 0 : hi;
  return out;
}

/**
 * The agent's observed state AT the cursor: which lane covers it, since when,
 * and how many children are running. `threadKey` scopes to one thread — its
 * own spans plus the agents IT spawned (parentKey), which is what the stage
 * lights while a thread is selected.
 *
 * Precedence is actor-first: a request in flight is `model` even while its
 * children run (agentsRunning still reports them); then a child span; then
 * the gap the reply opened. Between spans the cursor is in a hole, and the
 * hole has a name: after a failed request it is `failed` (until the retry),
 * before a human point it is `human` (the reply landed, the human hasn't
 * spoken yet), otherwise `idle` — including before the first pair and after
 * the last, where nothing is happening at all.
 */
export function stateAt(lanes: any, cursor: number, threadKey?: any): any {
  const L = lanes || {};
  const key = threadKey || "";
  let running = 0;
  let agent: any = null;
  for (const a of L.agents || []) {
    if (key && a.parentKey !== key) continue;
    if (a.t0 <= cursor && cursor < a.t1) {
      running++;
      if (!agent || a.t0 > agent.t0) agent = a;
    }
  }
  let m: any = null;
  let lastT = -Infinity;
  let lastItem: any = null;
  let lastKind = "";
  for (const x of L.model || []) {
    if (key && x.threadKey !== key) continue;
    // Half-open, like every span here: at exactly t1 the reply is visible
    // (visibleAt) and the gap that follows owns the cursor.
    if (x.t0 <= cursor && cursor < x.t1 && (!m || x.t0 > m.t0)) m = x;
    if (x.t1 <= cursor && x.t1 >= lastT) { lastT = x.t1; lastItem = x; lastKind = "end"; }
  }
  if (m) return { state: "model", since: m.t0, item: m, agentsRunning: running };
  if (agent) return { state: "agents", since: agent.t0, item: agent, agentsRunning: running };
  for (const g of L.tools || []) {
    if (key && g.threadKey !== key) continue;
    if (g.t0 <= cursor && cursor < g.t1) return { state: "tools", since: g.t0, item: g, agentsRunning: running };
  }
  for (const g of L.waiting || []) {
    if (key && g.threadKey !== key) continue;
    if (g.t0 <= cursor && cursor < g.t1) return { state: "waiting", since: g.t0, item: g, agentsRunning: running };
  }
  for (const f of L.failed || []) {
    if (key && f.threadKey !== key) continue;
    if (f.t <= cursor && f.t >= lastT) { lastT = f.t; lastItem = f; lastKind = "failed"; }
  }
  if (lastT === -Infinity) return { state: "idle", since: L.t0 || 0, item: null, agentsRunning: running };
  if (lastKind === "failed") return { state: "failed", since: lastT, item: lastItem, agentsRunning: running };
  // A human point still ahead means the reply landed and the human hadn't
  // answered yet. `item` stays the step that ENDED — a replay never shows
  // the reader something that hasn't happened at the cursor.
  for (const h of L.human || []) {
    if (key && h.threadKey !== key) continue;
    if (h.t > cursor) return { state: "human", since: lastT, item: lastItem, agentsRunning: running };
  }
  return { state: "idle", since: lastT, item: lastItem, agentsRunning: running };
}

/**
 * The NOW line: `stateAt` read into the one row the stage puts on screen —
 * what the agent is doing at the cursor, what is running, since when
 * (docs/design/replay-stage.md). Built ON stateAt, never forking its
 * precedence.
 *
 * `since` is always a wire timestamp. `held` is `cursor - since` only where
 * the state's extent is itself a wire fact — a span or gap with a t1. The
 * holes (`human`, `failed`, `idle`) are bounded by an event that has not
 * happened yet, so they hold nothing we observed: null.
 *
 * `liveStartMs` is an in-flight request's start (the proxies' `start` event)
 * at the live edge: the model IS thinking, the extent is unknown, and the
 * dot is the page's one heartbeat.
 */
export function nowAt(lanes: any, cursor: number, threadKey: any, liveStartMs?: number): any {
  const L = lanes || {};
  const key = threadKey || "";
  const st = stateAt(L, cursor, key);
  if (liveStartMs && liveStartMs > 0) {
    return {
      state: "model", live: true, what: "thinking",
      since: liveStartMs, held: null, agentsRunning: st.agentsRunning, pairId: "",
    };
  }
  const s = st.state;
  const item = st.item || null;
  let what = "";
  if (s === "model") what = "thinking";
  else if (s === "tools") {
    // Wire order of FIRST appearance, repeats folded: one gap covers three
    // Bash calls, and "Bash ×3" is what the reader means by that.
    const order: string[] = [];
    const n: any = {};
    for (const c of (item && item.names) || []) {
      if (!c) continue;
      if (n[c] == null) { n[c] = 0; order.push(c); }
      n[c]++;
    }
    const parts: string[] = [];
    for (const c of order) parts.push(c + (n[c] > 1 ? " ×" + n[c] : ""));
    what = parts.join(" · ");
  } else if (s === "agents") {
    const labels: string[] = [];
    for (const a of L.agents || []) {
      if (key && a.parentKey !== key) continue;
      if (a.t0 <= cursor && cursor < a.t1) labels.push(a.label || a.agentType || "subagent");
    }
    what = st.agentsRunning + " running";
    if (labels.length) {
      what += " · " + labels.slice(0, 3).join(", ") +
        (labels.length > 3 ? " +" + (labels.length - 3) : "");
    }
  } else if (s === "waiting") what = "harness continued";
  else if (s === "human") what = "awaiting the next prompt";
  else if (s === "failed") what = ((item && item.status) || "failed") + " · the retry is next";
  const extent = s === "model" || s === "tools" || s === "waiting" || s === "agents";
  // The idle BEFORE the first pair has no beginning we observed — stateAt
  // hands back the lane span's t0, which is still in the cursor's future.
  // A now line never states a time that has not happened: 0 = say nothing.
  const since = st.since > cursor ? 0 : st.since || 0;
  return {
    state: s,
    live: false,
    what,
    since,
    held: extent && item && item.t1 != null ? Math.max(0, cursor - st.since) : null,
    agentsRunning: st.agentsRunning,
    pairId: (item && (item.pairId || item.parentPairId)) || "",
  };
}

/**
 * The tally behind the now line: how many steps ran, which tools were called
 * and how often, how many children, failures and cuts — all as of the cursor.
 * A span counts the moment it STARTS (t0 <= cursor), a mark when it lands.
 *
 * `tools` is byName only. Durations are not here on purpose: the convo
 * header's `time` chip already states where the thread's wall-clock went,
 * and a number is stated once per view (docs/design/ui.md).
 */
export function soFar(lanes: any, cursor: number, threadKey?: any): any {
  const L = lanes || {};
  const key = threadKey || "";
  const out: any = { steps: 0, tools: {}, agents: 0, failed: 0, cuts: 0 };
  for (const x of L.model || []) {
    if (key && x.threadKey !== key) continue;
    if (x.t0 <= cursor) out.steps++;
  }
  for (const g of L.tools || []) {
    if (key && g.threadKey !== key) continue;
    if (g.t0 > cursor) continue;
    // A step whose loop ended before any result came back has no gap and no
    // tally: we never saw those calls run.
    for (const n of g.names || []) out.tools[n] = (out.tools[n] || 0) + 1;
  }
  for (const a of L.agents || []) {
    if (key && a.parentKey !== key) continue;
    if (a.t0 <= cursor) out.agents++;
  }
  for (const f of L.failed || []) {
    if (key && f.threadKey !== key) continue;
    if (f.t <= cursor) out.failed++;
  }
  for (const c of L.cuts || []) {
    if (key && c.threadKey !== key) continue;
    if (c.t <= cursor) out.cuts++;
  }
  return out;
}

/**
 * The strip's clock ruler: the FINEST ladder step whose ticks still land
 * >= 72px apart at this track width, aligned to the LOCAL calendar. Past the
 * ladder's top rung (a merged multi-day session) the day step is multiplied
 * until the 72px floor holds.
 *
 * `tzOffsetMin` is the offset the caller measured ON THE DATA
 * (`new Date(t0).getTimezoneOffset()`) — the function reads no clock of its
 * own, so the ruler does not depend on when the page is read, and a summer
 * trace read in winter still rules in the offset it was captured under.
 * `t - tzOffsetMin * 60000` is the local wall clock as a ms value, which is
 * why the UTC getters below format local time.
 *
 * Labels are HH:MM (HH:MM:SS under a minute); the first tick of a local
 * calendar day is `major` and names the date. Ticks are a ruler, never data:
 * nothing here is estimated or rounded into a claim.
 */
export function axisTicks(t0: number, t1: number, px: number, tzOffsetMin: number): any[] {
  const out: any[] = [];
  if (!(px > 0) || !(t1 > t0)) return out;
  const LADDER = [
    1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000,
    3600000, 7200000, 21600000, 43200000, 86400000,
  ];
  const span = t1 - t0;
  let step = LADDER[LADDER.length - 1];
  for (const s of LADDER) {
    if ((s / span) * px >= 72) { step = s; break; }
  }
  // A merged multi-day session outruns the ladder: 30 days at 900px would
  // draw 31 day-ticks 29px apart, every one of them `major`. Multiply the
  // coarsest rung instead — a multiple of a day keeps the local-midnight
  // alignment, so the labels stay a ruler rather than mush.
  if ((step / span) * px < 72) step *= Math.ceil(72 / ((step / span) * px));
  const DAY = 86400000;
  const shift = (tzOffsetMin || 0) * 60000;
  const two = (n: number) => (n < 10 ? "0" : "") + n;
  for (let lt = Math.ceil((t0 - shift) / step) * step; lt <= t1 - shift; lt += step) {
    const d = new Date(lt);
    const hh = two(d.getUTCHours());
    const mm = two(d.getUTCMinutes());
    const major = ((lt % DAY) + DAY) % DAY === 0;
    out.push({
      t: lt + shift,
      label: major
        ? two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) + " " + hh + ":" + mm
        : hh + ":" + mm + (step < 60000 ? ":" + two(d.getUTCSeconds()) : ""),
      major,
    });
  }
  return out;
}

/**
 * The BEAT: what this thread did at the step the cursor sits on — the step
 * whose pair END is the latest at or before it, the same boundary visibleAt
 * uses to make a pair visible. null before the thread's first response.
 *
 * Tool calls are fused with their results (buildToolResultIndex): ok is
 * true/false from the result's is_error flag, or null when no result was
 * captured — never a guess. `tokens.prompt` is the provider-reported window
 * this request carried (input + cache read + cache write) and `delta` its
 * growth over the previous step (the first step grew from nothing, so its
 * delta IS its window). Per-call durations are not on the wire — one gap
 * covers parallel calls — so the beat never invents one.
 *
 * `head` is the human prompt that started this step's working loop, so the
 * reader always knows which task the step serves. Empty when the loop has no
 * head or the harness authored it — a notification is not a task.
 */
export function beatAt(thread: any, cursor: number, pairOf: any): any {
  if (!thread || !thread.turns) return null;
  const vis = thread.turns.filter((x: any) => x && !x.toolResultsOnly);
  const loops = loopTurns(vis);
  const results = buildToolResultIndex(thread.turns);
  let best: any = null;
  let prevPrompt = 0;
  for (let li = 0; li < loops.length; li++) {
    const L = loops[li];
    for (const v of L.members) {
      const turn = vis[v];
      if (!turn || turn.role !== "assistant" || !turn.pairId) continue;
      const p = pairOf(turn.pairId);
      if (!p || !p.request) continue;
      const u = turn.usage || extractCallInfo(p);
      const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      const end = pairEndMs(p);
      if (end <= cursor + 0.5 && (!best || end >= best.end)) {
        best = { turn, p, u, prompt, prev: prevPrompt, end, ord: li, step: L.steps[v] || 0, isFinal: v === L.final, loop: L };
      }
      prevPrompt = prompt;
    }
  }
  if (!best) return null;
  const cap = (s: any) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 200);
  const oc = stepOutcome(best.turn, best.isFinal, best.p);
  const calls: any[] = [];
  for (const c of oc.calls) {
    const res = results[c.id];
    let rp = "";
    if (res) {
      const rc = res.content;
      if (typeof rc === "string") rp = rc;
      else if (Array.isArray(rc)) rp = rc.map((x: any) => (x && x.type === "text" ? x.text : x && x.type === "image" ? "[image]" : "")).join(" ");
      else if (rc != null) {
        try {
          rp = JSON.stringify(rc) || "";
        } catch {
          rp = "";
        }
      }
    }
    calls.push({
      name: c.name,
      preview: cap(toolPreview(c.name, c.input)),
      ok: res ? !res.is_error : null,
      resultPreview: cap(rp),
    });
  }
  const spawns: any[] = [];
  for (const s of oc.spawns) spawns.push({ id: s.id, label: cap(s.description || s.agentType || s.name), agentType: s.agentType });
  // The reply's final text (a step can narrate before its tool calls; the
  // LAST text block is what the human read) and the model's stated
  // reasoning, if it wrote one.
  let reply: any = null;
  let thinking: any = null;
  for (const b of best.turn.blocks || []) {
    if (!b) continue;
    if (oc.next === "reply" && b.type === "text" && typeof b.text === "string" && b.text.trim()) reply = cap(b.text);
    if (!thinking && b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) thinking = cap(b.thinking);
  }
  const HL = best.loop || {};
  const head = HL.head != null && !HL.headInjected
    ? String(turnSnippet((vis[HL.head] || {}).blocks || [])).replace(/\s+/g, " ").trim().slice(0, 80)
    : "";
  return {
    ord: best.ord,
    step: best.step,
    head,
    pairId: best.p.id,
    t0: pairStartMs(best.p),
    t1: best.end,
    dur: best.p.duration || 0,
    stop: oc.stop,
    next: oc.next,
    calls,
    spawns,
    reply,
    thinking,
    tokens: { prompt: best.prompt, delta: best.prompt - best.prev, cachePct: best.u.cachePct == null ? null : best.u.cachePct },
  };
}

/**
 * The thread's chapters: one per working loop that has a head, in order.
 * `ord` is the loop ordinal loopTurns assigns (the outline's "turn 04" is
 * ord + 1), `headIdx` its index among the thread's VISIBLE turns, `t` the
 * start of the request that carried the head — 0 when pairOf is absent or
 * the loop produced no captured request (never a made-up time). `injected`
 * names a head the harness authored (a notification), so [ / ] navigation
 * can tell it from the human's own words.
 */
export function chaptersOf(thread: any, pairOf?: any): any[] {
  const out: any[] = [];
  if (!thread || !thread.turns) return out;
  const vis = thread.turns.filter((x: any) => x && !x.toolResultsOnly);
  const loops = loopTurns(vis);
  for (let li = 0; li < loops.length; li++) {
    const L = loops[li];
    if (L.head == null) continue;
    let pairId = "";
    let t = 0;
    for (const v of L.members) {
      const turn = vis[v];
      if (!turn || turn.role !== "assistant" || !turn.pairId) continue;
      pairId = turn.pairId;
      const p = pairOf ? pairOf(pairId) : null;
      if (p && p.request) t = pairStartMs(p);
      break;
    }
    out.push({
      ord: li,
      headIdx: L.head,
      pairId,
      t,
      label: String(turnSnippet((vis[L.head] || {}).blocks || [])).replace(/\s+/g, " ").trim().slice(0, 200),
      injected: L.headInjected || "",
    });
  }
  return out;
}
