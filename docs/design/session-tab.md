# Session tab redesign: the sessions layer

Status: proposal (2026-07-17, from the multi-model attribution devlog).
Prereq: the per-turn attribution fix (index-first + content-verify +
scan) — the displays below are computed from attributed turns and must
not ship on top of leaky attribution.

## The model

One hierarchy for every traced client, bottom-up from the wire:

    messages (wire pairs)  ->  threads  ->  sessions  ->  project

- A trace run is project-scoped; the header already carries project +
  client identity.
- A **session** is a wire session id (`extractSessionId` — Claude:
  metadata.user_id JSON; codex/grok: wire-table headers). One run can
  contain several (e.g. /clear mid-run; a resumed session merged by
  history.ts).
- A **thread** is what buildSession groups today (agent-id header /
  first-user-text sig / conv header), now scoped *within* its session.
- Pairs without a session id group under one honest "no session id"
  bucket — never guessed into a neighbor.

**Every trace renders the sessions layer** (2026-07-20 round 5 —
supersedes the earlier "zero new chrome" invariant): a single-session
trace is ONE open absorbed container. The old flat mode showed a
"[chat] N turns" card that said less than the session header does;
the absorbed container (SESSION sid · turns · model · time · req,
outline directly under) IS the compact view.

## What a thread IS (2026-07-20, settled)

A thread is one conversation as the user experiences it. Identity
survives everything the harness does to its context; only the user
ends a conversation. The event table:

    event             wire effect                          structure
    /model            model id changes                     epoch (T0/T1)
    notice injection  history wobbles 1-3 turns            invisible
    recap/ephemeral   exchange answered, then dropped      superseded row
    auto-compact      fold: rewritten + shifted, msg[0]    anchor-merged
                      preserved
    manual /compact   full rewrite, msg[0] = continuation  reunified +
                      summary                              appended
    /clear            NEW session id                       new session

A /compact never mints a thread — same reasoning that keeps /model
from minting one: splitting severs per-turn attribution, subagent
links, and replay continuity, and nobody experiences /compact as "a
new conversation". What it changes is the model's MEMORY, not the
conversation's identity — so it belongs on the rail as a boundary
EVENT (like an epoch head), not as a container. /clear is the only
conversation-ending event, and the wire already marks it (the sid
rotates). Devlog: 2026-07-20-thread-identity-under-compaction.org.

## Most recent session first, always

We always trace and care for the most recent session.

- Default selection (no hash, or bare `#/session`): the newest
  session's main thread, at the live tail.
- Threads pane orders sessions newest-first; the newest is expanded,
  older sessions are collapsed folds (header line: short sid ·
  time range · N req · rollup errors).
- Live: when a NEW session id appears mid-run, follow tail semantics —
  if the user is tailing the previously-newest session, focus moves to
  the new session's thread; if they're reading history, a pill
  announces ("new session started"), nothing yanks.

## Routes

    #/session                        newest session, main thread
    #/session/<sid8>                 that session's main thread
    #/session/<sid8>|<grouping>      specific thread (the SHORT key)
    #/session/<key>/@<pair>          replay anchor (unchanged shape)

Thread keys in URLs are the short form `<sid8>|<grouping>` (2026-07-20
review): the full wire uuid in the hash was noise, and redacted traces
put literal `****` in the URL bar. Internal state keeps full keys;
only what lands in location.hash is shortened (`shortKeyStr` /
`threadHash`). Back-compat: old full-key links still resolve — lookup
order is exact key, short key, then sid-prefix.

## Threads pane (left)

    2 sessions · 5 threads · 9 req                    <- rollup, as today
    ⌗ SESSION 01e0e34a · 6 turns · haiku-4.5 +1 · 20:41 · 4 req
      ⑂ T0 sonnet-5 · 2 turns                         <- epoch section head
        ○ turn00  hihi testa again new chat           <- the prompt, verbatim
        ● turn01  Hey — new chat, clean slate...      <- reply snippet, dot = verdict
      ⑂ T1 haiku-4.5 · 4 turns
        ○ turn02  new haiku thread
        ● turn03  Got it — Haiku 4.5 now...
      [agent] [Explore] search for ...
      ▸ utility · 1
    ▸ ⌗ SESSION dad06800 · 7 turns · fable-5 +2 · 20:37 · 5 req

- The SELECTED conversation renders as an outline: epoch heads (only
  when >1) with their turns nested under, ordinals global. User rows
  show the prompt (turnSnippet: caveat/stdout wrappers skipped, a
  command-only turn previews as "/model" — that IS what the user did);
  assistant rows show a reply snippet. The dot LEADS each row — a
  status gutter, like a diff margin. A row shows the MESSAGE and
  nothing else: every metric (tokens, cost, ttft, duration, folded)
  lives in the instant hover — inline numbers fought the text for the
  same pixels (2026-07-20 round 3). Row click = jump to that turn in
  the convo; wire detail is one click further (the convo turn's wire
  link). Wire pairs backing no turn surface ONLY when they carry a
  story (rewound / failed) — routine superseded retries add nothing
  to an outline.
- Iconized identity (2026-07-20 round 2): the session header opens
  with a prompt-in-a-frame glyph + accent-tinted `SESSION` label
  (small caps via text-transform — the markup stays lowercase); each
  epoch head opens with a branch glyph + `T<n>` ordinal. Glyphs are
  stroke-only currentColor (.sico), accent-tinted at rest. The model
  id renders bare — `haiku-4.5 +1` is self-evident; its hover explains
  primary-model semantics and the per-model split.
- EVERY turn row carries a dot: user turns a hollow ring (the human
  side has no wire verdict), assistant dots the request's verdict —
  green healthy cache hit, amber weak hit (<90%) / cold / miss, red
  failed request, neutral no-cache/unattributed. Wire-only rows
  (rewound/failed) dot amber/red.
- Hover = instant, organized detail (custom .tip singleton filled from
  data-tip; native title waits ~1s and renders unstyled). First line
  is the heading, blank lines separate sections. Session: full id,
  wall-clock, thread/turn/req counts, tokens, est. cost, model list,
  errors. Epoch: T<n> + model run, turn span, time, out/cost, the
  /model-switch note. Turn: role + model, time, tokens/cost,
  ttft/duration, spelled-out cache verdict, failure notes. The
  tooltip is pointer-events: none and repositions against the
  viewport (flips above near the bottom edge).
- **Collapse rule, generalized** (2026-07-20 review): a container with
  exactly one chat collapses into its parent. `/clear` rotates the sid,
  so one-chat sessions are the COMMON case — "session → chat" rendered
  the same fact twice. The session header absorbs the chat card (its
  model chip joins the header, `data-goto` makes the header select the
  chat; clicking again folds); the outline and agent/utility threads
  hang directly under it. Multi-chat sessions keep their chat cards.
- **Uni-colorized** (ui.md rule 2, applied): kind chips are neutral
  outlines — the word carries the meaning. Red/amber stay reserved for
  state (err, rewound); accent stays reserved for selection.
- Keyboard: `[` / `]` = previous/next session (title-attr
  discoverable). Existing keys untouched.

## The session rail (2026-07-20 round 9)

Round 8 shipped the pieces; round 9 unifies them. The complaint was
real: inside one session card lived three unrelated row grammars —
epoch rows (glyph + T0), turn rows (dot + ordinal), and thread CARDS
(kind chip + label + meta line) — and agent threads sat detached at
the bottom even though the spawning turn is known. It didn't read as
one session.

One principle: **the session is a single rail.** A continuous vertical
line runs down the session body; every row is a node on it, sharing
one gutter column:

    ⌗ SESSION 153313f9 · 309 turns · fable-5 · 20:28–23:58
    │ ◇ T0 fable-5 · 24 turns          <- epoch = segment mark, no glyph
    │ ○ turn00  build and use ccx…     <- user node (hollow)
    │ ● turn01  I'll build ccx from…   <- assistant node (verdict color)
    │ ╰─ [explore] map the repo · 2 turns · $0.0035   <- branch row
    │ ◌ turn02  …superseded            <- grey node at its position
    │ ◇ T1 opus-4.8 · 8 turns
    │ ○ turn03  …
    ▸ utility · 2

- The rail is the git graph: turn dots (existing verdict colors) sit
  ON the line; epoch heads become ring nodes on the same line (the
  3-circle branch glyph in rows is gone — the rail itself carries the
  branch metaphor); superseded rows are grey nodes at their ordinal.
- **Spawned agent threads attach at their spawn turn** as branch rows:
  a CSS elbow off the rail + label + outcome stats inline (same data
  as the convo pane's spawn fold), click = open the thread. The
  detached card disappears while its parent thread is the selected
  one; selecting the branch row shows the agent thread's own card +
  outline as before (so nothing is ever unreachable when the parent
  isn't outlined). Unlinked agents and utility keep their rows below.
- Every row = [gutter node] [label] [text] [right-aligned attribute].
  One padding, one left edge, one hover grammar (data-tip). Kind
  chips survive only on rows that ARE threads (multi-chat sessions,
  unlinked agents).
- The rail tint is the accent at low mix — same family as the klabel
  and the selection wash, so container, identity, and structure share
  one voice.

Thread identity stays the conversation — a /model switch never mints a
thread (it would sever attribution, replay, and subagent links). What
it DOES mint is an **epoch**: a contiguous run of visible turns
answered by one model (`threadEpochs` in src/session.ts, folded from
attributed turns; user turns belong to the epoch of the reply that
answered them, so the prompt sent after a switch opens the new epoch).

- Threads pane: multi-epoch conversations list `t0/t1/t2` rows — short
  model id + turn count, click = jump to where that model takes over.
  Single-model threads render zero epoch chrome.
- Convo pane: a quiet hairline divider (`— → opus-4.8 —`) at each
  switch, placed before the prompt the new model answered; every
  attributed assistant turn's usage line names its short model id.
  Utility calls never mint epochs (haiku doing title-gen is not a
  model switch).
- Thread model stays a set: per-model requests / output tokens /
  cost, built from attributed turns + per-pair extractCallInfo.
- Label: single-model stays `fable-5 · 32 turns`; multi-model becomes
  `fable-5 +4 models · 32 turns`. Primary = most output tokens (who
  did the work), never last-used (that's the bug as a rule).
- Convo-pane chips: the `model` chip becomes `models` when >1, value
  `fable-5 +4`; its tooltip is the breakdown table (model · req ·
  out · cost). No extra chips — the row is dense already.

## The compact boundary (round 10)

After a /compact the request body sent to the API is a different
document — the view says so explicitly instead of merging silently:

- buildSession exports `t.compactions`: `{at, pairId, fromTurns,
  toTurns, mode}` — the first post-compact turn's index, the first
  request of the NEW packing (not merely the first post-spine request:
  pre-compact stragglers sit in between), the context collapse in
  turns, and fold vs rewrite.
- Outline: a break node on the rail (two slanted hairlines — the
  axis-break glyph, .cnode) + a `COMPACTED · 513 → 440 turns` row at
  the boundary ordinal. Grey like superseded: a timeline fact, not a
  warning. Hover spells out the collapse in turns AND tokens (pre =
  the thread's deepest request context, post = the witness request's),
  names the mode, and says the honest sentence: everything above this
  line survives only in the summary/folded form. Click = the first
  post-compact wire request.
- Convo pane: a dashed divider at the same full-turn index
  (`compacted · context rewritten · N → M turns · wire`) — dashed
  matches the superseded marker family; the conversation flows
  through it.
- The continuation summary turn, WHEN it renders (a trace that begins
  mid-session, or a post-compact spine), carries a `continuation
  summary` tag on its role bar — it is not something the user typed.
  In the common merged case it never renders: the anchor merge shows
  the real pre-compact turns instead, which say strictly more.
  (Detection via turnSnippet, not firstUserText — the continuation
  message opens with a <local-command-caveat> wrapper.)

## Superseded exchanges (was: "Rewind")

Prefix-divergent requests are captured data. Never auto-dropped — not
by purge, not by compact (compact must treat each divergent branch
tip as its own keeper; see devlog).

**Naming lesson (2026-07-20 round 5)**: the display MUST NOT claim
"/rewind". The detection (history diverges from the spine's prefix)
fires equally for /rewind, an edited message, and **ephemeral
injected exchanges** — the auto recap ("The user stepped away…") is
injected, answered, and then dropped from later history, and the old
"↩ rewound" label asserted a user action that never happened. The
honest word is **superseded**: this exchange left history; the cause
is listed, not asserted. (Internal field stays `t.rewound` — wire
truth, heavily tested — display language only.)

- Detection: a request whose history diverges from the spine's prefix
  at same-or-shorter length, superseded by a later request in the
  same thread.
- **Compaction is not supersession (2026-07-20 round 8)**: /compact
  REPACKS history — shorter and rewritten (tool_use turns become text,
  a recent tail survives verbatim). Two false-positive modes, both
  fixed in buildSession: (a) requests following the spine after a
  compact could match nothing — now they merge in via a
  context-verified anchor (deepest post-compact turn still present in
  the spine, 2 aligned neighbors required since boilerplate turns —
  system notifications, recap prompts — collide on sig), appending the
  genuinely new turns at their timeline position; (b) once the spine
  itself is a post-compact packing, every pre-compact pair whose
  exchange the fold rewrote would flag superseded en masse — a history
  drop of 10+ turns below the running max marks the repack (ephemeral
  notice turns wobble 1-3; a /rewind steps back a few), and pairs from
  before it classify unattributed instead. Supersession stays fully
  trusted when no repack happened or the spine predates it.
- **Structural detection over harness strings (round 11)**: matching
  the continuation preamble text is coupling to harness copy that a
  Claude Code update or a user customization can change silently — so
  strings demote to ONE vote, never the gate. The structural
  continuation test: same REAL session id (no-sid traces excluded:
  two sequential distinct conversations look identical to parent +
  continuation there) + the same system IDENTITY block (the first
  non-billing system block — the leading x-anthropic-billing-header
  block mutates per request; subagents and utilities carry different
  identity blocks) + a start smaller than the parent's deepest
  packing + a parent that goes quiet FOREVER (a compacted
  conversation never speaks again; a parent that spawned a subagent
  always resumes). The summary-turn tag is position-first too (the
  turn AT a rewrite-mode boundary), preamble as fallback. Capture-time
  metadata stamping was considered and rejected: capture stays
  lossless and dumb — viewer-side analysis improves retroactively
  (this round made OLD traces render better), which stamped-in
  heuristics would freeze. The future refactor when heuristics strain:
  a sequential request-diff primitive (consecutive same-thread bodies
  classify as extend / wobble / rewind / fold / rewrite), replacing
  spine-relative comparison with pairwise structure.
- **Full /compact reunification (round 9)**: a manual /compact rewrites
  message[0] into the continuation summary ("This session is being
  continued from a previous conversation…") — a new sig, so the
  continuation minted its own thread; worse, the summary quotes old
  Task dispatch prompts verbatim, so the agent-linker false-claimed it
  as a subagent (observed: the post-compact main chat filed under a
  codex-rescue thread). Fix: a thread opening with the continuation
  preamble merges into the same session's earlier-started thread with
  the deepest history (the packing the summary was made from); no
  parent in the trace = stays standalone. Since nothing survives a
  full rewrite verbatim, the anchor merge gains a fallback: no anchor
  + a 10+ drop ⇒ append the ENTIRE post-compact packing at the
  timeline tail — the summary turn is a real event, and the exchanges
  after it are the live conversation.
- Outline: a superseded exchange renders AT its timeline position as
  a grey half-present row (.tturn-sup, opacity) carrying the ordinal
  it occupied — strictly session order, never a trailing appendix:
      turn17  …
      turn18  The user stepped away and is coming…   superseded
      turn18  (the turn that replaced it)
  Row click opens the wire pair; hover explains the possible causes.
- Convo pane: one quiet grey marker row at the divergence point —
  `superseded exchange · wire` (grey dashed edge, not amber: it's a
  timeline fact, not a warning).
- Thread meta / convo chips say `N superseded` (grey, only nonzero).
- Replay: needs nothing — superseded pairs are real wire events, so
  scrubbing before the divergence shows the branch exactly as it
  existed; stepping past it shows the rewrite.

## Convo pane refinements (2026-07-20 round 4)

- Every reconstructed turn's role bar repeats the outline's ordinal
  (`turn03` in the pane IS `turn03` in the convo — one numbering,
  .turn-ord, faint whatever the role color). Jump targets and the
  outline now read as the same list at two zoom levels.
- Notable folds are iconized: subagent = branch glyph, skill = bolt,
  mcp = plug (purple, matching their titles). A subagent spawn fold
  carries the spawned thread's outcome inline — "N turns · out X ·
  $Y (· N err)" — so what a Task cost is visible without opening
  anything; the open-thread link stays. Skill folds name the skill in
  the title ("skill · ccx-recap") with its args as the hint.

## Attribution honesty

- Attributed turns: model/usage/cost/ttft/wire link, as today.
- Unattributed assistant turns (attribution failed even after verify
  + scan, e.g. compacted stubs): a muted `unattributed` bit in the
  turn-usage slot with a title explaining why. Silence is what let
  the original bug hide; a blank slot must be distinguishable from
  "nothing to show".

## Degrade honestly

- Pre-0.13 traces (no client label) and traces without session ids:
  one unlabeled bucket, today's flat rendering.
- Snapshots: sessions layer works identically (it's pure pair data);
  no live-only affordances leak in.
- view-rebuilds without project meta: header stays "unknown project",
  sessions layer unaffected.

## Explicitly not doing

- Session NAMES extracted from bodies (/rename command turns,
  title-gen responses) — reversed in the devlog: we don't parse
  conversation content whose format Claude Code owns. Session id is
  the identity.
- Full rewind branch-tree rendering — marker + wire link only, until
  rewind-heavy workflows prove the need.
- A project-level browser in the live page — project → runs browsing
  belongs to `cctrace view`'s picker and the instance registry.

## Test plan

Fixture: sanitized cut of trace-2026-07-17T05-19-24.jsonl (5 models,
injected system notices, one /rewind — all three hazards in one
session; commit privacy gate applies before it lands). buildSession
over it must: attribute every assistant turn, report all five models
with the right primary, classify the rewind as rewound-not-lost, and
group by session id given a second-sid pair. renderThreadsPane
snapshot tests: single-session = byte-identical to today.
