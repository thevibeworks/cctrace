# The Context view

Status: shipped 0.44 (ledger re-staging included); **rebuilt as a
DevTools shell** — the Trajectory tab folded in and the trajectory bar
made interactive. The third and last page view
(`#/context[/<key>][/=<deck>]`, tab beside requests/sessions): the agent's
context window over time. An interactive OVERVIEW owns the page's time
axis; a MARGIN reconciles the balance; one DECK at a time answers a
different question about what the overview has selected (§The form).

## Why (and where the idea comes from)

The Sessions view answers "what happened in the conversation". It does not
answer "what is the model actually carrying around, and what is eating the
window" — the question you have when a session degrades, when cost climbs,
or when a compaction fires and you want to see what it reclaimed.

Two upstreams are borrowed from, both vendored for study under
`reference/`: `dsh-context` (the DeepSeek Harness context plugin) for the
composition/history/events shape and its Trajectory reading of an agent's
path, and `semantica` (the graph-native context/provenance engine) for one
idea — every fact links to its source. semantica renders a decision's
provenance as a path through its graph; cctrace's version is smaller and
exact: each context-graph pane row names the wire request that first
carried its turn into the window ("since turn NN"), matched to the spine by
content (`ctxOriginTurn`), because the window IS a request body and its
origin is another captured request. The composition borrow from
`dsh-context`: the context
stats board, the six-category composition bar, the per-request stacked
history chart with ✂ compaction marks, the context-events list, and the
linked per-step decomposition (dsh's "browser"; ours is the context graph
— see below). The sibling borrow is dsh's **Trajectory** tab, which reads
an agent's path as a shape. That shipped as its own tab in 0.44 and was
wrong: it is a READING of a thread, not a second thread. It is now the
stream deck of this page (§The record stream), and the shape also rides
the sessions rail as a gutter (§The trajectory gutter).
The third upstream is **Chrome DevTools' Performance panel** — for the
shell, not the pixels: an overview strip that never scrolls, a brushed
range that scopes everything below it, wheel-zoom around the cursor, and
detail decks that read the current selection instead of navigating away
from it.
What is NOT borrowed from dsh is its data problem: dsh folds
a harness event log and must archive removed nodes to *approximately*
reconstruct past steps. cctrace sits on the wire, and every captured
`/v1/messages` (or Responses/Chat-Completions) request body IS the fully
assembled context of that step. So:

- per-step composition is **exact** — no fold, no shadow-price protocol, no
  removed-node archive, no "reconstruction is approximate" caveat;
- every step carries the provider's own usage, so the estimate is always
  **anchored** to a real prompt-token count from the same wire pair.

## The six categories

`CTX_CATS` in src/context.ts, in stacking order (envelope, then surface):

| id | what | how classified |
| --- | --- | --- |
| system | system prompt | `body.system` / leading system-developer run (openai) |
| tools | tool schemas | `body.tools` (+ codex `additional_tools`) |
| user | the human's words | user-turn text blocks not classified inject |
| inject | harness-injected context | `<system-reminder>` blocks, the per-turn `<total_tokens>` budget banner, `SessionStart hook additional context:` output, harness prompts (recap / tool-load / notification / reminder — `harnessPrompt`), continuation/compaction summaries, openai harness wrappers (AGENTS.md digest, environment context, mode banners) |
| assistant | model replies | assistant-turn blocks (text, thinking, tool_use) |
| toolResult | tool outputs | `tool_result` blocks (wherever they ride) |

Command wrappers (`<command-name>`…) stay **user** — they are the human's
action. Colors are data colors (fixed hex, both themes), same rule as the
request-category chips.

The `user` / `inject` line is the one classification that can invert the
whole reading, so it is drawn from measurement, not taste. On a real
91-step session, 97 of 99 "user" blocks were the `<total_tokens> … tokens
left` banner Claude Code appends to every user turn (plus the SessionStart
hook's output) — counted as the human's words they made harness overhead
look like conversation. Correctly bucketed, that session reads user 4% /
inject 20% instead of user 12% / inject 10%. Prefix matches only: a human
message that merely *mentions* `<total_tokens>` is still the human.

## Estimation and anchoring

`estTokens` = chars/4 (the fixed-density heuristic every harness meter
uses); images a flat `CTX_IMG_EST` (≈1.5k — dimensions aren't recoverable
from the wire copy). Every estimated figure renders with `≈` and sits NEXT
TO the provider-reported number, never instead of it:

- a step's **bar height** is the actual prompt tokens
  (input + cacheRead + cacheWrite) when the response reported usage, the
  estimate otherwise (failed requests: the bar shows what was SENT);
- the **segment split** inside a bar is the estimate's proportions;
- the headline shows both ("413.2k prompt · estimated ≈229.4k") — on
  code-heavy sessions chars/4 undercounts (real density ≈3 chars/token),
  and showing both is the honest form of that.

The **window** denominator comes from the models.dev catalog
(`limit.context`, now carried by src/pricing-catalog.ts) via
`modelWindow()` in src/pricing.ts (same id-normalization ladder as
`modelPricing`; embedded 200k fallback for Claude models), overridden to 1m
when the thread's `anthropic-beta` header says `context-1m` (a wire fact).
Unknown window = no percentage, never a made-up denominator.

## Data layer (src/context.ts, toString-inlined like session.ts)

- `contextComposition(pair)` — per-category sums for one request. Cheap by
  design (length arithmetic; memoized on the pair as `_ctxc`); null for
  compact stubs (their composition is gone; usage survives) and
  non-model-call pairs.
- `contextItems(pair)` — the flat walk: one item per system block / tool
  schema / content block, each with tokens, a label, and a REFERENCE to its
  source block (`b`) so full content renders lazily with the page's
  existing `renderBlock`. tool_results are labeled with the tool that
  produced them (tool_use id → name map within the request); inject items
  carry their PRODUCER (`src`, from `ctxInjectLabel`) — the same vocabulary
  the events list speaks.
- `contextGraph(pair)` / `ctxGroupOf(catId, item, idx)` — the grouped
  tree the view renders: category → group → item, built ON contextItems so
  the body is walked once. The grouping is the question each category
  answers, and that is the whole design:

  | category | grouped by | the question |
  | --- | --- | --- |
  | toolResult | tool name | which tool is eating the window (`Bash ×104 ≈62.8k` on a real trace — 48% of it) |
  | tools | built-ins vs one node per MCP server | what a server's schemas cost to keep loaded |
  | inject | producer (`ctxInjectLabel`) | which injector, `token budget ×97` as ONE node |
  | system | per block | which block of the system prompt grew |
  | user / assistant | history turn | a reply and the tool calls it made read as one node |

  Groups come back in FIRST-APPEARANCE (wire) order with their totals;
  ranking is the view's lens, not the data's. A group's label is the first
  non-empty item label it holds (a turn opening with an empty text block
  would otherwise be an unnamed node), with a per-category fallback.
- `ctxFlameTree` / `ctxFlameFind` / `ctxFlameLayout` / `ctxFlameDefault` —
  the ICICLE layout, pure and unit-tested apart from the DOM: the tree in
  uniform node shape, the ancestor chain for a key, the rows of
  `{x, w, pct, lbl, hasKids}` at a given zoom, and the node the section
  opens on. Layout is data, not view: the view only turns rows into
  positioned spans. A row entry says `hasKids` (can I zoom this) rather
  than carrying a child list — the tree already holds the children, and
  one name for two shapes was a readability trap.
- `contextTimeline(threadPairs, compactions?)` — one step per wire request
  in thread order, plus events between consecutive steps:
  - `model` — request model changed;
  - `compact` — history dropped ≥10 turns below the running max
    (buildSession's own rule), labeled fold/rewrite/rewind when the session
    layer classified that boundary (`t.compactions` passed in), with the
    token delta actual-anchored (prev prompt − new prompt);
  - `tools` / `system` — the envelope changed (deferred-tool loads, mode
    flips);
  - `inject` — inject-category text blocks in the turns this request
    APPENDED (past the previous request's history length; skipped across a
    repack boundary rather than mis-attributed). First step counts its
    opening injections (session-start context).
- `ctxAggregateTurns(steps, stepAddr)` — turn-granularity bars: each turn
  shows its LAST step (the deepest context it reached); failed steps never
  become a turn's face.

Turn/step addressing (`stepAddr`: pairId → {ord, step}) is built in the
page from the same `loopTurns` data the sessions outline uses, so bars and
events say "turn 04 · step 2" in the outline's numbering.

## The view (ui.ts)

Route `#/context[/<sid8-or-thread-key>[/<thread-key>]][/=<deck>]` — the
key grammar and resolution are shared with the sessions view
(`resolveThreadSel`), and so is the selection: switching tabs keeps the
thread in focus. The convo pane carries a quiet "context →" link; the
context head links back ("sessions →"). The legacy `#/trajectory[/<key>]`
route still resolves: it lands on the stream deck and rewrites itself to
`#/context/<key>/=stream`.

The page is an app SHELL, not a scroll: `#context-view` is a flex column
whose head and overview are fixed and whose margin and deck scroll
themselves. That is what retired the `max-height: calc(100vh - 120px)`
magic constant the sticky margin needed, and it is what lets the stream
deck's list and inspector be their own scroll columns.

### The form: an overview that drives three decks

The page is a DevTools shell: an interactive overview that owns the time
axis, a margin that reconciles the balance, and ONE deck at a time
answering a different question about the same selection.

That is a verdict on two shipped arrangements. 0.44 put five equal-weight
sections down a 1100px ribbon and made the answer arrive fifth, below the
fold. 0.45's ledger fixed the margin but left the canvas a scroll of
stacked reports — and it shipped a fourth tab, **Trajectory**, for a
reading of the same thread. Two tabs for one subject is the error: a
reader who has picked a thread and scrubbed to a step should not lose both
by clicking a tab to ask a different question about them.

    ┌─ head: kind · label · model · sid ──────────────── sessions → ─┐
    ├─ OVERVIEW (never scrolls) ─────────────────────────────────────┤
    │ 88 wire requests · 8 loops · drag / wheel / click  [step|turn] │
    │      ▁▂▃▄▅▆▇█  CTX   one column per step, stacked by category  │
    │ 249k ░░░▓▓▓▓░░░ ← the brush: drag, resize, pan, dim outside    │
    │ 2m24s ▁_▁__▃_▁  TIME model / tools / waiting, same x axis      │
    ├──────────────────┬─────────────────────────────────────────────┤
    │ MARGIN (scrolls) │ [window] [stream] [events]     deck controls│
    │ 260k             │                                             │
    │ 37% of 200k ▓░░  │  window — the pinned step as an icicle      │
    │ ≈137k · 47% under│  stream — every record, injections inline   │
    │ ── composition ──│  events — what grew or reclaimed it         │
    │ six ledger lines │                                             │
    │ ── this step ────│                                             │
    │ ── tool schemas ─│                                             │
    │ ── time went ────│                                             │
    │ ── other threads │                                             │
    └──────────────────┴─────────────────────────────────────────────┘

Two selections, and they mean different things — which is why one page
can carry all three readings without ambiguity:

- **the PIN** is one step (click a column, or ←/→). It drives the
  margin's balance and the window deck: *what was the model carrying at
  this exact request*.
- **the RANGE** is a brushed span of steps. It scopes the stream and the
  events: *what happened across these requests*. It never touches the
  balance, because a balance is a thing one request has.

Nothing about that is decoration: the overview is a frame element, not
the first thing in a scroll, because every deck below reads its
selection. Scrolling away the control that scopes the content underneath
is the thing DevTools got right and a stacked report gets wrong.

#### The overview (`renderCtxOverview` / `wireCtxOverview`, `.cx-ov`)

Two tracks on one x axis, under one brush.

- **ctx** — one stacked column per step (or per turn — granularity
  toggle, persisted in `cctrace-ctx-gran`), height = the anchored total,
  scaled to this thread's own peak and labelled with it in the gutter.
  Outliers are RAISED: a compaction/rewind wears ✂ *and* a full-height
  dashed amber axis-break down the column (`.cx-colw.cut`) — amber
  because `.rp-mark.cut` already paints this exact wire fact on the
  replay track, and one compaction gets one color across both surfaces; a
  failed request keeps its dashed red outline. It does NOT draw the model
  window as a second line — occupancy against the limit is the margin's
  balance, stated once.
- **time** — where THAT step's wall-clock went: the request's own
  duration (model), then the gap to the next request of the same working
  loop (tools when the reply made calls, waiting when the harness came
  back on its own) — `threadTimeSplit.byPair` in src/session.ts. Every
  figure is a wire timestamp; nothing here is estimated. The floor is a
  PIXEL, not a percent, so a 6-second step under a 2m24s outlier still
  reads as a baseline the spikes rise out of. The totals and the legend
  that names the three hues live in the margin (`renderCtxTimeBlock`) —
  a track whose colors are never named is a decoration. This is the
  per-step waterfall the 0.44 doc listed as a follow-up; the head strip
  it replaces was the honest small version of the same shape.

**Columns are equal-width and gapless**, and the *bar* inside each column
is what gets capped (28px), not the column. That is load-bearing: the
brush positions its edges at `i/N` of the track, which is only exact when
every column occupies exactly `1/N` of it — a 2px gap drifts the overlay
by a column width across 100 steps. The side effects are both wins: a
five-step thread reads as five slim bars across the axis instead of a
110px huddle in a 1000px field, and every column keeps a full-width hit
target.

Interactions, all repainting **in place** (a full re-render on every
pointer move would rebuild a 400k-token decomposition sixty times a
second):

| gesture | what it does |
| --- | --- |
| hover | scrubs the margin instantly, the icicle on a 90ms settle; leaving restores the pinned/newest step |
| click | pins that step (a second click un-pins) |
| drag | brushes a range — the dim panels, the caption and the deck follow |
| drag a handle | resizes the range from that edge, the other edge anchored |
| drag the window | pans the range, keeping its width |
| wheel | zooms around the cursor (1× fit … 32×); the track is a width change on a flex row, so nothing re-renders |
| shift+wheel | left to the browser — native horizontal scroll |
| `←` / `→` | walks the pinned step |
| `Esc` | peels one layer: the range, then the zoom, then the view |
| `1` / `2` / `3` | the three decks |

The range is stored in **step indices**, never column indices, so
flipping to turn granularity redraws the same selection instead of
silently meaning something else. The caption states it out loud —
`23 of 88 selected · turn 04 → turn 11 · esc clears` — because a range
that is only a rectangle is a range the reader has to infer.

#### The margin (`renderCtxMargin`, `.cx-margin`, 300px)

The whole balance, repainted on every scrub (`ctxRepaintMargin` swaps
`#cx-bal`; the time and threads blocks are outside it and stay put):

- **the balance** — the provider's prompt at display scale (`.cx-bal-n`,
  the one 24px number the design language licenses, see ui.md), the
  turn·step·model line, the six-segment bar scaled against the window
  (grey = headroom), `N% of context used`, and **the reconciliation**:
  `≈134k estimated · chars/4 reads 49% under`. On code-heavy bodies the
  estimate reads well under the bill, and saying so by how much is the
  honest form of showing both numbers. A failed or compact-stubbed step
  says that instead.
- **the ledger** — the six categories, always all six, always in CTX_CATS
  order, with weight, ≈tokens and %. This is the page's ONE list of those
  numbers; the icicle's row 1 is the other rendering and it is a *chart*
  — it reorders under the size lens and it disappears the moment you
  zoom. The ledger is the invariant that does not. Every line is also a
  control: clicking it zooms the graph to that category
  (`data-cxnode="c:<id>"`, the same node key the flame uses), and the
  line wears `.sel` while that zoom holds — margin and chart are one
  selection whichever side the click came from. From the stream or the
  events deck, clicking a ledger line brings the window deck with it:
  it is a control on the graph, and the margin is beside every deck.
- **this step** — clock, output, cache share, and both ways out (`turn NN
  · step N →` into the sessions rail, `wire →` to the captured pair).
- **heaviest tool schemas** — the standing cost, top 5 of N.
- **where the time went** — the thread's model / tools / waiting /
  between-turns totals, and the legend for the overview's time track.
- **other threads** — the multi-session picker, quietest block in the
  margin, because switching sheets must not need a scroll.

At ≤960px (the page's established breakpoint) the margin becomes a
multi-column band above the deck — `columns: 300px`, blocks
`break-inside: avoid`. Grid was tried and rejected: its rows take the
tallest block's height and leave dead cells.

#### The decks

One at a time, picked by a segmented control in the deck bar, persisted
in `cctrace-ctx-mode` and addressable as `#/context/<key>/=<deck>` (the
`=` marker keeps a deck name from ever being mistaken for a thread key).
Each deck's own controls sit on the right of the same bar; a hint line
under it says what the reader is looking at. Counts caption the thing
they count — `216` on stream, `83` on events — instead of a strip of
orphan chips under the head. "Turns" is overloaded on this page (the
thread label counts MESSAGE turns, the addresses count WORKING LOOPS), so
both are named in full rather than guessed at.

**1. window** — the pinned step's context, decomposed as an icicle (see
below) with its pane underneath. It carries no head of its own: the
margin beside it already names the step, its estimate, its billed prompt
and both links. The one thing the old head said that the margin does not
— *decomposed from the captured request body, exact, not reconstructed* —
is the deck hint, because that is the sentence separating this page from
a harness-log reconstruction.

**2. stream** — the thread as one linear stream of RECORDS
(`trajectoryRecords`), sliced to the brushed range. This is the whole of
what shipped as the Trajectory tab in 0.44, and the form is unchanged:
every record is a row, in spine order, with the context the harness
injected **inline at the moment it entered the window**. Two panes, the
requests grammar (list | inspector).

The range is a SLICE, not a membership test — from the first record
attributed to the range's first step to the last attributed to its last
(`tjRangeBounds`, computed over the full record list so the slice means
the same thing at every detail level). It has to be: most of a long
spine has no wire pair of its own, because the history arrived inside
request bodies whose own requests were never captured (or live in a
prior trace). Measured on a real 26-step thread, a pairId membership
test dropped 47 rows out of 417 and read as broken; the slice drops 409.
Two record kinds got a wire pair out of this: a user/injection turn is
now attributed to the request that CARRIED it into the window (`addr[v]
.pair` in trajectoryRecords), the same request its Context-pane
provenance already names, so its `wire →` link resolves too.

**3. events** — what changed the window, newest first, scoped to the
range, with the kind chips (inject / compact / model / tools / system) in
the deck bar. Each row: glyph, kind, label (producer for injections —
AGENTS.md, environment context, recap, the reminder's own opening
words), then the token delta (+amber = grew, −green = reclaimed) *beside
the label*, because the delta is what the event did to the window
(content); ×N, the turn·step link and the wall-clock hold the right edge
(transport). Capped at 200 rows with an honest "+N older" line.

### The record stream, in detail

Borrowed from the DeepSeek Harness web UI's **Trajectory** tab, studied
live (`dsh web`, not just the source — the form is the point). dsh reads
a whole session as a dense record-level table: every record is a row —
system prompt, the human's turns, the CONTEXT the harness injected
(inline, first-class, at the moment it entered), the model's thinking,
each tool call fused with its result, the reply — kind-badged, in order.

The move cctrace was missing: **context injections as first-class inline
rows woven into the reasoning flow.** The Sessions convo reads the
conversation but folds tools and renders injections as sys-tagged user
turns; the window deck reads one request's context as a composition.
Neither shows the agent's path as a stream where you watch context
*enter* the window inline with the reasoning that consumed it.

cctrace's structural advantage over dsh's harness-event-log
reconstruction: this is built from the reconstructed spine
(`buildSession`'s `t.turns`), so it is exact and every record carries its
wire pair.

`trajectoryRecords(thread)` — pure, unit-tested, inlined into the page
like session.ts. It walks `t.turns` and emits one record per block, in
order. Record kinds mirror `CTX_CATS`, as a linear stream:

| kind | what | how |
| --- | --- | --- |
| system | the system prompt | one record, blocks in the inspector |
| user | the human's own words | user-turn text that `ctxTextCat` says is `user` |
| context | harness-injected context | user-turn text that `ctxTextCat` says is `inject`, labeled by producer (`ctxInjectLabel`) — inline, at its position |
| assistant | the model's thinking / reply | assistant text (`think:false`) and thinking (`think:true`) |
| tool | a tool call fused with its result | a `tool_use`, `detail` = the `tool_result` preview, `err` = the result's `is_error` |

A record: `{ kind, think, ord, step, label, detail, tokens, pairId, err,
block, result, toolName }`. Turn/step addressing (`ord`, `step`) matches
the Sessions outline and the rest of this page (`loopTurns`), so
"turn 04 · step 2" means the same thing everywhere. `toolResultsOnly`
turns never become their own records — their results are fused into the
`tool` record via the tool_use id (`buildToolResultIndex`), the same
fusion the convo pane does.

The `user`/`context` split is the one that carries the whole reading: the
same measured rule as the composition (`ctxTextCat` — the
`<total_tokens>` budget banner and the SessionStart hook are injections,
not the human), so the CONTEXT rows are honestly the harness's and the
USER rows honestly the human's.

**Progressive disclosure** (archify's MAP → READ → FULL, studied at
tt-a1i.github.io/archify): `trajectoryAtLevel(records, level)` FILTERS,
never summarizes — a hidden record is counted (`{ records, hidden }`),
never folded into a lie. **full** = every record (default); **read** =
drop the plumbing (budget / SessionStart banners, standalone thinking),
keep system, the human, replies, tool calls and the substantive context;
**map** = the skeleton (system, the human's turns, the tool calls). The
deck bar states how many rows the level hid.

The rows: a `turn NN` sticky divider opens each working loop; each row is
`[badge] [label] [→ result] … [≈tokens]`, the badge and (for tools) the
label colored by kind, thinking dimmed, an errored tool result in red.
One row per record — the outline rule (identity per row; the amount rides
the right edge). The inspector opens the picked record with the detail
panel's own renderers (`renderSystem` / `renderBlockS` for a tool with
its result / `renderBlock`), so a tool_use/thinking/text reads exactly as
in the requests detail panel. A kind filter isolates one kind —
**context only** is the killer use: the context trajectory alone.

What is NOT borrowed: dsh's DevTools record inspector with
Payload/Result/Schema/Timing tabs — cctrace reuses its existing block
renderers instead, which already give payload+result+schema for a tool
fold.

### The icicle

The picked step as an **icicle**: rows top-down,
   width proportional to tokens, every child inside its parent's span.
   Row 0 is the focused node at full width; row 1 is the six categories in
   CTX_CATS order — *the same six the margin's ledger and balance bar
   show, in the same order and the same hues*. The graph IS that bar
   growing downward into its parts, which is why it belongs to this page
   rather than to a chart library.

   Why the flame-graph idiom and not a treemap or a sunburst: "what is
   eating my context window" is a **profiling** question, and this
   audience reads profiles natively. A treemap encodes area more honestly
   but here the LABELS are the answer (`Bash`, `Read`, `token budget`,
   `mcp · docs`) and a treemap can only whisper them on hover. A sunburst
   is the reflex this territory predicts, and it reads worse at every
   level. The rejection of the earlier nested-fold form is recorded in
   TASTE.md.

   Rules the form has to keep:
   - **Nodes wear tints** of the data color (`CX_TINT` per depth), not the
     raw hue — they carry text and `var(--text)` must stay legible on them
     in both themes. The full-strength hue is still stated, as a 2px left
     edge on every node. Full saturation stays the composition bar's job;
     it carries no text.
   - **Percentages are always of the whole request**, never of the zoom, so
     a number cannot change meaning when you drill in. The zoomed
     breadcrumb says so out loud.
   - **Slivers collapse, never vanish**: children under `minW` percent
     merge into one labeled `+N smaller` node at the end of their parent's
     span — countable, hoverable, honest. Only in a crowd (`tailMin`
     siblings), so the category row can never lose one of its six.
   - **Metrics drop before the label does.** A node clipped to `F` says
     nothing; count goes at <14% width, tokens at <10%, the label survives
     to 4%, below that the hover carries everything.
   - **A child never repeats its parent's name.** Under a node labelled
     `Bash`, `Bash → const tmp = …` spends the chart's narrowest column
     saying what the column above already said (stripped in
     `ctxFlameTree`, so both the graph and the pane get it).
   - **Red is a verdict on THIS node**, not "contains some": a 187-item
     group with three failures is not a failure (TASTE, 2026-07-20 — name
     the observed fact).
   - **Tips fly UP.** A tip dropped below a 17px row covers the rows being
     scrubbed — the same scar the threads pane carries.
   - **Keyboard reaches the labelled nodes** (`tabindex`, Enter/Space);
     slivers are reached by zooming their parent, which is what zoom is
     for. 75 labelled tab stops beats 400 unlabelled ones.

   Under the graph, the **pane**: whatever node is selected, opened. A leaf
   gives its exact bytes; a group gives its heaviest 15 items as lazy
   folds (`renderBlock` reuse, so tool_use/tool_result/thinking render
   exactly as in the detail panel), saying out loud that it is showing 15
   of N; a container gives its children ranked with weight bars, each one
   click from a zoom. Each row also names its **provenance** — the turn
   that first carried it into the window (`ctxSinceHtml` → `ctxOriginTurn`):
   "since turn 04 · step 2" for a prompt, tool result or injection (which
   entered with the NEXT request, whose reply is that step), "from turn 07"
   for a reply (which IS a step). Content-verified against the spine, never
   index-only, and among repeats (a second "continue", the same reminder
   opening two turns) the match is anchored on the request's own position
   in the spine — the window is the history up to that request, so the
   nearest occurrence counted from the window's END is the right one;
   start-anchoring sent every repeat after a compaction to its first
   occurrence in the session. A turn that matches nothing, and an envelope
   row (system, schemas) that has no turn, say nothing rather than guess. The link is a
   control: clicking it pins that step, so the overview and the icicle
   jump to where the item came from — semantica's "the path is navigable,
   not a picture", in one line. The pane sheds any column the head already states —
   under a group called "Bash", 15 rows of "tool_result | Bash → …" is one
   fact repeated 30 times. Selection defaults to the heaviest group
   (`ctxFlameDefault`), so the section opens ON the answer instead of
   asking the reader to go find it. Compact-stub steps say so instead of
   pretending.

   The lens toggle — **by size** (default) / **in order** — ranks *inside*
   a category, never the categories themselves; re-ranking row 1 would
   break the correspondence with the bar.

The margin and every deck row link BOTH ways: `wire` to the captured
pair, and `turn NN · step N →` into the sessions timeline at that turn
(`ctxTurnLink` / `window.ctxJumpTurn`, the reverse of the convo pane's
"context →"). Only for steps the outline could address — a superseded or
unattributed request has no turn to land on, and we do not invent one.

Live behavior: the view re-renders on pair arrival with every position
preserved — the margin's scroll, the deck's scroll, the stream list's
scroll and its search box's focus and caret, the overview's horizontal
scroll (which also STICKS to the newest edge when it was already there),
plus the zoom, the brushed range (clamped, never dropped, as steps
arrive under it), the granularity, the pin, the filters and the fold
state. Works identically in snapshots and `cctrace view` pages (pure
client-side).

## The trajectory gutter (the same shape, on the sessions rail)

The sessions rail is already a reading of the agent's path: its turn is
the working-loop unit and its rows already carry compaction breaks,
superseded exchanges and failed runs. What it lacked was MAGNITUDE, so it
gets a gutter (`.tctx` in ui.ts, built in `epochTurnList`):

- one 30px track per wire step, filled to how full the window was;
- the fill SPLIT: the prefix read from cache (green) vs what was billed
  fresh (amber). Stacked down the rail that column is the trajectory —
  context climbs, a ✂ row drops it, the step after a boundary is
  all-amber (cold), then green again;
- non-wire rows (the human's prompts, superseded/failed runs) get an
  invisible spacer, so the column holds and the rail's rhythm doesn't
  break;
- denominator: the model's window when models.dev knows it, else this
  thread's own peak (same anchored-prompt > window guard as the view
  above). The hover NAMES which — "context 212k · 61% of a 1m window" vs
  "… of this thread's peak". Never a bar against an unstated scale.

Every figure is provider-reported; nothing in the gutter is estimated.

dsh's Trajectory also reads the agent's path as TIME — three lanes (Input /
Model / Tools). cctrace has that too, off its own attributed pairs
(`threadTimeSplit` in src/session.ts), in three places: the context
overview's per-step **time track**, its **margin totals**, and — where
the reader is already looking at a thread's totals — a **`time` chip** on
the sessions thread header, `model 15m · tools 7m · between turns 20m`,
with the split in the hover; each assistant role bar carries its own
step's `tools`/`waiting` time beside its duration. The lanes in cctrace's
terms:
*model* is the requests' own durations; *tools* is the gap from a reply
that made tool calls to the same working loop's next request (one gap
covers calls run in parallel, so it is the STEP's tool time, never per
call); *waiting* is that gap after a reply with no tool call (the harness
came back on its own — a nudge, a loaded tool, a recap); *between turns* is
the gap before the next prompt. Failed and superseded requests are not on
the reply path — the gap spans them, they are never counted. Every figure
is a wire timestamp; nothing here is estimated either.

At trace scale the replay track tells the same story: a compaction/rewind
pair gets a distinct full-height `.rp-mark.cut` beside the per-pair ticks —
the trajectory's axis break on the timeline.

## Performance notes (what a long session costs)

Measured on a real 567-pair / 232 MB page in the headless harness: the
context route renders in ~45ms, the sessions route in ~35ms.

- `ctxData` caches per THREAD (bounded to 8, oldest evicted), not one
  slot: a trace holds many threads and switching between them must not
  re-walk every body.
- `contextGraph` results ride a 12-entry LRU keyed by pairId. Scrubbing
  the history chart walks a different body per bar; a one-slot cache
  re-walked the same bodies on every pass back.
- The graph pane repaints on a 90ms settle while the detail strip follows
  the pointer instantly.
- `pairOf(id)` is the page-wide pairId index. The session and context
  layers resolve pair ids inside per-turn loops, where `pairs.find()` is
  O(turns × pairs); the index is rebuilt only when the capture grows.
- `ctxThreadStat` (the picker's peaks) reads `extractCallInfo`'s per-pair
  memo and never walks a composition, so the strip stays affordable for
  every thread in the trace.

## Honesty rules (inherited from ui.md, applied here)

- `≈` on every estimate; the provider-reported number beside it whenever
  the wire has one.
- No window % without a known window.
- A compact-folded stub renders as "composition unavailable" + its real
  usage — never a guessed bar split (the bar is a single neutral segment).
- Failed requests keep their bar (the request was sent; that is wire
  truth) with a dashed red outline and no fake usage.
- Unlabeled history drops still get a ✂ (the drop is real) without
  claiming a mode the session layer didn't verify.

## Not done / follow-ups

- Per-item wire timestamps in the graph (dsh shows them; our items could
  carry the producing request's time via attribution — needs a
  turn-index → pair map walk). PARTLY DONE: the pane rows now carry
  provenance (`since turn NN`), which resolves the item's origin turn to a
  wire request; the exact per-item timestamp is one `pairOf` away from
  there.
- Skill/MCP loads as first-class inject events (today they're visible as
  tool results in the graph; the event list only carries text-block
  injections).
- prune-style shrink detection (Claude Code microcompaction rewrites old
  tool_results in place — detectable as same-index content shrink between
  consecutive requests).
- The thread strip compares PEAKS. A per-thread sparkline (the shape, not
  just the maximum) would say more, but it needs a timeline per thread —
  affordable only if the walk is made incremental first.
- Cross-thread graph diff ("what does this session carry that the other
  doesn't") — the data is there; the question is whether anyone asks it.
- The graph's zoom and selection are page state, not URL state: you cannot
  link someone to "the Bash node of turn 37". The route grammar has room
  (`#/context/<key>/=<deck>/<node>`) but nobody has asked yet. The DECK is
  in the URL as of the rebuild; the pin and the brushed range are not.
- The overview's x axis is ORDINAL (one column per step), not TIME. A real
  time axis is what DevTools has and what would make idle gaps visible;
  it is also what turns a 9-hour session with two 3-hour gaps into a chart
  of mostly nothing. Wanted: a toggle, not a replacement.
- The time track carries model/tools/waiting per step but the RANGE does
  not aggregate them ("this brushed span cost 4m of tools"). The data is
  right there in `ctxColTime`.
- Keyboard j/k over the stream deck's record list (today click-only; the
  requests list has j/k, the pattern is there).
- Link a record to replay: click → replay cursor at that pair, so the
  stream drives the time machine cctrace already has.
- The icicle's interaction (zoom, select, keyboard), the brush (drag,
  handles, pan), wheel zoom and the deck switch are verified in a REAL
  BROWSER (`test-output/ctx-rebuild/drive*.mjs`, cloakbrowser) and at the
  layout level (tests/context.test.ts drives `ctxFlameLayout` directly);
  tests/dom-stub.ts renders markup and cannot dispatch pointer events, so
  `bun test` covers the markup grammar and the routes, not the gestures.
