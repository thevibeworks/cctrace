# cctrace

HTTP traffic tracer for Claude Code CLI. Live web UI with WebSocket streaming.

## Architecture

```
src/
├── cli.ts          # Entry point: pick capture mode, spawn Claude, log pairs
├── args.ts         # Strict CLI parsing + "--" pass-through split (pure, tested)
├── capture.ts      # Capturer abstraction — unifies mitm + base-url modes
├── mitm.ts         # TLS-intercepting proxy (captures ALL Anthropic traffic)
├── certs.ts        # Auto-generate CA + leaf cert; Anthropic host filter
├── proxy.ts        # Reverse proxy via ANTHROPIC_BASE_URL (messages only)
├── detect.ts       # ELF/Mach-O/PE magic-byte detection, bash wrapper resolve
├── interceptor.ts  # fetch() monkey-patch for node mode (legacy)
├── loader.cjs      # CJS loader for --require (legacy)
├── preload.ts      # Built to .cache/preload.cjs (legacy)
├── clients/        # Client plugins: binary discovery + declarative wire tables
│                   #   (claude/codex/grok/kimi — dialect, firstPartyHosts, category
│                   #   pins, session/thread headers; JSON-safe, embedded into
│                   #   the page as CLIENT_WIRE; adding a client = one file)
├── dialects/
│   └── openai.ts   # OpenAI adapters. Responses (codex/grok): response.completed
│                   #   parsing, input[]->turns. Chat Completions (kimi): messages[]
│                   #   ->input[] via openaiInput + a chat branch in openaiCompleted
│                   #   (chunk deltas + prompt_tokens), so both fold into the SAME
│                   #   turn/usage model; usage mapping (inlined into UI)
├── server.ts       # Bun.serve() + WebSocket relay (page lives in ui.ts)
├── history.ts      # Cross-run session continuity: find prior traces by session_id; gz-aware reads;
│                   #   newest-prior-session guess for --continue preload
├── termlog.ts      # Terminal guard: cctrace output buffers while the traced TUI owns the screen, flushes at exit
├── instances.ts    # Live-instance registry (`cctrace ps`, /api/instances, header switcher)
├── version.ts      # CCTRACE_VERSION (+ commit hash: build --define, git fallback on source runs) + daily npm update check (cached in data dir, fail-soft)
├── view.ts         # `cctrace view`: rebuild a snapshot from a saved trace (file/session-id/fragment)
├── storage.ts      # `cctrace clean|merge|compress|purge`: log-dir housekeeping (plan + apply)
├── compact.ts      # `cctrace compact`: supersede-stub messages bodies + exemplar
│                   #   retention for noise categories (-95%+, body-level only)
├── ui.ts           # The whole web UI: Requests list + detail panel + Sessions view
├── replay.ts       # Session replay timeline primitives (inlined into UI)
├── pricing.ts      # Per-pair cost: models.dev catalog first, embedded Claude
│                   #   table as the offline fallback (inlined into UI)
├── pricing-catalog.ts # models.dev api.json fetch — 24h-TTL fail-soft cache in
│                   #   the data dir, filtered to anthropic/openai/xai
├── summarize.ts    # Pure extractors: SSE usage, count_tokens, usage limits (inlined into UI)
├── session.ts      # Conversation reconstruction from wire pairs (inlined into UI)
├── html.ts         # Static HTML generator (legacy node mode only)
└── types.ts        # Shared types
```

`skills/cctrace/SKILL.md` is an agent skill teaching Claude Code agents to
drive cctrace — keep it in sync when the CLI surface or UI routes change.

## Capture modes

The CLI auto-selects, or force with `--mode <mitm|base-url|node>`.

### mitm (default for native binaries) — captures all first-party traffic

TLS-intercepting proxy with an SSL-proxying include-list — Charles' actual
model (devlog 2026-07-15). This is the only mode that sees the full
first-party picture, because Claude hardcodes some hosts (OAuth, usage,
credits) independent of `ANTHROPIC_BASE_URL`.

1. `ensureCerts()` generates a CA + leaf cert (Anthropic SANs) under
   `~/.local/share/cctrace/mitm/` (override: `--data-dir` / `CCTRACE_DATA_DIR`)
2. Front door: an http.Server answers `CONNECT` and decides scope on the
   CONNECT line, before any TLS. Include-listed hosts (`buildInterceptSet`
   in src/certs.ts: the client's `firstPartyHosts` + `hostCategories` pins
   + base-url env hosts + `--intercept-host` extras) are MITM'd — Anthropic
   hosts via the static leaf terminator, others via dynamically generated
   per-host certs signed by the same CA. Every other host is an OPAQUE
   byte-counted tunnel: no forged cert (cert-pinning tools and system-store
   readers like apt keep working), one ~100-byte meta pair per connection
   (host, bytesUp/Down, duration — the "claude touched X" audit trail).
   `--capture-external` restores MITM-everything — with external BODIES
   capped at 64KB (`EXTERNAL_BODY_CAP` in src/mitm.ts: larger request/
   response bodies become meta stubs with exact byte counts + content type,
   same shape as compact's; url/status/headers/timing/sizes stay — the
   audit trail without the 52MB tarball or token-authed gh response in the
   trace). Enrolled hosts (`--intercept-host`) always capture in full — the
   user named them. The tunnel is also the
   last resort when cert generation fails
3. The TLS terminator decrypts, forwards to the real host, tees the response
   (stream to Claude + capture in parallel), logs the pair
4. Claude trusts our CA via `NODE_EXTRA_CA_CERTS` and routes through us via
   `HTTPS_PROXY`. Its subprocesses inherit the proxy too, so they get trust
   via a combined bundle (system CAs + mitm CA — `buildCaBundle` in
   src/certs.ts) exported as `SSL_CERT_FILE` / `CURL_CA_BUNDLE` /
   `REQUESTS_CA_BUNDLE` / `NIX_SSL_CERT_FILE`; those vars *replace* the trust
   store, hence the union (issue #17). `HTTP_PROXY` stays unset — the front
   door only speaks CONNECT and would break plain-http subprocess calls

Captures `/v1/messages`, `/api/oauth/*` (incl. usage/credits), `/api/claude_cli/*`,
`/mcp-registry/*`, `/api/event_logging/*`, plus Claude Code's datadog intake
(pinned to telemetry in src/clients/claude.ts). Remote MCP servers on
arbitrary hosts tunnel by default — enroll them with `--intercept-host`.

### base-url — lightweight, messages only

Reverse proxy via `ANTHROPIC_BASE_URL`. Zero setup (no CA), but only sees
`/v1/messages` — OAuth/usage/credits use a hardcoded base URL and bypass it.

### node — legacy (npm installs only)

`node --require` injects a `globalThis.fetch` monkey-patch before Claude starts.
Only works when Claude is a Node.js script, not a native binary.

## The Capturer abstraction

`capture.ts` exposes one interface both proxy modes implement:

```typescript
interface Capturer {
  mode: "mitm" | "base-url";
  env: Record<string, string>;   // vars to inject into Claude
  flush(): Promise<void>;         // await in-flight captures before exit
  stop(): void;
  pairCount(): number;
}
```

`cli.ts` spawns Claude with `capturer.env` and doesn't care which mode it is.

## Web UI

One self-contained page (`getLiveHtml` in `ui.ts`) serves both the live view
and static snapshots (`renderSnapshot` embeds pairs as `window.__PAIRS__`).
The header identifies the run: traced client (icon + name chip — quiet
generic monograms in `CLIENT_ICONS`, not vendor logos — from
`PageMeta.client` or the newest labeled pair; absent for pre-0.13 traces),
the trace title `<project>/<trace-file>` (PageMeta.project + .traceFile —
live runs, view serves, and snapshots all name the .jsonl behind the page;
view resolves the project from the log dir's parent when it's a standard
./.cctrace) and the current session id (extracted
client-side from pairs, newest live pair wins, click to copy) — the tab
title is brand-first: `CCTrace · <client> · <project> · <sid>`. The page
opens its WebSocket origin-relative (never a baked port: behind
container/host port forwards the bound port isn't the browser's port, and a
baked URL once handed a view page another instance's live stream). The
right side is count · instance-switcher · live-dot · version · mask/theme/github:
the live status sits beside the "⇄ N more" switcher (both are
instance-level facts), and the cctrace version (+ amber update link) sits
with the page chrome in its own `#ver` mount, hover = short about text. A
mask toggle (eye glyph, persisted in localStorage `cctrace-mask`) blurs
identity values marked `data-mask` (header session id + trace title,
per-session sid labels, usage/credits chips) for screen sharing — hover any
one to reveal it; display-layer only, unrelated to capture-time redaction
(src/redact.ts). Wall-clock times render 24h
(`fmtTime`/`fmtDateTime`). The category filter bar shows only categories
the trace actually contains (a codex run never shows Count Tokens), the
active one staying visible even at zero. Live-arrived rows get one 160ms
opacity fade (the motion budget lives in docs/design/ui.md). Two views,
hash-routed:

- **Requests** (`#`, `#/p/<id>`): one row per request with inline
  human-readable chips — model, requested reasoning effort (`extractEffort`
  in src/summarize.ts, one function for every wire shape: Anthropic
  `output_config.effort` / transitional `thinking.effort` (kimi too) /
  classic `thinking.budget_tokens` / bare `thinking.type: adaptive`, OpenAI
  Responses `reasoning.effort`, Chat Completions `reasoning_effort` — the
  tooltip names the wire field; also a detail-panel param chip), in/out
  tokens, one compact prompt-cache verdict chip (`summarizeCache` in src/summarize.ts: hit = read > 0, green
  only when ≥90% of the prompt came from cache — a weaker hit is amber, most
  of the context was re-billed at full input price;
  "↓read hit% ↑write" with a 1h-TTL breakdown since 1h bills 2x; cold =
  write only, amber; miss = cache_control set but nothing read/written;
  no chip when caching isn't used — tooltips spell the numbers out),
  estimated cost (src/pricing.ts: the models.dev catalog — refreshed by
  src/pricing-catalog.ts into <data-dir>/pricing.json, injected as
  META.pricing/window.__PRICING__ — resolves any model incl. gpt-5.x and
  grok-4.5 by exact id, date-strip, then trailing-segment fallback
  (gpt-5.6-sol -> gpt-5.6); the embedded Claude table stays as the offline
  fallback. Anthropic cache multipliers: 0.1x read, 1.25x 5m write, 2x 1h
  write, no-TTL writes assumed 5m same as ccusage; a catalog entry without
  a cache rate means the provider doesn't bill it), first-token delay
  (ttft chip: `firstTokenMs` on the pair, stamped live by the proxy pump in
  src/stream.ts when the first token event passes through — SSE events
  carry no timestamps, so it can't be derived from a saved body; the first
  body byte lands in `firstByteMs` as the fallback), count_tokens
  results, usage window percentages (5h / 7d / per-model), telemetry event
  counts, error types, a "stopped early" warn chip when the response is
  truncated (the guarded pump kept capturing the partial reply after a CLI
  abort — `resp.truncated`). Every row also has a DevTools-style size column
  (`extractSizes` in src/summarize.ts: `bodyBytes` wire counts stamped by
  the proxies at capture time — request as sent, so codex zstd shows the
  compressed size; response as received (identity encoding). Pre-0.17
  pairs fall back to an estimate from the decoded trace, tooltip says so;
  tunnel rows keep their byte-count chip instead). The detail panel adds
  prompt size, first token / first byte delay with its share of
  wall-clock, output tok/s (computed over post-first-token streaming time
  when ttft is known), and a cost tooltip broken down by component; the
  Sessions view shows per-turn and per-thread cost and ttft, plus error
  metrics aggregated per thread and per session (buildSession's usage:
  wireErrors = no response / 4xx-5xx / in-stream error events, truncated
  streams, toolErrors over toolUses for a rate — reported separately
  because they mean different failures; red chips in the convo pane, an
  "N err" badge on thread cards, a rollup line atop the threads pane).
  Clicking a
  row opens a split detail panel beside the list (no page jump);
  prev/next + `j`/`k` walk the FILTERED list; `Esc` closes. The detail
  toolbar (close/prev/next/position) is sticky, so it stays reachable
  inside megabyte conversations; the request id in that sticky bar is
  click-to-copy. Panel order is chips (identity) → Headers →
  Body → conversation: headers/body are short or collapsed folds, the
  conversation is the megabyte tail, so it renders LAST (reaching Headers no
  longer means scrolling past the whole conversation). The DevTools-style
  Headers section: General (url/method/status/host/timing/sizes — plus a
  "stopped early" row when the response is truncated) plus request/response
  headers as parsed k/v tables with a raw toggle and one-click copy. Body
  payloads stay lazy `<details>` folds, each with a mode toggle — pretty
  JSON vs as-logged raw text for bodies ("raw" is the decoded trace body
  re-serialized, not original wire bytes), raw SSE text vs parsed events for
  the stream. Every fold summary carries a quiet `copy` .fold-btn (copies the
  fold's body text — pretty JSON, full system prompt, tool input); user and
  assistant text blocks get a hover copy button. Then the conversation
  (system prompt, tools, thinking, tool_use collapsed; long texts clamp
  with a "show all" expander; streamed assistant reply reconstructed from
  SSE); usage requests render limit bars in its place. A quiet nav rail overlays the detail panel
  and the session convo (same targets both places): jump top/bottom, prev/
  next turn, prev/next user prompt, system prompt — in the session view
  also on keys `g`/`G`, `j`/`k`, `p`/`u`, `s`.
- **Sessions** (`#/session[/<sid8-or-key>[/<key>]]`): wire view +
  reconstructed conversation side by side. Threads are session-scoped
  (thread key = `<sid>|<wire key>`): when a trace holds several wire
  session ids (/clear mid-run, resumed sessions), the threads pane groups
  them into collapsible per-session sections, newest activity first
  (header: short sid click-to-copy, time range, req count, err rollup;
  `[`/`]` switch sessions; fold state survives re-renders, keyed by sid).
  A session holding exactly ONE chat absorbs the chat card into its
  header (the common case — /clear rotates the sid; clicking the header
  selects the chat, clicking again folds; the outline and agent/utility
  threads hang
  directly under). EVERY trace renders the sessions layer — a
  single-session trace is one open absorbed container (the flat
  "[chat] N turns" card said less than the session header does).
  Default focus is
  the newest session's main thread; a NEW sid appearing live follows only
  while tailing. The SELECTED conversation renders as an outline: epoch
  section heads (t0/t1, only when >1) with turns nested under — user rows
  show the prompt (`turnSnippet`: caveat/stdout wrappers skipped, a
  command-only turn previews as "/model"), assistant rows a reply snippet
  + out/duration with rewound / compact-folded / failed marks; row click
  jumps to the turn in the convo. EVERY turn row LEADS with a dot — a
  status gutter (user = hollow ring; assistant = wire verdict: green
  healthy cache hit, amber weak <90%/cold/miss, red failed) — then
  ordinal + message text, nothing else inline: all metrics live in the
  hover. Session headers open with a glyph + accent-tinted small-caps
  SESSION label (.sico/.klabel); epoch heads a branch glyph + T<n>;
  the model chip is bare (hover explains). Hover details are near-instant
  (120ms show delay so mousing across chips doesn't flicker) and
  structured — a custom page-wide .tip singleton filled from data-tip; a
  plain `title=` anywhere on the page is folded into the same panel on first
  hover (the attribute is moved to data-tip so the native tooltip never
  fires). Kind chips are neutral outlines
  (ui.md one-accent rule), red/amber reserved for state.
  `session.ts` groups model-call pairs into threads, one
  `buildSession(pairs, wire)` entry for BOTH wire dialects (`wireDialect`
  dispatches per pair). Anthropic: by the `x-claude-code-agent-id` header
  when present (cc ≥ ~2.1.2xx stamps every sidechain request with it —
  exact grouping), else by a signature of the first message's USER text
  (`firstUserText` skips the injected `<system-reminder>` context block —
  Claude Code prepends the same claudeMd/hook reminder to EVERY thread's
  first message, so hashing raw content collapses main + all subagents into
  one thread; that was a real bug). OpenAI Responses (codex/grok,
  `src/dialects/openai.ts`): by the wire conv header named in the client's
  wire table (codex `thread-id`, grok `x-grok-conv-id` — grok's parallel
  conversations split cleanly), sig fallback for header-less calls;
  `input[]` items normalize into the same turn/block model (message->text,
  function_call/custom_tool_call->tool_use, `*_output`->tool_result,
  reasoning->thinking — grok summaries readable, codex encrypted -> a
  placeholder), the final SSE `response.completed` event carries the whole
  output + usage (OpenAI input_tokens includes cache, peeled off to match
  the chips' convention; reasoning_tokens -> thinking), and codex
  `request_kind:"prewarm"` probes / grok `recap-*` convs classify as
  utility. OpenAI Chat Completions (kimi,
  `api.kimi.com/coding/v1/chat/completions`, 2026-07-20) is a THIRD wire
  sub-shape adapted INTO the Responses model rather than a third dialect:
  `openaiInput(req)` maps `messages[]` -> the same input items (system/user
  message, `reasoning_content`->reasoning, `tool_calls`->function_call, a
  `tool` role msg->function_call_output) and a branch in `openaiCompleted`
  assembles the streamed `chat.completion.chunk` deltas (content, reasoning,
  index-buffered tool_calls) + `usage` {prompt_tokens/completion_tokens/
  prompt_tokens_details.cached_tokens} into the same {output,usage} object —
  so openaiBlocks / normalizeOpenaiTurns / extractOpenaiInfo / attribution /
  compaction stay identical and `wireDialect` stays two-valued (callers read
  the conversation via `openaiInput`, never `req.input`). Chat Completions
  has no conversation HEADER (x-trace-id is per-request) — kimi threads
  always take the first-user-text sig fallback — but K3 sends the SESSION id
  in the request BODY: `prompt_cache_key: "session_<uuid>"`, stable across
  subagent threads, auto-compaction, and `--resume` across processes
  (devlog 2026-07-20-kimi-k3-wire-facts). The wire table names it
  (`sessionBodyField`), extractSessionId reads it (bare uuid), compact
  stubs preserve it — session identity, never a thread key (subagents
  share it). Kimi auto-compaction repacks at msgs=4: the original first
  user message with LATER user text merged in (NOT verbatim — the sig
  fallback splits here) + the working summary re-sent as a USER message
  ("The conversation so far has been compacted..."). Reunification for
  openai threads is marker-gated on that summary preamble (structural
  signals alone could false-claim a tail subagent — same sid, same system
  prompt); a marker-merged continuation appends without the 10-turn-drop
  heuristic since the repack is known, not inferred. Subagent linking has no known OpenAI wire marker yet — those
  threads list as separate chats. Subagent threads link to the Task/Agent tool_use that spawned them
  by prompt (the dispatch prompt lands verbatim as the first user text) and
  are classified `agent` even unlinked via wire markers (agent-id header,
  `cc_is_subagent=true` billing block, Agent-SDK system prompt) so they
  never compete with the main chat. Turns rebuild from each thread's longest
  request + its response; per-turn usage/duration attributes to the wire
  request that produced it — index-first (index = the request's history
  length), content-verified against the pair's assembled response
  (turnContentSig, capped compare), content-scan on mismatch (Claude Code
  repacks history with ephemeral notice turns, so indices drift).
  /compact REPACKS history (shorter + rewritten: tool_use turns become
  text, a recent tail survives verbatim) — two consequences handled in
  buildSession (2026-07-20): requests FOLLOWING the spine merge in via a
  context-verified anchor (deepest post-compact turn still in the spine,
  2 aligned neighbors — boilerplate sigs collide) so post-compact turns
  append at their timeline position instead of vanishing + flagging; and
  a 10+ turn drop below the running max marks the repack (notice wobbles
  are 1-3), gating supersession claims — a pre-compact pair judged
  against a post-compact spine classifies unattributed, never
  superseded. A FULL /compact goes further: message[0] becomes the
  continuation summary, which mints a new sig — that thread REUNIFIES
  into the same session's deepest-history conversation started before
  it (the summary even quotes old Task dispatch prompts, which
  false-claimed it as a subagent), and with no verbatim overlap the
  whole post-compact packing appends at the timeline tail (the summary
  turn is a real event). Reunification is STRUCTURAL, not string-gated
  (round 11): same real sid + same system identity block (first
  non-billing system block — subagents/utilities differ) + smaller
  start + a parent quiet forever; the harness preamble text ("This
  session is being continued...") is one extra vote, so a reworded or
  customized harness degrades gracefully. A history drop is NOT always a
  compaction (2026-07-22): a /rewind truncates and regrows on a new
  branch. The discriminator is index geometry — a fold's surviving tail
  aligns at SHIFTED indices (the history above it shrank into a
  summary), a rewind's shared content is a same-index PREFIX; and with
  no anchor at all, a same-sig thread that was never reunified can't be
  a real compact (every observed compact shape rewrites msg[0] and
  splits the sig — merged continuation requests are stamped `_cont`).
  The degenerate msg[0]-to-msg[0] anchor with zero verified context is
  rejected outright: msg[0]'s sig is the injected <system-reminder>
  prefix, identical for every request, and it once claimed a
  rewind-to-start as a fold. Every boundary is DISPLAYED (t.compactions,
  modes fold/rewrite/rewind): a break node + "compacted · N → M turns"
  (or "rewound") row on the rail, a dashed divider in the convo, hover =
  the context collapse in turns and tokens + what happened, click = the
  first post-boundary request; a rendered continuation-summary turn is
  tagged, never shown as user text. Pairs
  matching nothing classify prefix-divergent (internal field t.rewound)
  or UNATTRIBUTED (assistant turns without a
  pair say so quietly, never silently blank). Prefix-divergent pairs
  DISPLAY as "superseded", never "/rewind" — the detection fires equally
  for /rewind, edited messages, and ephemeral injected exchanges (the
  auto recap prompt is injected, answered, then dropped from history —
  a real false-"rewound" bug, 2026-07-20); they render grey at their
  timeline position in the outline (same ordinal as the turn that
  replaced them) and as a grey marker in the convo, wire pair linked.
  Failed requests (no response / HTTP 4xx-5xx, t.failed) never claim
  turns; they collapse into ONE row per timeline position — "21 failed
  requests · 429 engine_overloaded_error" at the exact spot the retry
  storm hit, red dot on the rail, first wire pair linked, a matching
  red-edged line in the convo — instead of 21 orphan rows dumped at the
  thread tail (a real kimi 429 storm, 2026-07-22). A thread's model is a SET
  (t.models: per-model requests/tokens/cost); the face model is the one
  with the most output tokens. The label names the conversation ("N
  turns" / "[type] description"); the model renders as its own
  right-aligned chip on the thread card ("fable-5 +4", split in the
  tooltip) — an attribute, never the identity. A /model switch opens an
  EPOCH, never a thread (`threadEpochs` in src/session.ts: contiguous
  runs of attributed turns per model): multi-epoch chats list t0/t1/t2
  rows on their card (short model + turn count, click = jump to where
  that model takes over) and the convo pane draws a quiet divider at
  each switch; every attributed assistant turn names its short model
  id. Selection emphasis is a
  faint accent wash on the session section and the thread head (no accent
  edges). tool_results fold into their tool_use by id
  (ccx convention); result-only user turns are skipped. EVERY tool_use folds
  to one line (focus hierarchy: user turns get extra space above + a faint
  accent wash on the role bar (no hard border — accent edges read as
  chrome), assistant reply text renders best-effort safe-subset markdown
  (`renderMd`: fenced/inline code, headings, bold, http(s) links —
  escaped first, so wire content can't smuggle markup), subagent
  spawns / Skill / MCP calls keep a purple title + glyph (branch / bolt /
  plug); a spawn fold shows the spawned thread's outcome inline
  ("2 turns · out 50 · $0.0035", agentThreadStats) plus the open-thread
  link, and a Skill fold names the skill in its title ("skill · ccx")
  with args as the hint; Read/Bash dumps stay quiet). Every turn's role
  bar carries the outline's ordinal (turn03 in the pane is turn03 here —
  .turn-ord). Every assistant
  turn links back to its wire request. The conversation pane
  tails like tail -f in live mode (open/refresh lands on the newest turn,
  sticky bottom, "new activity" pill when scrolled up, folds survive
  re-renders via positional restore); snapshots open at the top.
- **Replay** (inside the Sessions view): a time cursor over the same data —
  pairs whose response completed at or before the cursor are visible,
  everything after doesn't exist yet (`visibleAt` in `src/replay.ts`; the
  session rebuilds from the visible subset via the normal `buildSession`
  path). Toolbar "⏵ replay" or ←/→ enters it; ←/→ steps turns, shift+←/→
  steps wire requests, Space plays (setTimeout ladder over response-end
  boundaries, idle gaps compressed to ≤2s, speeds 1/2/8/60x), Home/End
  jump, Esc exits. The scrubber doubles as a minimap (turns = tall accent
  marks, errors red, probes short ticks). Deep links anchor on pair id —
  `#/session/<key>/@<pair-id>` opens paused at that moment (ids survive
  cross-run merges; wall-clock offsets wouldn't). Works identically in
  snapshots; live captures extend the track and "live ⤓" re-attaches the
  tail. P1+P2 shipped; P3 (--record-timing chunk replay) + P4 remain
  (docs/design/session-replay.md).
- Pure data extraction lives in `src/summarize.ts` + `src/session.ts`,
  inlined into the page via `Function.prototype.toString()` (same pattern as
  `categorize.ts`), so it is unit-testable and live/snapshot UIs cannot drift.
- UI design language and feature designs are written down in `docs/design/`
  (`ui.md` = the rules; `session-replay.md` = the replay proposal). Read
  `ui.md` before adding UI.

## Commands

```bash
cctrace                       # auto mode (mitm on native), capture everything
cctrace --mode base-url       # lightweight, messages only, no CA
cctrace --messages-only       # capture only /v1/messages
cctrace --print-ca            # print MITM CA cert path
cctrace -s                    # static mode (files only, no live UI)
cctrace -- --continue         # everything after -- goes to Claude verbatim
cctrace -- -p "explain this"  # (-p after -- is Claude's, before it cctrace's)
cctrace codex -- exec "..."   # trace the OpenAI Codex CLI instead of Claude
cctrace grok -- -p "..."      # trace the Grok CLI
cctrace kimi                  # trace the Kimi Code CLI (Moonshot AI)
```

**Client plugins** (`src/clients/`, #20): a leading client word
(`claude`|`codex`|`grok`|`kimi`) picks who gets traced; the rest of the grammar is
unchanged. Non-Claude clients always run mitm — HTTPS_PROXY + the combined
CA bundle (#17) cover their Rust/Go/native TLS stacks; `--client-path`
overrides discovery for any client. Each plugin is one self-describing
module: binary discovery + a declarative, JSON-safe `wire` table (dialect,
firstPartyHosts, host->category pins, session/thread header names) — adding
a client is one new file + a registry entry, zero core edits. The merged
tables embed into the page as `CLIENT_WIRE` data, so the plugin boundary
lives in the source tree while the page stays flat (the toString() inlining
pattern is untouched).

Their model calls are OpenAI-shaped (`.../responses`,
`.../chat/completions` — matched by path tail since custom providers mount
them under arbitrary prefixes) and categorize as Messages (`categorizeUrl`
classifies wire shape BEFORE host, issue #19 — which also puts third-party
`ANTHROPIC_BASE_URL` providers' `/v1/messages` in Messages instead of
External). The rest of a labeled client's traffic categorizes through its
wire table: host pins first (incl. third-party analytics the client calls —
mixpanel/otlp pin to telemetry so `purge --drop telemetry` sweeps them),
then unpinned first-party traffic lands in "other" (the keyword taxonomy
stays Anthropic-only), and genuinely foreign hosts (github, npm, pypi) stay
External. Unlabeled pre-0.13 pairs categorize exactly as before
(regression-tested). Session reconstruction for the OpenAI dialect is in
`src/dialects/openai.ts` (see the Sessions view above); wire session ids
come from headers — or a body field the wire table names
(`sessionBodyField`) — via `extractSessionId(pair, wire)`, so cross-run
continuity works for codex/grok/kimi too. Kimi Code's coding-plan calls are
OpenAI Chat Completions (`.../chat/completions`, matched by the same path
tail) — categorized as Messages, reconstructed via the `openaiInput` adapter
(above); its host pins (`api.kimi.com/coding/v1/{usages,models,feedback}`,
`auth.kimi.com`, `telemetry-logs.kimi.com`) sort the rest. Its session id is
the body's `prompt_cache_key` (K3+; K2.7-era traces have none and stay
per-run). Kimi coding-plan models price as ESTIMATES at the equivalent
pay-per-token rates (`CATALOG_ALIASES` in src/pricing-catalog.ts: wire
`k3` -> models.dev `moonshotai/kimi-k3` — models.dev's own kimi-for-coding
provider lists $0 subscription prices, and the cost chip estimates spend
the same way it does for Claude Max OAuth traffic).

Trace-management subcommands bypass the OPTIONS/`--` grammar (dispatched in
`cli.ts` before the strict parser). They read saved traces only — no proxy, no
Claude spawn. `clean`/`merge`/`compress`/`purge` are dry-run by default;
`--yes` applies.

```bash
cctrace view                              # no target: list traces newest-first and
                                          # pick one (TTY prompt, Enter = newest;
                                          # non-TTY prints the list and a hint)
cctrace view latest                       # reopen the newest trace directly
cctrace view <file|session-id|fragment>   # reopen a trace in the web UI: serves it
                                          # from the live web server (registers in
                                          # the instance registry, mode "view";
                                          # --port N; --serve = legacy alias)
cctrace view <target> --html              # write a snapshot .html instead (shareable,
                                          # but a big session renders 100s of MB)
cctrace clean [--yes]                     # rm regenerable .html + 0-byte traces
cctrace merge [--prune] [--yes]           # one deduped session-<id>.jsonl per session
cctrace compress [--older-than N] [--yes] # zstd archive; view reads .zst/.gz directly
cctrace purge [--drop|--keep CATS] [--yes]# drop categories (default telemetry,tokens,external)
cctrace compact [--zstd] [--yes]          # fold redundant bodies: superseded messages request
                                          # bodies -> stubs (longest per thread-epoch kept
                                          # full; session view renders identically), noise
                                          # cats -> meta-only except first/last/largest/
                                          # slowest/errors; never deletes pairs
cctrace ps [--json]                       # live instances (URL, pids, client, project, session)
cctrace --version                         # print version (+ newer version if known)
```

The `.jsonl` is the deliverable: live runs do NOT write a snapshot `.html` at
exit anymore (a 2h session produced ~400MB of HTML) — `view --html` renders
one on demand; static mode (`-s`) still writes one, that's its point. Every
captured pair is labeled with the producing client (`pair.client`, set in the
cli.ts log sink), which feeds the UI header chip/title, `ps`'s CLIENT column,
and the instance registry.

**Multi-instance**: every live run registers itself in `<data-dir>/instances/
<run-id>.json` (unique run id, port, project, session id once seen on the
wire, plus its own pid and the traced client child's `agentPid` —
informational only: pids are namespace-local and never feed liveness).
Capture runs don't delete their entry on exit — they TOMBSTONE it
(`endedAt` stamped, heartbeat stopped): the tombstones are the cross-project
run catalog (client, project path, absolute trace file, session id) behind
`cctrace view`'s "recent runs elsewhere" picker section, pruned after 30
days, re-stat'd before offering (a path from another container may not
resolve here — such runs just don't list, never error). `cctrace view`
servers still unregister (a view is not a run). User-facing listings (`ps`,
the switcher, `/api/instances`) sort project-first, newest first within —
registry scan order is arbitrary. Live entries rewrite every 30s
(heartbeat). Liveness
is NEVER judged by pid — the registry dir is often shared across pid
namespaces (containers sharing a $HOME volume + forwarded localhost ports),
where pid checks fail both ways; pre-0.10 readers even deleted other
namespaces' live entries. Instead: a heartbeat-fresh file counts as alive, a
stale one must answer a probe of `/api/self` on its port (matched by run id;
refused/mismatch ⇒ GC, timeout ⇒ hidden but kept, no heartbeat for 24h ⇒
GC), and the listing also sweeps the port walk (9317..9326) to synthesize
entries for live-but-unregistered instances straight from `/api/self`
(`src/instances.ts`). `cctrace ps` lists live runs; the server exposes
`/api/instances` (verified listing) and `/api/self` (identity, from memory —
never triggers registry reads). The web UI header grows a "⇄ N more"
switcher when other instances exist. Port allocation walks 9317, 9318, ...
before falling back to an OS-assigned port, so concurrent runs land on
predictable neighbors — the same walk the discovery sweep covers.

**Update check** (`src/version.ts`): startup reads only a local cache
(`<data-dir>/update-check.json`) — never the network — and refreshes it in
the background at most every 24h from the npm registry (3s timeout,
fail-soft), so a new release is offered on the run after it's seen. On a
TTY (and never in Claude's `-p` print mode) a newer version prompts
`upgrade now? [y/N]` (10s timeout = No); declining snoozes that version
(quiet one-line notice from then on). Accepting auto-runs `npm i -g` /
`bun add -g` only when the install method is unambiguous from
`import.meta.path`; compiled/source installs get printed instructions
instead. The UI header shows the version and an amber "vX available" link
(`PageMeta.version` / `latestVersion`). Opt out: `--no-update-check` or
`CCTRACE_NO_UPDATE_CHECK=1`.

The MITM CA / data dir is `~/.local/share/cctrace` (XDG data — the CA is
identity material; rotating it breaks any trust exported via `--print-ca`, so
it must not live where cache cleaners sweep) for every install method (source,
`bun link`, compiled binary), overridable via `--data-dir` / `CCTRACE_DATA_DIR`
(legacy `--cache-dir` / `CCTRACE_CACHE_DIR` still honored). A pre-0.6 CA found
in `~/.cache/cctrace` is moved once, preserving CA identity (`migrateCaDir` in
`src/certs.ts`).

CLI parsing lives in `src/args.ts`: argv splits at the first `--` (rest goes
to Claude untouched); cctrace's own flags parse strict, so unknown options
error with a "put it after --" hint instead of being silently swallowed.

**Bun `--` quirk**: bun's CLI (bun run / bunx / bun-link shim) eats a *leading*
`--`, so `cctrace -- --help` only works from the compiled binary. `make build`
compiles `dist/cctrace` (`bun build --compile`, never `--minify` — the UI
inlines functions via `toString()`); `make install` puts it in `~/.local/bin`.
The compiled binary uses `~/.local/share/cctrace/` instead of the repo `.cache/` and
does not support the legacy node mode (needs repo sources).

```bash
make help       # list targets
make install    # compile + install to ~/.local/bin (PREFIX overridable)
make test       # bun test
```

## Key design decisions

- **MITM default**: native Claude (>= v2.0.26) is a Bun-compiled binary;
  `node --require` can't inject. TLS interception captures everything at the
  transport layer, below URL construction.
- **Tunnel-by-default (0.16, devlog 2026-07-15)**: MITM-everything was the
  bug — a deva smoke test traced a 52MB npm tarball into mojibake, gh API
  response bodies (token-authed) landed verbatim, and any subprocess that
  takes CA trust from outside the env vars (apt, java, cert pinning) would
  hard-fail TLS. The include-list dissolves all three: only first-party +
  pinned + enrolled hosts decrypt; the rest pass through opaque with byte
  counts. Scope decides at CONNECT time (host-level) because the path is
  only visible after decryption. Per-process interception without env vars
  was investigated and ruled out — no portable unprivileged mechanism.
- **Dynamic certs for non-Anthropic hosts**: the pre-generated leaf only has
  Anthropic SANs; other hosts get a per-host cert minted on first contact
  (cached on disk), so external traffic is captured too. Blind tunnel remains
  the fallback when cert generation fails (no openssl).
- **Storage subcommands never shrink data**: `merge`/`compress` union with an
  existing `session-*.jsonl` / `.gz` instead of overwriting; `clean` verifies
  an `.html` has a source trace before calling it regenerable; every unlink
  re-stats first so a live capture appending between plan and apply is skipped,
  not truncated (`src/storage.ts`, regression-tested).
- **compact folds bodies, never deletes pairs** (`src/compact.ts`, measured
  on 4.3GB of real traces): ~79% of trace bytes are messages request bodies
  re-sending the whole conversation. Per thread-EPOCH (a history-length drop
  = compaction/clear closed an epoch) the longest request stays full; the
  rest become stubs carrying model/metadata/historyLen/firstUserText/
  keptPairId, so grouping, per-turn attribution, and continuity all still
  work (`session.ts` is stub-aware; regression: buildSession output is
  identical pre/post compact). Noise categories (telemetry/external/
  bootstrap) get exemplar retention per (host, path): first/last/largest/
  slowest/every-error keep bodies, the rest go meta-only — deterministic,
  unlike sampling. Responses are never touched (each exists once). Post-hoc
  only: capture stays lossless, the longest request isn't known until the
  session ends. Whole-pair deletion stays `purge` — a privacy tool, not a
  size optimization. Known loss (stated in --help): exact wire bytes of
  superseded requests. Same plan/apply + re-stat discipline as storage.ts.
- **Guarded pump, not `tee()`**: responses stream to Claude chunk-by-chunk while
  the same chunks accumulate for capture (`captureTee` in `src/stream.ts`).
  `ReadableStream.tee()` was abandoned: its native cancel path can crash the
  whole Bun process (`TypeError: null is not an object` in stream builtins)
  when a proxied connection drops mid-SSE, and it buffers unboundedly when one
  branch is slow. The pump guards every controller call, keeps capturing after
  a client abort (an interrupted request still logs its full response, or
  partial + `truncated: true` if upstream died), and applies real backpressure.
- **The proxy must never take down the session**: if cctrace dies, Claude's
  `HTTPS_PROXY` dies with it. Capture runs install `uncaughtException` /
  `unhandledRejection` handlers (log one line, keep serving), every proxy
  `Bun.serve` sets `idleTimeout: 0` (the 10s default would kill idle-quiet
  connections) plus an `error` hook (one failed request, no TUI spew), and
  `flush()` is capped at 5s so an abandoned capture can't hang exit.
- **accept-encoding: identity**: avoid gzip/br decompression mismatch when
  forwarding to Claude.
- **Request bodies forward as raw bytes**: codex zstd-compresses request
  JSON; the old `req.text()` decode corrupted it irreversibly (upstream
  400s). The proxies forward the untouched bytes and decode a copy for the
  trace (`decodeBodyForTrace` in src/stream.ts — undoes declared
  content-encoding, summarizes undecodable binary instead of mangling it).
- **WebSocket upgrades are refused fast (501)**: the TLS terminator has no ws
  handler; forwarding the handshake via fetch() handed clients a convincing
  101 whose frames went nowhere (codex hung ~82s/attempt until upstream's
  ping timeout, `request_kind: prewarm`). A fast refusal makes clients fall
  back to plain HTTP immediately; a real ws relay is follow-up work (#20).
- **Pair ingestion is in-process**: the CLI sink hands pairs to the live
  server via the `ingest` callback `createServer` returns, not a loopback
  POST. `/api/pair` remains only for legacy node mode's child process and
  requires the run's instance id (`x-cctrace-instance`) — the socket can be
  reachable across containers/LAN.
- **flush() before exit**: async captures must finish before the process exits,
  or pairs are lost.
- **Session continuity is viewer-side, keyed by wire session_id**: each run
  still writes its own immutable `trace-<ts>.jsonl`. Claude Code sends its
  session id in every /v1/messages request (`metadata.user_id` JSON), so when
  a live pair reveals a session_id found in a prior trace in the log dir,
  `history.ts` loads those pairs (marked `pair.prior = <file>`, deduped by
  pair id) into the server and the snapshot. Old turns then regain per-turn
  usage/duration/wire links in the Sessions view — the attribution loop in
  `session.ts` doesn't care which run a request came from. `--fresh` opts out,
  `--with FILE` force-merges. Append-to-one-file was rejected: it corrupts on
  unrelated sessions and still needs the same load-at-startup machinery.

## Testing

```bash
bun test                                # unit: proxy, certs, tunnel, abstraction
bun run tests/e2e-live.ts mitm "hi"     # e2e against real claude, all hosts
bun run tests/e2e-live.ts base-url "hi" # e2e, messages only
```

Results (incl. real captures) land in `test-output/` — gitignored. Latest run:
`test-output/SUMMARY.md`.
