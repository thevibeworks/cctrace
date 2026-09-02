---
name: cctrace
description: >
  Trace, inspect, and replay Claude Code's HTTP traffic with cctrace — a
  TLS-intercepting tracer with a live web UI. Use this skill whenever the user
  wants to see what Claude Code sends over the wire (system prompts, tools,
  token usage, cache hits, cost, usage limits, errors), debug a Claude Code
  session ("why did it do that", "what did the agent see", "why is my cache
  hit rate low", "how much did that session cost"), capture API traffic for a
  bug report, replay or share a captured session, work with saved .jsonl
  traces (view, clean, merge, compress), or find which port a running cctrace
  instance is on. Also use it when the user mentions cctrace, trace files in
  the trace store (or a legacy .cctrace/ dir), MITM-capturing Claude traffic, tracing a third-party
  ANTHROPIC_BASE_URL provider, or tracing the codex / grok / kimi / opencode CLIs.
---

# cctrace — trace Claude Code's HTTP traffic

cctrace wraps the Claude Code CLI, captures every request/response pair to
`trace-<ts>.jsonl` in the trace store (`~/.local/share/cctrace/traces/<project-key>/`,
one dir per project cwd, archived to `.jsonl.zst` at exit), and serves a
live web UI (requests list, reconstructed conversation, session replay,
cost estimates).

Repo: https://github.com/thevibeworks/cctrace · npm: `@thevibeworks/cctrace`

## Run a traced session

```bash
cctrace                          # wrap claude, capture everything, open live UI
cctrace -- --continue            # everything after -- goes to claude verbatim
cctrace -- -p "explain this"     # traced print-mode run
cctrace --mode base-url          # lightweight: /v1/messages only, no CA setup
cctrace -s                       # static: no live server, just files
cctrace --no-open                # don't auto-open the browser
cctrace --dir path/to/logs       # trace dir (default: the project's store dir)
cctrace --fresh                  # don't merge prior traces of a continued session
cctrace --no-auto-merge          # don't fold this run into session-<id>.jsonl at exit
cctrace --no-compress            # leave the trace plain .jsonl at exit (default: .jsonl.zst)
cctrace --version                # print version (+ newer version if known)
cctrace --no-update-check        # skip the daily npm version check / prompt
cctrace codex -- exec "..."      # trace the OpenAI Codex CLI instead
cctrace grok -- -p "..."         # trace the Grok CLI
cctrace kimi                     # trace the Kimi Code CLI (all non-Claude use mitm)
cctrace opencode -- run "..."    # trace opencode across all its providers
```

A traced session tells its child processes where the capture lives: the
spawned CLI (and its statuslines, hooks, and nested agents) sees
`CCTRACE_TRACE_FILE` (the .jsonl being written), plus `CCTRACE_SERVER_PORT`
and `CCTRACE_INSTANCE_ID` when a live server is running. An agent that finds
these in its environment is running under cctrace and can open its own live
UI at `http://localhost:$CCTRACE_SERVER_PORT/trace`.

Two gotchas worth knowing before suggesting commands:

- **`-p` position matters**: before `--` it is cctrace's port; after `--` it is
  Claude's print mode.
- **A leading `--` is eaten by bun** when running via `bunx` / `bun run` /
  `bun link` — `cctrace -- --continue` only works from the compiled binary
  (`make install` puts it in `~/.local/bin`). Workaround for bun-run installs:
  put any cctrace flag before the `--`.

## Capture modes (auto-selected; force with --mode)

| Mode | Sees | Setup | When |
|---|---|---|---|
| `mitm` (default for native claude) | ALL Anthropic traffic: messages, OAuth usage/credits, MCP registry, telemetry | auto-generates a CA under `~/.local/share/cctrace/mitm/`, trusted via `NODE_EXTRA_CA_CERTS` (claude itself) + a combined system+mitm bundle in `SSL_CERT_FILE`/`CURL_CA_BUNDLE`/`REQUESTS_CA_BUNDLE` (its subprocesses) | full picture — usage limits, credits, everything |
| `base-url` | `/v1/messages` only (OAuth/usage bypass `ANTHROPIC_BASE_URL`) | none | quick conversation/token debugging |
| `node` | legacy fetch injection | repo sources | npm-installed (non-native) claude only |

`cctrace --print-ca` prints the CA cert path (for trusting it elsewhere).
The MITM proxy is designed to never take down the wrapped session; if a page
of the UI dies, Claude keeps running.

**Side effect to expect**: while a session runs under mitm, that shell's
`HTTPS_PROXY` points at cctrace. Since 0.10 the exported CA bundle makes
curl/gh/python/go subprocesses verify fine; a tool that ignores those vars
(or a pre-0.10 cctrace) still fails TLS against the minted certs — run it
with `HTTPS_PROXY="" https_proxy=""` prefixed.

## The web UI

Prints as `Live UI: http://localhost:<port>/trace` (8722 by default — TRAC on a phone keypad; concurrent
instances land on 9318, 9319, ...). `GET /s/<sid8>` (0.40+) is the short
session jump — a redirect to `/trace#/session/<sid8>` that lands on that
session's conversation scrolled to the newest turn (`/s` alone: the newest
session) — the link a statusline can afford to print. Hash-routed views:

- **Requests** (`#`, `#/p/<id>`): one row per request. Content chips in
  reading order — model · effort (high/xhigh/adaptive/token budget, all
  clients' wire shapes) · think · in/out tokens · ≡ cache verdict (green
  hit with ↓read ↑write + hit %, amber cold write or miss; tooltip shows
  the absolute hold-until time, and the newest request says "expired" when
  the page renders past its deadline — resuming then re-writes the prefix)
  · estimated USD cost · errors — then right-aligned wire columns: ↑req
  ↓resp body sizes, first-token delay (ttft), duration, time.
  Click a row for the detail panel. Order top-to-bottom: chips (prompt size,
  first-token delay vs wall-clock, tok/s, cost breakdown) + a click-to-copy
  request id, then a DevTools-style Headers section (general + parsed
  request/response headers, raw toggle, copy), then body folds with
  pretty/raw and SSE events/raw toggles, then the full conversation last (it
  is the long part). Every fold has a `copy` button; text blocks have a hover
  copy. `j`/`k` walk rows, `/` filters, `Esc` closes.
  The toolbar's **Select** button enters select-to-purge: click rows (or
  "all shown" with a filter/category active), then **purge** deletes the
  selected pairs from the page AND rewrites the backing `.jsonl` — the web
  face of `cctrace purge`, by hand-picked request (confirmed, no undo;
  hidden on snapshots). Server side it's `POST /api/purge {ids:[...]}`.
  The **⌘ actions** menu (live/view pages) downloads a snapshot
  (`/api/snapshot.html`), the wire spec (`/api/spec.json|.md`), and
  per-session dumps: `GET /api/session.jsonl?sid=<full-sid>` (the
  session's wire pairs, same set `cctrace merge` writes) and
  `GET /api/session.md?sid=<full-sid>` (a readable markdown transcript)
  — handy for agents: fetch the .md to read a traced conversation
  without parsing SSE. `GET /dashboard` (any live instance — also the ▦
  header icon) is the central picture: every live + recently finished run
  across projects, groupable by project/client/time, with per-run stats
  (size · pairs · tokens · est cost) stamped at exit. Past rows open
  `GET /view/<run-id>` — a snapshot the serving instance renders on
  demand from that run's trace (JSON: `/api/instances` live, `/api/runs`
  finished).
  The header shows the trace's running totals (requests · in/out tokens ·
  est cost, breakdown on hover), and clicking the trace title copies its
  path (absolute into the store, or project-relative for a legacy
  ./.cctrace trace) — ready for `cctrace view`.
- **Sessions** (`#/session[/<sid8-or-key>[/<key>]]`): reconstructed
  conversation (main chat, subagent runs linked to the Task call that
  spawned them, utility probes as separate threads) beside the wire
  requests. A TURN is the working-loop unit — user request, agent work
  (indented: tool rows name the files touched, workspace-relative),
  final response (↳) — so "3 turns" can span hundreds of wire messages
  (clicking a turn's ❯ gutter folds its agent work under the prompt line);
  CLI-injected user-role prompts (recap, "Tool loaded.", SYSTEM
  NOTIFICATION wakeups) are marked "cli", never shown as the human.
  Per-turn tokens/duration/cost link back to each wire request,
  and error metrics per thread/session (failed requests, truncated streams,
  failed tool calls with an error rate). When a trace holds several wire
  session ids (/clear mid-run, resumed sessions), threads group into
  collapsible per-session sections, newest first (`[`/`]` switch sessions);
  single-session traces render flat. Each thread card shows its
  model as a right-aligned chip ("fable-5 +4" after mid-thread /model
  switches, split in the tooltip); the selected
  thread's request list marks rewound/compact-folded/failed requests.
  Tails like `tail -f`
  while live. All tool calls fold to one line; subagent/skill/MCP calls stay
  visually marked, and a subagent fold links to its reconstructed thread.
  Nav: `g`/`G` top/bottom, `j`/`k` turns, `p`/`u` user prompts, `s` system
  prompt (same jumps on the on-page rail).
- **Context** (`#/context[/<sid8-or-key>[/<key>]][/=<deck>]`): the agent's
  context window over time — the "what is eating the window" view, in a
  DevTools-shaped shell. On top, an interactive OVERVIEW that never
  scrolls away: one stacked column per wire request (or per turn, toggle),
  ✂ plus an amber axis break at compaction/rewind, and a second track for
  where that step's wall-clock went (model / tools / waiting). Hover
  scrubs, click PINS one step, drag BRUSHES a range (handles resize it,
  dragging the window pans it), wheel zooms around the cursor, `Esc`
  peels back (range → zoom → view), `1`/`2`/`3` pick the deck, `←`/`→`
  walk the pin.
  A left MARGIN carries the balance for the pinned step: its prompt
  tokens, a six-color bar against the model's context window, how far the
  chars/4 estimate reads under or over the billed prompt, and six ledger
  lines (system prompt, tool schemas, user messages, injected context,
  assistant replies, tool results) — click any line to zoom the graph to
  it. Below those, the step's links out (`turn NN · step N →`, `wire →`),
  the heaviest tool schemas, where the thread's time went, and — on
  multi-session traces — the other threads, peak assembled context on one
  scale, click to switch.
  Then one DECK at a time reads that selection (`/=window` is the
  default and stays out of the URL; `/=stream`, `/=events` deep-link):
  - **window** — the pinned step as an icicle (width is tokens, rows are
    levels) decomposing the request into category → group → item, tool
    results by tool, schemas by MCP server, injections by producer; click
    a node to zoom, a leaf to open its exact bytes in the pane below,
    "by size" or "in order", and every pane row names the turn that first
    carried it into the window.
  - **stream** — the thread as one linear stream of records: system
    prompt, the human's turns, harness-injected CONTEXT inline at the
    moment it entered, the model's thinking, each tool call fused with
    its result, the reply — kind-badged, in spine order, turn/step
    addressed like the Sessions outline. List | inspector. A detail level
    filters, never summarizes, and says how many rows it hid: MAP
    (system + the human + tool calls), READ (drops budget banners and
    bare thinking), FULL (everything). A kind filter isolates one record
    type (context-only IS the context trajectory) plus search. Scoped to
    the brushed range. (This was the Trajectory tab through 0.44;
    `#/trajectory` still redirects here.)
  - **events** — injections with producer labels, compactions with the
    reclaimed token delta, model switches, tool-schema changes — each
    linked to its wire request, scoped to the brushed range.

  Estimates carry ≈ and sit next to the provider-reported
  prompt tokens. Selection is shared with the Sessions view, and a step
  links back to its turn there.
- **Trajectory bar** (Sessions view, always on top): five lanes over
  wall-clock — turns (one clickable block per working loop, numbered, the
  turn's tally on hover) · model requests · tools · subagents · harness
  marks — drawn for the whole session even before any replay,
  idle folded to `⧸⧸` breaks. It syncs with the conversation: a faint
  marker tracks where you have scrolled, and a click jumps the
  conversation to that moment (⏵ starts replay); the ▾ chevron folds
  the lanes to the clock row.
- **Replay** (inside Sessions view): "⏵ replay" or `←`/`→` steps through the
  session as it happened; `[`/`]` jump between working loops; `Space` plays
  at 1/2/8/60x (idle gaps compressed). The scrubber is a TRAJECTORY: five
  lanes over wall-clock (turn blocks · model requests · tools · subagents
  stacked · harness cuts/failures) under a clock axis, everything right of
  the playhead dimmed and every thread but the selected one ghosted; wheel
  zooms around the cursor and the strip labels spans as you zoom in; click
  a span to jump there; the axis is the selected session's own time with
  idle gaps over 5 min folded to a hatched `⧸⧸` break. The left
  pane carries the BEAT (this step's tool calls fused with results,
  spawns, the reply, the window delta, and the prompt that started the
  loop) and the call tally so far. On a LIVE run replay tails:
  `⏭` / `End` park the cursor at the live edge and it follows every pair
  that lands, with the conversation scrolled to the moment. `F` hides the
  chrome for presenting; Esc peels present -> replay -> view. Pausing writes a
  shareable deep link: `#/session/<key>/@<pair-id>` opens paused at that
  exact moment — use these links to point a human at "the turn where it went
  wrong". Shift+drag on the scrubber selects a SLICE (a range): both panes
  narrow to that window, the deep link becomes `@a..b`, and the transport
  bar's "export" downloads a snapshot holding exactly the window's pairs —
  the small shareable artifact for bug reports.

The `.jsonl` trace is the durable artifact — `cctrace view` reopens it in the
same UI anytime. Live runs no longer write a snapshot `.html` at exit (big
sessions produced multi-hundred-MB files); `cctrace view <target> --html`
renders one on demand, and static mode (`-s`) still writes one, since the
snapshot is its whole point.

### Recovering a response the user stopped in the CLI

cctrace keeps capturing after the CLI aborts a request, so the partial reply
up to the stop point is saved. To find it: in the Requests list, look for the
row with a **"stopped early"** warn chip (the wire pair has `resp.truncated:
true`); open it, and the assembled partial reply renders in the detail
conversation like any other response. The detail Headers → General also shows
a "stopped early" row. Use this when the user says "it cut off / I hit Esc —
what did the model actually send?".

## Saved traces

Subcommands read traces on disk — no proxy, no Claude spawn. They default to
the current project's store dir (`--dir DIR` names another; the housekeeping
five also take `--all` = every project in the store); a legacy `./.cctrace`
that still holds traces is read alongside. The housekeeping commands
(clean/merge/compress/purge/compact) are **dry-run by default**; add `--yes`
to apply.

```bash
cctrace view                              # list traces newest-first, pick one
                                          # (TTY: Enter = newest; non-TTY: list only)
cctrace view latest                       # reopen the newest trace directly
cctrace view <file|session-id|fragment>   # reopen a trace in the web UI (serves
                                          # it locally; Ctrl-C stops; --port N)
cctrace view <target> --full              # every pair (default: the newest 256 MB of
                                          # lines stream in from the tail + a notice)
cctrace view <target> --html              # write a snapshot .html instead
                                          # (shareable; huge traces choke browsers)
cctrace view <target> --slice a..b        # narrow to a slice window (the @a..b of a
                                          # slice deep link); with --html = small artifact
cctrace view <target> --tail              # follow a RUNNING capture's trace live from
                                          # another terminal/container (tail -f the .jsonl)
cctrace clean [--yes]                     # rm regenerable .html + 0-byte traces + orphaned .tmp
cctrace merge [--prune] [--yes]           # one deduped session-<id>.jsonl per session —
                                          # the whole-dir sweep. Every capture run already
                                          # merges its own session at exit (--no-auto-merge
                                          # opts out), so a resumed session is one file
cctrace compress [--older-than N] [--yes] # zstd archive (view reads .zst/.gz directly)
cctrace purge [--drop CATS] [--yes]       # drop categories (default telemetry,tokens,external)
cctrace spec [target] [--out F] [--md] [--diff F]  # observed-wire catalog: endpoints, header
                                          # names, body field shapes, SSE events with sample
                                          # counts and first/last-seen; values redacted except
                                          # negotiation headers + model ids. No target = all
                                          # traces in the dir. --diff vs a saved catalog =
                                          # what changed on the wire (new headers/fields/events)
cctrace compact [--zstd] [--yes]          # fold redundant bodies (-95%+): superseded request
                                          # bodies stub, noise collapses to meta; the session
                                          # view renders identically, no pair is deleted
cctrace ps [--json]                       # live instances: URL, pids, client, project, session
cctrace history [--limit N | --all] [--json]  # global run log: every traced run (live +
                                          # past), newest first, across all projects; dimmed
                                          # rows are another container's (trace not here)
cctrace store [--json]                    # the store: root path, one row per project (size,
                                          # traces, newest), total — where the disk went
cctrace title [--force] [--json]           # list sessions needing a name + their spine
                                          # digest (human prompts + agent finals, no
                                          # tools/sub-agents). Naming is the cctrace-title
                                          # skill (subagent fan-out), not cctrace itself
cctrace title set <id> "<title>" [--dir DIR]  # record one title; titles.json per store
                                          # dir, shown everywhere a run is listed
cctrace adopt [DIR...] [--scan ROOT] [--rebase FROM=TO] [--copy] [--zst] [--yes]
                                          # move legacy ./.cctrace dirs into the store
                                          # (no DIR: this project's + every one the registry
                                          # knows; --scan walks a tree; --rebase keys dirs
                                          # mounted from another machine by that machine's
                                          # paths; --copy keeps sources, --zst archives on
                                          # the way in; dry-run by default)
```

Where traces live (0.41+): `~/.local/share/cctrace/traces/<project-key>/`
(`CCTRACE_DATA_DIR` / `--data-dir` moves the whole data dir), one dir per
project cwd named the way Claude Code names `~/.claude/projects/` entries,
with a `project.json` marker holding the exact path. Live runs write plain
`.jsonl`; at exit the run archives it (and any `session-<sid8>.jsonl` it
merged) to `.jsonl.zst` — every reader opens both. Reclaim space with
`cctrace clean --all`, `cctrace compress --all`, or by deleting a project's
dir. Design: docs/design/store.md.

Note for agents: plain `cctrace view` (and `view <target>`) starts a server
and blocks — run it in the background, pass an explicit target (non-TTY
no-target runs only print the trace list), or use `--html --no-open` when
you just need the file.

Capture scope (0.16+): only first-party hosts (plus pinned telemetry sinks,
base-url env hosts, and `--intercept-host` extras) are decrypted. Everything
else — npm, github, apt, remote MCP servers — passes through as an opaque
tunnel logged as one meta pair (host + byte counts, category External).
`--capture-external` restores decrypt-everything for debugging (external
bodies over 64KB are summarized with byte counts, not stored — enroll a
host with `--intercept-host` for its full payloads).
`--bypass-host HOST` (repeatable) goes the other way: the host is appended
to the traced child's NO_PROXY, so that one tool talks direct with its
normal non-proxy behavior — for tools that misbehave when any proxy is
present (wrangler swaps HTTP stacks); costs only that host's audit line.

`cctrace ps` answers "which port is my other session on?" — every live run
registers itself (heartbeat + port-probe verified, works across containers
sharing a data dir), and the default port walk 8722..8821 is swept for
instances the registry lost, so the listing reflects what actually serves.
The UI header shows a "⇄ N more" switcher when siblings exist.
`cctrace history` answers "what did I trace recently?" — the same registry's
tombstones as a global timeline; open any row with `cctrace view <SESSION>`.

If you (the agent) are yourself running under cctrace — `CCTRACE_TRACE_FILE`
/ `CCTRACE_SERVER_PORT` in your env say so — see docs/agent-awareness.md:
your HTTPS goes through a local tracing proxy, and the one caveat that
matters is that some tools behave differently behind proxy env vars
(wrangler swaps undici's dispatcher; its timeout overrides need the proxy
vars unset too). Bypass for ONE command with
`env -u HTTPS_PROXY -u https_proxy <cmd>`; never unset globally.

## Reading a trace programmatically

One JSON object per line, schema (`src/types.ts`):

```jsonc
{
  "id": "…",                      // stable pair id (replay deep links use it)
  "request":  { "timestamp": 1751778030.123,  // SECONDS
                "method": "POST", "url": "…", "headers": {…}, "body": {…} },
  "response": { "timestamp": …, "status": 200, "headers": {…},
                "body": {…},      // JSON responses
                "bodyRaw": "…",   // streamed SSE text (assemble events from data: lines)
                "truncated": true // present iff upstream died mid-stream
              },                  // null when no response arrived
  "duration": 1234,               // ms
  "client": "claude",             // who produced it: claude|codex|grok|kimi|opencode (0.13+)
  "prior": "trace-…jsonl"         // present iff merged from a previous run
}
```

Useful jq one-liners:

```bash
jq -r 'select(.request.url | contains("/v1/messages")) | .request.body.model' t.jsonl
jq 'select(.response.status >= 400)' t.jsonl                     # failures
jq -r '.request.body.metadata.user_id // empty' t.jsonl | head   # session id JSON
```

The Claude Code session id lives in `request.body.metadata.user_id` (a JSON
string with a `session_id` field) — that's how cctrace stitches `--continue`
runs together. Codex and grok carry theirs in request headers instead
(`session-id` / `x-grok-session-id`; thread ids in `thread-id` /
`x-grok-conv-id`) — cctrace reads those too, so continuity, the Session
view (threads/turns/tool folds), categories (oauth/usage/mcp/telemetry/
bootstrap instead of one External blob), and models.dev-based cost chips
all work for codex/grok traces the same as for Claude. Kimi Code
(`api.kimi.com/coding/v1/chat/completions`, OpenAI Chat Completions) carries
no thread id on the wire — its threads reconstruct from the first user
prompt's signature — but K3 sends the session id in the request body
(`prompt_cache_key: "session_<uuid>"`, stable across compaction and
`--resume`), so cross-run continuity and the Session view work the same;
its auto-compactions render as boundary markers, and coding-plan models
price as estimates at the equivalent pay-per-token (moonshotai) rates.
opencode is multi-provider — the wire shape of each request picks its
dialect, so Anthropic- and OpenAI-shaped calls in one session both
reconstruct; OpenCode Zen gateway calls (`opencode.ai/zen`) carry the
session id in the `x-opencode-session` header (`ses_…`), giving the same
cross-run continuity, and custom provider hosts enroll automatically from
`opencode.json(c)` `baseURL` entries.

## Privacy — treat traces as sensitive

Every pair is redacted at capture (`src/redact.ts`): auth headers masked to
first-10/last-4, OAuth tokens/credential fields masked in bodies and URLs.
Identity ids (session/user/device UUIDs) stay UNMASKED by default — they're
workflow identity, and sid-keyed features depend on them; `--redact-ids`
(or CCTRACE_REDACT_IDS=1) masks them for traces that leave the machine.
But **conversation content is captured
verbatim** — file contents, secrets pasted into chat, everything Claude saw.
Traces live outside the repo (the store under `~/.local/share/cctrace/`);
never commit a legacy `.cctrace/` dir (the repo's .gitignore already excludes
it), and review a snapshot before sharing it.
