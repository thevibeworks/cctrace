---
name: cctrace-insights
description: >
  Answer usage questions over the user's cctrace trace store — "how is my
  prompt caching doing this week", "where did my quota / money go", "which
  session is the heavy one", "am I getting the most out of my Claude
  subscription", "usage report for the last N days". cctrace computes the
  windowed wire facts (`cctrace insights --json`): runs/tokens/estimated
  cost by day, project, client and model, the cache read/write split, the
  heaviest sessions, and the account-quota percentages the client polled.
  This skill reads that JSON, interprets it, and writes the report with
  concrete recommendations. cctrace never reasons; this skill is the analyst.
---

# cctrace-insights — read the week's wire, say what it means

cctrace traces every request its wrapped CLIs make. `cctrace insights` folds
those traces (and the run registry) into windowed aggregates; you turn the
aggregates into an answer the user can act on.

## When to use

The user asks any windowed usage question about their traced agent work:
caching health, cost attribution, quota consumption, heaviest sessions,
subscription value, "what did my agents cost this week".

## Steps

1. **Get the data.** Two levels; pick by the question:

   ```bash
   cctrace insights --json                    # fast: registry exit stats, 7d
   cctrace insights --since 24h --scan --json # wire truth: cache/model/quota
   cctrace insights --since 7d --scan --json  # the full week off the wire
   ```

   The fast path answers "how much / which sessions" from exit-stamped run
   stats in milliseconds. `--scan` streams every in-window trace (a real 7d
   store decodes GBs; expect seconds, not minutes) and adds what only the
   wire knows: the cache read/write/uncached split with per-component
   estimated dollars, per-model and per-session weight, and every account
   quota poll (`5h`, `7d`, and model-scoped windows like `Fable`).

2. **Read the shape.** Key fields:

   - `runs.byDay / byProject / byClient` — runs, pairs, tokens, `estCostUsd`
     (from exit stats; `runs.withStats` says how many runs actually carry
     them — killed runs and pre-0.35 tombstones don't).
   - `runs.top[]` — heaviest runs, with `title` / `firstPrompt` so you can
     name them in prose.
   - `scan.usage` — window totals: `input` (uncached), `cacheRead`,
     `cacheWrite`, `output`, `thinking`, `cacheHitPct` (share of prompt
     tokens the cache served; `null` = the window never used the cache),
     and `est.*` dollars per component.
   - `scan.byDay` — the same per local day: the caching TREND.
   - `scan.byModel`, `scan.bySession` — where the tokens and dollars sit.
   - `scan.quota.windows` — per window (`5h`/`7d`/model-scoped): `min`,
     `max` (the peak), `last`, `lastResetsAt`.
   - Coverage: `tracesScanned`, `tracesMissing` (runs whose trace lives on
     another machine), `deduped`, `damagedLines`. Say so when coverage is
     partial — never present a partial scan as the whole picture.

3. **Write the report.** Short, plain, numbers first. A good shape:

   - one line of window + coverage;
   - caching: the hit share, what the reads cost vs what the same tokens
     would have cost uncached (cache reads bill at ~1/10 input rate — a
     high hit% on a big spend is the subscription working);
   - cost: byProject / byModel / top sessions, each with its ≈$;
   - quota: each window's peak and last, with the reset time;
   - 2-4 concrete recommendations (see below).

4. **Recommend from evidence, not vibes.** Patterns worth naming when the
   data shows them:

   - **Low `cacheHitPct` (< 85%) on a heavy day** — look for many short
     runs instead of continued sessions (`runs.byDay` count vs tokens):
     every fresh session rebuilds the prefix. Recommend `--continue` /
     longer-lived sessions, or check `scan.byDay` for the day the rate
     dropped and open that day's heavy session in the cctrace UI (Context
     view → cost track shows the amber bump and its wire cause).
   - **A `7d` quota window peaking near 100% while `5h` stays low** —
     work is spread thin; batching heavy work right after the weekly reset
     wastes less of the window.
   - **One session dominating `bySession`** — name it (`cctrace view
     <sid8>` opens it; suggest the Context view's "where the money went").
   - **A pricey model carrying cheap work** — `byModel` shows e.g. opus
     tokens on tasks whose sessions look like routine chores; suggest a
     smaller default for those.
   - **`tokensOut` tiny vs `tokensIn` huge** is NORMAL for agent loops
     (context re-reads); do not call it waste — the cache split says
     whether it was paid for.

## Honesty rules (cctrace's own)

- Every dollar is an ESTIMATE from models.dev catalog rates — write `≈$`.
  Subscription (Max/Pro) traffic isn't billed per token; the ≈$ states what
  the same traffic would cost at sticker price, which is exactly the
  "subscription value" number.
- Token counts and quota percentages are wire facts — state them plainly.
- `runs` totals and `scan` totals overlap (the same work, two sources) —
  never add them together.
- State coverage gaps (`tracesMissing`, `withStats` < `total`) instead of
  smoothing over them.
