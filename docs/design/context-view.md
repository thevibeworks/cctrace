# The Context view

Status: shipped (0.44). The third page view (`#/context[/<key>]`, tab beside
requests/sessions): what the model's context window was assembled from,
request by request — composition, growth history, change events, and a
per-step browser.

## Why (and where the idea comes from)

The Sessions view answers "what happened in the conversation". It does not
answer "what is the model actually carrying around, and what is eating the
window" — the question you have when a session degrades, when cost climbs,
or when a compaction fires and you want to see what it reclaimed.

The design borrows deliberately from `dsh-context` (the DeepSeek Harness
context plugin, vendored for study in `reference/dsh-context/`): the context
stats board, the six-category composition bar, the per-request stacked
history chart with ✂ compaction marks, the context-events list, and the
linked context browser. What is NOT borrowed is its data problem: dsh folds
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
| inject | harness-injected context | `<system-reminder>` blocks, harness prompts (recap / tool-load / notification / reminder — `harnessPrompt`), continuation/compaction summaries, openai harness wrappers (AGENTS.md digest, environment context, mode banners) |
| assistant | model replies | assistant-turn blocks (text, thinking, tool_use) |
| toolResult | tool outputs | `tool_result` blocks (wherever they ride) |

Command wrappers (`<command-name>`…) stay **user** — they are the human's
action. Colors are data colors (fixed hex, both themes), same rule as the
request-category chips.

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
- `contextItems(pair)` — the browser's detailed walk: one item per system
  block / tool schema / content block, each with tokens, a label, and a
  REFERENCE to its source block (`b`) so full content renders lazily with
  the page's existing `renderBlock`. tool_results are labeled with the tool
  that produced them (tool_use id → name map within the request).
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
5. **context browser** — the picked step (pinned, hovered, or newest)
   opened as six collapsible category folds → item rows (label + ≈tokens)
   → full content on expand (lazy — only what's opened is rendered;
   `renderBlock` reuse, so tool_use/tool_result/thinking render exactly as
   in the detail panel). Fold state survives live re-renders (by cat id /
   cat:index). Compact-stub steps say so instead of pretending.

Live behavior: the view re-renders on pair arrival with scroll, chart
position, granularity, pin, filter, and fold state preserved. Works
identically in snapshots and `cctrace view` pages (pure client-side).

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

- Per-item wire timestamps in the browser (dsh shows them; our items could
  carry the producing request's time via attribution — needs a
  turn-index → pair map walk).
- Skill/MCP loads as first-class inject events (today they're visible as
  tool results in the browser; the event list only carries text-block
  injections).
- A per-turn context sparkline in the sessions outline.
- prune-style shrink detection (Claude Code microcompaction rewrites old
  tool_results in place — detectable as same-index content shrink between
  consecutive requests).
