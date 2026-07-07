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
├── server.ts       # Bun.serve() + WebSocket relay (page lives in ui.ts)
├── ui.ts           # The whole web UI: Requests list + detail panel + Session view
├── summarize.ts    # Pure extractors: SSE usage, count_tokens, usage limits (inlined into UI)
├── session.ts      # Conversation reconstruction from wire pairs (inlined into UI)
├── html.ts         # Static HTML generator (legacy node mode only)
└── types.ts        # Shared types
```

## Capture modes

The CLI auto-selects, or force with `--mode <mitm|base-url|node>`.

### mitm (default for native binaries) — captures everything

TLS-intercepting proxy, Charles/mitmproxy style. This is the only mode that
sees the full picture, because Claude hardcodes some hosts (OAuth, usage,
credits) independent of `ANTHROPIC_BASE_URL`.

1. `ensureCerts()` generates a CA + leaf cert (Anthropic SANs) under `.cache/mitm/`
2. Front door: an http.Server answers `CONNECT`. Anthropic hosts are routed to a
   local `Bun.serve({ tls })` terminator; all other hosts are blind-tunneled
   through untouched (we never break a cert we can't forge)
3. The TLS terminator decrypts, forwards to the real host, tees the response
   (stream to Claude + capture in parallel), logs the pair
4. Claude trusts our CA via `NODE_EXTRA_CA_CERTS` + `SSL_CERT_FILE`, and routes
   through us via `HTTPS_PROXY`

Captures `/v1/messages`, `/api/oauth/*` (incl. usage/credits), `/api/claude_cli/*`,
`/mcp-registry/*`, `/api/event_logging/*`.

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
Two views, hash-routed:

- **Requests** (`#`, `#/p/<id>`): one row per request with inline
  human-readable chips — model, in/out tokens, cache read/write + hit %,
  count_tokens results, usage window percentages (5h / 7d / per-model),
  telemetry event counts, error types. Clicking a row opens a split detail
  panel beside the list (no page jump); prev/next + `j`/`k` walk the
  FILTERED list; `Esc` closes. Messages render conversation-first (system
  prompt, tools, thinking, tool_use collapsed; long texts clamp with a
  "show all" expander; streamed assistant reply reconstructed from SSE).
  Usage requests render limit bars. Raw payloads are lazy `<details>`.
- **Session** (`#/session[/<key>]`): wire view + reconstructed conversation
  side by side. `session.ts` groups /v1/messages pairs into threads by
  first-message signature (main chat, subagent runs matched to their Task
  dispatch by prompt, quota probes/title-gen as utility), rebuilds turns from
  each thread's longest request + its response, and attributes per-turn
  usage/duration to the wire request that produced it (index = the request's
  history length; later same-length requests win). tool_results fold into
  their tool_use by id (ccx convention); result-only user turns are skipped;
  mutating tools (Bash/Edit/Write/Task...) render expanded, lookups collapsed.
  Every assistant turn links back to its wire request.
- Pure data extraction lives in `src/summarize.ts` + `src/session.ts`,
  inlined into the page via `Function.prototype.toString()` (same pattern as
  `categorize.ts`), so it is unit-testable and live/snapshot UIs cannot drift.

## Commands

```bash
cctrace                       # auto mode (mitm on native), capture everything
cctrace --mode base-url       # lightweight, messages only, no CA
cctrace --messages-only       # capture only /v1/messages
cctrace --print-ca            # print MITM CA cert path
cctrace -s                    # static mode (files only, no live UI)
cctrace -- --continue         # everything after -- goes to Claude verbatim
cctrace -- -p "explain this"  # (-p after -- is Claude's, before it cctrace's)
```

CLI parsing lives in `src/args.ts`: argv splits at the first `--` (rest goes
to Claude untouched); cctrace's own flags parse strict, so unknown options
error with a "put it after --" hint instead of being silently swallowed.

**Bun `--` quirk**: bun's CLI (bun run / bunx / bun-link shim) eats a *leading*
`--`, so `cctrace -- --help` only works from the compiled binary. `make build`
compiles `dist/cctrace` (`bun build --compile`, never `--minify` — the UI
inlines functions via `toString()`); `make install` puts it in `~/.local/bin`.
The compiled binary uses `~/.cache/cctrace/` instead of the repo `.cache/` and
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
- **Blind-tunnel non-Anthropic hosts**: our leaf cert only has Anthropic SANs;
  forging other hosts would fail TLS, so we pass them through raw.
- **Stream tee, not clone**: `ReadableStream.tee()` streams to Claude immediately
  while capturing in parallel — no buffering of SSE responses.
- **accept-encoding: identity**: avoid gzip/br decompression mismatch when
  forwarding to Claude.
- **flush() before exit**: async captures must finish before the process exits,
  or pairs are lost.

## Testing

```bash
bun test                                # unit: proxy, certs, tunnel, abstraction
bun run tests/e2e-live.ts mitm "hi"     # e2e against real claude, all hosts
bun run tests/e2e-live.ts base-url "hi" # e2e, messages only
```

Results (incl. real captures) land in `test-output/` — gitignored. Latest run:
`test-output/SUMMARY.md`.
