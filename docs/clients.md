# Beyond Claude: Codex, Grok, Kimi Code, and compat providers

The capture core is client-agnostic -- it's a TLS-intercepting proxy, and any
CLI that honors `HTTPS_PROXY` plus the standard cert env vars gets traced.

## Other clients

A leading client word picks who runs:

```bash
cctrace codex -- exec "fix the failing tests"   # OpenAI Codex CLI
cctrace grok -- -p "explain this stack trace"   # Grok CLI
cctrace kimi                                    # Kimi Code CLI (Moonshot AI)
```

Non-Claude clients always use mitm capture, and get the full treatment:
their model calls (`.../responses`, `.../chat/completions`) land in
Messages, and the Sessions view reconstructs their conversations too --
threads keyed on each client's wire headers, tool calls and reasoning
normalized into the same turn model, per-turn usage and cost, replay
included.

Client notes:

- **Codex** -- OpenAI Responses dialect; session/thread ids ride in the
  `session-id`/`thread-id` headers; encrypted reasoning shows as a
  placeholder.
- **Grok** -- Responses dialect; `x-grok-session-id`/`x-grok-conv-id`
  headers (parallel conversations split cleanly); reasoning summaries read
  in full.
- **Kimi Code** -- OpenAI Chat Completions: threads reconstruct from the
  prompt signature (no thread header on the wire), the session id rides in
  the request body (`prompt_cache_key`, stable across compaction and
  `--resume`), auto-compactions render as boundary markers, and
  `reasoning_content` renders as thinking. Coding-plan models price as
  estimates at the equivalent pay-per-token rates (`k3` at
  `moonshotai/kimi-k3` rates) -- the cost chip is an estimate, not a bill,
  the same convention that prices Claude Max OAuth traffic.

## Third-party Anthropic-compatible providers

Point `ANTHROPIC_BASE_URL` at a gateway or a compat endpoint and run
`cctrace` as usual. mitm mode needs no extra setup: non-Anthropic hosts get
a per-host certificate minted on first contact (requires `openssl`), and
`/v1/messages` is classified by wire shape, not host, so provider traffic
lands in Messages with the provider's hostname visible on each row.
OAuth/usage/credits categories will simply be absent -- those endpoints are
hardcoded to Anthropic hosts and bypass `ANTHROPIC_BASE_URL` by design
(which is exactly why mitm mode exists).
