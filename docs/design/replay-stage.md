# Replay stage: trajectory, now, beat

Status: REVISION 2 (2026-08-28). Revision 1 shipped in 0.45.0 (PR #101):
the trajectory strip, a six-node state DIAGRAM, the beat, the live `start`
event. Eric's read of it: "the replay should tail the session; the
transition stage is inaccurate and a bad representation of Claude Code
agent work; refine the layout, the design, the live, the motion." This
revision keeps the strip and the beat, deletes the diagram, adds the NOW
line, and makes replay a tail. What changed and why is in "Revision 2"
below; the rest of the document is the current truth.

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
  the convo sticks to its bottom, the now line and the beat update.
  Behind the edge nothing moves; a `⤓ live` control snaps back.
- (2) The diagram is deleted. In its place the NOW line: one row naming
  the state at the cursor, what is running, since when. The loop's shape
  is the strip (model/tools alternation is the loop, unrolled over time)
  and the rail (the outline). Counts live where they already lived.
- (3) The convo's bottom IS the moment (a seek scrolls there); the future
  is dimmed on the strip instead of the past being tinted; a clock axis
  labels the strip; the playhead gets a flag and a halo; the selected
  thread draws full, the others ghost.

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

`stateCounts` and its `transitions` table were the diagram's; they go
with it. `soFar` keeps the one figure nothing else states — which tools
were called, how often, so far — for the stage footer.

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

## The screen

Session view, `body.replaying`. No new tab.

    +- head ---------------------------------------------------------- [F] -+
    | TRAJECTORY (#rp-lanes: frame element, never scrolls away)               |
    |  clock   | 21:44        22:00        22:15        22:30        22:45   |
    |  human   |  #           #                        #                     |
    |  model   |   ##  ## ## ####     ######   ## ###  ▒▒  ▒▒▒                |
    |  tools   |     ==  ==      ==         ==    ====  ▒▒▒                  |
    |  agents  |           [----- explore -----]   [-- review --]            |
    |  harness |                    ✂        ~~            ✂                 |
    |                               ▼ playhead; right of it: the veil (▒)     |
    |  [⏮][▶][⏭] 1x 2x 8x 60x   00:32:58 · +2:48:54 / 3:51:52  [● live][✕] |
    +---------------------------+--------------------------------------------+
    | STAGE (top of #threads)   | CONVO as of the cursor, bottom = the moment |
    |  ● tools  Bash · Read ×2  |                                            |
    |           since 00:32:58  |                                            |
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
  shift+drag selects a slice; drag scrubs; click a span seeks to that
  pair's end (the boundary where it became visible — the same event
  `replayEvents` walks); click a human point seeks to the end of the
  request that carried it.
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
- A `start` frame moves nothing; it lights the now line (below).
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
goes with it. Three blocks, top to bottom:

**The NOW line** (`#stage-now`, one row): a state dot in the lane color,
the state, what is running, and since when — `nowAt` rendered.

    ● model    thinking                          since 14:32:07      <- live, in flight: the dot pulses
    ● model    thinking · 12.9s                  since 00:32:45      <- scrubbed into a completed request
    ● tools    Bash · Read ×2 · 24ms             since 00:32:58
    ● agents   2 running · explore, review       since 14:20:11
    ● waiting  harness continued · 3s            since …
    ○ human    awaiting the next prompt           since 00:41:07      <- hollow dot: nothing runs
    ● failed   502 · the retry is next           since …             <- red
    ○ idle                                                            <- both ends of the tape

`since` is absolute local time (never a ticking counter — ui.md). The
held duration appears only when the state's extent is a wire fact
(the gap or span has ended by the cursor, or the cursor sits inside a
completed span: `cursor - since` is then two wire timestamps apart). A
live in-flight request shows `since` only. The dot is the page's ONE
heartbeat while replaying, and it beats only when `live` (the rev 1
model-node pulse, moved). Click the row: seek to the step that opened
the state.

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

Gone: the SVG diagram (`#sd`, `SD_*`, `sdEdge/sdNode/sdLit`, the
`.sd-*` CSS), `stateCounts`, `.sd-live` (the now line carries it).

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
the strip draws the open span; the now line reads `● model thinking
since 14:32:07` with the heartbeat — only when the cursor is at the
edge of what has COMPLETED (a reader scrubbed back is not told about
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

- Motion: the playhead is the ONE owner. The now dot beats only for a
  live in-flight request (the status dot's heartbeat, same keyframes).
  No flow tokens, no tweened counts, no ticking clocks; the convo jumps,
  never glides, on cursor changes. `prefers-reduced-motion` drops the
  fade and the heartbeat.
- A number is stated once per view: the call tally in "so far", times in
  the beat / strip tips / convo header, never twice.
- Snapshots and `cctrace view` pages get the whole stage (pure client
  side); a snapshot has no `start`s and no live chip.
- Non-Claude clients: codex/kimi have no spawn tool, so the agents lane
  is empty and labelled — honest, not hidden.
- Nothing here estimates. If a figure is not a wire timestamp or a
  provider-reported count, it does not render.

## Verification

- `bun test`: tests/replay.test.ts (nowAt per state incl. live, soFar,
  axisTicks step choice + day-major, beatAt.head; the parallel-agents and
  failed-request fixtures stay), tests/ui-grammar.test.ts (the stage
  renders now + beat + so-far and no `#sd`; a `pair` frame while
  replaying at the edge ADVANCES the cursor and a frame while behind does
  not; `start` lights the now line; the strip carries a clock row, the
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
- A compressed-time axis for merged multi-day sessions (playback already
  idle-compresses; the strip does not).
- The ruler takes ONE zone offset, measured at the span's start, so a
  session that runs across a DST transition draws one side an hour off its
  own tips. A correct ruler needs a per-tick offset (a Date per tick), and
  the payoff is two nights a year in a handful of zones.
- Per-call durations need chunk timing (session-replay P3).
- Rev 1 open nit: agent-span label contrast in the light theme (dark ink
  on --purple at 10px).
