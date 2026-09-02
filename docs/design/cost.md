# Cost: a reading of the Context view

Status: shipped on the Context view (`src/cost.ts` + the cost surfaces in
`src/ui.ts`). Not a fourth tab — a third track on the overview, two blocks
in the margin, one event kind in the events deck.

## Why

The Context view answers "what is the model carrying". The next question a
reader has, in the same breath, is "what is that costing me, and where did
the money go". Today's answer is one cost chip per request row in the
Requests list and one total in the header — enough to know the number,
useless for finding the spend.

What the wire actually says, measured with `temp/cost-scan.ts` over real
traces from this project's own store:

- **70-85% of a session's estimated cost is cache READS** — re-reading the
  assembled window on every step. Output is ~10%, fresh input rounds to 0%.
  One session inverted that (67% cache WRITES) and the reason was on the
  wire: 11 failed requests, each one re-writing the prefix that the failure
  never banked.
- The interesting money is in a handful of **bumps**. On a 289-call trace
  totalling ≈$87, 26 weak-cache steps carried ≈$5.46 of avoidable spend and
  ONE of them was ≈$3.07: a 5% hit on a 341k prompt, 180 seconds after a
  clean `end_turn`. Not an expiry — the cached prefix had CHANGED.
- Expiry looks different and is equally legible: in a 5m-TTL-era trace, a
  15h idle gap re-wrote the whole 285k prompt (≈$1.29 over warm), 6.4h cost
  ≈$1.15, 40 minutes ≈$0.44.
- **Quota is a wire fact too.** Claude Code polls `/api/oauth/usage` every
  ~10 minutes; the response carries `five_hour.utilization` /
  `seven_day.utilization` (or the newer `limits[]` shape) plus `resets_at`.
  A trace already holds the account's budget picture; nothing was rendering
  it outside a chip on one request row.

So the question the feature answers is not "what did this cost" (the header
already says that) but **"where does the quota go, and which steps paid
twice"**.

## The data rules (src/cost.ts)

Four pure functions, inlined into the page like `context.ts`:

- `stepCost(pair)` — one request's bill by component
  (`{total, input, output, cacheRead, cacheWrite, model}`), via
  `extractCallInfo` + `pairCost`, so OpenAI-dialect pairs price through the
  same path. Memoized on the pair as `_sc` beside `_ci`. **Null when the
  model has no catalog price** — an unpriced model says nothing, never $0.
- `threadCostSplit(threadPairs)` — the thread's totals, `byPair` (the
  overview's cost track reads this) and `byModel`, plus `steps` and
  `unpriced` counted separately.
- `costEvents(threadPairs, timelineEvents)` — the bumps.
- `usagePolls(pairs)` — the quota polls of the WHOLE trace, oldest first.

### What counts as a bump

A priced step whose cache hit is under 90% (or cold), that has a previous
request in the thread, and that re-billed tokens (`input + cacheWrite > 0`).
Two guards keep it honest:

- **A conversation's first request is a start, not a bump.** Nothing was
  warm; paying input rate is the price of the first prompt.
- **A thread that never used the cache has no bumps at all.** `banked`
  tracks whether ANY earlier request read or wrote the cache. It is a
  thread-level flag on purpose: the retry case is exactly a run of failed
  requests standing between the warm prefix and the re-write.

### Cause precedence

Each cause is a wire fact, taken in order — the first that fits wins:

1. **retry** — the previous request failed (no response, status ≥ 400, an
   error body) or was cut off before it completed (`truncated`, or a stream
   that never reached a `stop_reason`; for the OpenAI dialect, no
   `response.completed`). A request that dies does not bank its cache
   write, so the next one buys the prefix again. Carries `prevStatus`.
2. **expired** — the gap from the previous request's END
   (`request.timestamp + duration`) to this request's start exceeded that
   write's TTL: **1h when it wrote any 1h tokens, else 5m** — and a pure
   read refreshes 5m, so a read-only predecessor is a 5m clock. Carries
   `gap` (seconds) and `ttl`.
3. **invalidated** — otherwise: the prefix changed. When `contextTimeline`
   holds a `system` / `tools` / `compact` / `model` event on the SAME step,
   `causeKind` names it ("tool schemas changed"); otherwise `causeKind` is
   null and the view says **"cause not on the wire"** rather than guessing.

### The warm counterfactual

`extra` = the re-billed tokens at their billed rate minus what the same
tokens would have cost as cache reads:

    extra = input      x (input      - cacheRead)
          + write5m    x (cacheWrite5m - cacheRead)
          + write1h    x (cacheWrite1h - cacheRead)     [per MTok, /1e6]

That is a **counterfactual**, not a bill: it is what a warm cache would have
saved, assuming the same tokens. Every surface that shows it says "over
warm" and the hover spells the assumption out.

## Truth boundary

Inherited from ui.md and docs/design/context-view.md, applied here:

- Every dollar is an ESTIMATE from catalog rates (models.dev first, the
  embedded Claude table offline) and renders with a `≈` prefix. The rates
  a pair is billed at come from ONE place, `pairRates` in src/pricing.ts:
  the model's price, then the modifiers the wire states for that request
  — fast mode when the response's `usage.speed` is `"fast"` (Opus 5 /
  Opus 4.8: every rate doubles, cache multipliers on top), US-only
  inference when the request carries `inference_geo: "us"` (1.1x on every
  class). A modified pair names its modifiers in the cost tooltip
  ("estimated (fast mode): …"). The bump arithmetic prices against the
  same rates, so a bump under fast mode is a fast-mode bump. Cache reads
  are 0.1x input except Fable 5.1 / Mythos 5.1 (0.025x); long context on
  Claude 4.6+ is standard-rate, so no tier is ever applied.
- Every CAUSE is a wire fact: a gap against a TTL, a status code, a
  same-step timeline event. No cause is inferred from prose or shape.
- Unknown pricing renders NOTHING — no track, no block, no $0.
- No `Date.now()` in a render. Reset times are absolute wall-clock
  (`resets 10:59`), never a countdown: a rendered page must not go stale,
  and a ticking clock is motion this UI does not spend.
- The quota block reports what the CLIENT polled, at the time it polled it,
  and says so in its footer. cctrace never asks the API anything.

## The surfaces

- **Overview, third track** (`cx-cost`): one column per overview column
  (step or turn granularity, same `cols` the other two tracks use), stacked
  cache read / cache write / input / output bottom-up, scaled against the
  thread's dearest column THAT IS NOT A BUMP, floor `max(2px, …)`. The
  gutter states that top of scale (`≈$0.42 · cost`). A bump is an outlier
  by definition — on the real trace one $6.85 step over 262 at ~$0.20 — and
  scaling to it flattened every other column to the floor, which erased the
  trend the track exists to show (seen in Chrome, 2026-08-28). A bump column
  clips at full height instead: it already wears the amber `$` mark the way
  a compaction wears `✂` (positioned absolutely so the mark never shortens
  the bar), and its tooltip states the real figure and that it is off
  scale. When every priced column is a bump there is nothing to clip
  against and the scale is the plain maximum. Brush, hover-scrub, click-pin
  and dimming work exactly as on the other tracks (same `data-cxbar` /
  `data-cxc` / `.out`).
- **Colors**: four variables in both themes — `--cost-read`, `--cost-write`,
  `--cost-input`, `--cost-output`. A cool-to-hot RAMP, not six categorical
  hues: the cost track must not read as a second composition track, and the
  ordering (cheap → expensive) is the reading. `--green` / `--red` stay
  reserved for state.
- **Margin: "where the money went"** (`renderCtxCostBlock`) — the same lane
  grammar as "where the time went": a 4-segment bar, a key naming each
  component with `≈$` and %, per-model lines when a thread used more than
  one, and the bumps line ("3 cost bumps · ≈$3.3 over warm") which is a
  CONTROL: it opens the events deck filtered to `cost`. `N steps unpriced`
  when some model had no rate.
- **Margin: "quota"** (`renderCtxQuotaBlock`) — the latest poll: one row per
  limit (5h / 7d / model-scoped) with a percent bar, `N%` and `resets HH:MM`;
  a credits row when the account has extra usage enabled; the movement line
  (`5h 12% → 37% over this trace`) when the trace holds two or more polls.
  It belongs to the TRACE, so it sits outside `#cx-bal` and does not repaint
  on a scrub.
- **The balance's "this step"** — `≈$0.42 this step · 97% from cache`, the
  bill and the cache share in one line, repainted on every scrub. The old
  bare `97% cached` chip stays only when the step is unpriced, so the
  percentage is still stated exactly once.
- **The range caption** — a brushed span adds `· ≈$12.40`. The balance
  deliberately stays with the pinned step, so the span's own number is the
  one thing a range owes.
- **Events deck** — cost events flow into the same list, sorted by time,
  scoped by the range, rolled up by adjacent same-kind+cause runs like every
  other kind, with a `cost` kind chip. The row's delta slot carries DOLLARS
  (`≈+$1.29`), because the amount is what the reader is hunting; the hover
  states the counterfactual in tokens.

## What was rejected

- **A fourth tab.** The 0.45 rebuild retired the Trajectory tab for exactly
  this reason: cost is a READING of a thread, not a second thread. It rides
  the selection the overview already owns.
- **A $ figure on unpriced models.** `pairCost` returning null means the
  catalog does not know the model. Rendering $0 there is a lie the reader
  cannot detect; rendering nothing is the honest degrade.
- **A ticking quota clock** ("resets in 42:10"). Deadlines render absolute
  (ui.md), and a countdown would make every saved snapshot wrong the moment
  it is opened.
- **A cost bump on the first request.** It was tried and it flagged every
  session's opening step, which is the one step that CANNOT be warm.
- **Cost as a second composition track** (six category hues). The ramp is
  what makes the two tracks readable stacked on one axis.

## Follow-ups

- Cross-run cost trends on `/dashboard`: the tombstones already carry
  per-run stats (`TraceStats`), so cost by day / by project is a group-by
  away — it is the only view that can answer "what did this week cost".
- Codex / grok / kimi / opencode have **no quota signal on the wire** —
  their plans are metered server-side with nothing polled back. The block
  renders nothing for them, which is correct but silent; if any of them
  starts reporting, one `usagePolls` shape lands it.
- The bump list does not aggregate by CAUSE ("expiry cost you ≈$4 this
  session, prefix changes ≈$9"). The data is in `costEvents`; the question
  is whether the margin can carry a fourth block without becoming a report.
- Cache-write TTL is inferred from the tokens the response reported, not
  from `cache_control` on the request. They agree in every trace observed,
  but the request is the more direct fact.
