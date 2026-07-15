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
call to a live categorized web UI and a `.jsonl` trace you can reopen any
time with `cctrace view`. No cloud, no account, nothing leaves your machine.
It traces the OpenAI Codex and Grok CLIs too (`cctrace codex`, `cctrace grok`).

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
it sees the **whole first-party picture**, including the OAuth and
usage/credit endpoints that a base-URL proxy physically cannot reach (Claude
hardcodes their host). Since 0.16 that scope is deliberate: first-party
hosts are decrypted, everything else your session touches (npm, GitHub, apt)
passes through as an opaque byte-counted tunnel -- an audit trail without
the payload copies.

## What you get

- **The full picture.** `/v1/messages`, OAuth, **usage/credits**, MCP registry,
  bootstrap, telemetry -- not just the chat endpoint.
- **Live, categorized UI.** Filter chips with counts, colored badges, expandable
  headers/bodies, decoded SSE streams. It looks good. You'll actually want to
  keep it open.
- **Replayable traces.** Every run writes a `.jsonl` trace; `cctrace view`
  reopens it in the same UI anytime, and `cctrace view --html` renders a
  self-contained snapshot you can send to a colleague (works offline).
- **Zero config.** Auto-generates its CA, auto-detects your Claude install, and
  captures the full first-party picture by default. No config files to edit,
  no flags to memorize.
- **Scoped by design.** Only first-party hosts are decrypted. External hosts
  your agent's subprocesses contact -- npm, GitHub, apt -- pass through as
  opaque tunnels logged as host + byte counts, so a `go install` never lands
  53MB of tarball in your trace and `gh` API responses never hit disk.
  `--capture-external` decrypts everything when you're debugging;
  `--intercept-host` enrolls specific hosts (remote MCP servers).
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
sees the whole first-party picture, and speaks Claude.

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
cctrace                                    # trace claude, open the live UI
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
Ctrl-C -- the `.jsonl` trace stays in `.cctrace/`; reopen it anytime with
`cctrace view` (Enter picks the newest).

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
| **`mitm`** (default, native binaries) | **The full first-party picture** -- messages, OAuth, usage/credits, MCP registry, telemetry | Auto-generates a CA; Claude trusts it via `NODE_EXTRA_CA_CERTS` |
| **`base-url`** | `/v1/messages` only | Zero -- just sets `ANTHROPIC_BASE_URL` |
| **`node`** (auto for npm/JS installs) | First-party via `fetch()` hook | Legacy; only works on non-native (JS) Claude |

Capture scope is an include-list, decided per connection before any TLS
(Charles' SSL-proxying model): first-party hosts, the client's pinned
telemetry sinks, any `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` host, and
`--intercept-host` extras get real interception with per-host certs.
Everything else -- package registries, `gh` calls, apt -- passes through as
an **opaque tunnel** logged as one small row: host, bytes up/down, duration.
No forged certs for those hosts, so cert-pinning tools and system-trust
readers work through cctrace unchanged. `--capture-external` restores
decrypt-everything.

## The web UI

- **Inline row summaries** -- every request row reads at a glance: model,
  in/out tokens, a prompt-cache verdict (green hit with read/write arrows +
  hit %, amber cold write or miss -- the session view's wire rows carry a
  matching dot, so cache breaks stand out), count_tokens results, usage
  window percentages (5h / 7d / per-model), telemetry event counts, error
  types.
- **First-token latency** -- every streamed model call shows a `ttft` chip
  (measured live at the proxy pump; SSE events carry no timestamps, so a
  saved trace can't reconstruct it) and tok/s computed over the
  post-first-token stream -- slow-start vs slow-stream is one glance.
- **Category filter chips** with live counts -- only the categories the
  trace actually has (a Codex run shows no Count Tokens chip). Click to
  filter; combine with text search.
- **Split detail panel** -- click a row and the detail opens beside the list
  (deep-linkable by request id). Messages render conversation-first with the
  streamed reply decoded from SSE; usage requests render limit bars; raw
  headers/bodies stay one fold away. `j`/`k` walk the filtered list.
- **Session view** -- wire requests and the reconstructed conversation side by
  side: threads for the main chat and subagent runs (matched to their Task
  dispatch), utility noise collapsed, tool results folded into their tool
  calls, and per-turn token/duration linked back to the wire request.
- **Session replay** -- re-experience a captured session as it happened, right
  inside the Session view: `←`/`→` step through turns (`shift` steps every
  wire request), `Space` plays at 1/2/8/60x with long idle gaps compressed,
  and the scrubber doubles as a session minimap (turns, errors, probes).
  Pause anywhere and the URL (`#/session/<key>/@<pair-id>`) deep-links that
  exact moment. Works on every trace ever captured -- live, snapshot, or
  `cctrace view` rebuild -- because the wire is already a timeline.
- **Estimated cost** -- every messages request shows an estimated USD cost
  (live models.dev pricing with an embedded offline fallback, cache
  read/write TTLs priced separately), with
  per-turn and per-thread totals in the Session view. Estimates, not bills.
- **Multi-instance aware** -- run cctrace in three repos at once and nothing
  gets lost: ports allocate predictably (9317, 9318, ...), `cctrace ps`
  lists every live instance with its URL and session, and the web UI header
  grows a switcher to jump between them.
- **Session continuity** -- `cctrace -- --continue` (or `--resume`) picks up
  where a previous traced run left off: every Claude Code request carries its
  session id on the wire, so cctrace finds the earlier runs' traces in the log
  dir by exact match and merges them in. Old turns keep their tokens, timing,
  and wire links instead of rendering as bare history; merged requests are
  badged `prev` with a toggle to hide them. `--fresh` opts out; `--with FILE`
  force-merges any trace file.
- **Offline snapshots** -- the saved `.html` embeds the full trace and renders
  the same UI with no server. Open it a year from now, it still works.
- **Stays fresh** -- a daily background check against npm (never blocks
  startup, fail-soft) offers new releases with an `upgrade now? [y/N]`
  prompt on interactive runs; declining snoozes that version. The header
  shows the running version, and an amber notice when a newer one exists.
  Opt out with `--no-update-check` or `CCTRACE_NO_UPDATE_CHECK=1`.

## Working with saved traces

Subcommands operate on traces already on disk -- no proxy, no Claude spawn.
The housekeeping commands (`clean`/`merge`/`compress`/`purge`) are **dry-run
by default** (they print an itemized plan and touch nothing); add `--yes` to
apply.

```bash
# Reopen a saved trace in the web UI -- no target needed
cctrace view                               # lists traces newest-first, Enter = newest
cctrace view latest                        # newest trace, no questions
cctrace view 4f9a2c1e                      # a Claude Code session id (or prefix)
cctrace view trace-2026-07-08              # or a filename fragment / path
cctrace view <target> --html               # write a self-contained snapshot .html
                                           # instead (shareable; huge traces choke
                                           # browsers -- the default serve doesn't)

# Reclaim space: drop regenerable .html snapshots + 0-byte aborted traces
cctrace clean                              # dry run: lists what would go
cctrace clean --yes

# Consolidate a session's runs (--continue spans files) into one .jsonl
cctrace merge                              # one session-<id>.jsonl per session
cctrace merge --prune --yes                # also remove fully-merged sources

# Archive for backup: zstd (view reads .jsonl.zst / legacy .gz directly)
cctrace compress --older-than 7 --yes      # only traces older than 7 days

# Drop noise categories (telemetry, count_tokens, external) from saved traces
cctrace purge --yes                        # rows, not disk -- compress is for space

# Which cctrace sessions are live right now, and on which port?
cctrace ps                                 # URL, PID, client, project, session
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
cctrace [CLIENT] [OPTIONS] [-- CLIENT_ARGS...]
```

| Option | Description |
|--------|-------------|
| `--mode MODE` | `auto` (default), `mitm`, `base-url`, `node` |
| `-s, --static` | Static mode (no live server; writes the `.jsonl` + a snapshot `.html`) |
| `-p, --port PORT` | Live UI port (default: 9317; auto-falls back if busy) |
| `--messages-only` | Capture only the model API calls (`/v1/messages` and friends) |
| `--capture-external` | Decrypt every host (default: non-first-party hosts tunnel opaquely with byte counts) |
| `--intercept-host H` | Also decrypt host `H` (repeatable -- remote MCP servers, unusual providers) |
| `--no-open` | Don't auto-open the browser |
| `--print-ca` | Print the MITM CA cert path and exit |
| `--log NAME` | Custom log file base name |
| `--dir PATH` | Log directory (default: `.cctrace`) |
| `--fresh` | Don't merge prior traces of a continued session |
| `--with FILE` | Merge a specific trace file into the view (repeatable) |
| `--claude-path PATH` | Custom Claude binary path |
| `--client-path PATH` | Custom binary path for any client (codex/grok too) |
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

## Beyond Claude

The capture core is client-agnostic -- it's a TLS-intercepting proxy, and any
CLI that honors `HTTPS_PROXY` plus the standard cert env vars gets traced.

**Other clients** -- a leading client word picks who runs:

```bash
cctrace codex -- exec "fix the failing tests"   # OpenAI Codex CLI
cctrace grok -- -p "explain this stack trace"   # Grok CLI
```

Non-Claude clients always use mitm capture, and get the full treatment:
their model calls (`.../responses`, `.../chat/completions`) land in
Messages, and the Session view reconstructs their conversations too --
threads keyed on each client's wire headers, tool calls and reasoning
normalized into the same turn model, per-turn usage and cost, replay
included. Codex's encrypted reasoning shows as a placeholder; Grok's
summaries read in full.

**Third-party Anthropic-compatible providers** -- point `ANTHROPIC_BASE_URL`
at a gateway or a compat endpoint and run `cctrace` as usual. mitm mode needs
no extra setup: non-Anthropic hosts get a per-host certificate minted on
first contact (requires `openssl`), and `/v1/messages` is classified by wire
shape, not host, so provider traffic lands in Messages with the provider's
hostname visible on each row. OAuth/usage/credits categories will simply be
absent -- those endpoints are hardcoded to Anthropic hosts and bypass
`ANTHROPIC_BASE_URL` by design (which is exactly why mitm mode exists).

## Output

Every run writes to `.cctrace/` (or `--dir`):

- `trace-<timestamp>.jsonl` -- one request/response pair per line
  (machine-readable). That file IS the trace: `cctrace view` reopens it in
  the web UI anytime, `cctrace view <target> --html` renders a shareable
  self-contained snapshot on demand (live runs stopped writing one at exit
  in 0.13 -- a 2-hour session rendered 400MB of HTML).

## How it works

```mermaid
flowchart LR
    CC["Claude Code<br/>(native binary)"]
    FD{"cctrace<br/>CONNECT front door"}
    TLS["TLS terminator<br/>(our leaf cert)"]
    BT["TLS terminator<br/>(dynamic cert)"]
    TUN["opaque tunnel<br/>(byte counts only)"]
    API[("api.anthropic.com")]
    PIN[("pinned / enrolled<br/>host")]
    EXT[("external host<br/>npm · github · apt")]
    TEE(["tee response"])
    RD["redact<br/>headers · bodies · URLs"]
    UI["live UI<br/>(categorized)"]
    OUT[[".cctrace/ · jsonl"]]

    CC -- "HTTPS_PROXY +<br/>NODE_EXTRA_CA_CERTS" --> FD
    FD -- "Anthropic host" --> TLS
    FD -- "include-listed host" --> BT
    FD -- "anything else" --> TUN
    TLS --> API
    BT --> PIN
    TUN --> EXT
    PIN -- "response stream" --> TEE
    API -- "response stream" --> TEE
    TUN -- "one meta row" --> RD
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

We inject `HTTPS_PROXY` (to route traffic through us) and
`NODE_EXTRA_CA_CERTS` (which *appends* our CA to Bun's trust store, so Claude
trusts our leaf while public TLS still works).

Claude's subprocesses inherit `HTTPS_PROXY` too -- the bash tool's
`curl`/`gh`, python hooks, statusline scripts -- and `NODE_EXTRA_CA_CERTS`
means nothing to them, so they'd die on TLS verification. For them we build a
**combined bundle** (your system CAs + our CA -- the standard vars *replace*
the trust store, so the mitm cert alone would break every non-proxied
connection) and export it as `SSL_CERT_FILE`, `CURL_CA_BUNDLE`,
`REQUESTS_CA_BUNDLE`, and `NIX_SSL_CERT_FILE`. Proxied requests verify via
our cert, direct ones via the system CAs -- subprocesses never need to know
which path a request took.

We deliberately do **not** set `HTTP_PROXY` -- the front door only speaks
CONNECT and would break subprocess plain-`http://` calls. That's the kind of
bug that makes you question your life choices at 2 AM.

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

- **Session replay P3/P4** -- opt-in `--record-timing` for chunk-timed
  streaming replay (true typewriter pacing), replay-polished snapshots.
  P1+P2 (stepper, transport bar, minimap, deep links) shipped. Design:
  [docs/design/session-replay.md](docs/design/session-replay.md).
- **WebSocket relay** -- the terminator refuses ws upgrades fast (clients
  fall back to HTTP cleanly); an actual relay that captures frames is the
  remaining tail of #20.
- **Tunnel PID attribution** -- on Linux the proxy can map a connection's
  source port to the owning process, so tunnel rows could say *which*
  subprocess called npm. Investigated in the 2026-07-15 devlog, deferred.
- **Conversation dump** -- export the reconstructed conversation as Markdown
  or JSON, ready for sharing or post-mortem analysis.
- **MCP server** -- query captured traffic programmatically from any agent
  (an agent *skill* ships in [skills/cctrace](skills/cctrace/SKILL.md); the
  MCP surface is the remaining half).
- **`inference_geo` / deeper tier visibility** -- surface where inference ran
  and per-tier breakdowns alongside the existing cost estimates.

See [CHANGELOG.md](CHANGELOG.md) for released changes.

## Development

```bash
bun test                                # unit tests
bun run tests/e2e-live.ts mitm "hi"     # end-to-end against real Claude
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
