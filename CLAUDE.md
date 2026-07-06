# cctrace

HTTP traffic tracer for Claude Code CLI. Live web UI with WebSocket streaming.

## Architecture

```
src/
├── cli.ts          # Entry point: pick capture mode, spawn Claude, log pairs
├── capture.ts      # Capturer abstraction — unifies mitm + base-url modes
├── mitm.ts         # TLS-intercepting proxy (captures ALL Anthropic traffic)
├── certs.ts        # Auto-generate CA + leaf cert; Anthropic host filter
├── proxy.ts        # Reverse proxy via ANTHROPIC_BASE_URL (messages only)
├── detect.ts       # ELF/Mach-O/PE magic-byte detection, bash wrapper resolve
├── interceptor.ts  # fetch() monkey-patch for node mode (legacy)
├── loader.cjs      # CJS loader for --require (legacy)
├── preload.ts      # Built to .cache/preload.cjs (legacy)
├── server.ts       # Bun.serve() + WebSocket for live UI
├── html.ts         # Static HTML generator
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

## Commands

```bash
cctrace                       # auto mode (mitm on native), capture everything
cctrace --mode base-url       # lightweight, messages only, no CA
cctrace --messages-only       # capture only /v1/messages
cctrace --print-ca            # print MITM CA cert path
cctrace -s                    # static mode (files only, no live UI)
cctrace -- --model opus       # pass args to Claude
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
