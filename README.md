# cctrace

**HTTP traffic tracer for Claude Code** — see every request Claude Code's CLI
makes, live in your browser or as a saved report.

```bash
cctrace
```

Runs Claude Code normally, but captures every API call it makes —
`/v1/messages`, OAuth, usage/credits, MCP registry, telemetry — and streams
them to a live, categorized web UI.

## Why

Claude Code ships as a Bun-compiled native binary. The old trick of injecting a
`fetch()` hook via `node --require` doesn't work on a native binary anymore.
cctrace captures traffic the way it actually works today: a local
TLS-intercepting proxy (like Charles/mitmproxy, but zero-config) that Claude
routes through via `HTTPS_PROXY`, trusting an auto-generated CA. Because it
intercepts at the transport layer, it sees **everything** — including the
OAuth and usage/credit endpoints that a base-URL proxy can't reach.

## Requirements

- [Bun](https://bun.sh) (the CLI runs on Bun)
- `openssl` (for the auto-generated MITM CA)
- Claude Code installed (`claude` on PATH, or pass `--claude-path`)

## Install

```bash
git clone https://github.com/thevibeworks/cctrace
cd cctrace
bun install
bun link            # optional: makes `cctrace` global
```

## Usage

```bash
cctrace                       # auto mode: capture everything, live UI
cctrace -- -p "hello"         # pass args to Claude
cctrace --mode base-url       # lightweight: /v1/messages only, no CA
cctrace --messages-only       # capture only /v1/messages
cctrace -s                    # static: write files, no live server
cctrace --print-ca            # print the MITM CA cert path
```

When it starts you'll see:

```
[cctrace] Live UI: http://localhost:9317
[cctrace] Capture: MITM proxy http://127.0.0.1:44775 (all Anthropic hosts)
```

Open the **Live UI** URL to watch requests stream in. On exit, cctrace writes a
self-contained `.cctrace/trace-<timestamp>.html` you can open any time.

## Capture modes

cctrace auto-selects based on your Claude install; override with `--mode`.

| Mode | Captures | Setup |
|------|----------|-------|
| **`mitm`** (default for native binaries) | Everything: messages, OAuth, usage/credits, MCP, telemetry | Auto-generates a CA; Claude trusts it via `NODE_EXTRA_CA_CERTS` |
| **`base-url`** | `/v1/messages` only | Zero — just sets `ANTHROPIC_BASE_URL` |
| **`node`** (auto for npm installs) | Everything via `fetch()` hook | Legacy; only works on non-native (JS) Claude |

Non-Anthropic hosts are blind-tunneled through untouched — cctrace only
terminates TLS for hosts it can present a valid cert for.

## The web UI

- **Category filter chips** with live counts: Messages · Usage/Credits · OAuth ·
  MCP · Bootstrap · Telemetry · Other. Click to filter; combine with text search.
- **Colored category badge** on every request row.
- **Expandable** request/response headers and bodies; SSE streams are decoded.
- **Offline snapshots**: the saved `.html` embeds the trace and renders the same
  UI with no server.

Sensitive headers (`authorization`, `x-api-key`, `cookie`, …) are partially
redacted in the capture (first 10 + last 4 chars) so you can tell which key was
used without exposing it.

## Options

| Option | Description |
|--------|-------------|
| `--mode MODE` | `auto` (default), `mitm`, `base-url`, `node` |
| `-s, --static` | Static mode (no live server) |
| `-p, --port PORT` | Live UI port (default: 9317; auto-falls back if busy) |
| `--messages-only` | Capture only `/v1/messages` |
| `--no-open` | Don't auto-open the browser |
| `--print-ca` | Print the MITM CA cert path and exit |
| `--log NAME` | Custom log file base name |
| `--dir PATH` | Log directory (default: `.cctrace`) |
| `--claude-path PATH` | Custom Claude binary path |

## Output

Every run writes to `.cctrace/` (or `--dir`):

- `trace-<timestamp>.jsonl` — one request/response pair per line
- `trace-<timestamp>.html` — self-contained categorized viewer

## How it works

```
  Claude Code                cctrace                 Anthropic
  (native binary)          MITM proxy                api.anthropic.com
       |                       |                          |
       |  HTTPS_PROXY +        |                          |
       |  NODE_EXTRA_CA_CERTS  |                          |
       |---------------------->|  terminate TLS           |
       |                       |------------------------->|  forward (real TLS)
       |                       |<-------------------------|  response stream
       |<----------------------|  tee: one copy to Claude |
       |    (streamed, no      |       one copy captured  |
       |     buffering)        |                          |
                               v
                    live UI + .cctrace/*.{jsonl,html}
```

The proxy terminates TLS with an auto-generated leaf cert (Anthropic SANs),
forwards to the real API, and `tee`s the response stream so Claude gets bytes
immediately while cctrace captures a copy — no buffering of SSE responses.

## Development

```bash
bun test                                # unit tests
bun run tests/e2e-live.ts mitm "hi"     # end-to-end against real Claude
bun run build                           # build dist/cli.js
```

## License

MIT
