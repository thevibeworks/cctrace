# The Trajectory view

Status: shipped (0.44). The fourth page view (`#/trajectory[/<key>]`, tab
beside requests/sessions/context): the agent's PATH as one linear,
time-anchored stream of RECORDS — every record the run produced, one row,
in spine order.

## Why (and where the idea comes from)

Borrowed directly from the DeepSeek Harness web UI's **Trajectory** tab,
studied live (`dsh web`, not just the source — the form is the point).
dsh's Trajectory reads a whole session as a dense record-level table: every
record is a row — system prompt, the human's turns, the CONTEXT the harness
injected (inline, first-class, at the moment it entered), the model's
thinking, each tool call fused with its result, the reply — kind-badged, in
order, with a time waterfall above it.

The move cctrace was missing: **context injections as first-class inline
rows woven into the reasoning flow.** The Sessions convo reads the
conversation but folds tools and renders injections as sys-tagged user
turns; the Context view reads one request's window as a composition. Neither
shows the agent's path as a stream where you watch context *enter* the
window inline with the reasoning that consumed it. That stream is the
"context trajectory".

cctrace's structural advantage over dsh's harness-event-log reconstruction:
this is built from the reconstructed spine (`buildSession`'s `t.turns`), so
it is exact and every record carries its wire pair.

An earlier attempt borrowed the *numbers* (a Sessions "time" chip from
`threadTimeSplit`) and called it the trajectory borrow. That was shallow —
the chip is a good thing and it stays, but it is not the form. This view is
the form.

## The record stream (src/context.ts)

`trajectoryRecords(thread)` — pure, unit-tested, inlined into the page like
session.ts. It walks `t.turns` and emits one record per block, in order.
Record kinds mirror `CTX_CATS`, as a linear stream:

| kind | what | how |
| --- | --- | --- |
| system | the system prompt | one record, blocks in the inspector (dsh's "Initial System Prompt") |
| user | the human's own words | user-turn text that `ctxTextCat` says is `user` |
| context | harness-injected context | user-turn text that `ctxTextCat` says is `inject`, labeled by producer (`ctxInjectLabel`) — inline, at its position |
| assistant | the model's thinking / reply | assistant text (`think:false`) and thinking (`think:true`) |
| tool | a tool call fused with its result | a `tool_use`, `detail` = the `tool_result` preview, `err` = the result's `is_error` |

A record: `{ kind, think, ord, step, label, detail, tokens, pairId, err,
block, result, toolName }`. Turn/step addressing (`ord`, `step`) matches the
Sessions outline and the Context view (`loopTurns`), so "turn 04 · step 2"
means the same thing on every page. `toolResultsOnly` turns never become
their own records — their results are fused into the `tool` record via the
tool_use id (`buildToolResultIndex`), the same fusion the convo pane does.

The `user`/`context` split is the one that carries the whole view: the same
measured rule as the Context composition (`ctxTextCat` — the `<total_tokens>`
budget banner and the SessionStart hook are injections, not the human), so
the CONTEXT rows are honestly the harness's and the USER rows honestly the
human's.

## Progressive disclosure (archify's MAP → READ → FULL)

`trajectoryAtLevel(records, level)` — the second borrow, from Archify's
progressive-disclosure principle (studied at tt-a1i.github.io/archify): the
stream is always complete; the level decides what earns a row so a long run
stays scannable. It FILTERS, never summarizes — a hidden record is counted
(`{ records, hidden }`), never folded into a lie.

- **full** — every record (default).
- **read** — drop the plumbing: the `token budget` / `SessionStart hook`
  banners and standalone thinking. Keep system, the human, replies, tool
  calls, and the SUBSTANTIVE context (skills, AGENTS.md, watch/notice
  events).
- **map** — the skeleton: system, the human's turns, and the tool calls —
  what the agent was asked and what it did.

The toolbar states how many rows the level hid.

## The view (src/ui.ts, `renderTrajectory`)

Route `#/trajectory[/<sid8-or-thread-key>[/<thread-key>]]` — the key grammar
and the selection are shared with sessions/context (`resolveThreadSel`,
`sessionSelKey`), so switching tabs keeps the thread in focus. Two panes,
the requests grammar (list | detail):

- **head** — thread label · model · sid, a `sessions →` link, and the time
  strip: the `threadTimeSplit` lanes (model / tools / waiting / between) as
  one proportional bar with a legend — dsh's Input/Model/Tools waterfall at
  the session level, off cctrace's own attributed pairs, every figure a
  wire timestamp. Counts caption it: `112 records · 43 wire steps · 9h 14m
  · $15.08`. "Turns" is deliberately NOT in the counts — the head's thread
  label already counts message turns, and the counts count wire steps;
  naming both "turns" is the overload the Context view doc warns against.
- **toolbar** — the level (map/read/full), a kind filter (all / user /
  context / assistant / tool — "context only" is the killer use: the
  context trajectory alone), and a search box.
- **list** — the record stream. A `turn NN` sticky divider opens each
  working loop; each row is `[badge] [label] [→ result] … [≈tokens]`,
  the badge and (for tools) the label colored by category (`CTX_CATS`
  hues), thinking dimmed, an errored tool result in red. One row per
  record — the outline rule (identity per row; the amount rides the right
  edge).
- **detail** — the picked record, opened: the head (kind · turn·step ·
  ≈tokens · `wire →`) and the block rendered by the detail panel's own
  renderers (`renderSystem` / `renderBlockS` for a tool with its result /
  `renderBlock`), so a tool_use/thinking/text reads exactly as in the
  requests detail panel.

Live behavior: re-renders on pair arrival (the three WS handlers), list
scroll preserved across a same-thread re-render. Pure client-side — works
identically in snapshots and `cctrace view` pages.

## What is NOT borrowed

dsh's per-record time waterfall (each record a bar on a time axis, wheel
zoom, drag-to-focus) — cctrace shows the lane TOTALS as one strip, not a
per-record axis. The per-record waterfall is a genuine follow-up (the data
is there: per-pair durations + `threadTimeSplit.byPair`), but the record
table is the value and the totals strip is the honest small version of the
shape. dsh's DevTools record inspector with Payload/Result/Schema/Timing
tabs — cctrace reuses its existing block renderers instead, which already
give payload+result+schema for a tool fold.

Archify is an architecture-MAP generator (nodes/edges, guided path
"stories", route probe, semantic lens); only its progressive-disclosure
principle transfers to a linear trace. Its guided-story playback overlaps
cctrace's existing replay (a time cursor over the same pairs) — linking the
trajectory rows to replay is a follow-up, not a second playback engine.

## Follow-ups

- Per-record time waterfall (dsh shows it; needs per-record time off
  `threadTimeSplit.byPair` + a small axis component).
- Link a record to replay: click → replay cursor at that pair, so the
  trajectory drives the time machine cctrace already has.
- Keyboard j/k over the record list (today click-only; the requests list
  has j/k, the pattern is there).
- Deep link to a record (`#/trajectory/<key>/<record>`) — the route
  grammar has room; nobody has asked yet.
