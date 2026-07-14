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
  a .cctrace/ directory, MITM-capturing Claude traffic, tracing a third-party
  ANTHROPIC_BASE_URL provider, or tracing the codex / grok CLIs.
---

# cctrace — trace Claude Code's HTTP traffic

cctrace wraps the Claude Code CLI, captures every request/response pair to
`.cctrace/trace-<ts>.jsonl`, and serves a live web UI (requests list,
reconstructed conversation, session replay, cost estimates).

Repo: https://github.com/thevibeworks/cctrace · npm: `@thevibeworks/cctrace`

## Run a traced session

```bash
cctrace                          # wrap claude, capture everything, open live UI
cctrace -- --continue            # everything after -- goes to claude verbatim
cctrace -- -p "explain this"     # traced print-mode run
cctrace --mode base-url          # lightweight: /v1/messages only, no CA setup
cctrace -s                       # static: no live server, just files
cctrace --no-open                # don't auto-open the browser
cctrace --dir path/to/logs       # trace dir (default: ./.cctrace)
cctrace --fresh                  # don't merge prior traces of a continued session
cctrace --version                # print version (+ newer version if known)
cctrace --no-update-check        # skip the daily npm version check / prompt
cctrace codex -- exec "..."      # trace the OpenAI Codex CLI instead
cctrace grok -- -p "..."         # trace the Grok CLI (both always use mitm)
```

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

Prints as `Live UI: http://localhost:<port>` (9317 by default; concurrent
instances land on 9318, 9319, ...). Hash-routed views:

- **Requests** (`#`, `#/p/<id>`): one row per request with chips — model,
  in/out tokens, a cache verdict (green hit with ↓read ↑write + hit %, amber
  cold write or miss), estimated USD cost, errors. Click a
  row for the detail panel: full conversation, prompt size, tok/s, cost
  breakdown, raw payloads. `j`/`k` walk rows, `/` filters, `Esc` closes.
- **Session** (`#/session[/<key>]`): reconstructed conversation (main chat,
  subagent runs linked to the Task call that spawned them, utility probes as
  separate threads) beside the wire requests, with per-turn
  tokens/duration/cost linked back to each request. Tails like `tail -f`
  while live. All tool calls fold to one line; subagent/skill/MCP calls stay
  visually marked, and a subagent fold links to its reconstructed thread.
  Nav: `g`/`G` top/bottom, `j`/`k` turns, `p`/`u` user prompts, `s` system
  prompt (same jumps on the on-page rail).
- **Replay** (inside Session view): "⏵ replay" or `←`/`→` steps through the
  session as it happened; `Space` plays at 1/2/8/60x (idle gaps compressed);
  the scrubber is a minimap (turns tall, errors red). Pausing writes a
  shareable deep link: `#/session/<key>/@<pair-id>` opens paused at that
  exact moment — use these links to point a human at "the turn where it went
  wrong".

The `.jsonl` trace is the durable artifact — `cctrace view` reopens it in the
same UI anytime. Live runs no longer write a snapshot `.html` at exit (big
sessions produced multi-hundred-MB files); `cctrace view <target> --html`
renders one on demand, and static mode (`-s`) still writes one, since the
snapshot is its whole point.

## Saved traces

Subcommands read traces on disk — no proxy, no Claude spawn. The housekeeping
commands (clean/merge/compress/purge) are **dry-run by default**; add `--yes`
to apply.

```bash
cctrace view <file|session-id|fragment>   # reopen a trace in the web UI (serves
                                          # it locally; Ctrl-C stops; --port N)
cctrace view <target> --html              # write a snapshot .html instead
                                          # (shareable; huge traces choke browsers)
cctrace clean [--yes]                     # rm regenerable .html + 0-byte traces
cctrace merge [--prune] [--yes]           # one deduped session-<id>.jsonl per session
cctrace compress [--older-than N] [--yes] # zstd archive (view reads .zst/.gz directly)
cctrace purge [--drop CATS] [--yes]       # drop categories (default telemetry,tokens)
cctrace ps [--json]                       # live instances: URL, client, project, session
```

Note for agents: plain `cctrace view <target>` starts a server and blocks —
run it in the background (or use `--html --no-open` when you just need the
file).

`cctrace ps` answers "which port is my other session on?" — every live run
registers itself (heartbeat + port-probe verified, works across containers
sharing a data dir), and the default port walk 9317..9326 is swept for
instances the registry lost, so the listing reflects what actually serves.
The UI header shows a "⇄ N more" switcher when siblings exist.

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
  "client": "claude",             // who produced it: claude|codex|grok (0.13+)
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
runs together.

## Privacy — treat traces as sensitive

Every pair is redacted at capture (`src/redact.ts`): auth headers masked to
first-10/last-4, OAuth tokens/credential fields masked in bodies and URLs,
session/device UUIDs partially masked. But **conversation content is captured
verbatim** — file contents, secrets pasted into chat, everything Claude saw.
Never commit `.cctrace/` (the repo's .gitignore already excludes it), and
review a snapshot before sharing it.
