# Replay stage: trajectory, state, beat

Status: BUILDING (2026-08-27, branch feat/replay-stage). Session replay
(docs/design/session-replay.md, P1+P2 shipped) grows from "a timeline
and the session text as of the cursor" into a STAGE: the trace as lanes
over time, the agent's observed state machine with the current transition
lit, and the beat — what the agent did at this step — all driven by the
one cursor replay already has, live or from a saved trace.

## Why

Replay answers "what did the agent know when it did X" by rebuilding the
conversation as of a cursor. It does not show the SHAPE of a run — prompt,
tool bursts, subagent fan-out, a compaction, the answer — anywhere; the
rail is a list, the track is one row of ticks. A reader with a five-agent
parallel run cannot see the parallelism. This page adds that shape without
a new engine: every new surface is a pure reading of `visibleAt(pairs,
cursor)`, the same function the convo already reads.

Borrowed from archify (vendored at `reference/archify`, its
`references/viewer-runtime.md` + `DESIGN.md`): chapters are a finite,
reader-started story over stable ids; a still frame is always complete and
motion has one owner; reading depth is a function of zoom, not a toggle;
every reader state is a URL. NOT borrowed: route/reach (causality cannot
be read off the wire), ambient flow motion, share-card PNGs, an SVG canvas
as the primary surface.

## The truth boundary (read this before drawing anything)

The wire gives SEQUENCE, CONTAINMENT, SPAWN and TIMING. It does not give
causation. Every mark on this page is one of:

- a wire timestamp (request.timestamp, duration) — `threadTimeSplit`'s
  arithmetic, nothing new;
- a wire fact on a pair (status, stop_reason, blocks, compaction marks);
- a spawn edge verified by tool_use id (`agentOf` in buildSession).

"Decisions" means observed choices: which tool, which args, spawn what,
stop. "Why" exists only when the model wrote a thinking block, labelled
*the model's stated reasoning*, never drawn as an arrow. Same scar as
TASTE's "superseded, not rewound": name the observed fact.

## The observed state machine

Per assistant turn of a thread (`t.turns[i]`, `role === "assistant"`,
with `pairId`), plus the gap that follows it (`loopTurns` decides whether
the gap is inside the same working loop):

    state     observed from                                   -> next
    --------  ----------------------------------------------  -----------------------------------
    human     user turn whose harnessTurnKind is "" (a head)  model   (the request that carries it)
    model     the pair: [pairStartMs, pairEndMs]              tools   reply has tool_use / server_tool_use
                                                              agents  a tool_use in SPAWN_TOOLS (Task/Agent)
                                                              reply   loop ends here (its `final`)
                                                              waiting no tool call, loop continues (harness nudge)
                                                              failed  status >= 400 / no response
    tools     gap: pair end -> same loop's next request start model
    agents    child thread: its first pair start -> last end  model   (the result rides the parent's next request)
    waiting   the same gap after a reply with no tool call    model
    reply     the between-turns gap                           human
    failed    the pair; the retry is the next request         model
    cut       compactions[] (fold / rewrite / rewind)         annotates a step; not a state

`tools` and `waiting` are the same gap classified by whether the reply
made calls — exactly `threadTimeSplit`. Failed and superseded requests
are not on the reply path: the gap spans them, they are never counted
(same rule). A step that is BOTH tools and agents (a Task call beside a
Bash call) is `agents` for the lane and counts both in the diagram.

## Data layer (src/replay.ts unless noted; pure, toString-inlined, unit-tested)

Every function takes plain data and returns plain data. No DOM, no module
state, cross-calls only by name (the toString() inlining rule).

```
stepOutcome(turn, isFinal, pair) -> {
  next: 'tools'|'agents'|'reply'|'waiting'|'failed',
  stop: string|null,              // usage.stopReason
  calls: [{ name, id, input }],   // tool_use blocks, wire order
  spawns: [{ id, name, agentType, description }],   // the SPAWN_TOOLS subset
  err: boolean                    // failed request
}

sessionLanes(threads, pairOf) -> {
  t0, t1,                          // ms epoch, whole trace
  human:   [{ t, threadKey, ord, label, pairId }],           // pairId = the request that carried the prompt
  model:   [{ t0, t1, threadKey, pairId, ord, step, err, stop, next }],
  tools:   [{ t0, t1, threadKey, pairId, names: ['Bash','Read'], count }],
  waiting: [{ t0, t1, threadKey, pairId }],
  agents:  [{ t0, t1, threadKey, label, agentType, parentKey, parentPairId, row }],  // row = stacking slot
  cuts:    [{ t, threadKey, pairId, mode }],                  // fold / rewrite / rewind / ''
  failed:  [{ t, threadKey, pairId, status }]
}
```

`sessionLanes` walks the SAME path `threadTimeSplit` walks (one
definition of tools/waiting time — extend `threadTimeSplit` to expose the
gap's `[t0, t1]` per pair rather than re-deriving it; `byPair` keeps its
existing `tools`/`waiting` ms fields, the context view reads them).
Agents stack: assign `row` greedily by start time so overlapping children
never share a row; the strip caps visible rows and folds the rest into a
`+k more` row (the slivers rule from the icicle).

```
stateAt(lanes, cursor, threadKey?) -> {
  state: 'human'|'model'|'tools'|'agents'|'waiting'|'idle'|'failed',
  since: ms, item, agentsRunning: n
}
stateCounts(lanes, cursor, threadKey?) -> {
  human: n, model: { n, ms, failed }, tools: { n, ms, byName: {Bash: 41} },
  agents: { n, ms }, waiting: { n, ms }, cuts: n,
  transitions: { 'human>model': n, 'model>tools': n, 'tools>model': n,
                 'model>agents': n, 'agents>model': n, 'model>reply': n,
                 'model>waiting': n, 'waiting>model': n, 'reply>human': n }
}
beatAt(thread, cursor, pairOf) -> {
  ord, step, pairId, t0, t1, dur, stop, next,
  calls: [{ name, preview, ok, resultPreview }],   // fused with tool_result via buildToolResultIndex
  spawns: [{ label, agentType, threadKey? }],
  reply: text|null,          // the final text of a `reply` step, first ~200 chars
  thinking: text|null,       // first ~200 chars, if the model wrote one
  tokens: { prompt, delta, cachePct }   // provider-reported; delta vs the previous step
} | null
chaptersOf(thread) -> [{ ord, headIdx, pairId, t, label }]   // one per working loop with a head
```

Per-call durations are NOT on the wire (one gap covers parallel calls);
the beat carries the step's tools gap once, never a fake per-call time.

## The screen

Session view, `body.replaying`. No new tab.

    +- head ------------------------------------------------------ [F] -+
    | TRAJECTORY  (#rp-lanes: frame element, never scrolls away)         |
    |  human   |  #          #                        #                   |
    |  model   |   ##  ## ## ####     ######   ## ###                     |
    |  tools   |     ==  ==      ==         ==    ====                    |
    |  agents  |           [----- explore -----]   [-- review --]         |
    |  harness |                    ✂        ~~            ✂              |
    |  [⏮][▶] 1x 2x 8x 60x ────────●──────── 14:32 / 41:07   [live ⤓]    |
    +---------------------------+---------------------------------------+
    | STAGE (top of #threads)   | CONVO as of the cursor (unchanged)    |
    |   human -> model -> reply |                                       |
    |             |  ^          |                                       |
    |             v  |          |                                       |
    |          tools  agents    |                                       |
    |  lit: model -> tools      |                                       |
    |  so far: Bash 41 · Read 30|                                       |
    |  -- the beat --           |                                       |
    |  turn 04 · step 2 · 12.3s |                                       |
    |  stop tool_use            |                                       |
    |  Bash  git status    ok   |                                       |
    |  Bash  bun test      err  |                                       |
    |  window 137k (+8.1k)      |                                       |
    |  cache 91%                |                                       |
    | -- the rail, as before -- |                                       |
    +---------------------------+---------------------------------------+

### Trajectory (`#rp-lanes`, replaces the one-row `#rp-track`)

- Lanes x wall-clock. Five lanes: human (points), model (spans), tools
  (spans; a waiting gap draws in the same lane, dimmed), agents (stacked
  spans), harness (cuts ✂ and failed ✗ marks). Lane labels in a 56px
  gutter on the left, lowercase, 10px.
- Same `left%` math as `rp-marks`; the playhead (`#rp-handle`), the fill
  and the slice band span ALL lanes. shift+drag still selects a slice;
  drag scrubs; click a span seeks to that pair's end (the boundary where
  it became visible — the same event `replayEvents` walks); click a human
  point seeks to the end of the request that carried it.
- Wheel zooms around the cursor, 1x fit to 32x, the way the context
  overview does (reuse its zoom/brush helpers — do NOT fork a second
  brush implementation; extract shared helpers if needed and keep the
  context tests green). The strip scrolls horizontally inside its frame
  and keeps the playhead in view during playback.
- Reading depth by zoom (`data-depth` on the strip): map (<2x) = spans
  only; read (>=2x) = tool initials / ✂ / ✗ on spans wider than 24px;
  full (>=8x) = labels (tool names, agent labels, the human's first
  words). CSS decides visibility off `data-depth` + span width class;
  the markup carries the labels always.
- Hover = the page tip (`data-tip`): a span says what it is, its clock,
  duration, tool names / agent label, stop reason, ok/err. Tips fly UP.
- Colors are the existing data colors: model = accent tint, tools =
  `--purple` tint? NO — purple marks notable folds. Use the time-track
  hues the context overview already names for model / tools / waiting
  (`renderCtxTimeBlock`'s legend), agents = the branch color the rail
  uses, cuts amber (`.rp-mark.cut`), failed red. One wire fact, one color
  across surfaces.
- Live: re-render on pair arrival like `renderReplayMarks(force)`; stick
  to the live edge when the cursor was there. An open `start` (below)
  draws as a model span from its ts to the strip's right edge, dashed.

### Stage (`#stage`, top of the `#threads` column while replaying)

The rail stays under it — the strip is the time navigation, the rail is
still the outline and the thread switcher. Esc exits replay, the stage
goes with it.

- **State diagram**: one inline SVG, fixed viewBox, six nodes hand-placed
  (human, model, tools, agents, waiting, reply). Nodes are chips: label +
  count-so-far (+ time where the state has time). Edges are the
  transitions in `stateCounts`, each with its count. The cursor's state
  wears `.on`; the transition just taken is the one strong edge; a node
  or edge with zero observations is faint (never hidden — fixed geometry
  must not shift). `failed` is a badge on the model node (`41 · 2
  failed`), `cuts` a badge on the reply->human edge. Motion: none. The
  lit state switches with a 160ms opacity transition; nothing tweens.
- **The beat**: `beatAt` rendered as rows: caption `turn 04 · step 2 ·
  12.3s · stop tool_use`; one row per tool call `[name] [preview]
  [ok|err]` (fold body = the existing `renderBlockS` for tool + result);
  spawn rows link to the child thread; the reply's first line on a reply
  step; the stated reasoning dimmed, labelled; footer `window 137k
  (+8.1k) · cache 91%`. One row per fact, the amount at the right edge.
- **Chapters**: `[` / `]` jump to the previous / next working-loop head
  (chaptersOf). `←/→` keep stepping turns, shift+←/→ requests. The
  caption is the beat caption, from observed facts only.

### Live: the `start` event

Today a pair reaches the page only when its response completes, so the
stage could say "the model just thought for 12s" but never "the model is
thinking now". The proxies (mitm + base-url) mint the pair id BEFORE
forwarding and emit `onStart({ id, url, method, ts })`; the CLI sink hands
it to the server (`server.ingestStart`), which broadcasts
`{ type: "start", start: { id, url, method, ts, client } }`, keeps the
open starts (dropped when the pair with that id lands, or after 10 min),
and includes them in `init` as `starts`. The page keeps `openStarts`;
the strip draws the open span; the stage lights `model` with the one
heartbeat pulse the live dot already has and says `thinking since
14:32:07` (absolute — never a ticking counter, ui.md). Only messages-
category starts are broadcast (a count_tokens probe is not a state).

### Presentation (`F`)

`body.present`: the header, the toolbar, the cats row and the nav rails
hide; the strip and the panes fill the viewport. Type scale unchanged
(closed set, ui.md). Esc peels present first, then replay. Persisted
nowhere — a presentation is a moment.

### URL

`#/session/<key>/@<pair>` and `@a..b` already address the cursor and the
slice; the stage and the strip read them. Nothing new in the URL.

## Rules kept

- Motion: the playhead is the ONE owner. No flow tokens, no tweened
  counts, no ticking clocks. `prefers-reduced-motion` drops the 160ms
  fade and the heartbeat.
- A number is stated once per view: counts live in the diagram, times in
  the beat/strip tips; the rail's `time` chip is untouched.
- Snapshots and `cctrace view` pages get the whole stage (pure client
  side); a snapshot has no `start`s and says nothing about "now".
- Non-Claude clients: codex/kimi have no spawn tool, so `agents` reads 0
  and faint — honest, not hidden.
- Nothing here estimates. If a figure is not a wire timestamp or a
  provider-reported count, it does not render.

## Verification

- `bun test`: new cases in tests/replay.test.ts (outcome, lanes, stateAt,
  counts, beat, chapters — incl. a parallel-agents fixture and a failed
  request), tests/server.test.ts (start broadcast + drop-on-pair +
  init.starts), tests/ui-grammar.test.ts (stage + lanes markup renders
  and parses on the hostile fixtures, replaying and not).
- Real browser (cloakbrowser, `test-output/replay-stage/drive.mjs`, the
  ctx-rebuild drivers are the pattern): enter replay, play, scrub, click a
  span, `[`/`]`, zoom, `F`, Esc peel — zero page errors.

## Not done / follow-ups

- The context overview (ordinal) and this strip (time) are two overview
  components. Fold them into one with an axis switch once both have
  settled; do not build a third.
- A compressed-time axis for merged multi-day sessions (playback already
  idle-compresses; the strip does not).
- Per-call durations need chunk timing (session-replay P3).
