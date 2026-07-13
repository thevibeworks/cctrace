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
├── history.ts      # Cross-run session continuity: find prior traces by session_id; gz-aware reads
├── instances.ts    # Live-instance registry (`cctrace ps`, /api/instances, header switcher)
├── version.ts      # CCTRACE_VERSION + daily npm update check (cached in data dir, fail-soft)
├── view.ts         # `cctrace view`: rebuild a snapshot from a saved trace (file/session-id/fragment)
├── storage.ts      # `cctrace clean|merge|compress`: log-dir housekeeping (plan + apply)
├── ui.ts           # The whole web UI: Requests list + detail panel + Session view
├── replay.ts       # Session replay timeline primitives (inlined into UI)
├── pricing.ts      # Claude model pricing + per-pair cost estimation (inlined into UI)
├── summarize.ts    # Pure extractors: SSE usage, count_tokens, usage limits (inlined into UI)
├── session.ts      # Conversation reconstruction from wire pairs (inlined into UI)
├── html.ts         # Static HTML generator (legacy node mode only)
└── types.ts        # Shared types
```

`skills/cctrace/SKILL.md` is an agent skill teaching Claude Code agents to
drive cctrace — keep it in sync when the CLI surface or UI routes change.

## Capture modes

The CLI auto-selects, or force with `--mode <mitm|base-url|node>`.

### mitm (default for native binaries) — captures everything

TLS-intercepting proxy, Charles/mitmproxy style. This is the only mode that
sees the full picture, because Claude hardcodes some hosts (OAuth, usage,
credits) independent of `ANTHROPIC_BASE_URL`.

1. `ensureCerts()` generates a CA + leaf cert (Anthropic SANs) under
   `~/.local/share/cctrace/mitm/` (override: `--data-dir` / `CCTRACE_DATA_DIR`)
2. Front door: an http.Server answers `CONNECT`. Anthropic hosts are routed to a
   local `Bun.serve({ tls })` terminator; other hosts get a dynamically
   generated per-host cert signed by the same CA (blind tunnel only as a
   last resort when cert generation fails)
3. The TLS terminator decrypts, forwards to the real host, tees the response
   (stream to Claude + capture in parallel), logs the pair
4. Claude trusts our CA via `NODE_EXTRA_CA_CERTS` and routes through us via
   `HTTPS_PROXY`. Its subprocesses inherit the proxy too, so they get trust
   via a combined bundle (system CAs + mitm CA — `buildCaBundle` in
   src/certs.ts) exported as `SSL_CERT_FILE` / `CURL_CA_BUNDLE` /
   `REQUESTS_CA_BUNDLE` / `NIX_SSL_CERT_FILE`; those vars *replace* the trust
   store, hence the union (issue #17). `HTTP_PROXY` stays unset — the front
   door only speaks CONNECT and would break plain-http subprocess calls

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
The header identifies the run: project name (cwd basename, injected as
`PageMeta` by the server/CLI; unknown for `cctrace view` rebuilds) and the
current Claude session id (extracted client-side from pairs, newest live pair
wins, click to copy) — the tab title becomes `<project> · cctrace`. The
cctrace version (+ amber update link) sits top-right in its own `#ver` mount,
separate from the run identity. Two views, hash-routed:

- **Requests** (`#`, `#/p/<id>`): one row per request with inline
  human-readable chips — model, in/out tokens, one compact prompt-cache
  verdict chip (`summarizeCache` in src/summarize.ts: hit = read > 0, green,
  "↓read hit% ↑write" with a 1h-TTL breakdown since 1h bills 2x; cold =
  write only, amber; miss = cache_control set but nothing read/written;
  no chip when caching isn't used — tooltips spell the numbers out),
  estimated cost (src/pricing.ts: embedded sticker prices; cache rates via
  the universal multipliers 0.1x read, 1.25x 5m write, 2x 1h write; writes
  without a TTL breakdown are assumed 5m, same as ccusage), count_tokens
  results, usage window percentages (5h / 7d / per-model), telemetry event
  counts, error types. The detail panel adds prompt size, output tok/s, and
  a cost tooltip broken down by component; the Session view shows per-turn
  and per-thread cost. Clicking a row opens a split detail
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
  Every assistant turn links back to its wire request. The conversation pane
  tails like tail -f in live mode (open/refresh lands on the newest turn,
  sticky bottom, "new activity" pill when scrolled up, folds survive
  re-renders via positional restore); snapshots open at the top.
- **Replay** (inside the Session view): a time cursor over the same data —
  pairs whose response completed at or before the cursor are visible,
  everything after doesn't exist yet (`visibleAt` in `src/replay.ts`; the
  session rebuilds from the visible subset via the normal `buildSession`
  path). Toolbar "⏵ replay" or ←/→ enters it; ←/→ steps turns, shift+←/→
  steps wire requests, Space plays (setTimeout ladder over response-end
  boundaries, idle gaps compressed to ≤2s, speeds 1/2/8/60x), Home/End
  jump, Esc exits. The scrubber doubles as a minimap (turns = tall accent
  marks, errors red, probes short ticks). Deep links anchor on pair id —
  `#/session/<key>/@<pair-id>` opens paused at that moment (ids survive
  cross-run merges; wall-clock offsets wouldn't). Works identically in
  snapshots; live captures extend the track and "live ⤓" re-attaches the
  tail. P1+P2 shipped; P3 (--record-timing chunk replay) + P4 remain
  (docs/design/session-replay.md).
- Pure data extraction lives in `src/summarize.ts` + `src/session.ts`,
  inlined into the page via `Function.prototype.toString()` (same pattern as
  `categorize.ts`), so it is unit-testable and live/snapshot UIs cannot drift.
- UI design language and feature designs are written down in `docs/design/`
  (`ui.md` = the rules; `session-replay.md` = the replay proposal). Read
  `ui.md` before adding UI.

## Commands

```bash
cctrace                       # auto mode (mitm on native), capture everything
cctrace --mode base-url       # lightweight, messages only, no CA
cctrace --messages-only       # capture only /v1/messages
cctrace --print-ca            # print MITM CA cert path
cctrace -s                    # static mode (files only, no live UI)
cctrace -- --continue         # everything after -- goes to Claude verbatim
cctrace -- -p "explain this"  # (-p after -- is Claude's, before it cctrace's)
cctrace codex -- exec "..."   # trace the OpenAI Codex CLI instead of Claude
cctrace grok -- -p "..."      # trace the Grok CLI
```

**Client profiles** (`src/clients.ts`, issue #20 first cut): a leading client
word (`claude`|`codex`|`grok`) picks who gets traced; the rest of the grammar
is unchanged. Non-Claude clients always run mitm — HTTPS_PROXY + the combined
CA bundle (#17) cover their Rust/Go/native TLS stacks; `--client-path`
overrides discovery for any client. Their model calls are OpenAI-shaped
(`.../responses`, `.../chat/completions` — matched by path tail since custom
providers mount them under arbitrary prefixes) and categorize as Messages
(`categorizeUrl` classifies wire shape BEFORE host, issue #19 — which also
puts third-party `ANTHROPIC_BASE_URL` providers' `/v1/messages` in Messages
instead of External). Session-view reconstruction of OpenAI SSE remains
follow-up work (#20).

Trace-management subcommands bypass the OPTIONS/`--` grammar (dispatched in
`cli.ts` before the strict parser). They read saved traces only — no proxy, no
Claude spawn. `clean`/`merge`/`compress` are dry-run by default; `--yes` applies.

```bash
cctrace view <file|session-id|fragment>   # rebuild a snapshot .html and open it
cctrace view <target> --serve [--port N]  # serve it from the live web server instead
                                          # (huge traces: no 400MB .html; registers
                                          # in the instance registry, mode "view")
cctrace clean [--yes]                     # rm regenerable .html + 0-byte traces
cctrace merge [--prune] [--yes]           # one deduped session-<id>.jsonl per session
cctrace compress [--older-than N] [--yes] # gzip -9 archive; view reads .jsonl.gz
cctrace ps [--json]                       # list live cctrace instances (URL, project, session)
cctrace --version                         # print version (+ newer version if known)
```

**Multi-instance**: every live run registers itself in `<data-dir>/instances/
<run-id>.json` (unique run id, port, project, session id once seen on the
wire), rewrites it every 30s (heartbeat), and unregisters on exit. Liveness
is NEVER judged by pid — the registry dir is often shared across pid
namespaces (containers sharing a $HOME volume + forwarded localhost ports),
where pid checks fail both ways; pre-0.10 readers even deleted other
namespaces' live entries. Instead: a heartbeat-fresh file counts as alive, a
stale one must answer a probe of `/api/self` on its port (matched by run id;
refused/mismatch ⇒ GC, timeout ⇒ hidden but kept, no heartbeat for 24h ⇒
GC), and the listing also sweeps the port walk (9317..9326) to synthesize
entries for live-but-unregistered instances straight from `/api/self`
(`src/instances.ts`). `cctrace ps` lists live runs; the server exposes
`/api/instances` (verified listing) and `/api/self` (identity, from memory —
never triggers registry reads). The web UI header grows a "⇄ N more"
switcher when other instances exist. Port allocation walks 9317, 9318, ...
before falling back to an OS-assigned port, so concurrent runs land on
predictable neighbors — the same walk the discovery sweep covers.

**Update check** (`src/version.ts`): startup reads only a local cache
(`<data-dir>/update-check.json`) — never the network — and refreshes it in
the background at most every 24h from the npm registry (3s timeout,
fail-soft), so a new release is offered on the run after it's seen. On a
TTY (and never in Claude's `-p` print mode) a newer version prompts
`upgrade now? [y/N]` (10s timeout = No); declining snoozes that version
(quiet one-line notice from then on). Accepting auto-runs `npm i -g` /
`bun add -g` only when the install method is unambiguous from
`import.meta.path`; compiled/source installs get printed instructions
instead. The UI header shows the version and an amber "vX available" link
(`PageMeta.version` / `latestVersion`). Opt out: `--no-update-check` or
`CCTRACE_NO_UPDATE_CHECK=1`.

The MITM CA / data dir is `~/.local/share/cctrace` (XDG data — the CA is
identity material; rotating it breaks any trust exported via `--print-ca`, so
it must not live where cache cleaners sweep) for every install method (source,
`bun link`, compiled binary), overridable via `--data-dir` / `CCTRACE_DATA_DIR`
(legacy `--cache-dir` / `CCTRACE_CACHE_DIR` still honored). A pre-0.6 CA found
in `~/.cache/cctrace` is moved once, preserving CA identity (`migrateCaDir` in
`src/certs.ts`).

CLI parsing lives in `src/args.ts`: argv splits at the first `--` (rest goes
to Claude untouched); cctrace's own flags parse strict, so unknown options
error with a "put it after --" hint instead of being silently swallowed.

**Bun `--` quirk**: bun's CLI (bun run / bunx / bun-link shim) eats a *leading*
`--`, so `cctrace -- --help` only works from the compiled binary. `make build`
compiles `dist/cctrace` (`bun build --compile`, never `--minify` — the UI
inlines functions via `toString()`); `make install` puts it in `~/.local/bin`.
The compiled binary uses `~/.local/share/cctrace/` instead of the repo `.cache/` and
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
- **Dynamic certs for non-Anthropic hosts**: the pre-generated leaf only has
  Anthropic SANs; other hosts get a per-host cert minted on first contact
  (cached on disk), so external traffic is captured too. Blind tunnel remains
  the fallback when cert generation fails (no openssl).
- **Storage subcommands never shrink data**: `merge`/`compress` union with an
  existing `session-*.jsonl` / `.gz` instead of overwriting; `clean` verifies
  an `.html` has a source trace before calling it regenerable; every unlink
  re-stats first so a live capture appending between plan and apply is skipped,
  not truncated (`src/storage.ts`, regression-tested).
- **Guarded pump, not `tee()`**: responses stream to Claude chunk-by-chunk while
  the same chunks accumulate for capture (`captureTee` in `src/stream.ts`).
  `ReadableStream.tee()` was abandoned: its native cancel path can crash the
  whole Bun process (`TypeError: null is not an object` in stream builtins)
  when a proxied connection drops mid-SSE, and it buffers unboundedly when one
  branch is slow. The pump guards every controller call, keeps capturing after
  a client abort (an interrupted request still logs its full response, or
  partial + `truncated: true` if upstream died), and applies real backpressure.
- **The proxy must never take down the session**: if cctrace dies, Claude's
  `HTTPS_PROXY` dies with it. Capture runs install `uncaughtException` /
  `unhandledRejection` handlers (log one line, keep serving), every proxy
  `Bun.serve` sets `idleTimeout: 0` (the 10s default would kill idle-quiet
  connections) plus an `error` hook (one failed request, no TUI spew), and
  `flush()` is capped at 5s so an abandoned capture can't hang exit.
- **accept-encoding: identity**: avoid gzip/br decompression mismatch when
  forwarding to Claude.
- **flush() before exit**: async captures must finish before the process exits,
  or pairs are lost.
- **Session continuity is viewer-side, keyed by wire session_id**: each run
  still writes its own immutable `trace-<ts>.jsonl`. Claude Code sends its
  session id in every /v1/messages request (`metadata.user_id` JSON), so when
  a live pair reveals a session_id found in a prior trace in the log dir,
  `history.ts` loads those pairs (marked `pair.prior = <file>`, deduped by
  pair id) into the server and the snapshot. Old turns then regain per-turn
  usage/duration/wire links in the Session view — the attribution loop in
  `session.ts` doesn't care which run a request came from. `--fresh` opts out,
  `--with FILE` force-merges. Append-to-one-file was rejected: it corrupts on
  unrelated sessions and still needs the same load-at-startup machinery.

## Testing

```bash
bun test                                # unit: proxy, certs, tunnel, abstraction
bun run tests/e2e-live.ts mitm "hi"     # e2e against real claude, all hosts
bun run tests/e2e-live.ts base-url "hi" # e2e, messages only
```

Results (incl. real captures) land in `test-output/` — gitignored. Latest run:
`test-output/SUMMARY.md`.
