# Changelog

All notable changes to cctrace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

## [0.19.0] - 2026-07-20

The kimi release: Kimi Code CLI (Moonshot AI) joins claude/codex/grok
as a traced client, hardened against the real K3 wire — durable
session identity, compaction reconstruction, and honest cost
estimates for the coding plan.

### Added

- cctrace kimi: traces the Kimi Code CLI through the same mitm path
  as codex/grok. Kimi speaks OpenAI Chat Completions — a third wire
  sub-shape adapted into the Responses object model at two seams
  (openaiInput maps messages[] -> input items, a chat branch in
  openaiCompleted assembles chunk deltas + usage), so sessions,
  attribution, compact, and the UI stay on one code path. Host pins
  route auth/usage/models/telemetry into their categories.
- Kimi session identity: K3 sends prompt_cache_key ("session_<uuid>")
  in every request body — stable across subagent threads,
  auto-compaction, and --resume across processes. New wire-table
  field sessionBodyField; extractSessionId reads it, compact stubs
  preserve it. The session chip and cross-run --continue stitching
  work for kimi traces (K2.7-era traces carry no key and stay
  per-run).
- Kimi auto-compaction, reconstructed and displayed: the restart
  packing (the original first user message with later user text
  merged in, the working summary re-sent as a user message)
  reunifies into its parent thread and renders a compaction
  boundary. OpenAI-dialect reunification is gated on the summary
  marker — structural signals alone could false-claim a subagent,
  which shares the session key — and a marker-verified continuation
  appends without the 10-turn-drop heuristic (the repack is known,
  not inferred).
- Media tool results: image_url parts in kimi tool messages become
  image blocks in the session view instead of being flattened away.
- Synthetic K3 fixture (thinking config, prompt_cache_key, dynamic
  max_completion_tokens, the mct=131072 compaction call and the
  msgs=4 restart) with rebuild regression tests; the K2.7 fixture
  stays as the adapter tripwire.

### Changed

- Kimi coding-plan models price as estimates at the equivalent
  pay-per-token rates (k3 -> moonshotai/kimi-k3, kimi-for-coding ->
  kimi-k2.7-code via catalog aliases). The cost chip is an estimate,
  not a bill — the same convention that prices Claude Max OAuth
  traffic; models.dev's kimi-for-coding provider lists $0
  subscription entries, which said less than nothing.

### Fixed

- mitm tests scrub all six proxy env vars per test — a proxied dev
  shell (including a cctrace-traced one) leaked into the suite.

## [0.18.0] - 2026-07-20

The sessions release: the Sessions tab becomes a real reconstruction of
what the harness did to your conversation — sessions, threads, model
epochs, subagent spawns, and compaction, all on one rail.

### Added

- Sessions layer: messages -> threads -> sessions -> project. Threads
  are session-scoped (/clear rotates the session id and never merges
  conversations), sessions list newest-first as collapsible sections,
  and a session holding exactly one conversation absorbs its card into
  the session header. Routes: #/session/<sid8>[/<thread-key>] with
  short thread keys in URLs (old full-key links still resolve);
  [ and ] switch sessions.
- The session rail: one continuous line down the session body, every
  row a node on it. Turn dots carry the wire verdict (green healthy
  cache hit, amber weak/cold/miss, red failed request; hollow ring for
  the user), model epochs are ring marks (a /model switch opens an
  epoch t0/t1 inside the thread, never a new thread), subagent threads
  attach as branch rows at the turn that spawned them with the outcome
  inline (turns, tokens, cost, errors), and superseded exchanges sit
  grey at the ordinal they occupied. Rows show the message; every
  metric lives in instant structured hovers.
- Content-verified per-turn attribution: index-first, verified against
  each pair's assembled response, content-scan on drift (Claude Code
  repacks history with ephemeral notice turns, so raw indices lie). A
  thread's model is a set; the face model is the one with the most
  output tokens. Every assistant turn links back to its wire request,
  and the outline's turn ordinals repeat on the conversation's role
  bars — one numbering at two zoom levels.
- Compaction, reconstructed and displayed. Post-compact packings merge
  back into the conversation (a context-verified anchor for folds, a
  full append for rewrites), pre-compact repack drift classifies as
  unattributed instead of superseded, and a full /compact continuation
  reunifies into its conversation structurally — same session id, same
  system identity block, smaller start, a parent that never speaks
  again; the harness preamble text is one vote, not the gate. Every
  boundary renders: a break node + "compacted · 513 -> 440 turns" row
  on the rail, a dashed divider in the conversation, a hover with the
  context collapse in turns and tokens plus fold-vs-rewrite, click
  opens the first post-compact request. A rendered continuation
  summary is tagged as such, never displayed as something the user
  typed.
- Command and skill turns preview as what the user did: /model,
  /ccx args, /codex:status — both wire block orders handled; skill
  folds name the skill; subagent spawn folds show the spawned thread's
  outcome and an open-thread link.
- Every page names its trace: <project>/<trace-file.jsonl> in the
  header for live runs, view serves, and snapshots.
- Launch and continuity UX: cctrace is silent while the traced client
  owns the terminal (output buffers and flushes at exit);
  --continue/--resume preload the resumed session so the UI opens
  populated; --version and the banner print the commit hash.
- Compaction regression fixture cut from a real triple-packing session
  by tests/sanitize-trace.ts (kept in-tree): equality-preserving hash
  tokens, structural markers preserved, zero original text.

### Changed

- Thread identity is the conversation, not the model: labels name the
  conversation ("63 turns", "[explore] search for..."), the model is a
  quiet right-aligned chip ("fable-5 +4" after mid-thread switches,
  per-model split in the tooltip).
- A weak prompt-cache hit (under 90% of the prompt read from cache) is
  an amber warning, not a green — most of the context was re-billed at
  full input price.
- Header: the version moved to the right with the page chrome (hover =
  about), the live dot sits beside the instance switcher, and usage
  reset countdowns tick live.

### Fixed

- Injected recap exchanges and compaction repacks were displayed as
  "rewound" — a /rewind that never happened. Prefix-divergent pairs now
  display as "superseded" with the possible causes listed, at their
  timeline position, wire pair linked; post-compact requests attribute
  instead of flagging; post-/compact conversations no longer split into
  a second thread (or worse, get claimed as a subagent because the
  continuation summary quotes old Task dispatch prompts).
- Parallel Task spawns with identical prompts all matched the first
  dispatch — threads now pair 1:1 with their tool_use in wire order,
  fixing labels and branch links.
- Jumping to a turn past the first model epoch scrolled to the wrong
  place; jumps now compute against the pane's own scroll box and
  animate (honoring prefers-reduced-motion).
- Redacted traces put literal **** in session URLs; the hash now
  carries short thread keys.

## [0.17.0] - 2026-07-17

### Added

- DevTools-style request inspection (#37): a size column on every row
  (request/response body bytes stamped on the wire at capture time —
  codex zstd shows the compressed size; older traces fall back to an
  estimate and say so), a Headers section in the detail panel (General
  block plus request/response headers as parsed key/value tables with a
  raw toggle and one-click copy), and body view toggles — pretty JSON vs
  as-logged raw for bodies, parsed events vs raw text for SSE streams.
  The detail panel also shows prompt size, first-token/first-byte delay
  with its share of wall-clock, and output tokens/sec.
- Session error metrics (#38): wire errors (no response, 4xx/5xx,
  in-stream error events), truncated streams, and tool-call failures
  aggregated per thread and per session — red chips in the conversation
  pane, an "N err" badge on thread cards, a rollup line above the
  threads pane. Reported separately because they mean different
  failures.
- cctrace compact (#40): folds redundant bytes out of saved traces
  without deleting pairs. Superseded messages request bodies (each API
  turn re-sends the whole conversation) become small stubs — the longest
  request per thread-epoch keeps its full body, so the Session view
  renders identically (regression-tested). Noise categories (telemetry,
  external, bootstrap) keep first/last/largest/slowest/error bodies per
  endpoint, the rest go meta-only. Measured -95%+ on real multi-GB
  traces. Dry-run by default, --yes applies, --zstd archives the result.
  Known loss, stated in --help: exact wire bytes of superseded requests.
- Run catalog (#42): capture runs no longer vanish from the instance
  registry at exit — they tombstone (client, project, trace file,
  session id, pruned after 30 days). cctrace view with no target now
  also offers "recent runs elsewhere" across projects, re-stat'd before
  listing so paths from other containers never error. ps/switcher
  listings sort project-first, and registry entries carry the traced
  agent's pid and cctrace's own pid (informational — liveness stays
  heartbeat+probe).

### Changed

- Conversation design pass (#39): user turns get quieter emphasis (a
  faint accent wash and breathing room instead of a hard colored
  border), and assistant replies render a safe subset of markdown —
  fenced/inline code, headings, bold, http(s) links — escaped first so
  wire content cannot smuggle markup.
- --capture-external now caps external response/request bodies at 64KB
  (#41): larger bodies become meta stubs with exact byte counts and
  content type; url, status, headers, timing and sizes stay. Hosts you
  enroll with --intercept-host still capture in full — you named them.

## [0.16.0] - 2026-07-15

### Changed

- Capture scope: tunnel-by-default (docs/devlog/2026-07-15-capture-scope-
  tunnel-by-default.org). The mitm proxy now decrypts only an include-list
  of hosts: the traced client's first-party infrastructure, its pinned
  telemetry sinks (Claude Code's datadog intake joins the claude wire
  table), hosts from base-url env overrides, and --intercept-host extras.
  Every other CONNECT passes through as an opaque tunnel — no forged cert,
  so cert-pinning tools and system-trust readers (apt, java) work — logged
  as one meta pair with host, byte counts and duration. Field evidence: a
  deva smoke test traced a 52MB npm tarball into mojibake; gh API response
  bodies landed verbatim. --capture-external restores decrypt-everything.
  Remote MCP servers on arbitrary hosts now need --intercept-host.
- Response capture is binary-safe: undecodable bodies summarize as
  <binary body: N bytes> instead of decoding tarballs into mojibake, same
  handling requests already had. A torn multi-byte char at an abort point
  keeps the body.
- purge default drop is now telemetry,tokens,external (was telemetry,
  tokens): old traces carry decoded third-party payloads worth sweeping;
  new traces only lose ~100-byte tunnel meta rows.
- Timestamps render 24h everywhere in the UI (list rows, detail panel,
  session wire rows); locale 12h AM/PM wasted row width.
- The category filter bar shows only categories the trace contains — a
  codex/grok run no longer shows an empty Count Tokens chip. The active
  category stays visible at zero so a filter can be clicked off.
- Header layout: version badge (+ amber update link) moved next to the
  cctrace wordmark, the traced-client chip gained a quiet monogram icon
  (spark/hexagon/slash — generic shapes, not vendor logos), right side is
  request count, live dot, theme/github actions.

### Added

- cctrace view with no target lists traces newest-first (index, size, age)
  and, on a TTY, prompts for a pick — Enter opens the newest. Non-TTY runs
  print the list and exit. New "latest" keyword opens the newest trace
  directly: cctrace view latest.
- Live-arrived request rows fade in (160ms, opacity only) so new wire
  activity is visible without breaking the ~zero motion budget; bulk
  renders and filter re-renders stay instant.
- Tunnel meta rows show a "tunnel ↑bytes ↓bytes" chip and say plainly that
  the payload was not captured.

## [0.15.0] - 2026-07-15

### Added

- First-token latency (ttft). The capture pump (captureTee in
  src/stream.ts) stamps two delays on every streamed pair: firstByteMs,
  request arrival to the first response body byte, and firstTokenMs,
  request arrival to the first token event (anthropic
  content_block_delta, openai response.*.delta, chat completion chunks;
  setup events like message_start and the trailing message_delta do not
  count). Measured live in the pump because SSE events carry no
  timestamps; saved traces cannot backfill it. Both capture modes, all
  clients. The requests list gets a ttft chip with its share of
  wall-clock, the detail panel shows the first token / first byte delay,
  speed (tok/s) divides by post-first-token streaming time when ttft is
  known instead of whole wall-clock, and session turns show ttft next to
  duration. Pairs captured before 0.15 render unchanged.

## [0.14.0] - 2026-07-14

### Added

- Client plugin layer (#28). src/clients/ replaces clients.ts: one module
  per client (claude, codex, grok) with binary discovery and a JSON-safe
  wire table (dialect, first-party hosts, host-to-category pins, session
  and thread header names). Adding a client is one file plus a registry
  entry. categorizeUrl order: wire shape, client host pins, first-party
  "other", External. Analytics hosts a client calls (mixpanel, otlp) pin
  to telemetry so purge --drop telemetry sweeps them. On real traces grok
  External dropped 857 -> 2 pairs, codex -> 9. Unlabeled pre-0.13 pairs
  categorize byte-identically (regression-tested).
- OpenAI Responses dialect (#29). src/dialects/openai.ts reconstructs
  codex and grok sessions: input[] normalizes to the existing turn/block
  model (message -> text, function_call -> tool_use, *_output ->
  tool_result, reasoning -> thinking; codex reasoning is encrypted, shown
  as a placeholder). Usage comes from the final response.completed SSE
  event, cached tokens peeled off input to match the chips. Threads key
  on the wire conv header (codex thread-id, grok x-grok-conv-id); prewarm
  probes and recap-* convs classify as utility. Chips, detail panel,
  session view, replay and cross-run continuity work for both clients.
  buildSession stays one entry for both dialects.
- Pricing from the models.dev catalog (#30). pricing-catalog.ts caches
  models.dev/api.json in the data dir (24h TTL, fail-soft), filtered to
  anthropic/openai/xai. Lookup: exact id, date-suffix strip, then
  trailing-segment fallback (gpt-5.6-sol -> gpt-5.6); the embedded Claude
  table remains the offline fallback. Costs render for codex and grok
  models; unknown models stay unpriced.
- Docs synced to the multi-client layer (#31): CLAUDE.md, README cost
  line, agent skill.

## [0.13.0] - 2026-07-14

### Fixed

- **Cross-instance stream leak** — the live page baked an absolute
  `ws://localhost:<bound-port>` WebSocket URL into the HTML. Behind
  container/host port forwards the bound port is not the port the browser
  sees, so a `view --serve` page could attach to a *different* instance's
  live stream (observed: a grok capture streaming into a codex view page).
  The WebSocket now connects origin-relative; instance-switcher links use
  `location.hostname`. Relatedly, `/api/pair` accepted unauthenticated
  POSTs from anything that could reach the socket — proxy modes now hand
  pairs to the server in-process, and the endpoint (kept for legacy node
  mode's child process) requires the run's instance id.
- **Codex through the proxy** — two stacked failures. Codex opens a
  WebSocket to `chatgpt.com/backend-api/codex/responses`; the TLS
  terminator forwarded the handshake via `fetch()` and returned a
  convincing 101 whose frames went nowhere, hanging ~82s per attempt until
  upstream's ping timeout. WebSocket upgrades are now refused immediately
  (501, logged as a pair) so clients fall back to plain HTTP at once. Then
  the fallback failed too: codex zstd-compresses request bodies, and the
  proxies read them with a lossy UTF-8 text decode before re-sending —
  upstream 400s. Request bodies now forward as raw untouched bytes; the
  trace stores a decoded copy (zstd/gzip/br/deflate undone; true binary
  summarized, never mangled).
- **Sidechain session reconstruction** — subagent (Task) runs never
  appeared as linked threads; on real traces main + every subagent
  collapsed into ONE thread, corrupting per-turn attribution. Claude Code
  prepends the same `<system-reminder>` context block to every thread's
  first user message, which defeated both the first-message signature and
  the dispatch-prompt match (the prompt is `content[1]`, after the
  reminder). Threads now group by the `x-claude-code-agent-id` header when
  present (exact, cc ≥ ~2.1.2xx) or by a reminder-skipping signature of the
  first user text; dispatch linking reads the real prompt (verbatim on the
  wire); sidechains without a captured dispatch are still classified
  `agent` via wire markers (`cc_is_subagent=true`, Agent-SDK system
  prompt) so they never compete with the main chat. Linked threads are
  labeled `[subagent_type] description`.

### Changed

- **Live runs no longer write a snapshot `.html` at exit** — the `.jsonl`
  is the deliverable (`cctrace view` reopens it anytime); a 2h session was
  producing ~400MB of HTML nobody asked for. Static mode (`-s`) still
  writes the snapshot — that's its point.
- **`cctrace view` serves by default** (what `--serve` did; the flag stays
  as a silent alias). `cctrace view <target> --html` writes the shareable
  self-contained snapshot instead.
- **Session view: every tool_use folds to one line.** The old "mutating
  tools render expanded" rule buried conversations under Read/Bash output.
  Focus goes to what matters: user prompts (accent border), subagent
  spawns (purple, with an "open thread →" link to the reconstructed
  sidechain), Skill and MCP calls (purple), and the assistant's replies.
- Brand-first tab title: `CCTrace · <client> · <project> · <session>`.

### Added

- **Client labeling** — every captured pair records who produced it
  (`"client": "claude" | "codex" | "grok"`); the UI header shows a client
  chip, `cctrace ps` gains a CLIENT column, and the instance registry
  carries it.
- **In-page navigation** — the detail-panel toolbar (close/prev/next) is
  sticky; a quiet nav rail overlays the session conversation and the
  detail panel: jump top/bottom, prev/next turn, prev/next user prompt,
  system prompt. Session-view keys: `g`/`G` top/bottom, `j`/`k` turns,
  `p`/`u` user prompts, `s` system prompt.
- `--help` rewritten to match the actual CLI surface (multi-client
  tagline, `purge`, per-subcommand flags, zstd, `.zst` view targets);
  README / CLAUDE.md / agent skill synced.

## [0.12.0] - 2026-07-14

### Added

- **Long-window zstd `compress`** (#25) — session traces are mostly
  re-sent conversation prefixes; Bun's built-in zstd at level 19 windows
  the whole input. Measured on a real 375MB trace: 5.7MB (63x,
  byte-identical round trip) where `gzip -9` got 2.8x. Legacy `.jsonl.gz`
  archives stay readable and are upgraded (unioned, then removed) on the
  next run.
- **`cctrace purge`** — drop whole categories from saved traces (default:
  telemetry + count_tokens). Measured honestly: ~45% of rows but ~9% of
  bytes, so the CLI says "rows, not disk" and points at `compress` for
  space. Dry-run by default, atomic rewrite, re-stat before unlink.
- **`make publish`** — project-local `.npmrc` + `.env` token handling with
  long fetch timeouts; `~/.npmrc` is never touched.

## [0.11.0] - 2026-07-13

### Added

- **`cctrace view --serve`** — serve a saved trace from the live web server
  instead of writing a snapshot `.html`. For big sessions a static snapshot
  runs to hundreds of MB and dies in the browser; `--serve` loads the same
  pairs into the normal live UI (registered in the instance registry as mode
  `view`, visible in `cctrace ps`, Ctrl-C to stop). The snapshot path prints
  a hint when the written `.html` exceeds 100 MB.
- **Client profiles** (#20, first cut) — `cctrace codex -- exec "..."` and
  `cctrace grok -- ...` trace the OpenAI Codex and Grok CLIs. A leading
  client word selects the profile (binary discovery + `--client-path`
  override); non-Claude clients always run mitm, where `HTTPS_PROXY` plus
  the 0.10 combined CA bundle already cover their Rust/native TLS stacks
  (verified end-to-end against both CLIs). OpenAI-format session
  reconstruction remains follow-up work.
- **Shape-first categorization** (#19) — `categorizeUrl` now classifies the
  wire shape before the host: `/v1/messages` (and `count_tokens`) on ANY
  host is Messages/Count Tokens, so third-party Anthropic-compatible
  providers behind `ANTHROPIC_BASE_URL` no longer drown in the External
  bucket. OpenAI shapes (`.../responses`, `.../chat/completions`, matched by
  path tail — custom providers mount them under arbitrary prefixes) count as
  Messages too, and `--messages-only` honors the same shapes. The
  Anthropic-only taxonomy (usage/oauth/mcp/telemetry keywords) stays
  host-gated: those substrings are far too generic for foreign hosts.

### Fixed

- Diagnosed the "Identifier 'pairs' has already been declared" snapshot
  corruption reported on large traces: the broken `.html` carried the exact
  `$&`-substitution signature of the pre-0.5.0 `renderSnapshot`, i.e. it was
  written by a stale installed binary (npm never had 0.5.0 — 0.4.0 installs
  jumped straight to 0.6.0+). Current escaping (`jsonForScript` +
  function-replacement, both since 0.5.0) verifies clean on the same
  375 MB trace; the write-time self-check (0.9.0) would have flagged any
  real regression. Fix: upgrade the binary that generates the snapshot —
  and prefer `view --serve` at that size anyway.

## [0.10.0] - 2026-07-13

### Fixed

- **Subprocess TLS trust** (#17) — children of the traced CLI inherit
  `HTTPS_PROXY`, but `NODE_EXTRA_CA_CERTS` is Node-only, so every non-Node
  subprocess (statusline `curl`, `gh`, python hooks) died on TLS
  verification. mitm mode now builds a combined bundle (system CAs + mitm
  CA — the standard vars *replace* the trust store, so the union keeps
  non-proxied connections working) and exports it as `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, and `NIX_SSL_CERT_FILE`. An
  existing user bundle (corporate TLS inspection) is respected as the base,
  so stacking works.
- **`cctrace ps` no longer lies** — liveness was judged by pid, which is
  meaningless when the registry dir is shared across pid namespaces
  (containers sharing a `$HOME` volume with forwarded localhost ports):
  every read *deleted* live entries registered from other namespaces, and
  `ps` reported "No live cctrace instances" while several were serving.
  Liveness is now heartbeat + port truth: instances rewrite their entry
  every 30s, stale entries must answer `/api/self` on their port (matched
  by a unique run id; new endpoint), only definitively-dead entries are
  GC'd, and wrongly-deleted entries self-heal on the next heartbeat.
  Registry files are keyed by run id, not pid — pids collide across
  namespaces too.
- **Instance discovery survives a wiped registry** — `cctrace ps`,
  `/api/instances`, and the UI's "⇄ N more" switcher also sweep the UI
  port walk (9317..9326) and synthesize entries from each live port's
  `/api/self`, so instances the registry lost (e.g. entries deleted by a
  still-running pre-0.10 cctrace) are found anyway. Older instances that
  can't identify themselves show as minimal `?` rows.

### Changed

- **Version badge moved top-right** — the UI header's `vX.Y.Z` (+ amber
  "vX available" link) now lives on the right side next to the actions,
  instead of crowding the project · session-id run identity.

## [0.9.0] - 2026-07-12

### Added

- **Update checker** — cctrace now knows when it's stale. The npm registry
  is queried in the background at most once a day (3s timeout, fail-soft,
  cached in `<data-dir>/update-check.json`); startup itself never waits on
  the network. When a newer version is known, an interactive run asks
  `upgrade now? [y/N]` (10s timeout; only on a TTY, never in `-p` print
  mode) — accepting runs `npm i -g`/`bun add -g` when the install method
  is unambiguous, otherwise prints the right instructions; declining
  snoozes that version to a quiet one-line notice. Opt out with
  `--no-update-check` or `CCTRACE_NO_UPDATE_CHECK=1`.
- **Version everywhere** — the startup banner prints `cctrace vX.Y.Z`,
  `cctrace --version`/`-V` reports it (plus any known newer version), the
  web UI header shows it next to the session id with an amber
  "vX.Y.Z available" link when an update is known, and snapshots record
  the version that produced them.

- **Prompt-cache hit/miss attribution** — every /v1/messages request now
  carries one compact cache verdict instead of two verbose chips: green
  `cache ↓116.9k 97% ↑1.2k` when the prompt prefix was served from cache
  (hit % of prompt), amber `cache ↑50.0k` for a cold write (conversation
  start, or the cached prefix changed/expired), amber `cache miss` when
  cache_control was set but nothing was read or written, and no chip when
  the request doesn't use the cache. 1h-TTL writes get their own breakdown
  (they bill at 2x). Tooltips spell out the full numbers. The session
  view's wire-request rows carry a matching colored dot, so scanning a
  thread shows exactly where the cache broke; thread chips compact to the
  same ↓/↑ format.

### Fixed

- **Generated markup is now grammar-clean** — two classes of captured
  content broke the page's HTML: `fmtCost`'s `<$0.0001` label reached
  `innerHTML` with a raw `<` (chips, thread meta, turn usage), and ANSI
  escape sequences in captured terminal output passed through `escapeHtml`
  — control characters are HTML parse errors and rendered as garbled
  `[1m` text. `kv()` now escapes its value (a chip can never open a tag),
  and `escapeHtml` strips ANSI CSI sequences and all other C0 control
  chars. A parse5-backed test sweeps every fragment the page generates
  from hostile captures and fails on any parse error.

### Added

- **Snapshots self-check and self-repair** — every pair enters the page
  through one guard: a structurally broken pair (torn trace line, no
  request/url) is dropped with a console note instead of blanking the page,
  and each list row / detail panel / session turn / thread card renders
  inside its own try/catch, so one corrupt item degrades to one visible
  "broken item" card. `cctrace view` warns about skipped torn/broken lines,
  and every written snapshot is verified (the embedded pair payload is
  re-extracted and re-parsed) before the CLI reports success.

## [0.8.0] - 2026-07-11

### Added

- **Agent skill** (`skills/cctrace/SKILL.md`) — teaches any Claude Code
  agent to drive cctrace: run traced sessions (with the `--`/`-p`/bun
  gotchas spelled out), pick capture modes, read the UI (replay deep links,
  cost chips), work saved traces (`view`/`clean`/`merge`/`compress`/`ps`),
  parse trace .jsonl programmatically, and handle traces as the sensitive
  artifacts they are.

- **Multi-instance support** — running several cctrace sessions at once is
  no longer a port scavenger hunt. Every live run registers itself in
  `<data-dir>/instances/` (port, project, session id once seen on the wire)
  and unregisters on exit; dead entries self-heal via pid checks.
  `cctrace ps` lists live instances with their URLs; the web UI header
  shows a "⇄ N more" switcher to jump straight to the other instances; and
  port allocation now walks 9317, 9318, ... so concurrent runs land on
  predictable neighbors instead of random OS-assigned ports.

- **Session replay (P1+P2 of the design)** — replay a captured session as it
  happened, inside the Session view. "⏵ replay" (or ←/→) enters a time
  cursor over the wire: ←/→ steps turns, shift+←/→ steps wire requests,
  Space plays at 1/2/8/60x with idle gaps compressed to ≤2s, Home/End jump,
  Esc exits. The scrubber doubles as a session minimap (turns tall, errors
  red, probes as ticks). Moments are shareable: `#/session/<key>/@<pair-id>`
  deep-links open paused at that pair, and pausing updates the URL. Works in
  live captures (new pairs grow the track; "live ⤓" re-attaches the tail)
  and in offline snapshots. Pure timeline primitives in `src/replay.ts`,
  unit-tested and inlined like the rest of the page.

- **Estimated cost everywhere** (`src/pricing.ts`) — every `/v1/messages`
  request now shows an estimated USD cost: as a chip in the Requests list,
  in the detail panel (with a tooltip breaking it down into input / output /
  cache read / cache write), per assistant turn and per thread in the
  Session view. Pricing is an embedded sticker-price table (works offline in
  snapshots); cache rates use Anthropic's universal multipliers (0.1x read,
  1.25x 5m write, 2x 1h write — the 5m/1h split comes from the wire's
  `cache_creation` breakdown, and writes without one are billed at the
  cheaper 5m rate, matching ccusage). Unknown models simply show no cost.
- **More token metrics in the detail panel** — effective prompt size
  (input + cache read + cache write) and output speed (tok/s over
  wall-clock duration).

## [0.7.0] - 2026-07-11

### Added

- **Tab title includes the session id** — the browser tab now reads
  `<project> · <session-prefix> · cctrace` once the session id is known,
  so multiple live UIs (or saved snapshots) of the same project are
  distinguishable at a glance. Previously only the project name appeared.
- **Session view tails like tail -f** — opening or refreshing a live session
  lands on the newest turn; re-renders stick to the bottom while you're
  there and never yank the scroll while you're reading history (new activity
  surfaces as a "↓ new activity" pill instead). Folds you open survive live
  re-renders; the thread sidebar keeps its scroll. Snapshots still open at
  the top — reviewing a finished session is reading, not tailing.
- UI polish: thin quiet scrollbars, live/offline/snapshot status dot (with a
  heartbeat pulse when live), accent `::selection` + `:focus-visible`, `/`
  focuses the filter, keyboard hints in the empty state,
  `prefers-reduced-motion` respected.
- `docs/design/` — written design docs: the UI design language
  (`ui.md`) and the session-replay proposal (`session-replay.md`).

### Planned

- **Session replay** — step / scrub / play through a captured session as it
  happened; viewer-side over existing traces, phased P1–P4
  (design: `docs/design/session-replay.md`).
- **Codex support** — trace OpenAI Codex CLI through the same MITM front door
  (OpenAI host filters, endpoint categories, Codex-aware conversation
  reconstruction).
- **Conversation dump** — export the reconstructed conversation as Markdown/JSON.
- **Agent skill** — a Claude Code skill / MCP server for querying captured
  traffic programmatically.
- **Multi-session live view** — path-based session routing
  (`/<project>/<session-id>`) to avoid port conflicts.
- **Cumulative token metrics** — per-session totals and cost estimates
  (per-request usage + cache hit rates shipped in 0.4.0).

## [0.6.1] - 2026-07-10

### Added

- **The header now shows which run you're looking at** — project name
  (the directory cctrace ran in; full path on hover) and the current Claude
  session id (short form; hover for the full id, click to copy). The session
  id is extracted from the pairs in the page, so saved snapshots and
  `cctrace view` rebuilds show it too; the browser tab is titled
  `<project> · cctrace` so multiple live UIs stay tellable apart.

## [0.6.0] - 2026-07-09

### Fixed

- **A dropped connection can no longer crash cctrace mid-session** — a
  process-fatal `TypeError: null is not an object` in Bun's stream builtins
  (observed during long-running operations like `/compact`) killed the proxy
  and severed the live Claude session behind it. Three layers, each
  independently tested:
  - `ReadableStream.tee()` replaced with a guarded pump (`src/stream.ts`):
    every controller call is wrapped, a client abort still captures the full
    response, an upstream failure logs the partial body with
    `truncated: true`, and upstream is only read as fast as Claude consumes
    it (tee buffered unboundedly).
  - Capture runs install `uncaughtException`/`unhandledRejection` handlers:
    an escaped stream error now costs one log line, not the session.
    Verified to intercept the observed error class on Bun 1.3.14.
  - Every proxy `Bun.serve` sets `idleTimeout: 0` (default 10s) and an
    `error` hook (a handler failure returns 502 instead of printing a
    multi-line error over Claude's TUI); `flush()` is capped at 5s so an
    abandoned capture cannot hang exit.

### Changed

- **The MITM CA moved from XDG cache to XDG data** —
  `~/.cache/cctrace` → `~/.local/share/cctrace` (`$XDG_DATA_HOME` respected).
  The CA is identity material: rotating it silently breaks any trust exported
  with `--print-ca`, and cache directories are exactly what cleanup tools
  wipe. A pre-0.6 CA is **moved once, preserving its identity** — same key,
  same fingerprint, permissions re-locked (dir `0700`, keys `0600`).

### Added

- `--data-dir PATH` / `CCTRACE_DATA_DIR` — the documented names for the
  storage override. Legacy `--cache-dir` / `CCTRACE_CACHE_DIR` keep working
  as aliases.
- `truncated: true` on a captured response whose upstream stream died before
  finishing (previously the pair was silently dropped).

## [0.5.0] - 2026-07-08

### Added

- **`cctrace view <target>`** — rebuild a snapshot `.html` from a saved trace
  with no proxy and no Claude spawn, then open it. Target is a `.jsonl` (or
  `.jsonl.gz`) path, a Claude Code **session id** (or prefix — merges every
  trace carrying it, deduped, like live continuity), or a trace filename
  fragment. Resolution + rendering live in `src/view.ts`, unit-tested.
- **Storage subcommands `clean` / `merge` / `compress`** — housekeeping for a
  log dir that grows large. `clean` deletes regenerable `.html` snapshots and
  0-byte aborted traces; `merge` consolidates each session's pairs (across
  `--continue` runs) into one deduped `session-<id>.jsonl` (`--prune` drops
  fully-merged sources, never one holding un-attributable utility pairs);
  `compress` gzip -9 archives traces to `.jsonl.gz` (`--older-than N`,
  `--keep-jsonl`). All three **dry-run by default** and print an itemized plan;
  `--yes` applies. Data-safety invariants, each regression-tested: `merge` and
  `compress` **union with existing outputs** (a re-run can only grow a merged
  file or archive, never shrink one); `clean` verifies an `.html` is actually
  regenerable (a sibling `.jsonl`/`.jsonl.gz` exists) instead of assuming;
  every unlink re-stats first, so a live capture appending pairs between plan
  and apply is skipped and reported, not truncated; outputs are written
  tmp+rename. Logic in `src/storage.ts`.
- **Transparent `.jsonl.gz` reads** — `view` and cross-run continuity read
  gzip-archived traces directly (`readTraceText` in `src/history.ts`).
- **`--cache-dir` / `CCTRACE_CACHE_DIR`** — override the MITM CA / cache dir.

### Fixed

- **Snapshot `.html` no longer breaks — or silently corrupts — on hostile
  payload content.** Two bugs, one choke point. `renderSnapshot` embedded the
  trace via raw `JSON.stringify` inside an inline `<script>`, so a payload
  holding a literal `</script>` (common when Claude discusses HTML) closed
  the tag early and the browser threw `Invalid or unexpected token` on load —
  `jsonForScript` now escapes `<` (as `\u003c`) plus the U+2028/U+2029 line separators (all
  decode back on parse). And the `</head>` injection used a *string*
  `.replace()`, whose `$`-substitution rules corrupt any payload containing
  `$$`, `$&`, `` $` `` or `$'` (a Makefile in the conversation was enough) —
  it is now a function replacement. Both regression-tested in
  `tests/snapshot.test.ts`.
- **Prior-run pairs dedupe across trace files.** After a (non-prune) `merge`,
  a pair exists in both its original trace and the merged session file;
  continuity snapshots now dedupe by pair id instead of rendering every prior
  turn twice (`loadPriorPairs`). Relatedly, `view <session-id>` resolves by
  session scan *before* filename matching, so it merges all of a session's
  traces even when a `session-*.jsonl` filename contains the id.

### Changed

- **One cache dir for every install method.** The MITM CA now lives in
  `~/.cache/cctrace` (XDG) for source runs, `bun link`, and the compiled
  binary alike, instead of a repo-local `.cache/` for source — so the CA is
  generated once and reused. A leftover repo-local CA is flagged at startup
  (that key can forge Anthropic certs; delete it).
- **Verbose startup** — cert generation vs cache reuse, CA path, and the MITM
  proxy address are now logged instead of happening silently.
- **Snapshot opens on exit in static mode** (`-s`); live mode keeps its single
  tab and prints a `cctrace view …` reopen hint. `--continue`/`--resume` prints
  a note that prior turns merge on Claude's first request (they can't sooner —
  the session id only appears on the wire).
- **Docs lead with the two jobs cctrace is built for** — LLM tracing (what
  Claude Code sends and receives each turn) and security/privacy tracing
  (what actually leaves your machine). README (en/zh) "Why" section, landing
  page hero, and meta description reframed accordingly.
- `bun test` discovery is scoped to `tests/` via `bunfig.toml` (a vendored
  checkout under `reference/` used to get swept in).

## [0.4.0] - 2026-07-07

### Added

- **Cross-run session continuity** — `cctrace -- --continue` / `--resume` now
  merges the earlier runs' traces of the same Claude session into the live UI
  and the `.html` snapshot. Matching is exact: Claude Code sends its session
  id in every `/v1/messages` request (`metadata.user_id`), so when a live pair
  reveals a session seen in a prior `.jsonl` in the log dir, those pairs are
  loaded, badged `prev` (with a "Prev runs" toggle in the toolbar), and the
  Session view gets full per-turn usage/duration/wire links for old turns
  instead of bare replayed history. `--fresh` disables the merge; `--with FILE`
  force-merges arbitrary trace files. Extraction (`extractSessionId`) and file
  scanning (`src/history.ts`) are pure and unit-tested.
- **Session view** — split-pane: wire threads on the left, reconstructed
  conversation on the right (`#/session`). Requests group into threads by
  their first message (main chat, subagent runs, quota probes / title
  generation as collapsed "utility"); subagent threads are matched to the
  Task tool_use that dispatched them. Turns rebuild from each thread's
  longest request plus its streamed response; every assistant turn shows the
  per-turn usage (model, in/out, cache, duration) of the wire request that
  produced it, with a `wire` link back to the request detail. tool_results
  fold into their tool_use (result-only turns collapse away); mutating tools
  (Bash/Edit/Write/Task) render expanded, read-only lookups collapsed.
  Reconstruction lives in `src/session.ts`, pure and unit-tested.
- **Split detail panel** — clicking a request now opens the detail beside the
  list instead of replacing it: the list, filters, and category chips stay
  visible, the selected row is highlighted, and browsing keeps its context.
  On narrow windows the panel goes full-width.
- **Claude CLI pass-through** — `cctrace [OPTIONS] [-- CLAUDE_ARGS...]`:
  everything after the first `--` is passed to the Claude CLI verbatim
  (`cctrace -- --continue`, `cctrace -- -p "explain this"`). Forwarded args
  are echoed at startup. Parsing lives in `src/args.ts` and is unit-tested.
- **`make build` / `make install`** — compile cctrace into a standalone binary
  (`bun build --compile`) and install it to `$PREFIX/bin` (default
  `~/.local/bin`). The compiled binary needs no Bun at runtime and — unlike
  bun-run installs — receives a leading `--` intact, so `cctrace -- --help`
  reaches Claude. (Bun's CLI eats a leading `--` under `bunx`/`bun run`/`bun
  link`; usage errors from source runs now mention this.) Legacy `node` mode
  still requires running from source. Also: `make help`, `make test`,
  `make link`, `make clean`.
- **Request detail view** — every index row now opens a hash-routed detail page
  keyed by request id (`#/p/<id>`), deep-linkable in both the live UI and
  static snapshots. Navigate with prev/next buttons or `j`/`k`; `Esc` returns
  to the list.
- **Conversation view** — `/v1/messages` details render the actual exchange:
  system prompt (collapsed, with `cache_control` markers), tool definitions
  (collapsed), message turns with readable text, and the streamed assistant
  reply reconstructed from SSE events. Thinking, `tool_use`, and `tool_result`
  blocks are collapsed one-liners so the primary flow stays readable; long
  texts clamp with a "show all" expander.
- **Inline row summaries** — human-readable labels on the index row itself:
  model + `in`/`out` tokens + `cache read/write` (+ hit %) for messages
  (now decoded from SSE streams, which previously showed nothing), `= N tok`
  for count_tokens, `5h/7d/per-model %` for usage, event counts for telemetry,
  error types for failed requests.
- **Usage limits panel** — `/api/oauth/usage` details render each rate-limit
  window (5h session, 7d all-models, 7d per-model) as a bar with utilization %
  and reset time.
- `src/summarize.ts` — pure, unit-tested extraction helpers (SSE parsing,
  usage merging, assistant reassembly), inlined into the web UI the same way
  as `categorize.ts`.

### Changed

- **prev/next and `j`/`k` walk the filtered list**, not the full capture —
  with a category or text filter active, navigation steps through what you
  see (position reads `n / N shown`).
- The web UI moved from `server.ts` into its own `src/ui.ts`; `server.ts` is
  now just the Bun.serve + WebSocket relay.
- **CLI options are now parsed strictly.** An unknown flag before `--`
  (e.g. `cctrace --continue`) errors with a hint to move it after `--` —
  previously it was silently swallowed and never reached Claude. Stray
  positionals and missing option values error the same way.
- Index rows no longer expand inline; clicking opens the detail view. Raw
  request/response payloads render lazily on expand (megabyte JSON bodies are
  only stringified when asked).
- Token/cache metadata moved from the separate `pair-meta` line into the row
  itself, on a single line.
- Anthropic-host URLs display as path-only in the list (the category badge
  already names the service); other hosts keep `host + path`.

## [0.3.0] - 2026-07-07

### Added

- **Full interception of non-Anthropic hosts** — instead of blind-tunneling
  traffic our Anthropic-only leaf cert couldn't serve, the MITM proxy now
  mints a per-host TLS cert on first contact (signed by the same CA, cached
  on disk), so everything Claude talks to is captured. External traffic gets
  its own filter category in the UI; the blind tunnel remains only as a
  fallback when cert generation fails.
- **count_tokens category** — `/v1/messages/count_tokens` requests get their
  own badge and an inline `= N tok` row summary.
- Tunneled `CONNECT` requests are logged, so even pass-through traffic is
  visible.
- GitHub Pages landing page; brand slogan ("See what Claude really does.").

## [0.2.0] - 2026-07-07

### Added

- **Theme toggle** — the web UI now supports system / light / dark themes. Defaults
  to the OS preference; click the toggle in the header to override. Preference is
  persisted in localStorage and applies to both live and snapshot views. A
  synchronous `<head>` script prevents FOUC on reload.
- **GitHub link** in the web UI header — links to the repo for easy access.
- Brand icon (`assets/cctrace-logo.svg`) — a "cc" monogram threaded by the
  dot→ring trace line. Theme-aware; shown in both READMEs and wired into the live
  web UI as the header logo and favicon.
- Mermaid architecture diagram in the README (renders on GitHub), replacing the
  ASCII sketch.
- npm install option (`bun add -g @thevibeworks/cctrace` / `bunx @thevibeworks/cctrace`).

### Changed

- Published as `@thevibeworks/cctrace` on npm (scoped package, public access).

## [0.1.1] - 2026-07-06

### Security

- **Redact request/response bodies and URLs, not just headers.** Captured pairs
  now pass through a single redaction choke point (`src/redact.ts`) before
  reaching the `.jsonl`, the shareable `.html`, or the live WebSocket. Credential
  fields (`access_token`, `refresh_token`, `client_secret`, `code`, `api_key`, …)
  are masked in JSON and form-encoded bodies, and credential-bearing URL query
  params (e.g. OAuth `?code=`) are masked. Previously only header names were
  redacted, so a session that crossed an OAuth token refresh could persist a live
  token in a shareable file. Applies to all capture modes, including legacy node.
- CA/leaf private keys are now written with explicit `0600` perms, in a `0700`
  cache dir.

### Fixed

- **Drop `SSL_CERT_FILE` and `HTTP_PROXY` from the env injected into Claude.**
  `NODE_EXTRA_CA_CERTS` alone is sufficient for Claude to trust our CA (verified
  against the real binary), and the dropped vars leaked into Claude's subprocesses
  (the bash tool's `curl`/`python`, MCP servers) and could break their networking.
- Empty-body responses (204/304, and 3xx redirects under `mitm`) are now recorded
  instead of silently dropped.

### Changed

- Browser auto-open is cross-platform (`xdg-open` / `start` / `open`).
- `--mode` now errors on an unknown value instead of silently falling back.
- Removed the non-functional `bun build --target node` script (it emitted code
  referencing `Bun.*`). Use `bun build --compile` for a standalone binary.

### Added

- Bilingual README (English + 简体中文), positioning comparison, and a branded
  preview asset.
- `SECURITY.md`, `CONTRIBUTING.md`, CI (`bun test` on push/PR), issue/PR templates.

## [0.1.0] - 2026-07-06

Initial public release.

### Added

- **MITM capture mode** (default for native Claude binaries): a local
  TLS-intercepting proxy with an auto-generated CA. Captures everything —
  `/v1/messages`, OAuth, usage/credits, MCP registry, telemetry — because it
  intercepts below URL construction, reaching hosts a base-URL proxy can't.
- **base-url capture mode**: zero-setup reverse proxy via `ANTHROPIC_BASE_URL`;
  captures `/v1/messages` only.
- **node capture mode** (legacy): `fetch()` hook via `node --require`, for
  non-native (JS) Claude installs.
- **Capturer abstraction** (`src/capture.ts`): both proxy modes behind one
  interface; `cli.ts` spawns Claude mode-agnostically.
- **Live categorized web UI**: filter chips with live counts, colored category
  badges, expandable headers/bodies, decoded SSE streams.
- **Offline snapshots**: each run writes a self-contained `.html` that renders
  the same UI with no server.
- Blind-tunnel for non-Anthropic hosts (we only terminate TLS where we can
  present a valid cert).
- Partial redaction of sensitive headers in captured output.
- Automatic port fallback when the default UI port is busy.

[Unreleased]: https://github.com/thevibeworks/cctrace/compare/v0.19.0...HEAD
[0.19.0]: https://github.com/thevibeworks/cctrace/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/thevibeworks/cctrace/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/thevibeworks/cctrace/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/thevibeworks/cctrace/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/thevibeworks/cctrace/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/thevibeworks/cctrace/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/thevibeworks/cctrace/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/thevibeworks/cctrace/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/thevibeworks/cctrace/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/thevibeworks/cctrace/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/thevibeworks/cctrace/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/thevibeworks/cctrace/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/thevibeworks/cctrace/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/thevibeworks/cctrace/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thevibeworks/cctrace/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/thevibeworks/cctrace/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/thevibeworks/cctrace/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/thevibeworks/cctrace/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/thevibeworks/cctrace/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/thevibeworks/cctrace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thevibeworks/cctrace/releases/tag/v0.1.0
