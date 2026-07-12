# Changelog

All notable changes to cctrace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/thevibeworks/cctrace/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/thevibeworks/cctrace/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/thevibeworks/cctrace/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/thevibeworks/cctrace/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/thevibeworks/cctrace/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/thevibeworks/cctrace/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/thevibeworks/cctrace/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/thevibeworks/cctrace/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/thevibeworks/cctrace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thevibeworks/cctrace/releases/tag/v0.1.0
