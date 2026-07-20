# Capture modes and scope

cctrace auto-selects a capture mode based on your Claude install; override
with `--mode`.

| Mode | Captures | Setup |
|------|----------|-------|
| **`mitm`** (default, native binaries) | **The full first-party picture** -- messages, OAuth, usage/credits, MCP registry, telemetry | Auto-generates a CA; Claude trusts it via `NODE_EXTRA_CA_CERTS` |
| **`base-url`** | `/v1/messages` only | Zero -- just sets `ANTHROPIC_BASE_URL` |
| **`node`** (auto for npm/JS installs) | First-party via `fetch()` hook | Legacy; only works on non-native (JS) Claude |

## Scope: include-list, tunnel by default

Capture scope is an include-list, decided per connection before any TLS
(Charles' SSL-proxying model): first-party hosts, the client's pinned
telemetry sinks, any `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` host, and
`--intercept-host` extras get real interception with per-host certs.
Everything else -- package registries, `gh` calls, apt -- passes through as
an **opaque tunnel** logged as one small row: host, bytes up/down, duration.
No forged certs for those hosts, so cert-pinning tools and system-trust
readers work through cctrace unchanged.

`--capture-external` restores decrypt-everything -- with external *bodies*
capped at 64KB (larger ones are summarized with exact byte counts;
url/status/headers/timing always stay), so an npm tarball or a token-authed
API response never lands in the trace. Enroll a host with `--intercept-host`
when you want its full payloads.

## How the proxy works

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

## Output

Every run writes to `.cctrace/` (or `--dir`):

- `trace-<timestamp>.jsonl` -- one request/response pair per line
  (machine-readable). That file IS the trace: `cctrace view` reopens it in
  the web UI anytime, `cctrace view <target> --html` renders a shareable
  self-contained snapshot on demand (live runs stopped writing one at exit
  in 0.13 -- a 2-hour session rendered 400MB of HTML).
