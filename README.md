<p align="center"><img src="assets/cctrace-logo.svg" width="84" alt="cctrace"></p>

# cctrace

> **See what Claude really sends.**
>
> Every request Claude Code makes -- messages, OAuth, usage/credits, MCP --
> captured live in your browser.

English | [简体中文](README.zh-CN.md)

[![tests](https://github.com/thevibeworks/cctrace/actions/workflows/test.yml/badge.svg)](https://github.com/thevibeworks/cctrace/actions/workflows/test.yml)
[![version](https://img.shields.io/github/v/tag/thevibeworks/cctrace?label=version&sort=semver)](https://github.com/thevibeworks/cctrace/tags)
[![license](https://img.shields.io/github/license/thevibeworks/cctrace)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-bun-f9f1e1)](https://bun.sh)

<p align="center">
  <img src="assets/cctrace-demo.gif" alt="cctrace live demo" width="100%">
</p>

cctrace sits between Claude Code and the Anthropic API, recording every HTTP
call to a live categorized web UI -- then saves a self-contained HTML snapshot
you can open any time. No cloud, no account, nothing leaves your machine.

```bash
cctrace
```

That's it. Claude launches normally. You get a browser tab showing everything
it does.

## Why

cctrace is built for exactly two jobs:

1. **LLM tracing** -- see exactly what Claude Code sends and receives each
   turn: system prompt, context, tool definitions, streamed replies,
   token/cache usage.
2. **Security & privacy tracing** -- audit what actually leaves your machine:
   which hosts get contacted, what telemetry goes out, what's inside every
   payload.

Both jobs need the full picture -- every request, not just the convenient
ones -- and getting that is harder than it sounds:

Claude Code ships as a Bun-compiled **native binary**. The classic trick of
injecting a `fetch()` hook with `node --require` doesn't work on a native
binary -- it's dead, Jim. cctrace captures traffic the way it actually works
today: a local **TLS-intercepting proxy** (Charles/mitmproxy-style, but
zero-config) that Claude routes through via `HTTPS_PROXY`, trusting an
auto-generated CA.

Because it intercepts at the transport layer -- below where URLs are built --
it sees **everything**, including the OAuth and usage/credit endpoints that a
base-URL proxy physically cannot reach (Claude hardcodes their host).

## What you get

- **The full picture.** `/v1/messages`, OAuth, **usage/credits**, MCP registry,
  bootstrap, telemetry -- not just the chat endpoint.
- **Live, categorized UI.** Filter chips with counts, colored badges, expandable
  headers/bodies, decoded SSE streams. It looks good. You'll actually want to
  keep it open.
- **Shareable snapshots.** Every run writes a self-contained `.html` that
  renders the same UI offline, no server needed. Send it to a colleague.
- **Zero config.** Auto-generates its CA, auto-detects your Claude install, and
  captures everything by default. No config files to edit, no flags to memorize.
- **Safe by default.** Credentials are redacted from headers, bodies, *and* URLs
  before anything hits disk (see [Security & privacy](#security--privacy)).
  Your API keys stay your API keys.

## How it compares

|  | **cctrace** | base-URL proxy | claude-trace (`node --require`) | Charles / mitmproxy |
|---|:---:|:---:|:---:|:---:|
| Works on the native binary | yes | yes | **no** | yes |
| Captures `/v1/messages` | yes | yes | yes | yes |
| Captures **OAuth / usage / credits** | yes | **no** | **no** | manual |
| Zero config (auto CA + trust) | yes | yes | yes | **no** |
| Claude-aware UI (categories, SSE decode) | yes | -- | partial | **no** |
| Local-only, nothing leaves your machine | yes | yes | yes | yes |

The `fetch()`-hook approach (claude-trace and friends) stopped working when
Claude Code went native. A base-URL proxy still works but only sees
`/v1/messages` -- you're flying blind on OAuth, usage, and credits. A general
TLS proxy like Charles sees everything but needs manual CA setup and knows
nothing about Claude's endpoints. cctrace is the middle path: zero-config,
sees everything, and speaks Claude.

## Quick start

Requires [Bun](https://bun.sh), `openssl`, and Claude Code (`claude` on PATH).

### Install from npm

```bash
npm install -g @thevibeworks/cctrace
```

### Or run without installing

```bash
bunx @thevibeworks/cctrace
```

### Or clone the repo

```bash
git clone https://github.com/thevibeworks/cctrace
cd cctrace
bun install
bun link            # optional: puts `cctrace` on your PATH
```

### Or build a standalone binary (recommended)

```bash
git clone https://github.com/thevibeworks/cctrace
cd cctrace
make install        # compiles dist/cctrace, installs to ~/.local/bin
```

`make install` (or `make build`) compiles cctrace into a single executable
via `bun build --compile` -- Bun is needed to build, **not to run**. It's also
the install that makes `cctrace -- <claude args>` work verbatim (see the
pass-through note below). `make help` lists all targets; `PREFIX=/usr/local
make install` changes the destination.

Then just run it:

```bash
cctrace                                    # capture everything, open the live UI
cctrace -- --continue                      # resume your last Claude session, traced
cctrace -- -p "hello"                      # pass args straight through to Claude
cctrace -- --dangerously-skip-permissions  # full auto, traced
```

On start you'll see:

```
[cctrace] Live UI: http://localhost:9317
[cctrace] Capture: MITM proxy http://127.0.0.1:44775 (all Anthropic hosts)
```

Open the **Live UI** URL and watch requests stream in. When you're done, hit
Ctrl-C -- cctrace prints the path to a saved `.cctrace/trace-<timestamp>.html`.

## Running cctrace (Bun & `bin`)

cctrace **runs on [Bun](https://bun.sh)** -- the CLI is `src/cli.ts` executed
directly (shebang `#!/usr/bin/env bun`). There is no compiled JS and no Node
fallback; everything uses `Bun.serve`/`Bun.spawn`.

| Command | Works | Notes |
|---|---|---|
| `cctrace` (after `make install`) | yes | compiled binary, no Bun at runtime, `--` passes through intact |
| `bun run src/cli.ts [args]` | yes | from a clone |
| `bun start` | yes | alias of the above |
| `./src/cli.ts` | yes | direct exec via the Bun shebang |
| `cctrace` (after `bun link`) | yes | needs `~/.bun/bin` on your `PATH`; bun eats a leading `--` |
| `node .../cli.ts` / `npm i -g` without Bun | **no** | fails loudly: `env: 'bun': No such file or directory` |

**Prerequisites -- all three matter:**

- **Bun** -- the runtime (or the build tool, if you `make install` the
  compiled binary). If you don't have Bun, [install it](https://bun.sh).
- **`openssl` on `PATH`** -- `mitm` mode shells out to it to generate the CA +
  leaf cert. No openssl? Use `--mode base-url` (no CA needed, but you only
  see messages).
- **A real Claude Code install** -- auto mode reads the magic bytes of your
  `claude` binary to pick the capture mode. No `claude` on PATH? cctrace
  exits with `Claude not found` (or pass `--claude-path`).

> **Standalone binary:** `make build` compiles one for your platform
> (`bun build --compile`); `make install` puts it on your PATH. One caveat:
> the compiled binary doesn't include the legacy `node` capture mode (it needs
> the repo sources) -- native Claude installs use `mitm` (the default) anyway.

## Capture modes

cctrace auto-selects based on your Claude install; override with `--mode`.

| Mode | Captures | Setup |
|------|----------|-------|
| **`mitm`** (default, native binaries) | **Everything** -- messages, OAuth, usage/credits, MCP, telemetry | Auto-generates a CA; Claude trusts it via `NODE_EXTRA_CA_CERTS` |
| **`base-url`** | `/v1/messages` only | Zero -- just sets `ANTHROPIC_BASE_URL` |
| **`node`** (auto for npm/JS installs) | Everything via `fetch()` hook | Legacy; only works on non-native (JS) Claude |

Non-Anthropic hosts are **fully intercepted** too -- cctrace dynamically
generates a TLS cert for each host (signed by the same CA), so you see the
complete request and response for everything Claude contacts. External
traffic gets its own filter category in the UI.

## The web UI

- **Inline row summaries** -- every request row reads at a glance: model,
  in/out tokens, cache read/write + hit %, count_tokens results, usage window
  percentages (5h / 7d / per-model), telemetry event counts, error types.
- **Category filter chips** with live counts: Messages, Usage/Credits, OAuth,
  MCP, Bootstrap, Telemetry, Other. Click to filter; combine with text search.
- **Split detail panel** -- click a row and the detail opens beside the list
  (deep-linkable by request id). Messages render conversation-first with the
  streamed reply decoded from SSE; usage requests render limit bars; raw
  headers/bodies stay one fold away. `j`/`k` walk the filtered list.
- **Session view** -- wire requests and the reconstructed conversation side by
  side: threads for the main chat and subagent runs (matched to their Task
  dispatch), utility noise collapsed, tool results folded into their tool
  calls, and per-turn token/duration linked back to the wire request.
- **Session continuity** -- `cctrace -- --continue` (or `--resume`) picks up
  where a previous traced run left off: every Claude Code request carries its
  session id on the wire, so cctrace finds the earlier runs' traces in the log
  dir by exact match and merges them in. Old turns keep their tokens, timing,
  and wire links instead of rendering as bare history; merged requests are
  badged `prev` with a toggle to hide them. `--fresh` opts out; `--with FILE`
  force-merges any trace file.
- **Offline snapshots** -- the saved `.html` embeds the full trace and renders
  the same UI with no server. Open it a year from now, it still works.

## Working with saved traces

Subcommands operate on traces already on disk -- no proxy, no Claude spawn.
The three housekeeping commands are **dry-run by default** (they print an
itemized plan and touch nothing); add `--yes` to apply.

```bash
# Rebuild a snapshot .html and open it -- by file, session id, or filename bit
cctrace view .cctrace/trace-2026-07-08T05-51-43.jsonl
cctrace view 4f9a2c1e                      # a Claude Code session id (or prefix)

# Reclaim space: drop regenerable .html snapshots + 0-byte aborted traces
cctrace clean                              # dry run: lists what would go
cctrace clean --yes

# Consolidate a session's runs (--continue spans files) into one .jsonl
cctrace merge                              # one session-<id>.jsonl per session
cctrace merge --prune --yes                # also remove fully-merged sources

# Archive for backup: gzip -9 (view reads .jsonl.gz directly)
cctrace compress --older-than 7 --yes      # only traces older than 7 days
```

Housekeeping never shrinks your data. `clean` only deletes an `.html` whose
source `.jsonl`/`.jsonl.gz` still exists (checked, not assumed — an orphan
snapshot is kept). `merge` and `compress` union with existing outputs, so
re-running them can only grow a merged file or archive. `merge` only prunes a
source when *every* pair in it was attributed to a session, so a trace holding
OAuth/usage/telemetry (no session id) is never deleted out from under you.
And every deletion re-checks that the file didn't change since the plan, so
housekeeping while a live capture is appending is safe.

## Options

```
cctrace [OPTIONS] [-- CLAUDE_ARGS...]
```

| Option | Description |
|--------|-------------|
| `--mode MODE` | `auto` (default), `mitm`, `base-url`, `node` |
| `-s, --static` | Static mode (no live server, just files) |
| `-p, --port PORT` | Live UI port (default: 9317; auto-falls back if busy) |
| `--messages-only` | Capture only `/v1/messages` |
| `--no-open` | Don't auto-open the browser |
| `--print-ca` | Print the MITM CA cert path and exit |
| `--log NAME` | Custom log file base name |
| `--dir PATH` | Log directory (default: `.cctrace`) |
| `--fresh` | Don't merge prior traces of a continued session |
| `--with FILE` | Merge a specific trace file into the view (repeatable) |
| `--claude-path PATH` | Custom Claude binary path |
| `--data-dir PATH` | MITM CA / data dir (default: `~/.local/share/cctrace`; or `CCTRACE_DATA_DIR`. Legacy `--cache-dir` / `CCTRACE_CACHE_DIR` still work; a pre-0.6 CA in `~/.cache/cctrace` migrates over automatically) |

### Passing args to Claude

Everything after `--` goes to the Claude CLI verbatim; flags before it belong
to cctrace:

```bash
cctrace -- --continue                       # claude --continue, traced
cctrace -- -p "why is this failing?"        # claude print mode, traced
cctrace --mode base-url -- --model opus     # cctrace flag + Claude flags
```

A flag cctrace doesn't recognize before `--` is an error with a hint -- a typo
or misplaced Claude flag is never silently swallowed. The one collision to
know: `-p` before `--` is cctrace's port, after `--` it's Claude's print mode.

> **Bun-run caveat:** when cctrace runs through bun's CLI (`bunx`, `bun run`,
> the `bun link` shim), bun itself eats a **leading** `--`, so
> `cctrace -- --help` arrives as `cctrace --help`. The compiled binary
> (`make install`) is immune -- that's the recommended install. On a bun-run
> install, put any cctrace flag before the `--`
> (e.g. `cctrace --no-open -- --continue`).

## Output

Every run writes to `.cctrace/` (or `--dir`):

- `trace-<timestamp>.jsonl` -- one request/response pair per line (machine-readable)
- `trace-<timestamp>.html` -- self-contained categorized viewer (human-readable)

## How it works

```mermaid
flowchart LR
    CC["Claude Code<br/>(native binary)"]
    FD{"cctrace<br/>CONNECT front door"}
    TLS["TLS terminator<br/>(our leaf cert)"]
    BT["TLS terminator<br/>(dynamic cert)"]
    API[("api.anthropic.com")]
    ORI[("non-Anthropic<br/>origin")]
    TEE(["tee response"])
    RD["redact<br/>headers · bodies · URLs"]
    UI["live UI<br/>(categorized)"]
    OUT[[".cctrace/ · jsonl + html"]]

    CC -- "HTTPS_PROXY +<br/>NODE_EXTRA_CA_CERTS" --> FD
    FD -- "Anthropic host" --> TLS
    FD -- "other host" --> BT
    TLS --> API
    BT --> ORI
    ORI -- "response stream" --> TEE
    API -- "response stream" --> TEE
    TEE -- "streamed to Claude,<br/>no buffering" --> CC
    TEE -- "captured copy" --> RD
    RD --> UI
    RD --> OUT

    classDef accent stroke:#3fb950,stroke-width:2px;
    class RD accent
```

The proxy terminates TLS with an auto-generated leaf cert (Anthropic SANs),
forwards to the real API, and `tee`s the response stream so Claude gets bytes
immediately while cctrace captures a copy -- zero buffering of SSE responses.
Every captured pair is redacted before it reaches any sink.

We inject only two things into Claude's environment: `HTTPS_PROXY` (to route
traffic through us) and `NODE_EXTRA_CA_CERTS` (which *appends* our CA to Bun's
trust store, so Claude trusts our leaf while public TLS still works).

We deliberately do **not** set `SSL_CERT_FILE` or `HTTP_PROXY` -- those leak
into Claude's subprocesses (the bash tool's `curl`/`python`, MCP servers) and
would break their networking. That's the kind of bug that makes you question
your life choices at 2 AM.

## Security & privacy

cctrace is a local debugging tool, but it intercepts real credentialed traffic,
so it redacts before writing anything:

- **Headers** -- `authorization`, `x-api-key`, `cookie`, etc. are masked to a
  first-10/last-4 preview (enough to tell *which* key, not the key itself).
- **Bodies** -- credential fields (`access_token`, `refresh_token`,
  `client_secret`, `code`, `api_key`, ...) are masked in JSON and form-encoded
  bodies. Your `/v1/messages` conversation content is left intact.
- **URLs** -- credential-bearing query params (e.g. OAuth `?code=`) are masked.

Redaction happens at a single choke point, so it applies uniformly to the
`.jsonl`, the shareable `.html`, and the live WebSocket. The `.cctrace/` output
is gitignored by default.

**Still:** a trace is a record of your real session. Review it before sharing.
Never paste raw output into a public issue. Seriously.

## Roadmap

- **Codex support** -- trace OpenAI Codex CLI through the same MITM front
  door. The proxy layer is already agent-agnostic; what's left is OpenAI host
  filters, endpoint categories, and conversation reconstruction for its wire
  format.
- **Conversation dump** -- export the reconstructed conversation as Markdown
  or JSON, ready for sharing or post-mortem analysis.
- **Agent skill** -- a purpose-built Claude Code skill/MCP server for
  interacting with cctrace programmatically: query captured traffic, inspect
  specific requests, export conversations.
- **Multi-session live view** -- run multiple cctrace sessions without port
  conflicts by routing each session to a path like
  `http://localhost:9317/<project>/<session-id>`.
- **Token metrics** -- per-turn and cumulative token usage, cache hit rates,
  cost estimates, and `service_tier` / `inference_geo` visibility.

See [CHANGELOG.md](CHANGELOG.md) for released changes.

## Development

```bash
bun test                                # unit tests
bun run tests/e2e-live.ts mitm "hi"     # end-to-end against real Claude
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
