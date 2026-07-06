# Changelog

All notable changes to cctrace are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow
[SemVer](https://semver.org/).

## [Unreleased]

### Added

- Brand icon (`assets/cctrace-logo.svg`) — a "cc" monogram threaded by the
  dot→ring trace line. Theme-aware; shown in both READMEs and wired into the live
  web UI as the header logo and favicon.
- Mermaid architecture diagram in the README (renders on GitHub), replacing the
  ASCII sketch.

### Planned

- **Conversation view** — an interactive mode that reconstructs a full LLM
  interaction from the raw capture: system prompt, message turns, tool
  definitions, tool calls and their results, and the streamed assistant reply
  decoded from the SSE events — rendered as one readable conversation instead of
  a wire-level request/response dump. The wire view stays; this reads the same
  bytes at the conversation layer.

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

[Unreleased]: https://github.com/thevibeworks/cctrace/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/thevibeworks/cctrace/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/thevibeworks/cctrace/releases/tag/v0.1.0
