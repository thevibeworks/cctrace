# Installing and running cctrace

Requires [Bun](https://bun.sh), `openssl`, and the CLI you want to trace
(`claude` on PATH for the default client).

## Install methods

```bash
# npm (needs Bun at runtime)
npm install -g @thevibeworks/cctrace

# or run without installing
bunx @thevibeworks/cctrace

# or clone
git clone https://github.com/thevibeworks/cctrace
cd cctrace
bun install
bun link            # optional: puts `cctrace` on your PATH

# or build a standalone binary (recommended)
git clone https://github.com/thevibeworks/cctrace
cd cctrace
make install        # compiles dist/cctrace, installs to ~/.local/bin
```

`make install` (or `make build`) compiles cctrace into a single executable
via `bun build --compile` -- Bun is needed to build, **not to run**. It's also
the install that makes `cctrace -- <claude args>` work verbatim (see the
pass-through caveat below). `make help` lists all targets; `PREFIX=/usr/local
make install` changes the destination.

## Runtime

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

## Prerequisites -- all three matter

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

## Passing args to the traced CLI

Everything after `--` goes to the traced CLI verbatim; flags before it belong
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

## All options

```
cctrace [CLIENT] [OPTIONS] [-- CLIENT_ARGS...]
```

| Option | Description |
|--------|-------------|
| `--mode MODE` | `auto` (default), `mitm`, `base-url`, `node` |
| `-s, --static` | Static mode (no live server; writes the `.jsonl` + a snapshot `.html`) |
| `-p, --port PORT` | Live UI port (default: 9317; auto-falls back if busy) |
| `--messages-only` | Capture only the model API calls (`/v1/messages` and friends) |
| `--capture-external` | Decrypt every host (default: non-first-party hosts tunnel opaquely with byte counts); external bodies over 64KB are summarized, not stored |
| `--intercept-host H` | Also decrypt host `H` (repeatable -- remote MCP servers, unusual providers) |
| `--no-open` | Don't auto-open the browser |
| `--print-ca` | Print the MITM CA cert path and exit |
| `--log NAME` | Custom log file base name |
| `--dir PATH` | Log directory (default: `.cctrace`) |
| `--fresh` | Don't merge prior traces of a continued session |
| `--with FILE` | Merge a specific trace file into the view (repeatable) |
| `--claude-path PATH` | Custom Claude binary path |
| `--client-path PATH` | Custom binary path for any client (codex/grok/kimi too) |
| `--data-dir PATH` | MITM CA / data dir (default: `~/.local/share/cctrace`; or `CCTRACE_DATA_DIR`. Legacy `--cache-dir` / `CCTRACE_CACHE_DIR` still work; a pre-0.6 CA in `~/.cache/cctrace` migrates over automatically) |
| `--no-update-check` | Skip the daily npm release check (or `CCTRACE_NO_UPDATE_CHECK=1`) |
