# Goal: Multi-client tracing as plugins

Status: goal brief (contract for the implementation loop)
Decided: 2026-07-14 — evidence and rejected alternatives in
`docs/devlog/2026-07-14-multi-client-plugin-design.org`

## Problem

cctrace 0.13.0 captures codex and grok cleanly but treats them as
foreigners: ~95% of their non-model traffic lands in External (unpurgeable,
unreadable), the Session view is empty (buildSession only ingests Anthropic
`messages[]` bodies), and there is no session-id continuity or usage/cost
for OpenAI-shaped calls. Every future client would bolt on more special
cases in core files.

## Outcome

Codex and grok are first-class: categorized, session-reconstructed, priced.
Adding client #4 is one plugin file + a registry entry, zero core edits.

Observable, on the two example traces (kept locally, never committed):

- `temp-example-grok-trace/.cctrace/trace-2026-07-14T16-16-24.jsonl`
  (909 pairs): External drops from ~860 pairs to <10 (registry.npmjs.org
  only); mixpanel + `grok.com/_data/v1/events` + `/v1/traces` → telemetry,
  `auth.x.ai` → oauth, `/v1/billing` → usage. Session view shows the main
  conversation with turns, tool folds, and per-turn usage; parallel
  conversations split by `x-grok-conv-id`; `recap-*` convs classify utility.
- `temp-example-codex-trace/.cctrace/trace-2026-07-14T16-16-40.jsonl`
  (275 pairs): External drops to ~10 (github/npm/pypi/oaiusercontent);
  plugins/models → bootstrap, `ps/mcp` + connectors → mcp, `wham/*` → usage,
  analytics-events + `ab.chatgpt.com` → telemetry, `auth.openai.com` →
  oauth. Session view shows 2 threads keyed by the `session-id` header;
  prewarm calls (`request_kind` in `x-codex-turn-metadata`) classify utility.
- Model calls for both show in/out/cacheRead/thinking chips
  (`cached_tokens`, `cache_write_tokens`, `reasoning_tokens` mapped) and a
  cost estimate resolved from the models.dev catalog (gpt-5.x, grok-4.5).
- The header session-id chip populates and cross-run continuity
  (`history.ts`) works for codex/grok, keyed on their wire session ids.

## Scope

**In:**
- `src/clients.ts` → `src/clients/` plugin dir (`types.ts`, `index.ts`,
  `claude.ts`, `codex.ts`, `grok.ts`); `ClientPlugin` = discovery (as
  today) + declarative `wire` table (dialect, firstPartyHosts,
  hostCategories pins, sessionHeader, threadHeader). JSON-safe data only.
- `src/categorize.ts`: client-scoped categorization (shape-first rule
  unchanged → client host pins → first-party keyword taxonomy → External);
  call sites in `src/ui.ts` and `src/storage.ts` plumb `pair.client` + the
  embedded wire table.
- `src/dialects/openai.ts` (new): pure inlined-safe normalizers —
  `response.completed` parsing (delta-assembly fallback), `input[]` →
  existing turn/block model, usage mapping, session/thread id extraction.
- `src/session.ts` / `src/summarize.ts`: dialect dispatch feeding the
  EXISTING core (one `buildSession` entry; spine model unchanged).
- `src/pricing-catalog.ts` (new): models.dev API fetch, 24h-TTL fail-soft
  cache in the data dir (version.ts pattern), filtered catalog injected as
  `META.pricing`; `pairCost` consults it first, embedded table = fallback.
- Tests: sanitized synthetic fixtures mimicking the real shapes (never raw
  trace content). Docs: CLAUDE.md, docs/design/ui.md, skills/cctrace/SKILL.md.

**Out (do NOT):
- No new category ids — the existing 9 (messages…other) are the taxonomy.
- No WebSocket relay work, no OpenAI subagent/dispatch linking (no known
  wire marker — threads list as separate chats; deferred explicitly).
- No changes to capture modes, mitm/proxy internals, instance registry,
  replay engine, or CLI grammar.
- No committing real traces, hostnames of private relays, or session ids.

**Frozen:**
- The `toString()` inlining pattern: plugins contribute DATA (embedded like
  `META`) and pure functions (inlined by name). No runtime module
  indirection in the page; never `--minify`.
- On-disk `TracePair` schema: additive only (`pair.client` semantics
  unchanged; absent = pre-0.13).
- Pairs without `pair.client` categorize byte-identically to today
  (regression-tested).
- CLI surface and `createServer`/`Capturer` interfaces.

## Context

- Both clients speak the OpenAI Responses dialect; the final SSE
  `response.completed` event carries the complete output + usage. Full
  evidence (header names, item vocabulary, utility markers, system-prompt
  location per client) in the 2026-07-14 devlog entry.
- Codex reasoning is encrypted → render a placeholder; grok `summary[]`
  renders as thinking.
- models.dev is the standing pricing source for ALL future models (user
  decision 2026-07-14); ccusage uses the same source.
- Repo gate is `bun test` + `make build`, not tsc (pre-existing tsc noise).

## Contract

**DONE WHEN** (per phase, each independently shippable as one PR):
1. Plugin registry exists; client-scoped categorization meets the External
   counts above on both example traces; `cctrace purge --drop telemetry`
   plan on the grok trace claims the mixpanel/events pairs.
2. `cctrace view` on both example traces renders Session threads/turns as
   described; unit tests cover the OpenAI normalizer, thread keying by
   header, utility classification, usage mapping, and sig fallback for
   header-less calls.
3. Cost chips resolve gpt-5.x/grok-4.5 from a cached models.dev catalog;
   with the cache absent and network unreachable, everything still renders
   (no cost chip, no error).

**VERIFY:**
- `bun test` green (272 existing + new), `make build` compiles.
- Regression: categorize with no `client` matches today's output on the
  existing test corpus.
- Manual: `cctrace view <each example trace>` — check thread counts
  (codex 2 by session-id; grok main + parallel convs + recap utilities),
  fold rendering, usage/cost chips, header sid chip. Report what was NOT
  manually verified.
- Snapshot parity: `view --html` of the grok trace shows the same session
  view (inlining intact — `grep -c '<script>'` sanity applies).

**STOP RULES** (halt and ask):
- If one `buildSession` entry can't cleanly host the dialect dispatch and
  the design drifts toward two parallel session builders in the page —
  stop; that's a redesign decision, not an implementation detail.
- If a wire table can't stay JSON-safe (needs regexes/functions) — stop.
- If models.dev's schema doesn't map cleanly onto per-model
  input/output/cacheRead/cacheWrite rates — stop phase 3 and report.
- Any temptation to add a category, change on-disk schema, or touch frozen
  interfaces.

**PAUSE IF:**
- A needed wire fact isn't in the example traces (e.g. codex cache-write
  billing semantics) — surface the question instead of guessing.
- models.dev is unreachable during development — build against a checked-in
  sample response, note it.

**ITERATION:** rerun the narrowest failing test after each change; inspect
actual trace pairs before adjusting a normalizer; at most 3 focused rounds
on a failing phase before reporting what's stuck. Phases land in order;
do not start phase N+1 with phase N red.

---

/goal bun test green + make build, and cctrace view on both example traces shows client-scoped categories (External <10 pairs each) and reconstructed OpenAI sessions with usage + models.dev-priced cost chips
