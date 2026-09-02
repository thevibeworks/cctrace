# cctrace Web UI

(Moved verbatim from CLAUDE.md 2026-07-30 — the behavior spec for ui.ts.
Design rules live in ui.md; read that before adding UI.)

One self-contained page (`getLiveHtml` in `ui.ts`) — a destination RAIL on
the left and a work column on the right, with three destinations:
Requests, Sessions, and Context (the agent's context window over time: an
interactive overview driving a window / stream / events deck,
docs/design/context-view.md) — serves both the live view
and static snapshots (`renderSnapshot` embeds pairs as `window.__PAIRS__`).
The rail identifies the run (0.48 — identity belongs to the navigation, not
to a strip above the content): the mark, then a RUN CARD carrying traced client (icon + name chip — quiet
generic monograms in `CLIENT_ICONS`, not vendor logos — from
`PageMeta.client` or the newest labeled pair; absent for pre-0.13 traces),
the trace title `<project>/<trace-file>` (PageMeta.project + .traceFile —
live runs, view serves, and snapshots all name the .jsonl behind the page;
view resolves the project from the cwd whose store dir it serves (or a
legacy ./.cctrace's parent, or an explicit --dir's project.json marker),
and projectPath is that repo root so tool paths relativize;
live/tail pages carry a PULSE strip (bottom of the session view, body
.pulse-on): newest model call's tool labels + age (1s tick — the one
ticking surface, terminal convention) + the newest request's cache
deadline (absolute hold-until, amber "expired" past it; the same 1s
timer re-renders the requests list once when the deadline crosses).
Boot shows a rotating loading VERB (ccx tradition, #boot-verb) until
the first render replaces it. The cache "expired" state also renders
on the detail panel's cache chip and the outline's newest-turn hover
— newest model call ONLY (later hits refresh the TTL);
clicking the title copies PageMeta.traceRelPath — absolute into the store,
project-relative for a legacy trace — ready for `cctrace view`) and the current session id (extracted
client-side from pairs, newest live pair wins, click to copy) and the live
dot (connected / offline / snapshot) — the browser tab title is
brand-first: `CCTrace · <client> · <project> · <sid>`. Under the card sit
the destinations (`Requests` / `Sessions` / `Context` / `Runs`, the last
only on served pages), each a button whose `.active` state the view
switcher drives; the work column's own header then names the destination
(`#page-title`) and carries that destination's numbers. The page
opens its WebSocket origin-relative (never a baked port: behind
container/host port forwards the bound port isn't the browser's port, and a
baked URL once handed a view page another instance's live stream). The
work header carries trace totals and the truncation chip; the rail's foot
carries the instance switcher, the version and mask/theme/github
(totals = requests · in/out tokens · est cost across the whole trace,
live-updating, breakdown in the hover — per-pair call info memoized on the
pair since extractCallInfo parses SSE):
the live status sits in the run card (it is a fact about THIS run), the
"⇄ N more" switcher and the cctrace version (+ amber update link) sit in
the rail's foot with the page chrome, in their own `#inst` / `#ver` mounts, hover = a miniature release
note (slogan + fresh-features list in renderVer — refresh it when cutting
a release). Chrome tooltips (toolbar/header/replay bar) all speak the
designed tip grammar: heading line, `---` divider, `> ` interaction hints.
In the session view the trace controls (replay, ⌘ actions) right-align via
margin-left:auto — the requests view's filter input holds that edge, so
the controls keep one position in both views. A
mask toggle (eye glyph, persisted in localStorage `cctrace-mask`) blurs
identity values marked `data-mask` (header session id + trace title,
per-session sid labels, usage/credits chips) for screen sharing — hover any
one to reveal it; display-layer only, unrelated to capture-time redaction
(src/redact.ts). What blurs is a category SET (data-mask="title|sid|usage",
body.mask-<k> classes, localStorage cctrace-mask-keys, right-click the eye
for the picker) — session ids are EXCLUDED by default (a local uuid is not
a credential; the blurred chip read worse than it protected). Served pages
(live/view/tail — never snapshots) carry an ACTIONS menu (⌘ toolbar
button, #act-wrap — trace actions live with the trace controls, not the
header): downloads (/api/snapshot.html, /api/spec.json|.md — CLI
redaction rules — a /dashboard link (the central instances page:
verified live runs + recent tombstones across every project sharing the
data dir, served identically by any instance; also linked from the
instance switcher menu — and the one page that OPERATES: stop a live run,
archive the store, see below) — and per-session dumps: /api/session.jsonl|.md?sid=…,
one row pair per sid on the page, newest first, capped at 4 — the .jsonl
is the same pair set `cctrace merge` writes (viewer-only prior/
speculative markers stripped), the .md a readable transcript
(renderTranscript in src/transcript.ts: full user text blockquoted,
full assistant text, one line per tool call with its result, thinking
and utility threads omitted, UTC times)) plus RUNNABLE housekeeping — per-category purge
(telemetry/tokens/external, live counts, the existing /api/purge path +
confirm) and compact via POST /api/compact (plan by default →
{apply:true}; planCompact/applyCompact from src/compact.ts, re-stat
discipline: a live capture appending mid-flight is skipped). merge/
compress stay terminal-only (whole-log-dir sweeps). The header totals
rollup also shows the trace file's on-disk size (traceBytes: baked into
PageMeta for exports, refreshed on every ws init/pair frame live —
config.traceSize in src/server.ts). The PULSE (0.28) grew stand-out
styling: accent wash, spinning/breathing ✻ while fresh (≤30s), a
rotating verb while in flight, 160ms fade on action change. Wall-clock times render 24h
(`fmtTime`/`fmtDateTime`). The category filter bar shows only categories
the trace actually contains (a codex run never shows Count Tokens), the
active one staying visible even at zero. Live-arrived rows get one 160ms
opacity fade (the motion budget lives in docs/design/ui.md). Three views,
hash-routed:

- **Requests** (`#`, `#/p/<id>`): one row per request. The toolbar's Select
  button enters select-to-purge (hidden on snapshots): rows grow a check
  gutter, "all shown" selects the filtered list, purge confirms then POSTs
  `/api/purge {ids}` — the server drops the pairs from memory, calls the
  CLI's onPurge to rewrite the backing .jsonl(s) (`purgePairsById` in
  src/storage.ts: atomic, archive-preserving, torn lines kept, skips files
  changed mid-flight), and broadcasts `purged` so every page removes the
  rows. A row is a RULE, not a card (0.48): 26px, one line, opening with
  the PEN — the row's own stroke on a shared scale, full-scale deflection
  30s of wall-clock, the faint head time-to-first-token and the solid tail
  the streaming that followed, inked in the category's own color, tooltip
  stating the scale and whether the row pinned at full width. Then
  method · status (a soft-ground tag, not a filled pill) · category (dot +
  label) · url. Content chips read
  left-to-right — model · effort · think · in/out · ≡cache · cost — then
  the wire transport facts sit as right-aligned COLUMNS: ↑req ↓resp sizes ·
  ttft · duration · time (the flexible gap between chips and columns is
  structural, `.sum` flex). The chip line ellipsizes as a LINE, never
  mid-token, and the columns drop in a decided order as the viewport
  narrows: bytes at 900px, clock at 820, ttft at 700, the chips at 560.
  Between two rows more than two minutes apart the list draws a hatched
  GAP band naming the wait ("1h 28m with nothing on the wire") — the same
  threshold the trajectory bar folds idle at, maintained on live arrivals
  too (`lastRowEnd`), so an hour of nothing never reads as the next line. The chips: model; requested reasoning effort
  (`extractEffort` in src/summarize.ts, one function for every wire shape:
  Anthropic `output_config.effort` / transitional `thinking.effort` (kimi
  too) / classic `thinking.budget_tokens` / bare `thinking.type: adaptive`,
  OpenAI Responses `reasoning.effort`, Chat Completions `reasoning_effort`
  — the tooltip names the wire field; also a detail-panel param chip);
  thinking tokens; in/out tokens; one compact prompt-cache verdict chip
  prefixed `≡` (the layered-cache glyph, U+2261 — slim, monospace-safe;
  `summarizeCache` in src/summarize.ts: hit = read > 0, green
  only when ≥90% of the prompt came from cache — a weaker hit is amber, most
  of the context was re-billed at full input price;
  "↓read hit% ↑write" with a 1h-TTL breakdown since 1h bills 2x; cold =
  write only, amber; miss = cache_control set but nothing read/written;
  no chip when caching isn't used — tooltips spell the numbers out. With
  the response timestamp the tooltip adds the ABSOLUTE hold-until
  wall-clock ("held until ~14:32 (1h)") — absolute so a rendered page can
  never go stale, and deliberately NOT a ticking countdown: per-request
  countdowns lie, every later hit refreshes the TTL, so only the newest
  request's deadline means anything. That newest model-call pair — and only
  it — renders "· expired" when the page is drawn past its deadline
  (opts.newest/now into summarizePair; zero timers, computed at render:
  the useful case is reopening/viewing an idle session, where it says
  "resuming now re-writes the prefix");
  estimated cost (src/pricing.ts: the models.dev catalog — refreshed by
  src/pricing-catalog.ts into <data-dir>/pricing.json, injected as
  META.pricing/window.__PRICING__ — resolves any model incl. gpt-5.x and
  grok-4.5 by exact id, date-strip, then trailing-segment fallback
  (gpt-5.6-sol -> gpt-5.6); the embedded Claude table stays as the offline
  fallback. Anthropic cache multipliers: 0.1x read, 1.25x 5m write, 2x 1h
  write, no-TTL writes assumed 5m same as ccusage; a catalog entry without
  a cache rate means the provider doesn't bill it), count_tokens
  results, usage window percentages (5h / 7d / per-model), telemetry event
  counts, error types, a "stopped early" warn chip when the response is
  truncated (the guarded pump kept capturing the partial reply after a CLI
  abort — `resp.truncated`). First-token delay is the ttft COLUMN
  (`firstTokenMs` on the pair, stamped live by the proxy pump in
  src/stream.ts when the first token event passes through — SSE events
  carry no timestamps, so it can't be derived from a saved body; the first
  body byte lands in `firstByteMs` as the detail-panel fallback). The size
  column is DevTools-style
  (`extractSizes` in src/summarize.ts: `bodyBytes` wire counts stamped by
  the proxies at capture time — request as sent, so codex zstd shows the
  compressed size; response as received (identity encoding). Pre-0.17
  pairs fall back to an estimate from the decoded trace, tooltip says so;
  tunnel rows keep their byte-count chip instead). The detail panel adds
  prompt size, first token / first byte delay with its share of
  wall-clock, output tok/s (computed over post-first-token streaming time
  when ttft is known), and a cost tooltip broken down by component; the
  Sessions view shows per-turn and per-thread cost and ttft, a `time`
  chip breaking the thread's wall-clock into model / tools / waiting /
  between-turns time read off the wire alone (dsh Trajectory's lanes via
  `threadTimeSplit`, which also feeds the context overview's per-step time
  track; each assistant role bar also carries its own step's
  tools/waiting time), plus error
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
  reconstructed conversation side by side.
  `GET /s[/<sid-prefix>]` is the printable short form (0.40): a server-side
  302 to this hash route, so a statusline chip can link straight to the
  current session's conversation — live entry lands at the newest turn —
  while the browser bar keeps the self-describing `/trace#/session/<sid8>`. Threads are session-scoped
  (thread key = `<sid>|<wire key>`): when a trace holds several wire
  session ids (/clear mid-run, resumed sessions), the threads pane groups
  them into collapsible per-session sections, newest activity first with
  the sid as tie-break — and inside a section cards order by conversation
  start time (key tie-break), never wire push order, which shuffled on
  merged multi-run traces
  (header: short sid click-to-copy, time range, req count, err rollup;
  `[`/`]` switch sessions; fold state survives re-renders, keyed by sid).
  A subagent card nests under its dispatching thread's card in an
  indented .tkids block — ALWAYS, whatever is selected (cards must never
  jump between "sibling" and "hidden" as selection moves; the outline's
  branch row marks the spawn's timeline position, the nested card is the
  thread's home). A subagent whose parent lives in another session stays
  a flat card but its meta line carries "↰ parent". The subagent's convo
  pane header (agent-note) jumps back to the PARENT AT ITS SPAWN TURN
  (jumpToParent: resolves the spawn tool_use id to a visible-turn index,
  falls back to the thread head when a cross-run merge lost the
  dispatching request).
  A session holding exactly ONE chat absorbs the chat card into its
  header (the common case — /clear rotates the sid; clicking the header
  selects the chat, clicking again folds; the outline and agent/utility
  threads hang
  directly under). EVERY trace renders the sessions layer — a
  single-session trace is one open absorbed container (the flat
  "[chat] N turns" card said less than the session header does).
  Default focus is
  the newest session's main thread; a NEW sid appearing live follows only
  while tailing. The SELECTED conversation renders as an outline whose
  TURN is the working-loop unit — user request → agent work → final
  response — NOT one wire message (`loopTurns` in src/session.ts groups
  visible message-turns; a real trace's 213 wire messages read as 3
  turns). Ordinals number loops — BARE, zero-padded, 1-BASED on the rail
  ("01"; the word "turn" repeated down the rail is noise, and 1-based
  makes the last label agree with the "N turns" counts; prose surfaces
  spell "turn 01"). Each assistant member is a STEP — one iteration of
  the agentic cycle = one wire request (loopTurns stamps steps/stepCount):
  mid rows carry a faint sub-ordinal ".2" in the ordinal cell (01 + .2
  reads 01.2), hovers say "step 2 of 4", the convo role bar gives mids
  the same "01.2" address, a step whose folded tool_result is_error wears
  a quiet red "tool err" mark (count in hover), and the final's hover
  names the wire stop_reason ("stop: end_turn"; tool_use = loop cut
  mid-work, said honestly). The continuation summary heads its turn as a
  RECAP node (sys-tag "recap", neutral dot, never the human's ❯ —
  continuationSummaryTurn in src/session.ts is the one detector shared
  with the convo's sum-tag, position-at-rewrite-boundary first, preamble
  string as fallback); a genuine user message heads the ordinal
  (prompt via `turnSnippet`: caveat/stdout wrappers skipped, a
  command-only turn previews as "/model"); the agent's intermediate
  messages indent under it (.tturn-sub/.tturn-mid — narration snippet, or
  the enriched tool label: `turnToolLabel` names files workspace-relative,
  "Edit src/ui.ts, Read src/session.ts, +2" — with a toolPreview fallback
  covering the whole Claude Code tool surface: MultiEdit, SlashCommand,
  AskUserQuestion, ExitPlanMode, BashOutput/KillShell, Workflow (meta.name
  pulled from inline scripts), TaskUpdate/Get, MCP resources; task-tracking
  TaskCreate {subject} never renders as a subagent spawn); the loop's last
  assistant message is the final response row (↳ marker, reply snippet).
  Clicking a head's ❯ gutter folds the loop's member rows under the prompt
  line ("⋯ N" count; state per thread+ordinal in foldedTurns, survives live
  re-renders; truth markers — compact/superseded/failed rows — never fold).
  Row tooltips LEAD with the full text the row truncated (user prompt,
  assistant narration, injected prompt, superseded prompt — 600-char cap),
  then the metrics; long fold hints get the same treatment (fold() puts
  hints > 60 chars in data-tip). Harness-
  authored user-ROLE messages (`harnessPrompt`, precise prefixes only)
  never read as the human: the away-recap prompt and "Tool loaded."
  absorb into the open turn wearing a small-caps SYS tag (.sys-tag in the
  outline, the sum-tag style on the convo role bar — one system-scope
  marker family with the continuation-summary tag);
  "[SYSTEM NOTIFICATION" wakeups DO head their turn (they start real
  agent work) but render as CLI-authored, not with the human's ❯ mark;
  reminder-only user messages (all text is <system-reminder> nudges —
  harnessTurnKind, since turnSnippet strips reminders to "") absorb as
  sys · reminder. Loop
  counts feed every "N turns" label (thread cards, session headers,
  spawn-fold stats) and the convo pane's role-bar ordinals (user head +
  final response carry "turn NN", intermediates none). Row click still jumps
  by message index. EVERY row LEADS with a dot — a
  status gutter (user = a ❯ prompt glyph in the accent tint — the shell's
  own "your turn" marker, and the rail line skips user heads so the rail
  spans a turn's WORK; assistant = wire verdict dot: green
  healthy cache hit, amber weak <90%/cold/miss, red failed) — then
  ordinal + message text, nothing else inline: all metrics live in the
  hover; user rows read in full text color, finals muted, mids faint.
  Every row CLOSES with the trajectory gutter (`.tctx`, the same shape
  the context overview draws, at rail scale): a 30px
  track per wire step, filled to how full the window was, the fill split
  into the prefix read from CACHE (green) and what was billed FRESH
  (amber). Stacked down the rail that column IS the thread's context
  trajectory — it climbs, a ✂ boundary row drops it, the step after is
  all-amber (cold), then green again. Non-wire rows (the human's prompts,
  superseded/failed runs) get an invisible spacer so the column holds.
  Every figure is provider-reported; the denominator is the model's
  context window when models.dev knows it, else this thread's own peak
  (same anchored-prompt > window guard as the Context view), and the
  hover NAMES which — "context 212k · 61% of a 1m window" vs "…of this
  thread's peak". The replay track carries the same story at trace scale:
  a compaction/rewind pair gets a distinct full-height `.rp-mark.cut`
  beside the per-pair ticks.
  The thread/session model chip wears the identifier color (--text-method,
  same as METHOD and tool names) and its hover carries the wire facts:
  exact model id(s), requested effort level(s), 1m-context beta when the
  anthropic-beta header says so (threadWireFacts); the sid is unbolded —
  identity, not emphasis. Subagent branch rows name the agent's model
  ("[general-purpose] map repo · opus-4-6 · 2 turns · $0.0035"). Session headers open with a glyph + accent-tinted small-caps
  SESSION label (.sico/.klabel); epoch heads a branch glyph + T<n>;
  the model chip is bare (hover explains). Hover details are near-instant
  (120ms show delay so mousing across chips doesn't flicker) and
  structured — a custom page-wide .tip singleton filled from data-tip
  (first line = heading, "---" line = hairline section divider, "> "
  prefix = faint interaction hint; the convention reads content →
  metrics → hints); a
  plain `title=` anywhere on the page is folded into the same panel on first
  hover (the attribute is moved to data-tip so the native tooltip never
  fires). Tips are capped at 320px wide; anchors inside the threads pane
  fly out to the RIGHT of the pane instead of covering the rows below,
  and a tip whose anchor a live re-render detached hides itself
  (tipDetachedGuard). The ❯ fold gutter carries its own tip naming the
  fold toggle. Kind chips are neutral outlines
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
  plug); tool fold previews name what the tool touched in workspace terms
  (`toolPreview`/`wsPath` in src/session.ts: file paths relativize to the
  workspace root — "src/ui.ts", "~/.claude/settings.json", full path only
  when outside both; `wsRelText` relativizes paths INSIDE Bash command
  text too, so the sidebar reads "$ cd .cctrace && ls" — display-layer
  only, fold bodies keep the wire text; Read shows its line window, Write
  its size, Edit flags replace-all, TodoWrite counts done. The root comes from
  META.projectPath, else `cwdFromText` reads the cwd the traced CLI stated
  on the wire — codex's <cwd> tag or Claude Code's bulleted
  " - Primary working directory:" env line, precise shapes only, scanned
  over the first 3 messages pairs since utility probes carry no env
  block); tools with a richer shape than JSON open to RICH bodies
  (richToolBody/diffHunk/escHtml in src/session.ts, inlined + unit-tested:
  Edit/MultiEdit = git-style hunks — removed block then added block,
  everything escaped; Write = all-additions; TodoWrite = a checklist with
  per-status glyphs; AskUserQuestion = questions + options; Workflow =
  its meta phase titles; ExitPlanMode renders the plan via the page's
  renderMd) with the raw input JSON one fold deeper (details.rawin);
  a spawn fold shows the spawned thread's outcome inline
  ("2 turns · out 50 · $0.0035", agentThreadStats) plus the open-thread
  link, and a Skill fold names the skill in its title ("skill · ccx")
  with args as the hint; Read/Bash dumps stay quiet). Every turn's role
  bar carries the outline's ordinal ("03" on the rail is "turn 03" here —
  .turn-ord) and its wall-clock at the right edge (.turn-time, 24h, hover =
  full date; turnTimes in ui.ts — a user turn inherits the timestamp of the
  request that carried it, and the outline's user/recap/injected hovers name
  the same moment). Every assistant
  turn links back to its wire request. The conversation pane
  tails like tail -f in live mode (open/refresh lands on the newest turn,
  sticky bottom, "new activity" pill when scrolled up); live re-renders
  PATCH per top-level node (applyConvoParts: the pane renders as a parts
  array, only nodes whose html changed are replaced, so an expanded
  final response / open fold / text selection the user is reading is
  never rebuilt by a pair landing elsewhere — thread switches and
  misaligned node counts fall back to the full innerHTML rewrite with
  positional fold restore); snapshots open at the top.
- **Context** (`#/context[/<sid8-or-key>[/<key>]][/=<deck>]`): the agent's
  context window over time — the full spec is docs/design/context-view.md
  (the idea owes dsh-context for the composition and dsh's Trajectory tab
  for the record stream, Chrome DevTools' Performance panel for the shell,
  and semantica for provenance; cctrace's edge is that every captured
  request body IS the assembled context, so every step is exact and
  anchored to that pair's provider-reported prompt tokens).
  Same key grammar and thread resolution as Sessions (`resolveThreadSel`),
  selection shared both ways (tab switches keep the thread; the convo
  chips row carries "context →", the context head "sessions →"). The
  legacy `#/trajectory[/<key>]` route lands on the stream deck and
  rewrites itself to `#/context/<key>/=stream`.

  The page is an app SHELL, not a scroll: a fixed head, then the
  OVERVIEW, then a margin beside a deck — each of the two scrolling
  itself. The OVERVIEW (`renderCtxOverview` / `wireCtxOverview`, `.cx-ov`)
  is the page's time axis and never scrolls away, because every deck
  below reads its selection. Three tracks on one x axis, under one brush:
  **ctx** (one stacked column per step — or per turn, toggle persisted in
  `cctrace-ctx-gran` — height anchored to actual prompt tokens and scaled
  to this thread's own peak, segment split from the estimate, ✂ plus a
  full-height amber axis break on compaction/rewind steps, dashed red =
  failed request whose bar shows what was SENT; it does NOT draw the
  window as a second line, because occupancy against the limit is the
  margin's balance, stated once) and **time** (that step's model duration
  then its tools/waiting gap, off `threadTimeSplit.byPair` — every figure
  a wire timestamp, floor of one PIXEL so a short step under a 2m outlier
  still reads as a baseline; totals and legend live in the margin) and
  **cost** (that step's estimated bill stacked cache read / cache write /
  input / output against the thread's dearest column, amber $ marks on
  the cache BUMPS with their wire cause — retry / expired / prefix
  changed — priced against a warm cache; "where the money went" and the
  polled account quota live in the margin; the full contract is
  docs/design/cost.md).
  Columns are equal-width and GAPLESS with the bar inside capped at 28px,
  because the brush's edges sit at `i/N` of the track and a gap would
  drift the overlay by a column across 100 steps.

  Two selections, and they mean different things. The **PIN** is one step
  (click a column, ←/→) and drives the margin's balance and the window
  deck. The **RANGE** is a brushed span (stored in step indices, so the
  granularity toggle redraws the same selection) and scopes the stream
  and the events; it never touches the balance, because a balance is a
  thing one request has. Gestures: hover scrubs the margin instantly and
  the icicle on a 90ms settle (leaving restores the pinned/newest step),
  click pins, drag brushes, the handles resize from an edge, dragging the
  window pans it, wheel zooms around the cursor (1× fit … 32×, a width
  change on a flex row so nothing re-renders), shift+wheel is left to the
  browser, `Esc` peels one layer at a time (range → zoom → the view), and
  `1`/`2`/`3` pick the decks. The caption states the range out loud
  (`23 of 88 selected · turn 04 → turn 11 · esc clears`) — a range that is
  only a rectangle is a range the reader has to infer. All of it repaints
  IN PLACE; a full re-render per pointer move would rebuild a 400k-token
  decomposition sixty times a second.

  The **margin** (`renderCtxMargin`, repainted on every scrub via
  `ctxRepaintMargin`, which swaps `#cx-bal` and leaves the time and
  threads blocks alone) is the balance: the picked step's
  provider-reported prompt at
  display scale (the one 24px number ui.md licenses), a six-segment bar
  scaled against the model's window from the models.dev catalog
  (limit.context, 1m honored via the anthropic-beta header, and a sanity
  guard drops the denominator when the anchored prompt exceeds it — a
  stale catalog must never render "100% used"), "N% of context used", and
  the RECONCILIATION — how far chars/4 reads under or over the billed
  prompt ("≈134k estimated · chars/4 reads 49% under"), or the failed /
  compact-stub reason instead. Under it the LEDGER: the six categories,
  always all six, always in CTX_CATS order, with weight, ≈tokens and % —
  the page's one LIST of those numbers (the icicle's row 1 is a chart: it
  reorders under the size lens and vanishes when you zoom), and every line
  is also a control carrying the flame's own node key
  (`data-cxnode="c:<id>"`), so clicking it zooms the graph and the line
  wears `.sel` while that zoom holds (from another deck it brings the
  window deck with it). Then "this step" (clock, output,
  cache share, `turn NN · step N →` and `wire →`), the heaviest tool
  schemas, "where the time went" (the thread's model/tools/waiting/
  between-turns totals and the legend for the overview's time track),
  and — when the trace holds more than one thread — **other
  threads**: every thread's PEAK assembled context (provider-reported),
  grouped by session, all bars on one scale, the % against each thread's
  own model window. It sits at the foot of the margin so switching sheets
  never needs a scroll. At ≤960px the margin becomes a multi-column
  band above the deck (`columns: 300px`, blocks `break-inside: avoid`).

  The **deck** is one of three readings of that selection, picked by a
  segmented control (persisted in `cctrace-ctx-mode`, addressable as
  `/=<deck>` — the `=` marker keeps a deck name from being mistaken for a
  thread key), with the deck's own controls on the right of the same bar
  and a hint line under it:

  1. **window** — the pinned step as an ICICLE: rows top-down, width =
  tokens, every child inside its parent's span; row 1 is the composition
  bar's own six categories in the same order and hues, so the graph reads
  as that bar growing downward into its parts. Grouping is the question
  each category answers: tool results by the tool that produced them,
  schemas by MCP server vs built-ins, injections by producer, the system
  prompt per block, the conversation per turn. Click a node to zoom
  (breadcrumb home; percentages stay against the whole request), a leaf to
  open its bytes in the pane below. Nodes wear depth TINTS with the full
  hue as a 2px left edge — they carry text; metrics drop before the label
  does; slivers merge into one countable "+N smaller"; red marks a leaf
  that failed, never a group that contains one; tips fly UP so they don't
  cover the rows being scrubbed; labelled nodes are keyboard-reachable.
  Under it the pane: the selected node opened — a leaf's exact bytes, or a
  group's heaviest 15 items as lazy renderBlock folds, or a container's
  children ranked, each row naming its PROVENANCE ("since turn NN · step
  N", clickable to pin that step). "by size" / "in order" lens ranks
  INSIDE a category (never the categories), persisted in
  `cctrace-ctx-sort`; compact stubs
  say "composition unavailable" + their surviving usage; the pane scrolls
  inside itself. The deck carries no head of its own — the margin beside
  it already names the step, its estimate, its billed prompt and both
  links; the one thing that head said which the margin does not,
  "decomposed from the captured request body — exact, not reconstructed",
  lives in the deck hint.

  2. **stream** — the thread as one linear stream of RECORDS
  (`trajectoryRecords`), SLICED to the brushed range (first record
  attributed to its first step through the last attributed to its last —
  a pairId membership test cannot work, because most of a long spine has
  no wire pair of its own): system, the human's
  turns, the CONTEXT the harness injected INLINE at the moment it entered
  the window, the model's thinking, each tool call fused with its result,
  the reply. Kind-badged, in spine order, `turn NN` sticky dividers, the
  amount on the right edge. One column of rows; a picked record opens in
  the INSPECTOR — the right panel every deck shares: a pick (an icicle
  node, a stream record, an event row) opens it beside the deck, × / Esc
  closes it, and inside a VERTICAL facet rail lists only what the wire can
  answer for that pick — content (the detail panel's own block renderers,
  the picked fold open), schema (the tool's declaration in the carrying
  request, with its weight and rank), origin (the step it entered with and
  the carry: how many requests re-sent it, ≈tokens × N), wire (the
  carrying request in brief, both links out). Spec:
  docs/design/context-view.md §The inspector.
  archify's MAP / READ / FULL level FILTERS and never summarizes (hidden
  rows are counted out loud, persisted in `cctrace-tj-level`), plus a kind
  filter — **context only** is the killer use, the context trajectory
  alone — and a search box. This shipped as a fourth tab in 0.44; it is a
  reading of a thread, not a second thread, so it is a deck.

  3. **events** — what changed the window, newest first, scoped to the
  range, kind chips in the deck bar (inject / compact / model / tools /
  system): producer-labeled
  injections, compactions with the actual-anchored reclaim delta, model
  switches, tool-schema/system changes, the token delta beside the LABEL
  because it is what the event did to the window, with ×N, the turn·step
  wire link and the clock holding the right edge (the outline's numbering
  via loopTurns), adjacent runs of the same kind+label rolled into one
  ×N row, capped at 200 with an honest "+N older" line.

  Counts caption the thing they count (`88 wire requests · 8 working
  loops` on the overview, `216` on stream, `83` on events) instead of an
  orphan chips row under the head, and "turns" is spelled out both ways
  because the thread label counts MESSAGE turns while the addresses count
  WORKING LOOPS. Data layer is
  src/context.ts (contextComposition/contextItems/contextGraph/
  ctxFlameLayout/contextTimeline/ctxAggregateTurns/trajectoryRecords/
  trajectoryAtLevel + CTX_CATS), pure and
  unit-tested apart from the DOM — layout is data, the view only turns
  rows into positioned spans — and inlined via
  toString like session.ts, so snapshots and view pages carry the whole
  thing offline.

- **Replay** (inside the Sessions view): a time cursor over the same data —
  pairs whose response completed at or before the cursor are visible,
  everything after doesn't exist yet (`visibleAt` in `src/replay.ts`; the
  session rebuilds from the visible subset via the normal `buildSession`
  path). Toolbar "⏵ replay" or ←/→ enters it; ←/→ steps the SELECTED
  thread's own turns (a merged capture's other sessions never eat a
  keypress), shift+←/→ steps wire requests, Space plays (setTimeout
  ladder over response-end boundaries, idle gaps compressed to ≤2s,
  speeds 1/2/8/60x), Home/End jump, Esc exits. The selection PINS for
  the whole replay (resolved against the full capture — a cursor
  before the thread's first response says "nothing on this thread's
  wire yet" instead of flipping to the fallback thread), and
  enter/⏮/Home park on the thread's own edges while ⏭/End stay the
  tape's live edge (replay-stage.md rev 5). The scrubber doubles as a minimap (turns = tall accent
  marks, errors red, probes short ticks). Deep links anchor on pair id —
  `#/session/<key>/@<pair-id>` opens paused at that moment (ids survive
  cross-run merges; wall-clock offsets wouldn't). SLICES: shift+drag on
  the track selects a range (`sliceWindow` in src/replay.ts — pairs whose
  response completed inside it, every category); while set, both panes
  rebuild from the window only, playback/stepping/scrubbing bound to it,
  the band + a chip render on the transport bar, and the deep link
  becomes `@a..b` (the window's edge pair ids by END time —
  sliceBoundPairs). The chip's "export" downloads `/api/slice.html?from=
  &to=` — a snapshot holding exactly the window's pairs (~KBs, the
  honest shareable artifact; whole-session --html pages run 100s of MB);
  `cctrace view <t> --slice a..b` is the CLI face (applySlice in
  src/view.ts), composing with --html and serve. A shift-CLICK
  (zero-width window) clears instead of filtering everything out; ✕ on
  the chip clears; Esc exits replay and the slice with it. Works
  identically in snapshots (export hidden — no server); live captures
  extend the track and the transport's live chip re-attaches the tail.
  P1+P2+slices
  shipped; P3 (--record-timing chunk replay) + P4 + P5 (diff between two
  moments — slices give it endpoints) remain
  (docs/design/session-replay.md).
- **The trajectory bar is the session view's OVERVIEW and its minimap**
  (replay-stage.md rev 3 + 4): `#replay-bar` is FRAME in the session
  view at all times — the strip draws the whole session's shape (lanes,
  clock row, idle folded, thread focus, the live open-request stub)
  without a replay running; the transport, veil, playhead and slice
  stay hidden until `body.replaying`. The bar syncs with the session's
  TURNS both ways: every rendered `.turn` carries `data-ts`, a faint
  reading marker (`#rp-read`, the playhead's quiet twin, hidden while
  replaying) tracks the topmost visible turn as the reader scrolls
  (rAF-throttled, `rpSyncRead`), and a click on the track outside
  replay jumps the conversation to the last turn at or before that
  instant (`rpJumpConvoTo`) — it does NOT enter replay; ⏵ / Space /
  arrows do. Wheel zoom works without entering. The ▾ chevron in the
  clock gutter cell folds the lanes to the ~13px clock row (persisted,
  `cctrace-traj-fold`); replay overrides the fold. A trace with no
  session pairs hides the bar (`.rp-empty`).
- **The replay stage** (docs/design/replay-stage.md — the rules live
  there): the track is `#rp-lanes`, a clock row (`#rp-axis`, ticks from
  `axisTicks` in the page's local time, a major tick dropping a rule
  through every lane) over five lanes x wall-clock (turn blocks — one
  per working loop, the prompt's instant to its last reply, numbered at
  any depth that fits, the tally on hover, lit under the conversation's
  reading position, click = its prompt — model spans, tools/waiting
  spans, agents stacked by row, harness cuts ✂ / failed ✗), built from
  `sessionLanes` over the FULL threads (not the
  cursored ones) and positioned with the same `(t - t0)/dur` math the
  marks used; playhead, veil and slice span every lane. The rail's
  selected thread draws full and every other thread's items carry
  `.other` (~30%); `#rp-veil` dims everything RIGHT of the playhead — a
  replay never shows what has not happened. Wheel zooms around the cursor
  (1x-32x, the same helper the context overview uses) and sets
  `data-depth` map/read/full; while replaying, click seeks to that
  pair's END (the boundary where it became visible). The loop-row
  flowchart that sat between the strip and the transport was removed in
  rev 4 (Eric, after real use) — the state at any moment is read off
  the strip, the beat and the conversation.
  The strip's axis is the selected thread's own extent
  (`threadExtent`), idle gaps ≥ 2 min folded to 28px hatched `rp-break`
  columns labelled `⧸⧸ <skipped>` in the clock row — waiting gaps
  stretch the extent but are NOT busy, so a long harness-wait folds
  like idle (replay-stage.md rev 5) (`timeScale` /
  `scaleX` / `scaleT` — the ONE x<->t mapping every strip surface uses:
  spans, ticks, veil, playhead, slice, drag, wheel zoom); the transport's
  clock and length stay real wall-clock.
  `#stage` sits at the top of `#threads` above the rail, two blocks: the
  beat from `beatAt` (caption, the loop's head, tool rows fused with
  results via the detail panel's own renderers, spawn rows, reply line,
  stated reasoning, window delta) and `.st-sofar` from `soFar` (the call
  tally as of the cursor — the only place the per-tool count is stated).
  `[`/`]` walk `chaptersOf`; `F` toggles `body.present` (chrome hidden,
  type scale unchanged); Esc peels present -> replay -> view. Open
  `start`s (below) draw as a dashed model span to the newest known
  time — never a ticking clock.
- **Replay TAILS a live run.** The transport is
  `[⏮][▶][⏭] 1x 2x 8x 60x  <local clock> · +<offset> / <length>  [live]
  [✕ exit]`. `⏭` / `End` seek the end of the tape — on a live page the
  live edge. A `pair` frame measures `wasAtEdge` (cursor >=
  `replaySpan(pairs).t1 - 0.5`) and `wasAtBottom` (`convoAtBottom`)
  BEFORE ingest: at the edge the cursor moves to the new edge, the loop
  row and the beat follow (the beat gets the page's 160ms live-arrived
  fade once), and the convo sticks to its bottom only if the reader was
  there. Behind the edge nothing moves and the `#rp-live` chip flips from
  `● live` to a `⤓ live` button that snaps back. `history` frames never
  move the cursor. Every other cursor change (seek, step, chapter,
  playback tick) scrolls the convo to its bottom instantly — the bottom
  IS the moment. Reading pages (snapshot / `cctrace view`) have no live
  chip: there is no edge to chase.
- **Live wire** (WebSocket `/ws`, served pages only — a snapshot has none):
  `init` on connect (`{ pairs, traceBytes, starts }`, the whole state, re-sent
  wholesale when a speculative preload is evicted), `pair` per capture
  (`{ pair, traceBytes }`), `history` when a continuity merge or `--with`
  load lands (`{ pairs }`), `purged` after a select-to-purge (`{ ids }`),
  and `start` — a model call that has been FORWARDED and has no response
  yet, the "the model is thinking now" state:
  `{ type: "start", start: { id, url, method, ts, client } }` (`TraceStart`
  in src/types.ts — `id` is the id the eventual pair carries, `ts` is epoch
  SECONDS like `request.timestamp`, `client` is stamped by the CLI's log
  sink exactly like `pair.client`). Only MESSAGES-category calls start: a
  count_tokens probe, oauth or telemetry is not a state (both proxies gate
  on `categorizeUrl`). The server holds the open ones (`ingestStart` beside
  `ingest` from createServer), replays them in `init.starts` — always
  present, `[]` when nothing is in flight — so a page connecting
  mid-request still knows, and drops one when the pair with its id lands or
  after 10 minutes. A start is never written to the trace: it is live
  state, not wire data, so snapshots and `cctrace view` pages say nothing
  about "now" (docs/design/replay-stage.md).
- **Dashboard** (`/dashboard`, src/dashboard.ts — every live/view server
  serves the same page from the shared registry): live runs, the store,
  finished runs. Two of those three sections ACT.
  - Each live row carries a **stop** button. It arms on the first click
    ("end session?" for a capture, "close?" for a viewer) and sends on the
    second; arming decays after 5s. The page always posts to ITS OWN
    origin — `POST /api/instances/stop {id[,force]}` — and that server
    relays to the target's own port (`POST /api/shutdown`, node:http,
    exactly how liveness is probed): a pid is neither addressable nor
    trustworthy across the pid namespaces that share a data dir, while
    port + run id name one run. The receiver compares the id against its
    own before acting, so a stale row pointing at a recycled port cannot
    kill the newcomer. A capture run stops the way Ctrl-C stops it — the
    traced child takes SIGTERM and its exit runs the whole close-out
    (flush, receipt, seal, tombstone), so stopping from the page never
    costs a trace; `force` escalates to SIGKILL for a child that ignores
    the polite ask. Rows for instances the port sweep found without an id
    (pre-0.10 servers) get no button: unaddressable is not stoppable.
    Stopping the instance that served the page is allowed and says so —
    the note turns amber instead of freezing on a stale picture.
  - The **store** section is the housekeeping picture (`GET /api/store`,
    src/maintenance.ts): bytes on disk, traces, projects, and the exact
    archive plan — plain traces and their weight, legacy `.gz` to
    re-encode, interrupted exit seals, plus how many plain traces a live
    run is holding (informational: a trace being written can't be
    archived, so it never justifies the button). **archive now**
    (`POST /api/store/archive`) spawns `cctrace compress --all --yes` as a
    CHILD process and streams its output into the job record the page
    polls every 2s; `{"cancel":true}` kills it between files. The child
    is the point twice over: there is exactly one implementation of
    archiving (the CLI), and a multi-GB archive never runs on the event
    loop of a capture run, whose MITM proxy the traced session depends on
    — the same reason the exit seal is a detached helper
    (docs/design/store.md). What the job reports as reclaimed comes from
    re-measuring the store before and after, never from parsing the log.
- Pure data extraction lives in `src/summarize.ts` + `src/session.ts`,
  inlined into the page via `Function.prototype.toString()` (same pattern as
  `categorize.ts`), so it is unit-testable and live/snapshot UIs cannot drift.
- UI design language and feature designs are written down in `docs/design/`
  (`ui.md` = the rules; `session-replay.md` = the replay proposal). Read
  `ui.md` before adding UI.
