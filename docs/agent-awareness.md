# Agent awareness: telling the traced agent it runs under cctrace

The problem, from a real session (2026-08-05): an agent inside a traced
session spent 1.5 hours failing to deploy a Cloudflare Worker. The proxy
added no slowdown — but with HTTPS_PROXY set, wrangler swaps undici's global
dispatcher for its own ProxyAgent and silently discards user-installed
timeout overrides. The fix (raise the timeout AND clear the proxy vars for
that one command) is obvious only if you know the proxy is there and what it
implies. The agent didn't, because nothing told it.

Two ways to tell it:

## 1. --inform-agent (claude)

    cctrace --inform-agent claude

Appends a short note to Claude's system prompt (via --append-system-prompt):
you are traced, where the live UI serves, what the proxy does and does not
touch, and the one escape hatch. Costs a few hundred tokens per request;
that's why it is opt-in.

## 2. The instructions-file snippet (codex, grok, kimi, or always-on claude)

The other client CLIs have no system-prompt flag. Put this in the agent's
instructions file (AGENTS.md / CLAUDE.md / equivalent) instead — it is inert
when the session isn't traced, because it keys off the env vars:

```
## Traced sessions (cctrace)

If CCTRACE_TRACE_FILE is in your env, this session's HTTPS traffic runs
through a local tracing proxy (cctrace). Live trace UI:
http://localhost:$CCTRACE_SERVER_PORT/trace. Anthropic/model API calls are
captured; other hosts pass through an opaque tunnel — the proxy adds no
meaningful latency.

Caveat: some tools change behavior when proxy env vars are set (wrangler
replaces undici's dispatcher, so its timeout overrides only work with the
proxy vars unset). If a large upload or deploy times out through the proxy,
re-run just that one command with the proxy cleared:

    env -u HTTPS_PROXY -u https_proxy <command>

If the network itself needs a proxy, set HTTPS_PROXY to that real proxy for
the command instead. Never unset the proxy globally or kill the cctrace
process — that severs the whole session's capture.
```

## What the env vars mean

Every traced child (and its subprocesses — statuslines, hooks, nested
agents) gets:

- CCTRACE_TRACE_FILE — absolute path of the .jsonl being written
- CCTRACE_SERVER_PORT — the live UI's port (live runs only)
- CCTRACE_INSTANCE_ID — this run's registry id (live runs only)

A statusline or tool can use these to render a "traced" indicator that
links to the live UI — presence of the vars IS the signal; no registry
scan needed.
