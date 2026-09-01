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
├── clients/        # Client plugins: binary discovery + declarative wire tables
│                   #   (claude/codex/grok/kimi/opencode — dialect, firstPartyHosts,
│                   #   category pins, session/thread headers, providerHosts for
│                   #   multi-provider clients; JSON-safe, embedded into
│                   #   the page as CLIENT_WIRE; adding a client = one file)
├── dialects/
│   └── openai.ts   # OpenAI adapters. Responses (codex/grok): response.completed
│                   #   parsing, input[]->turns. Chat Completions (kimi): messages[]
│                   #   ->input[] via openaiInput + a chat branch in openaiCompleted
│                   #   (chunk deltas + prompt_tokens), so both fold into the SAME
│                   #   turn/usage model; usage mapping (inlined into UI)
├── server.ts       # Bun.serve() + WebSocket relay (page lives in ui.ts).
│                   #   Frames: init (pairs + open `starts`), pair, history,
│                   #   purged, start — a messages request announced as it
│                   #   is FORWARDED (proxies mint the pair id first), retired
│                   #   when its pair lands: the page's "thinking now" state
├── history.ts      # Streaming trace readers (traceLines/readTracePairs: plain/.zst/.gz, line
│                   #   by line, tail budget TAIL_BYTES = newest 256 MB) + cross-run session
│                   #   continuity: find prior traces by session_id, newest first, one budget;
│                   #   newest-prior-session guess for --continue preload
├── termlog.ts      # Terminal guard: cctrace output buffers while the traced TUI owns the screen, flushes at exit
├── title.ts        # `cctrace title`: the DATA layer for session naming — extract a
│                   #   session's SPINE (human prompts + agent final answers, main chat
│                   #   only, no tools/sub-agents) into a digest, store/serve titles
│                   #   (titles.json per store dir, shown in dashboard/history/picker/
│                   #   header). The namer is the cctrace-title skill (subagent fan-out);
│                   #   cctrace itself never calls a model. `title --json` lists digests,
│                   #   `title set <id> "<title>"` writes one
├── report.ts       # End-of-run close-out: Traced/Session/failed lines (pairs by
│                   #   category, wall-clock, on-disk size, sids, tokens+cache%,
│                   #   est cost — this run's pairs only, prior merges excluded)
├── instances.ts    # Live-instance registry (`cctrace ps`, /api/instances, header switcher)
├── version.ts      # CCTRACE_VERSION (+ commit hash: build --define, git fallback on source runs) + daily npm update check (cached in data dir, fail-soft)
├── view.ts         # `cctrace view`: rebuild a snapshot from a saved trace (file/session-id/fragment);
│                   #   streams from the tail (--full = everything), reports what it left out
├── storage.ts      # `cctrace clean|merge|compress|purge`: log-dir housekeeping (plan + apply);
│                   #   the zstd codec (streamed, L9 + 128MB window) + the exit-time
│                   #   archive/stale-sweep helpers
├── store.ts        # The trace store: <data-dir>/traces/<project-key>/ layout, project
│                   #   marker, legacy ./.cctrace detection, `cctrace store` listing,
│                   #   `cctrace adopt` (docs/design/store.md)
├── compact.ts      # `cctrace compact`: supersede-stub messages bodies + exemplar
│                   #   retention for noise categories (-95%+, body-level only)
├── spec.ts         # `cctrace spec`: observed-wire catalog (endpoints, header
│                   #   names, body shapes, SSE events — counts + provenance,
│                   #   values redacted except negotiation headers/model ids;
│                   #   diff = what changed on the wire between observations)
├── icons.ts        # Per-client icon glyphs — ONE source for every surface that
│                   #   labels a CLI (trace view header, dashboard rows)
├── ui.ts           # The whole web UI: Requests list + detail panel +
│                   #   Sessions + Context views (three tabs). Context is a
│                   #   DevTools-shaped shell: an interactive overview
│                   #   (two tracks, one brush) driving three decks —
│                   #   window / stream / events
├── replay.ts       # Session replay: the time cursor primitives (visibleAt,
│                   #   boundaries, tick ladder, slices) + the STAGE readings
│                   #   of a cursor — sessionLanes (human/model/tools/agents/
│                   #   harness over wall-clock), stateAt/nowAt/loopAt (the
│                   #   observed state at the cursor, read into one NOW line
│                   #   and lit on the LOOP ROW in the replay bar),
│                   #   soFar (the tally behind it), axisTicks (the strip's
│                   #   clock ruler), beatAt (the step's calls fused with
│                   #   results, plus its loop's head), chaptersOf (loops).
│                   #   Pure, inlined into the UI (docs/design/replay-stage.md)
├── pricing.ts      # Per-pair cost: models.dev catalog first, embedded Claude
│                   #   table as the offline fallback (inlined into UI)
├── pricing-catalog.ts # models.dev api.json fetch — 24h-TTL fail-soft cache in
│                   #   the data dir, filtered to anthropic/openai/xai
├── cost.ts         # The cost layer (inlined into UI): stepCost (per-pair bill
│                   #   by component, memoized as _sc), threadCostSplit (a
│                   #   thread's bill byPair/byModel), costEvents (the BUMPS —
│                   #   a weak/cold cache hit priced against warm, caused by
│                   #   retry / expiry vs the write's TTL / a changed prefix)
│                   #   and usagePolls (the account quota the client polled).
│                   #   Estimates from catalog rates, causes from the wire
│                   #   (docs/design/cost.md)
├── summarize.ts    # Pure extractors: SSE usage, count_tokens, usage limits (inlined into UI)
├── session.ts      # Conversation reconstruction from wire pairs (inlined into UI).
│                   #   threadTimeSplit: where a thread's wall-clock went
│                   #   (model/tools/waiting/between) off attributed pairs —
│                   #   the Sessions "time" chip, the context overview's
│                   #   time track (per-step, via byPair) and its margin
├── context.ts      # The context layer (inlined into UI): per-request window
│                   #   composition (6 categories), per-thread timeline +
│                   #   events (injections/compactions/model/tool changes),
│                   #   and the CONTEXT GRAPH — the assembled window as a
│                   #   weighted tree, category -> group -> item (tool
│                   #   results by tool, schemas by MCP server, injections
│                   #   by producer, conversation by turn). Every request
│                   #   body IS the assembled context, so steps are exact
│                   #   and anchored to that pair's usage. The sessions
│                   #   rail carries the same data as the trajectory
│                   #   gutter. Pane rows carry PROVENANCE — the wire
│                   #   request that first carried an item into the window
│                   #   (ctxOriginTurn, content-verified against the spine;
│                   #   semantica's fact->source trail), clickable to pin
│                   #   that step. trajectoryRecords: the thread as one
│                   #   linear stream of records (system/user/CONTEXT-inline/
│                   #   assistant/tool call+result) — the context view's
│                   #   STREAM deck, MAP/READ/FULL from archify
│                   #   (docs/design/context-view.md)
├── vendor/
│   └── marked.umd.js  # Vendored marked.js UMD (GFM markdown for session text)
├── html.ts         # Static HTML generator (legacy node mode only)
└── types.ts        # Shared types
```

`skills/cctrace/SKILL.md` is an agent skill teaching Claude Code agents to
drive cctrace — keep it in sync when the CLI surface or UI routes change.

## Capture modes

The CLI auto-selects, or force with `--mode <mitm|base-url|node>`.

### mitm (default for native binaries) — captures all first-party traffic

TLS-intercepting proxy with an SSL-proxying include-list — Charles' actual
model (devlog 2026-07-15). This is the only mode that sees the full
first-party picture, because Claude hardcodes some hosts (OAuth, usage,
credits) independent of `ANTHROPIC_BASE_URL`.

1. `ensureCerts()` generates a CA + leaf cert (Anthropic SANs) under
   `~/.local/share/cctrace/mitm/` (override: `--data-dir` / `CCTRACE_DATA_DIR`)
2. Front door: an http.Server answers `CONNECT` and decides scope on the
   CONNECT line, before any TLS. Include-listed hosts (`buildInterceptSet`
   in src/certs.ts: the client's `firstPartyHosts` + `hostCategories` pins
   + base-url env hosts + `--intercept-host` extras + the client plugin's
   `configHosts` discoveries — codex reads every `model_providers.*
   base_url` in `$CODEX_HOME/config.toml`, fail-soft, so a custom provider
   is captured without flags) are MITM'd — Anthropic
   hosts via the static leaf terminator, others via dynamically generated
   per-host certs signed by the same CA. Every other host is an OPAQUE
   byte-counted tunnel: no forged cert (cert-pinning tools and system-store
   readers like apt keep working), one ~100-byte meta pair per connection
   (host, bytesUp/Down, duration — the "claude touched X" audit trail).
   `--capture-external` restores MITM-everything — with external BODIES
   capped at 64KB (`EXTERNAL_BODY_CAP` in src/mitm.ts: larger request/
   response bodies become meta stubs with exact byte counts + content type,
   same shape as compact's; url/status/headers/timing/sizes stay — the
   audit trail without the 52MB tarball or token-authed gh response in the
   trace). Enrolled hosts (`--intercept-host`) always capture in full — the
   user named them. The tunnel is also the
   last resort when cert generation fails
3. The TLS terminator decrypts, forwards to the real host, tees the response
   (stream to Claude + capture in parallel), logs the pair
4. Claude trusts our CA via `NODE_EXTRA_CA_CERTS` and routes through us via
   `HTTPS_PROXY`. Its subprocesses inherit the proxy too, so they get trust
   via a combined bundle (system CAs + mitm CA — `buildCaBundle` in
   src/certs.ts) exported as `SSL_CERT_FILE` / `CURL_CA_BUNDLE` /
   `REQUESTS_CA_BUNDLE` / `NIX_SSL_CERT_FILE`; those vars *replace* the trust
   store, hence the union (issue #17). `HTTP_PROXY` stays unset — the front
   door only speaks CONNECT and would break plain-http subprocess calls.
   Alongside the plumbing, the child also gets trace IDENTITY
   (`traceIdentityEnv` in src/capture.ts, both proxy modes):
   `CCTRACE_TRACE_FILE` always, plus `CCTRACE_SERVER_PORT` +
   `CCTRACE_INSTANCE_ID` on live runs — so subprocesses of a traced
   session (statuslines, hooks, nested agents) can KNOW they're captured
   and where the UI serves, without registry heuristics. Node mode has
   exported these names since day one; the proxy modes agree now.
   `--bypass-host HOST` (repeatable, #83) appends to the child's
   NO_PROXY/no_proxy (inherited values preserved): the named host talks
   direct with the tool's normal non-proxy behavior — for tools that swap
   HTTP stacks when a proxy is present (wrangler); the only capture loss
   is that host's ~100B tunnel meta pair

Captures `/v1/messages`, `/api/oauth/*` (incl. usage/credits), `/api/claude_cli/*`,
`/mcp-registry/*`, `/api/event_logging/*`, plus Claude Code's datadog intake
(pinned to telemetry in src/clients/claude.ts). Remote MCP servers on
arbitrary hosts tunnel by default — enroll them with `--intercept-host`.

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

The web UI's full behavior spec lives in docs/design/web-ui.md (one
self-contained page in ui.ts: Requests + Sessions + Replay views).
Read docs/design/ui.md for the design rules before adding UI.

## Commands


**Client plugins** (`src/clients/`, #20): a leading client word
(`claude`|`codex`|`grok`|`kimi`|`opencode`) picks who gets traced; the rest of the grammar is
unchanged. Non-Claude clients always run mitm — HTTPS_PROXY + the combined
CA bundle (#17) cover their Rust/Go/native TLS stacks; `--client-path`
overrides discovery for any client. Each plugin is one self-describing
module: binary discovery + a declarative, JSON-safe `wire` table (dialect,
firstPartyHosts, host->category pins, session/thread header names) — adding
a client is one new file + a registry entry, zero core edits. The merged
tables embed into the page as `CLIENT_WIRE` data, so the plugin boundary
lives in the source tree while the page stays flat (the toString() inlining
pattern is untouched).

Their model calls are OpenAI-shaped (`.../responses`,
`.../chat/completions` — matched by path tail since custom providers mount
them under arbitrary prefixes) and categorize as Messages (`categorizeUrl`
classifies wire shape BEFORE host, issue #19 — which also puts third-party
`ANTHROPIC_BASE_URL` providers' `/v1/messages` in Messages instead of
External). The rest of a labeled client's traffic categorizes through its
wire table: host pins first (incl. third-party analytics the client calls —
mixpanel/otlp pin to telemetry so `purge --drop telemetry` sweeps them),
then unpinned first-party traffic lands in "other" (the keyword taxonomy
stays Anthropic-only), and genuinely foreign hosts (github, npm, pypi) stay
External. Unlabeled pre-0.13 pairs categorize exactly as before
(regression-tested). Session reconstruction for the OpenAI dialect is in
`src/dialects/openai.ts` (see the Sessions view above); wire session ids
come from headers — or a body field the wire table names
(`sessionBodyField`) — via `extractSessionId(pair, wire)`, so cross-run
continuity works for codex/grok/kimi/opencode too. Kimi Code's coding-plan calls are
OpenAI Chat Completions (`.../chat/completions`, matched by the same path
tail) — categorized as Messages, reconstructed via the `openaiInput` adapter
(above); its host pins (`api.kimi.com/coding/v1/{usages,models,feedback}`,
`auth.kimi.com`, `telemetry-logs.kimi.com`) sort the rest. Its session id is
the body's `prompt_cache_key` (K3+; K2.7-era traces have none and stay
per-run). Kimi coding-plan models price as ESTIMATES at the equivalent
pay-per-token rates (`CATALOG_ALIASES` in src/pricing-catalog.ts: wire
`k3` -> models.dev `moonshotai/kimi-k3` — models.dev's own kimi-for-coding
provider lists $0 subscription prices, and the cost chip estimates spend
the same way it does for Claude Max OAuth traffic).

opencode (#89) is the multi-provider client: the chosen model decides which
provider gets the call (OpenCode Zen gateway at `opencode.ai/zen`, BYO
Anthropic/OpenAI, copilot, openrouter, ...), and zen itself mounts BOTH
dialects (`/zen/v1/messages` + `/zen/v1/responses|chat/completions`) — no
per-host dialect machinery needed because `wireDialect(pair)` already picks
anthropic vs openai PER PAIR from the path shape; the client-level `dialect:
"openai"` only steers categorizeUrl's fallback. Interception scope comes
from `wire.providerHosts` (new in 0.38: single-purpose LLM API hosts a
multi-provider client can route to, enrolled unconditionally by
`buildInterceptSet` — safe because decrypting a model-API host can only
capture model traffic; shared hosts like github.com/googleapis.com stay
opaque tunnels on purpose) plus `configHosts` scanning `"baseURL"` values
in every opencode.json(c) the client would read ($OPENCODE_CONFIG, global
config dir, cwd). Zen calls carry the sqlite session id on the wire
(`x-opencode-session: ses_…`), so cross-run continuity + exit auto-merge
work unchanged; zen-only models price via the models.dev `opencode`
provider, appended LAST in PRICING_PROVIDERS so resold claude/gpt ids keep
the originating provider's rates.

Trace-management subcommands bypass the OPTIONS/`--` grammar (dispatched in
`cli.ts` before the strict parser). They read saved traces only — no proxy, no
Claude spawn. `clean`/`merge`/`compress`/`purge` are dry-run by default;
`--yes` applies.

The annotated per-command reference lives in docs/design/cli.md;
`cctrace --help` and skills/cctrace/SKILL.md cover day-to-day usage.

The `.jsonl` is the deliverable: live runs do NOT write a snapshot `.html` at
exit anymore (a 2h session produced ~400MB of HTML) — `view --html` renders
one on demand; static mode (`-s`) still writes one, that's its point. Every
captured pair is labeled with the producing client (`pair.client`, set in the
cli.ts log sink), which feeds the UI header chip/title, `ps`'s CLIENT column,
and the instance registry.

**The trace store** (0.41, `src/store.ts`, docs/design/store.md): traces
live in `<data-dir>/traces/<project-key>/` — one dir per project cwd, keyed
the way Claude Code keys `~/.claude/projects/` (path with non-[A-Za-z0-9-]
→ `-`), a `project.json` marker holding the exact path — never in the
project tree. The data dir is what containers sharing `$HOME` already
share (the registry lives there), so a run traced in one container opens
from any other; `--dir DIR` still overrides (write there, read only there).
A live run writes plain `.jsonl`; at exit it archives its trace to
`.jsonl.zst` FIRST (`sealTrace` in cli.ts → `restFile` → `archiveTrace`/
`applyCompress`: streamed, decode-verified before the plain source is
unlinked, two attempts because a tunnel closing as the child dies can log
its meta pair mid-compress), THEN auto-merges its sessions (the fresh
`.zst` reads like any source; the id scan streams via `traceLines` and a
session with a source over `MERGE_MAX_SOURCE_BYTES` = 1 GiB is blocked
with the reason, never attempted), archives what the merge wrote, and
sweeps the dir for plain leftovers of killed runs (`planStaleSweep`:
minted `trace-*`/`session-*` names only, idle > 24h, not this run's file,
not any heartbeat-fresh registry logFile — matched as recorded AND as
mapped into this side's store dir, `liveLogFiles` in store.ts) and the
`.tmp` of a killed archive (`sweepOrphanTmps`, idle > 1h). The supersedes
overwrite is stamped (`ArchiveStamp` from planMerge: overwrite only while
the archive on disk is the one the plan saw), the union path is
damage-aware, temp names carry the pid. `--no-compress` opts out. The
seal runs in a DETACHED helper (`cctrace __seal <job...>`, one
`seal-<run>-<ts>.json` per run in the data dir root) spawned in its own
session (setsid) so the shell returns the moment the plain trace is safe
and a closed terminal doesn't kill it; the helper heartbeats the job file
and re-points the run's tombstone at the archive when done (`patchEntry`).
A container torn down mid-seal orphans the job: every live run's startup
re-spawns jobs idle > 10 min (`recoverSeals`, folded per project dir so N
orphans cost one scan, one sequential helper, 3 attempts then dropped out
loud) and `cctrace compress --yes` finishes them inline first. Archive-
first is the load-bearing order: with merge-first, 56 of 58 helpers in a
real data dir died with 33 GB still plain (2026-08-26). `CCTRACE_SYNC_SEAL=1`
forces inline; static mode seals inline (its snapshot needs the pairs). Legacy `./.cctrace` dirs are read for continuity
(`resolveTraceDirs` → `readDirs`, threaded through history/view/server)
and print a one-line `cctrace adopt` hint; `adopt` moves them in
(rename / EXDEV copy+verify, skips live + fresh + name-collisions, re-points
registry entries; `--rebase FROM=TO` keys dirs mounted from another machine
by that machine's project paths, which is what the shared registry
records; `--copy --zst` builds a verified compressed mirror without
touching the sources). Every trace-reading subcommand defaults to the
project's store dir; the housekeeping five take `--all`. `cctrace store`
is the size picture.

**Multi-instance**: every live run registers itself in `<data-dir>/instances/
<run-id>.json` (unique run id, port, project, session id once seen on the
wire, the human's first real prompt (`firstPrompt`, stamped once via the
server's onPrompt callback — firstPromptOfPair in src/session.ts skips
harness prompts and the "quota" probe; it is the trace's identity in the
view picker), plus its own pid and the traced client child's `agentPid` —
informational only: pids are namespace-local and never feed liveness).
Capture runs don't delete their entry on exit — they TOMBSTONE it
(`endedAt` stamped, heartbeat stopped): the tombstones are the cross-project
run catalog (client, project path, absolute trace file, session id) behind
`cctrace view`'s "recent runs elsewhere" picker section, pruned after 30
days, re-stat'd before offering (a path from another container may not
resolve here — such runs just don't list, never error). `cctrace view`
servers still unregister (a view is not a run). User-facing listings (`ps`,
the switcher, `/api/instances`) sort project-first, newest first within —
registry scan order is arbitrary. Live entries rewrite every 30s
(heartbeat). Liveness
is NEVER judged by pid — the registry dir is often shared across pid
namespaces (containers sharing a $HOME volume + forwarded localhost ports),
where pid checks fail both ways; pre-0.10 readers even deleted other
namespaces' live entries. Instead: a heartbeat-fresh file counts as alive, a
stale one must answer a probe of `/api/self` on its port (matched by run id;
refused/mismatch ⇒ GC, timeout ⇒ hidden but kept, no heartbeat for 24h ⇒
GC), and the listing also sweeps the port walk (8722..8731, plus the legacy 9317..9326) to synthesize
entries for live-but-unregistered instances straight from `/api/self`
(`src/instances.ts`). `cctrace ps` lists live runs; the server exposes
`/api/instances` (verified listing) and `/api/self` (identity, from memory —
never triggers registry reads). The web UI header grows a "⇄ N more"
switcher when other instances exist. EVERY live/view server also serves
`/dashboard` — the central picture: verified live instances + finished
runs (`/api/runs`, traceExists + on-disk size re-resolved per request via
`findTraceCarrier` in src/view.ts — the tombstone's logFile, its .zst/.gz
sibling, or the session-<sid8> file auto-merge absorbed it into, so
compressed/merged traces still open; only a truly absent trace dims),
groupable by project/client/time with show-more paging, one page for all
projects/containers sharing the data dir; any instance's port answers the
same (`src/dashboard.ts`, values rendered via textContent — first prompts
are wire-derived; icon glyphs come from `src/icons.ts`, the same marks as
the trace view header). A finished run's row shows the stats its tombstone
carries — pairs/messages/tokens/est cost, stamped once at exit
(`TraceStats` from `traceSummary`, cli.ts `onStats`) — and OPENS directly:
`/view/<run-id>` renders a snapshot on demand from the run's trace, the id
resolved through the registry server-side (the page never names a file;
sid-bearing runs merge every trace of that session, same continuity as
`cctrace view <sid>`; `findTraceCarrier` tries the recorded path, its
.zst/.gz and session-file forms, then the same names in the project's
STORE dir — so an adopted or store-native trace opens even from a
tombstone that named the legacy path). Linked from the switcher menu, the
⌘ actions menu, an always-visible ▦ header icon on http-served pages, a
startup `Dashboard (all runs)` line, and a `cctrace ps` footer line. Port
allocation walks 8722..8821 (`PORT_WALK` = 100) before falling back to an
OS-assigned port, so concurrent runs land on predictable neighbors — the
same walk the discovery sweep covers. Env `PORT` is not honored (0.41):
the fixed range is the whole port story.

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

## Key design decisions

- **MITM default**: native Claude (>= v2.0.26) is a Bun-compiled binary;
  `node --require` can't inject. TLS interception captures everything at the
  transport layer, below URL construction.
- **Tunnel-by-default (0.16, devlog 2026-07-15)**: MITM-everything was the
  bug — a deva smoke test traced a 52MB npm tarball into mojibake, gh API
  response bodies (token-authed) landed verbatim, and any subprocess that
  takes CA trust from outside the env vars (apt, java, cert pinning) would
  hard-fail TLS. The include-list dissolves all three: only first-party +
  pinned + enrolled hosts decrypt; the rest pass through opaque with byte
  counts. Scope decides at CONNECT time (host-level) because the path is
  only visible after decryption. Per-process interception without env vars
  was investigated and ruled out — no portable unprivileged mechanism.
- **Dynamic certs for non-Anthropic hosts**: the pre-generated leaf only has
  Anthropic SANs; other hosts get a per-host cert minted on first contact
  (cached on disk), so external traffic is captured too. Blind tunnel remains
  the fallback when cert generation fails (no openssl).
- **Storage subcommands never shrink data**: `merge`/`compress` union with an
  existing `session-*.jsonl` / `.gz` instead of overwriting; `clean` verifies
  an `.html` has a source trace before calling it regenerable; every unlink
  re-stats first so a live capture appending between plan and apply is skipped,
  not truncated (`src/storage.ts`, regression-tested). The one sanctioned
  overwrite: the exit archive of a session file the auto-merge JUST wrote
  (`supersedesArchive`) — planMerge unioned the prior archive into it or
  blocked, so the plain file is a verified superset.
- **Central store, compressed at rest (0.41)**: per-project `./.cctrace/`
  was the right first move and the wrong steady state — 73 GB across ~50
  dirs nobody could `du`, and 255/272 dashboard runs unopenable from any
  container but the one that wrote them. The store rides the data dir
  (already shared), stays per-project inside it (housekeeping scans one
  project's worth, `rm -rf` one dir reclaims one project), and archives at
  exit because the measurement said so: zstd L9 with a 128 MB window is 87x
  at ~1 GB/s on a real session trace (L19: same 87x at 53 MB/s; L3 default
  window: 33x — the redundancy is one request body apart, so the window is
  what matters). Capture itself stays plain: tail-able, torn-line
  recoverable, and the compressed form is verified before the plain one
  goes. Streaming compression of the LIVE file was rejected — every reader
  would need frame-aware tailing for a peak-disk win that only matters in
  the multi-GB-single-run case `compact` addresses better.
- **compact folds bodies, never deletes pairs** (`src/compact.ts`, measured
  on 4.3GB of real traces): ~79% of trace bytes are messages request bodies
  re-sending the whole conversation. Per thread-EPOCH (a history-length drop
  = compaction/clear closed an epoch) the longest request stays full; the
  rest become stubs carrying model/metadata/historyLen/firstUserText/
  keptPairId, so grouping, per-turn attribution, and continuity all still
  work (`session.ts` is stub-aware; regression: thread set, turn count,
  per-turn pairId attribution and token totals are identical pre/post
  compact — NOT the whole buildSession object: a stubbed turn's request
  meta — stream/max_tokens/temperature/tool count/system-block count —
  reads as absent, and `spec` sees the stub as a request-body shape).
  Measured 2026-08-18 on real ~215MB traces: after zstd-at-rest (0.41)
  compact saves 0.5-1.4MB more per trace, and files >=2GB can't be
  compacted at all (whole-file string read; JSC's 2^31-1 cap) — so it is
  a niche tool now, not a step in the store migration. Noise categories (telemetry/external/
  bootstrap) get exemplar retention per (host, path): first/last/largest/
  slowest/every-error keep bodies, the rest go meta-only — deterministic,
  unlike sampling. Responses are never touched (each exists once). Post-hoc
  only: capture stays lossless, the longest request isn't known until the
  session ends. Whole-pair deletion stays `purge` — a privacy tool, not a
  size optimization. Known loss (stated in --help): exact wire bytes of
  superseded requests. Same plan/apply + re-stat discipline as storage.ts.
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
- **Request bodies forward as raw bytes**: codex zstd-compresses request
  JSON; the old `req.text()` decode corrupted it irreversibly (upstream
  400s). The proxies forward the untouched bytes and decode a copy for the
  trace (`decodeBodyForTrace` in src/stream.ts — undoes declared
  content-encoding, summarizes undecodable binary instead of mangling it).
- **WebSocket upgrades are refused fast (501)**: the TLS terminator has no ws
  handler; forwarding the handshake via fetch() handed clients a convincing
  101 whose frames went nowhere (codex hung ~82s/attempt until upstream's
  ping timeout, `request_kind: prewarm`). A fast refusal makes clients fall
  back to plain HTTP immediately; a real ws relay is follow-up work (#20).
- **Pair ingestion is in-process**: the CLI sink hands pairs to the live
  server via the `ingest` callback `createServer` returns, not a loopback
  POST. `/api/pair` remains only for legacy node mode's child process and
  requires the run's instance id (`x-cctrace-instance`) — the socket can be
  reachable across containers/LAN.
- **flush() before exit**: async captures must finish before the process exits,
  or pairs are lost.
- **Session continuity is viewer-side, keyed by wire session_id**: each run
  still writes its own immutable `trace-<ts>.jsonl`. Claude Code sends its
  session id in every /v1/messages request (`metadata.user_id` JSON), so when
  a live pair reveals a session_id found in a prior trace in the log dir,
  `history.ts` loads those pairs (marked `pair.prior = <file>`, deduped by
  pair id) into the server and the snapshot. Old turns then regain per-turn
  usage/duration/wire links in the Sessions view — the attribution loop in
  `session.ts` doesn't care which run a request came from. `--fresh` opts out,
  `--with FILE` force-merges. Append-to-one-file was rejected: it corrupts on
  unrelated sessions and still needs the same load-at-startup machinery.
- **Auto-merge at exit consolidates the DISK side of that continuity**
  (`autoMergeOnExit` in src/cli.ts): capture stays one immutable file per run,
  but at exit the run folds its OWN sessions into `session-<sid8>.jsonl` and
  prunes the sources it fully absorbed — so a resumed session is one file, not
  one per run. Scoped by the sids this run saw on the wire (`planMerge(logDir,
  { sessionIds, fragmentedOnly })`), so a concurrent run's trace is never
  touched, and it only fires when there's something to consolidate: a fresh
  single-file session's trace is left byte-identical. The scoped plan's prune
  rule is stricter than the whole-dir one — a source is prunable only when
  every pair lands in a session THIS plan writes (a file also holding an
  unmerged session's pairs would otherwise vanish into no output). Everything
  else is the manual command's discipline: atomic writes, union-never-shrink,
  re-stat before each unlink. Scoped plans substring-scan before parsing
  anything (a wire sid is always a verbatim substring of its pair's JSON
  line), so unrelated traces are never JSON-parsed and the common
  nothing-to-consolidate exit concludes from the scan alone — a 2.5GB dir
  went from ~22s silent at 7GB RSS to ~6s with progress lines (files ≥16MB
  print scan/read/write steps via `MergeProgress`; merged outputs write in
  8MB chunks). Fail-soft and silent when it does nothing;
  `--no-auto-merge` opts out, `--fresh` opts out of the whole continuity
  layer. Legacy node mode doesn't do it. When this run's own trace is
  absorbed, the exit receipt and the registry tombstone name the session file
  instead — nothing points at a path that no longer exists.

## Testing

Results (incl. real captures) land in `test-output/` — gitignored. Latest run:
`test-output/SUMMARY.md`.
