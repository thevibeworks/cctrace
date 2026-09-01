# Replay stage: trajectory, now, beat

Status: REVISION 5 (2026-09-01). Revision 1 shipped in 0.45.0 (PR #101):
the trajectory strip, a six-node state DIAGRAM, the beat, the live `start`
event. Eric's read of it: "the replay should tail the session; the
transition stage is inaccurate and a bad representation of Claude Code
agent work; refine the layout, the design, the live, the motion." This
revision keeps the strip and the beat, deletes the diagram, adds the NOW
line, and makes replay a tail. What changed and why is in "Revision 2"
below; the rest of the document is the current truth.

Revision 2.1 (2026-08-29, same PR): Eric's read of rev 2 was that the
picture of the loop was worth keeping — "redesign it accurately, live and
horizontal, in the replay bar". The NOW line becomes the LOOP ROW in the
frame: the machine drawn once, the state lit. "Revision 2.1" below.

Revision 2.2 (2026-08-29, same PR): rev 2.1's chip row was not a
diagram. The loop row becomes a FLOWCHART (boxes, a `calls?` decision
diamond, labelled edges, the lit edge flowing) and the strip's axis
becomes the selected thread's own time with idle gaps compressed —
"The loop row: the flowchart" and "The strip's axis" below.

Revision 3 (2026-08-31): the trajectory strip is the session view's
OVERVIEW, always on top — Eric: "make the session's trajectory bar
always on top (collapsible of course); not only for the replay, useful
to overall view the whole traced session". The strip no longer waits
for replay; replay's own chrome (transport, veil, playhead, slice)
still does. "Revision 3: the strip is the overview" below.

Revision 4 (2026-09-01, same PR): the loop row is REMOVED and the
overview syncs with the conversation. Eric, after using rev 2.2's
flowchart on real sessions: "remove the diagram; it's shit and
useless; the trajectory bar should sync with the session turns".
"Revision 4: the diagram goes, the bar becomes the minimap" below.

Revision 5 (2026-09-01, same PR): replay stops stealing the reader's
thread — the selection pins to the full capture for the whole replay,
enter/⏮/Home park on the thread's own edges, ←/→ step its own pairs,
and waiting gaps fold like idle. "Revision 5: replay holds the
reader's thread" below.

Session replay (docs/design/session-replay.md, P1+P2 shipped) grows from
"a timeline and the session text as of the cursor" into a STAGE: the trace
as lanes over time, what the agent is doing at the cursor, and the beat —
what it did at this step — all driven by the one cursor replay already
has, live or from a saved trace.

## Why

Replay answers "what did the agent know when it did X" by rebuilding the
conversation as of a cursor. It did not show the SHAPE of a run — prompt,
tool bursts, subagent fan-out, a compaction, the answer — anywhere. This
page adds that shape without a new engine: every surface is a pure reading
of `visibleAt(pairs, cursor)`, the same function the convo already reads.

Borrowed from archify (vendored at `reference/archify`): chapters are a
finite, reader-started story over stable ids; a still frame is always
complete and motion has one owner; reading depth is a function of zoom,
not a toggle; every reader state is a URL. NOT borrowed: route/reach
(causality cannot be read off the wire), ambient flow motion, share-card
PNGs, an SVG canvas as the primary surface.

## The truth boundary (read this before drawing anything)

The wire gives SEQUENCE, CONTAINMENT, SPAWN and TIMING. It does not give
causation. Every mark on this page is one of:

- a wire timestamp (request.timestamp, duration) — `threadTimeSplit`'s
  arithmetic, nothing new;
- a wire fact on a pair (status, stop_reason, blocks, compaction marks);
- a spawn edge verified by tool_use id (`agentOf` in buildSession).

"Decisions" means observed choices: which tool, which args, spawn what,
stop. "Why" exists only when the model wrote a thinking block, labelled
*the model's stated reasoning*, never drawn as an arrow. Name the observed
fact.

## Revision 2: what was wrong, what changes

Measured on a real 4h trace (1209 pairs, 25 sessions, 2 subagents) in a
real browser, 2026-08-28:

1. **Replay did not tail.** A landed pair redrew the strip
   (`rpLiveRefresh`) but never moved `replay.cursor`: a reader who entered
   replay on a live run and parked at the edge fell behind silently — the
   beat, the convo and the "state" froze at entry time while the strip
   grew. The strip claimed live; the page was a snapshot.
2. **The diagram modelled the wrong machine.** Six nodes and nine counted
   edges describe a Markov chain. Claude Code's loop is
   `prompt -> [model -> tools]* -> model -> answer`: `reply` is an outcome,
   not a state the agent occupies; `waiting` (a call-less reply the loop
   continued past) read 0 on every trace inspected; `human` never lit.
   The counts were redundant (tools 160 = model>tools 160 ~ tools>model
   159), inconsistent (model>agents 1 vs agents>model 2: one step spawned
   two children), and — the killer — `model 164 · 33m 12s / tools 160 ·
   17m 31s` restated the convo header's `time` chip verbatim. ui.md: a
   number is stated once per view. The diagram spent the best 100px of the
   left column on a graph nobody reads twice.
3. **The moment was not on screen.** Scrubbing rebuilt the convo and left
   it scrolled to turn 01. The playhead — a 2px accent line over an
   accent-tinted past over accent-hued model spans — was invisible on any
   dense region. The strip had no clock axis. The model and tools lanes
   drew EVERY thread's pairs on top of each other, so a subagent's
   requests read as the main loop's.

The changes, each traceable to one of the three:

- (1) The cursor at the live edge FOLLOWS: a landed pair advances it,
  the convo sticks to its bottom, the loop row and the beat update.
  Behind the edge nothing moves; a `⤓ live` control snaps back.
- (2) The diagram is deleted. In its place the NOW line: one row naming
  the state at the cursor, what is running, since when. The loop's shape
  is the strip (model/tools alternation is the loop, unrolled over time)
  and the rail (the outline). Counts live where they already lived.
- (3) The convo's bottom IS the moment (a seek scrolls there); the future
  is dimmed on the strip instead of the past being tinted; a clock axis
  labels the strip; the playhead gets a flag and a halo; the selected
  thread draws full, the others ghost.

## Revision 2.1: the loop row

Rev 2 deleted the diagram and argued the loop's shape was already on the
strip. Eric's read, on the real trace: the strip shows the loop UNROLLED
— right for where time went, useless for "where in the loop is it right
now" at a glance — and the picture of the machine was the thing he
missed. Rev 2's critique of the diagram stands (wrong machine, redundant
counts, a restated time chip); its remedy was wrong. The fix is an
accurate diagram, not none:

- The machine is Claude Code's: three states the agent occupies —
  `human`, `model`, and one HAND-OFF slot that reads `tools`, `agents` or
  `waiting` (one position in the loop, three flavors) — and four edges:
  prompt (human>model), calls (model>slot), results (slot>model), answer
  (model>human). `reply` is not a node: it is the answer edge. `failed`
  is the model chip in red with no edge — the request went nowhere.
- It is horizontal and it lives in the FRAME: a row in the replay bar
  between the strip and the transport, aligned to the strip's gutter and
  labelled `now`. It is on screen whenever the strip is.
- It is live: the cursor's state lights one chip and the edge it came in
  by; at the live edge a request in flight beats the model chip (the
  page's one heartbeat). Nothing moves when the state changes — the
  geometry is fixed pixels, only the lit parts change.
- It carries NO counts. The tally stays in "so far", the times in the
  beat and the strip tips. What rides beside the machine is the NOW
  line's own text — what is running, how long it has held where that is
  a wire fact, since when — so the state is stated ONCE on the page: the
  stage's `#stage-now` row is gone, the stage is the beat and the tally.

## The observed loop

Per assistant turn of a thread (`t.turns[i]`, `role === "assistant"`,
with `pairId`), plus the gap that follows it (`loopTurns` decides whether
the gap is inside the same working loop):

    at the cursor  observed from                                  what it means
    -------------  --------------------------------------------  ------------------------------
    model          the pair: [pairStartMs, pairEndMs]            a request is in flight
    tools          gap: pair end -> same loop's next request     the harness runs the calls
    agents         child thread: first pair start -> last end    a subagent is working
    waiting        the gap after a call-less reply the loop      the harness came back on its
                   continued past                                own (hook, nudge)
    human          after a loop's final, before the next head    the reply landed; the human
                                                                 has not spoken
    failed         after a status >= 400 pair, before its retry  the request went nowhere
    idle           before the first pair / after the last        nothing on the wire
    cut            compactions[]                                 a mark on the strip, not a state

`tools` and `waiting` are the same gap classified by whether the reply
made calls — exactly `threadTimeSplit`. Failed and superseded requests
are not on the reply path: the gap spans them, they are never counted
(same rule). A step that is BOTH tools and agents (a Task call beside a
Bash call) is `agents` for the lane; the now line names both.

`stateAt` is the one reading of this table; the strip, the now line and
the live edge all consume it. Precedence is actor-first: a request in
flight is `model` even while children run (`agentsRunning` still reports
them); then a child span (a tools gap that overlaps a running child
reads `agents` — the coarser fact); then the gap the reply opened; then
the hole, named. Every span is half-open: at exactly a pair's end the
reply is visible and the GAP owns the instant, so a click on a tools
span (which seeks to the pair's end) reads `tools`, never `model`.

## Data layer (src/replay.ts unless noted; pure, toString-inlined, unit-tested)

Every function takes plain data and returns plain data. No DOM, no module
state, cross-calls only by name (the toString() inlining rule).

```
stepOutcome(turn, isFinal, pair) -> {
  next: 'tools'|'agents'|'reply'|'waiting'|'failed',
  stop: string|null, calls: [{ name, id, input }],
  spawns: [{ id, name, agentType, description }], err: boolean
}

sessionLanes(threads, pairOf) -> {
  t0, t1,
  human:   [{ t, threadKey, ord, label, pairId }],
  model:   [{ t0, t1, threadKey, pairId, ord, step, err, stop, next }],
  tools:   [{ t0, t1, threadKey, pairId, names, count }],
  waiting: [{ t0, t1, threadKey, pairId }],
  agents:  [{ t0, t1, threadKey, label, agentType, parentKey, parentPairId, row }],
  cuts:    [{ t, threadKey, pairId, mode }],
  failed:  [{ t, threadKey, pairId, status }]
}
stateAt(lanes, cursor, threadKey?) -> { state, since, item, agentsRunning }

nowAt(lanes, cursor, threadKey, liveStartMs) -> {        // NEW (rev 2)
  state: 'model'|'tools'|'agents'|'waiting'|'human'|'failed'|'idle',
  live: boolean,          // a request is in flight at the live edge (liveStartMs > 0)
  what: string,           // 'thinking' | 'Bash · Read ×2' | '2 running · explore, review' |
                          // 'harness continued' | 'awaiting the next prompt' |
                          // '502 · the retry is next' | ''
  since: ms,              // when the state began (a wire timestamp; the start's ts when live)
  held: ms|null,          // cursor - since for a state with a known extent; null when live
  agentsRunning: n,
  pairId: string|''       // the step that opened the state (seek target)
}
loopAt(lanes, cursor, threadKey, liveStartMs) -> nowAt's fields + {   // NEW (rev 2.1)
  node: 'human'|'model'|'slot'|'',        // the lit chip ('' = idle: nothing lit)
  slot: 'tools'|'agents'|'waiting',       // the hand-off slot's label
  edge: 'human>model'|'model>slot'|'slot>model'|'model>human'|'',  // INTO the lit chip
  also: boolean                           // a child runs while the actor is elsewhere
}
soFar(lanes, cursor, threadKey?) -> {                     // replaces stateCounts (rev 2)
  steps: n, tools: { Bash: 41, ... }, agents: n, failed: n, cuts: n
}
beatAt(thread, cursor, pairOf) -> {
  ord, step, pairId, t0, t1, dur, stop, next, head,      // head: the loop's prompt, first ~80 chars (NEW)
  calls: [{ name, preview, ok, resultPreview }],
  spawns: [{ id, label, agentType }],
  reply, thinking, tokens: { prompt, delta, cachePct }
} | null
chaptersOf(thread, pairOf) -> [{ ord, headIdx, pairId, t, label, injected }]

axisTicks(t0, t1, px, tzOffsetMin) -> [{ t, label, major }]   // NEW (rev 2)
```

`stateCounts` and its `transitions` table were the rev-1 diagram's; they
went with it. `soFar` keeps the one figure nothing else states — which
tools were called, how often, so far — for the stage footer.

`loopAt` is built ON `nowAt` and `stateAt`, never forking their
precedence. The edge into `model` is adjacency: the human point or the
gap that ended exactly where this request began (gap windows end at the
next request's start — threadTimeSplit's rule; a tools gap whose step
spawned reads `agents` on the slot, the lane's coarser fact). A live
request has no gap yet, so its edge is the protocol's: the newest landed
reply made calls, and the request in flight carries their results; after
a final reply the wire cannot tell the human from a harness nudge until
the pair lands — no edge. The edge into `human` lights only when the
reply actually landed (the last step's `next` is reply): a loop the human
interrupted mid-tools lights the chip, never the answer edge.

`axisTicks` picks the FINEST step from `1s 5s 15s 30s 1m 2m 5m 10m 15m
30m 1h 2h 6h 12h 1d` whose ticks still land >= 72px apart at the given
track width (4h at 1400px -> 15m at 87px; 10m would be 58px); past the top
rung the day step is multiplied until the floor holds, so a merged
multi-day session rules in whole days instead of 30px mush. Aligned to the
LOCAL clock: `tzOffsetMin` is the offset measured on the DATA
(`new Date(span.t0).getTimezoneOffset()`, so the ruler agrees with
`fmtTime` for the trace's own date instead of today's); the function itself
never reads a Date. Labels are `HH:MM` (`HH:MM:SS` under 1m); a tick that
is the first of a calendar day is `major` and reads `MM-DD HH:MM`. Ticks
are never estimated — they are a ruler, not data.

Per-call durations are NOT on the wire (one gap covers parallel calls);
the beat carries the step's tools gap once, never a fake per-call time.

## Revision 3: the strip is the overview

The strip drew the whole session's shape — and then hid until the
reader pressed ⏵. An overview that must be asked for is not an
overview. Revision 3 makes `#replay-bar` FRAME in the session view at
all times, with a sharp line between what the strip is and what replay
adds:

- **Always drawn** (`body.view-session`): the lanes, the clock row,
  the breaks, thread focus, the live open-request stub — full
  contrast, no veil (nothing is "the future" when there is no cursor).
  The strip renders on every session render and grows on every landed
  pair, replaying or not. A trace with no session pairs yet hides the
  bar (`.rp-empty`) — an empty band asserting nothing is not a frame.
- **Replay-only chrome stays replay's** (`body.replaying`): the
  transport, the veil, the playhead and the slice band are hidden
  outside replay. The strip without a cursor states history; the
  cursor states a moment.
- **Clicking the strip navigates the conversation** (revised by rev 4
  — the first cut entered replay on any touch, which made an overview
  click a mode switch): outside replay a click jumps the convo to the
  turn at that time; replay is entered by ⏵ / the keyboard, as before.
  Wheel zoom works without entering replay — reading closer is not
  seeking.
- **Collapsible, to the clock row** (the ▾ chevron in the clock
  gutter cell, persisted as `cctrace-traj-fold`): the lanes fold away
  and the ~13px clock row stays — a thin ruler is still an overview,
  and it is the reopen target. Replaying overrides the fold (the
  instrument needs its lanes); the chevron hides while replaying.

## Revision 4: the diagram goes, the bar becomes the minimap

The loop row lasted three revisions of redesign and one week of real
use. Eric's verdict on the shipped flowchart: "remove the diagram;
it's shit and useless". The autopsy, so the next diagram idea reads it
first: the machine has three states and never changes shape, so after
one glance the drawing carries no information — the READER's question
at any moment is "what is happening / what did it do", and the beat,
the strip and the convo already answer that at the cursor. 70px of
frame restated a fact three other surfaces state better. The row, its
data layer (`loopAt`, `nowAt`, `stateAt`) and its motion (the flowing
edge, the heartbeat) are deleted; the motion budget returns to ONE
owner, the playhead. `sessionLanes`, `soFar`, `beatAt`, `axisTicks`
and the `start` event stay — they feed surfaces that survived.

What replaces it is not another drawing but the second half of Eric's
ask: "the trajectory bar should sync with the session turns". The bar
is the session's MINIMAP now, bidirectionally tied to the conversation:

- **Convo -> strip: the reading marker** (`#rp-read`). As the reader
  scrolls the conversation, a quiet 1px line (surface-colored halo, a
  hollow ▿ on the clock row) marks the topmost visible turn's wall-
  clock on the strip — every rendered `.turn` carries `data-ts` (the
  same timestamp its role bar shows), the scroll handler reads the
  first one visible and positions the marker through the SCALE like
  every other mark. It moves only under the reader's own scroll
  (direct manipulation — the scrollbar-thumb exemption, ui.md 5),
  rAF-throttled, and hides while replaying: the playhead owns
  position there.
- **Strip -> convo: click jumps the conversation.** Outside replay a
  click on the track scrolls the convo to the last turn at or before
  that instant (`data-rpt` is already the time; the walk is over
  `data-ts`) — the same jump the outline makes, same scroll math.
  Clicking no longer enters replay (rev 3's first cut did; an
  overview click must not be a mode switch). Replay entry stays on
  ⏵ / Space / arrows.
- While replaying, the sync already exists and is unchanged: the
  cursor IS the position, the convo follows it, seeks land on its
  bottom.

## Revision 5: replay holds the reader's thread

Rev 4 in real use (2026-09-01, Eric: "replay is like broken now,
sessions not focused, the nav bar not following"). Root cause: with
replay active the session rebuilds from the wire AS OF the cursor, and
`showSession` re-resolved the selection against that cursored subset —
before the selected thread's first response it resolved to the
FALLBACK (`newestMainThread` of whatever existed at the cursor) and
OVERWROTE `sessionSelKey`. The rail flipped to a stranger, the convo
followed, and the strip's axis (the selected thread's extent) re-ruled
itself to the stranger's — on a merged capture the bar re-scaled on
every other tick of playback. Fixes, all selection-side, lanes
untouched:

- **The selection is the reader's, pinned for the whole replay.** With
  replay active the intended thread resolves once against the FULL
  capture (`fullThreads`, same resolution the stage already used); the
  cursored rebuild renders that thread's cursored counterpart, and
  before its first response the convo says "nothing on this thread's
  wire yet at this moment" instead of switching threads. The axis
  never re-rules mid-replay; the playhead crosses one stable ruler.
- **Enter / ⏮ / Home park on the THREAD's edges, not the tape's.** A
  merged capture's tape can start 44 minutes inside another session
  and end 8 hours after this one — entering replay used to park the
  cursor there, the whole strip behind one break column. `enterReplay`
  (reading pages) parks at the thread extent's end; `rpHome()` (⏮,
  Home, play-at-the-end restart) seeks its start. ⏭ / End stay the
  TAPE's live edge — "catch up to live" is about the capture.
- **←/→ step THIS conversation.** The turn stepper filters boundaries
  to the selected thread's own pairs; other sessions in a merged
  capture no longer eat keypresses. Shift+arrow keeps every wire
  boundary, playback still walks the whole tape (other sessions'
  pairs are invisible here and tick past).

Same session, the waiting fold: see "The strip's axis" — waiting gaps
left the busy union, so a 45-minute harness wait compresses instead of
holding half the strip.

## The screen

Session view. The bar is on top always (rev 3); `body.replaying` adds
the transport, the veil and the playhead. No new tab.

    +- head ---------------------------------------------------------- [F] -+
    | TRAJECTORY (#rp-lanes: frame element, never scrolls away)               |
    |  clock   | 21:44     ▿  22:00        22:15        22:30        22:45   |
    |  human   |  #        ┆  #                        #                     |
    |  model   |   ##  ## #┆####      ######   ## ###  ▒▒  ▒▒▒               |
    |  tools   |     ==  ==┆     ==         ==    ====  ▒▒▒                  |
    |  agents  |           [----- explore -----]   [-- review --]            |
    |  harness |           ┆        ✂        ~~            ✂                 |
    |             reading marker ▴ (¬replaying) · playhead ▼ + veil (replay)  |
    |  [⏮][▶][⏭] 1x 2x 8x 60x   00:32:58 · +2:48:54 / 3:51:52  [● live][✕] |
    +---------------------------+--------------------------------------------+
    | STAGE (top of #threads)   | CONVO as of the cursor, bottom = the moment |
    |  turn 05 · step 25 · 12.9s · stop tool_use                             |
    |  our team just mounted all .cctrace…   (the loop's head, faint)        |
    |  ▸ Bash  (Read the exit…)    ok                                        |
    |  window 315k (+3.4k) · cache 99%                                       |
    |  so far  Bash 157 · Write 2 · ToolSearch 1 · 2 agents                  |
    | -- the rail, as before -- |                                            |
    +---------------------------+--------------------------------------------+

### Trajectory (`#rp-lanes`)

- Lanes x wall-clock, plus a CLOCK row on top (`axisTicks`): tick labels
  in the page's local time, 10px, faint, hairlines down through the
  lanes at major ticks only. Five lanes: human (points), model (spans),
  tools (spans; a waiting gap draws in the same lane, dimmed), agents
  (stacked spans), harness (cuts ✂ and failed ✗ marks). Lane labels in a
  56px gutter, lowercase, 10px.
- **Thread focus.** The rail's selected thread draws in full: its human
  points, its model and tools spans, and the agents IT spawned. Every
  other thread's items carry `.other` and draw at ~30% — the shape of
  the whole capture stays readable, the selected loop is the picture.
  Selecting a child in the rail flips the focus: the child's own steps in
  full, the parent's ghosted. The axis never changes with the selection.
- **The veil.** The FUTURE is dimmed: `#rp-veil` covers the strip from
  the playhead to the right edge at ~55% of the surface color. The past
  keeps full contrast. This is the same statement the convo makes — a
  replay never shows the reader something that hasn't happened — made on
  the strip, and it is why the accent-tinted past fill (`#rp-fill`,
  rev 1) is gone: it was a player convention that cost the model spans
  their contrast exactly where the reader looks.
- **The playhead** (`#rp-handle`): a 2px accent line through the clock
  row and every lane, a 1px halo in the surface color so it reads over
  spans of any hue, and a small ▼ flag on the clock row. It is the ONE
  moving thing on the page.
- Same `left%` math everywhere; the slice band spans all lanes.
  While replaying: shift+drag selects a slice, drag scrubs, click seeks
  to that pair's end (the boundary where it became visible — the same
  event `replayEvents` walks; a human point seeks to the end of the
  request that carried it). Outside replay: click jumps the
  CONVERSATION to the turn at that instant (rev 4), drag does nothing.
- Wheel zooms around the cursor, 1x fit to 32x, the context overview's
  helpers (one brush implementation). The strip scrolls horizontally
  inside its frame and follows the playhead only when it LEAVES the
  frame.
- Reading depth by zoom (`data-depth`): map (<2x) = spans; read (>=2x)
  = tool initials / ✂ / ✗ on spans wider than 24px; full (>=8x) = names.
- Hover = the page tip (`data-tip`). Colors are the existing data colors:
  model / tools / waiting from the time-track vars, agents purple, human
  accent, cuts amber, failed red. One wire fact, one color across surfaces.
- Live: a landed pair or a `start` re-renders the strip; the frame sticks
  to the live edge when the reader was there. An open `start` draws as a
  dashed model stub hugging the right edge.

### The loop row — REMOVED (rev 4)

Rev 2.1/2.2 drew Claude Code's machine as a flowchart here (`#rp-now`:
human / model / hand-off boxes, a `calls?` diamond, the lit edge
flowing). Removed 2026-09-01 on Eric's verdict after real use — see
"Revision 4" for the autopsy. The row, `loopAt`/`nowAt`/`stateAt`, the
`.rl-*` CSS and the flow/heartbeat animations are gone; the state at
any moment is read off the strip, the beat and the conversation.

### The strip's axis: the thread's own time, idle compressed

Revision 2.2. On the real 2026-08-28 trace (6 sessions, 10h38m of
capture) the selected 1h34m session sat in the left quarter of the strip
and three quarters of the frame drew nothing — the axis was the whole
capture (`rpSpan`: every pair plus open starts). Two fixes, both on the
axis, nothing on the lanes:

1. **The axis is the SELECTED thread's extent**: `t0..t1` of its own
   focus items (its model / tools / waiting spans, human points, cuts and
   failed marks, and the agent spans it spawned) — stretched to cover an
   open `start` when the thread is the live one. Other threads' items
   still draw (`.other`, ghosted) but only where they fall inside the
   axis; a capture with one thread selected no longer shows five idle
   hours of somebody else's sessions. Changing the selection re-rules the
   axis (the strip memo key already carries `selKey`).
2. **Idle is compressed**: a gap in the thread's BUSY time (the union of
   its focus spans, points widened to nothing) longer than `RP_IDLE_MS`
   (2 min) collapses to a fixed `RP_BREAK_PX` (28px) break, drawn as a
   hatched column across every lane with the skipped duration in the
   clock row (`⧸⧸ 1h 29m`). A human who went to lunch is 28px, not
   half the strip. Waiting gaps are NOT busy (rev 5): a call-less gap
   the harness sat out stretches the extent but joins the compressible
   idle — nobody worked, so a 45-minute wait folds exactly like the
   45 minutes before the next prompt (dsh's Trajectory tab compresses
   every uncovered stretch the same way; ours keeps the threshold so
   short waits still read as time).

`timeScale(busy, t0, t1, px, idleMs, breakPx)` in src/replay.ts (pure,
unit-tested) builds the mapping: `busy` are sorted, merged [t0,t1]
intervals; the result is `{ segs: [{ t0, t1, x0, x1, kind: 'busy'|'break' }],
px }` with x in PIXELS along the track (the strip's width is
`frameW * zoom`, already measured), busy segments sharing the remaining
width proportionally to their duration, breaks fixed. `scaleX(scale, t)`
and `scaleT(scale, x)` are the two inverses (clamped; inside a break
both map linearly across the break's 28px, so scrubbing through a break
is fast but continuous). With no gap over `idleMs` the scale is one
linear segment and every position is what it was.

EVERY x<->t site goes through the scale — there is one mapping, never a
second `(t - t0) / dur` beside it: the strip's spans, points and marks
(`renderReplayStrip`), the veil / playhead / slice band
(`renderReplayBar`), the clock row, `rpFollowHandle`, the track's
pointer handlers (drag scrubs, click seeks, shift+drag selects), and
wheel zoom around the cursor. A span that straddles a break draws
clipped to its busy parts (the break column sits on top).

The clock row rules PER BUSY SEGMENT: `axisTicks(seg.t0, seg.t1,
seg.x1 - seg.x0, tz)` for each busy segment, positioned by `scaleX` —
busy segments share pixels proportionally to duration, so they all land
on the same ladder step, and a folded 8h break never coarsens the ruler
of the 90 minutes beside it (ruling over the whole extent did exactly
that: 5-minute ticks collapsed to hourly the moment a break existed).
Each break gets its `⧸⧸ <skipped>` label instead (fmtSpan, coarse:
`1h 29m`, `12m`), 10px, faint, centred in the column — anchored to the
column's inner edge when the column touches either end of the track,
so the label is never clipped; a tick label that would collide with it
is dropped (its rule stays). Major rules (day boundaries) drop through
the lanes when they land in busy time.

The transport's `<length>` stays the axis's REAL duration (`t1 - t0`,
wall-clock) — the ruler compresses, the clock does not lie. `+<offset>`
stays real too. Playback's idle compression (`nextTick`, ≤2s per gap)
is unchanged and unrelated: it compresses waiting, this compresses
pixels.

Deep links (`@<pair-id>`) are unaffected: they address pairs, not x.

### Transport

`[⏮] [▶] [⏭]  1x 2x 8x 60x   <clock> · +<offset> / <length>   [live] [✕ exit]`

- `⏭` seeks to the end of the tape — on a live page that is the live
  edge, and tailing resumes. `Home` / `End` do the same as ⏮ / ⏭.
- The clock reads the cursor's absolute local time AND its offset —
  the terminal the human is looking at shows wall-clock, not offsets.
  `<length>` is the STRIP's axis (`rpSpan`: the capture stretched to
  cover an open `start`), so on a live page with a request in flight
  the offset reads short of the length even when the cursor is at the
  edge — "at the edge" is measured against the newest COMPLETED pair
  (`replaySpan(pairs).t1`), never against the strip's right edge.
- `[live]` is a state chip on live pages only: `● live` (green dot, the
  same green the status dot uses) while the cursor is at the edge and
  tailing; `⤓ live` (a quiet button) when the reader is behind — click
  snaps to the edge. Reading pages (view / snapshot) render nothing
  into it (the skeleton `<span id="rp-live">` stays, empty, like the
  slice chip).
- `✕ exit` exits replay (Esc). It no longer doubles as "back to live":
  exiting is exiting, snapping to the edge is ⏭.

### Tail

The rule is the convo's own (ui.md 3, terminal semantics): stick when
you're there, never yank when you're not.

- On a `pair` frame, BEFORE ingest: `wasAtEdge = replay.active &&
  replay.cursor >= replaySpan(pairs).t1 - 0.5`, and `wasAtBottom =
  convoAtBottom()`. After ingest, if `wasAtEdge`: `replay.cursor` moves
  to the new `replaySpan(pairs).t1`, `refreshReplay()` runs, the convo
  goes to its bottom only if `wasAtBottom`, the hash updates. If the
  reader was behind: the strip grows, the chip flips to `⤓ live`,
  nothing else moves.
- A `history` frame (older pairs merged in) never moves the cursor: the
  edge did not change.
- A `start` frame moves nothing; it lights the loop row (the model chip
  beats — below).
- Playback reaching the end of the tape on a live page parks the cursor
  at the edge — from there it tails. On a reading page it pauses, as
  before.
- Entering replay on a live page (toggle, or `⏵ replay`) parks at the
  edge = tailing from the first second.

### The convo follows the cursor

Every cursor change rebuilds the convo as of the cursor; its bottom is
the newest visible turn, i.e. the moment. So:

- a seek, a step (←/→), a chapter jump ([/]), a playback tick: the convo
  scrolls to its bottom, INSTANTLY (`convoToBottom`, not the smooth
  variant — playback would otherwise be continuous motion, and a rebuilt
  pane has no scroll position worth animating from);
- a tail advance: bottom only if it was at the bottom (above);
- a reader who scrolled up while paused is never moved.

The convo header's `time` chip and the request counts keep reading the
cursored thread — they were correct and they are where those numbers
live.

### Stage (`#stage`, top of the `#threads` column while replaying)

The rail stays under it — the strip is the time navigation, the rail is
still the outline and the thread switcher. Esc exits replay, the stage
goes with it. The moment itself is the loop row in the frame (above);
the stage is what this STEP did. Two blocks, top to bottom:

**The beat** (`.sb`, unchanged in kind, refined): caption `turn 05 ·
step 25 · 12.9s · stop tool_use`; under it the loop's HEAD — the
human's prompt that started this turn, first ~80 chars, faint, click
seeks to the chapter — so the reader always knows which task the step
serves without finding it in the rail. Then one row per tool call
`[name] [preview] [ok|err]` (fold body = `renderBlockS` for tool +
result; a spawn keeps its purple title and its "open thread" link), the
reply's first line on a reply step, the stated reasoning dimmed and
labelled, and the footer `window 315k (+3.4k) · cache 99%`. One row per
fact, the amount at the right edge. On a tail advance the new beat gets
the page's 160ms live-arrived fade; on a scrub it does not (scrubbing is
continuous, a fade per frame is motion).

**So far** (`.sd-tools` renamed `.st-sofar`, one faint line): `so far
Bash 157 · Write 2 · ToolSearch 1 · 2 agents · 1 failed · 1 ✂` — the
call tally as of the cursor, top four names, `+k` for the rest. The
only place the per-tool call count is stated.

Gone: the rev-1 SVG diagram (`#sd`, `SD_*`, `sdEdge/sdNode/sdLit`, the
`.sd-*` CSS) and `stateCounts` (rev 2); the stage's `#stage-now` row and
its `.sn-*` CSS (rev 2.1 — the loop row in the bar IS the now line).

- **Chapters**: `[` / `]` jump to the previous / next working-loop head
  (chaptersOf). `←/→` keep stepping turns, shift+←/→ requests.

### Live: the `start` event

A pair reaches the page only when its response completes, so without
this the stage could say "the model just thought for 12s" but never "the
model is thinking now". The proxies (mitm + base-url) mint the pair id
BEFORE forwarding and emit `onStart({ id, url, method, ts })`; the CLI
sink hands it to the server (`server.ingestStart`), which broadcasts
`{ type: "start", start: { id, url, method, ts, client } }`, keeps the
open starts (dropped when the pair with that id lands, or after 10 min),
and includes them in `init` as `starts`. The page keeps `openStarts`;
the strip draws the open span; the loop row lights the model chip — `thinking since
14:32:07`, beating — only when the cursor is at the edge of what has
COMPLETED (a reader scrubbed back is not told about
now). Only messages-category starts are broadcast (a count_tokens probe
is not a state).

### Presentation (`F`)

`body.present`: the header, the toolbar, the cats row and the nav rails
hide; the strip and the panes fill the viewport. Type scale unchanged.
Esc peels present first, then replay. Persisted nowhere.

### URL

`#/session/<key>/@<pair>` and `@a..b` already address the cursor and the
slice; the stage and the strip read them. Nothing new in the URL.

## Rules kept

- Motion: ONE owner, the playhead (rev 4 restored this — rev 2.2's
  flowing edge went with the loop row). The reading marker moves only
  under the reader's own scroll (the scrollbar-thumb exemption).
  No flow tokens, no tweened counts, no ticking clocks; the convo jumps,
  never glides, on cursor changes. `prefers-reduced-motion` drops the
  live-arrived fade.
- A number is stated once per view: the call tally in "so far", times in
  the beat / strip tips / convo header, never twice.
- Snapshots and `cctrace view` pages get the whole stage (pure client
  side); a snapshot has no `start`s and no live chip.
- Non-Claude clients: codex/kimi have no spawn tool, so the agents lane
  is empty and labelled — honest, not hidden.
- Nothing here estimates. If a figure is not a wire timestamp or a
  provider-reported count, it does not render.

## Verification

- `bun test`: tests/replay.test.ts (soFar, axisTicks step choice +
  day-major, beatAt.head; the parallel-agents and failed-request
  fixtures stay; timeScale — no gap is one linear segment, a 20-minute
  gap is busy / 28px break / busy with scaleX·scaleT round-tripping in
  busy time and inside the break, breaks exceeding the width fall back
  to linear; threadExtent scoped to a thread, the human pause kept as a
  gap; the loopAt/nowAt/stateAt blocks went with the loop row, rev 4),
  tests/ui-grammar.test.ts (the page renders no `#rp-now` and the bar
  holds strip + transport only; every session-view turn carries
  `data-ts`; a click on the track outside replay jumps the convo to the
  turn at that instant and does NOT enter replay; the reading marker
  positions off the topmost visible turn and hides while replaying;
  the stage renders beat + so-far and no `#stage-now` / `#sd`; a `pair`
  frame while replaying at the edge ADVANCES the cursor and a frame while
  behind does not; a selected thread with
  a >5 min idle gap draws an `rp-break` column and a `⧸⧸` label in the
  clock row, a thread without one draws none; the strip carries a clock row, the
  veil, `.other` on unselected threads; ⏭ / End seek to the edge; entering
  replay from the requests tab still rules the clock once the route lands;
  selecting the child flips the focus; a tail advance renders the session
  view once and only fades when the beat actually moved).
- Real browser: test-output/replay-stage/check.sh (updated for the new
  ids) and a LIVE tail check — a traced `claude -p` run with a browser
  attached in replay, asserting the cursor followed the landed pairs and
  the convo shows the new turn.

## Not done / follow-ups

- The context overview (ordinal) and this strip (time) are two overview
  components. Fold them into one with an axis switch once both have
  settled; do not build a third.
- The ruler takes ONE zone offset, measured at the span's start, so a
  session that runs across a DST transition draws one side an hour off its
  own tips. A correct ruler needs a per-tick offset (a Date per tick), and
  the payoff is two nights a year in a handful of zones.
- Per-call durations need chunk timing (session-replay P3).
- Rev 1 open nit: agent-span label contrast in the light theme (dark ink
  on --purple at 10px).
