# The Context view

Status: shipped (0.44). The third page view (`#/context[/<key>]`, tab beside
requests/sessions): what the model's context window was assembled from,
request by request — composition, growth history, change events, and the
per-step context GRAPH.

## Why (and where the idea comes from)

The Sessions view answers "what happened in the conversation". It does not
answer "what is the model actually carrying around, and what is eating the
window" — the question you have when a session degrades, when cost climbs,
or when a compaction fires and you want to see what it reclaimed.

The design borrows deliberately from `dsh-context` (the DeepSeek Harness
context plugin, vendored for study in `reference/dsh-context/`): the context
stats board, the six-category composition bar, the per-request stacked
history chart with ✂ compaction marks, the context-events list, and the
linked per-step decomposition (dsh's "browser"; ours is the context graph
— see below). The sibling borrow is dsh's **Trajectory** tab, which reads
an agent's path as a shape: that lands not as a fourth tab but as a gutter
on the sessions rail, which is already cctrace's trajectory (§The
trajectory gutter). What is NOT borrowed is its data problem: dsh folds
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

Route `#/context[/<sid8-or-thread-key>[/<thread-key>]]` — the key grammar
and resolution are shared with the sessions view (`resolveThreadSel`), and
so is the selection: switching tabs keeps the thread in focus. The convo
pane carries a quiet "context →" link; the context head links back
("sessions →").

Four sections, ui.md grammar (h4 sections, chips, one accent):

1. **head + stats chips** — thread identity (kind, label, model chip, sid)
   and: turns · steps · injections · compactions · reclaimed · est ·
   prompt (actual) · window.
2. **current composition** — the newest assembled request: headline
   occupancy (actual, estimate, % of window), the six-segment bar scaled
   against the window (grey = headroom), legend with per-category ≈tokens
   and %, and the top-5 tool schemas by size.
3. **context history** — one stacked column per step (or per turn —
   granularity toggle, persisted in `cctrace-ctx-gran`), height = anchored
   total, ✂ above compaction/rewind steps, dashed red outline on failed
   requests. Hover previews the detail strip AND the browser (dsh's linked
   scrub); click pins; ←/→ walk the pinned step. The chart keeps its scroll
   position across live re-renders and sticks to the newest edge when there.
4. **context events** — newest first, filter chips (inject / compact /
   model / tools / system), each row: glyph, kind, label (producer for
   injections — AGENTS.md, environment context, recap, the reminder's own
   opening words), token delta (+amber = grew, −green = reclaimed), turn ·
   step link to the wire pair, wall-clock. Capped at 200 rows with an
   honest "+N older" line.
5. **context graph** — the picked step as an **icicle**: rows top-down,
   width proportional to tokens, every child inside its parent's span.
   Row 0 is the focused node at full width; row 1 is the six categories in
   CTX_CATS order — *the same six the composition bar above shows, in the
   same order and the same hues*. The graph IS that bar growing downward
   into its parts, which is why it belongs to this page rather than to a
   chart library.

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
   click from a zoom. The pane sheds any column the head already states —
   under a group called "Bash", 15 rows of "tool_result | Bash → …" is one
   fact repeated 30 times. Selection defaults to the heaviest group
   (`ctxFlameDefault`), so the section opens ON the answer instead of
   asking the reader to go find it. Compact-stub steps say so instead of
   pretending.

   The lens toggle — **by size** (default) / **in order** — ranks *inside*
   a category, never the categories themselves; re-ranking row 1 would
   break the correspondence with the bar.

Both the detail strip and the graph head link BOTH ways: `wire` to the
captured pair, and `turn NN · step N →` into the sessions timeline at that
turn (`ctxTurnLink` / `window.ctxJumpTurn`, the reverse of the convo pane's
"context →"). Only for steps the outline could address — a superseded or
unattributed request has no turn to land on, and we do not invent one.

Live behavior: the view re-renders on pair arrival with scroll, chart
position, granularity, pin, filter, and fold state preserved. Works
identically in snapshots and `cctrace view` pages (pure client-side).

## The trajectory gutter (the Trajectory borrow)

dsh ships Trajectory as its own tab — the agent's path read as a shape.
cctrace already HAS that path: the sessions rail, whose turn is the
working-loop unit and whose rows already carry compaction breaks,
superseded exchanges and failed runs. What it lacked was MAGNITUDE. So the
borrow lands as a gutter, not a tab (`.tctx` in ui.ts, built in
`epochTurnList`):

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
  turn-index → pair map walk).
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
  (`#/context/<key>/<node>`) but nobody has asked yet.
- The icicle's interaction (zoom, select, keyboard) is verified in a real
  browser and at the layout level (tests/context.test.ts drives
  `ctxFlameLayout` directly); tests/dom-stub.ts renders markup and cannot
  dispatch clicks, so the click path itself is not covered by `bun test`.
