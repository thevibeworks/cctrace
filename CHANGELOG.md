# Changelog

All notable changes to cctrace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

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
  `~/.local/bin`). The compiled binary needs no Bun at runtime, stores its CA
  under `~/.cache/cctrace/`, and — unlike bun-run installs — receives a
  leading `--` intact, so `cctrace -- --help` reaches Claude. (Bun's CLI eats
  a leading `--` under `bunx`/`bun run`/`bun link`; usage errors from source
  runs now mention this.) Legacy `node` mode still requires running from
  source. Also: `make help`, `make test`, `make link`, `make clean`.

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

### Planned

- **Conversation dump** — export the reconstructed conversation as Markdown/JSON.
- **Agent skill** — a Claude Code skill / MCP server for querying captured
  traffic programmatically.
- **Multi-session live view** — path-based session routing
  (`/<project>/<session-id>`) to avoid port conflicts.
- **Cumulative token metrics** — per-session totals and cost estimates
  (per-request usage + cache hit rates shipped above).

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

[Unreleased]: https://github.com/thevibeworks/cctrace/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/thevibeworks/cctrace/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/thevibeworks/cctrace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thevibeworks/cctrace/releases/tag/v0.1.0
