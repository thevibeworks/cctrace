# Handoff: 0.38.0 — opencode client shipped (#89)

> 2026-08-07 · release PR in flight from main @ 39de9cb

## Goal

Eric: "our deva framework just supported the opencode agent... add support
for tracing opencode in cctrace" (issue #89). Done, released as 0.38.0.

## State

- src/clients/opencode.ts: plugin with wire table + opencodeConfigHosts
  (regex over "baseURL" in opencode.json(c): $OPENCODE_CONFIG, XDG global,
  cwd). sessionHeader x-opencode-session (ses_... rides zen calls — live
  verified). dialect "openai" is categorize-fallback only; wireDialect
  picks per pair (zen mounts /zen/v1/messages AND /responses|/chat/
  completions — the per-host dialect worry in #89 was already solved by
  shape-first design).
- ClientWire.providerHosts (new field, src/clients/types.ts) + one
  buildInterceptSet hunk (src/certs.ts): single-purpose LLM API hosts
  enrolled unconditionally (anthropic/openai/openrouter/githubcopilot/
  generativelanguage/x.ai/deepseek/groq/mistral). github.com +
  googleapis.com deliberately NOT enrolled (shared hosts; the existing
  api.github.com-never-intercepted test guards this).
- Pricing: "opencode" appended LAST to PRICING_PROVIDERS — zen resale ids
  lose to originating providers, zen-only ids priced.
- Icon glyph (terminal prompt), help text, docs (clients.md, README,
  SKILL.md, CLAUDE.md, llms.txt, index.html en+zh), CHANGELOG 0.38.0,
  renderVer highlights refreshed.
- Live-verified against the zen gateway with OPENCODE_API_KEY from .env:
  capture, categorization, reconstruction (4-turn cross-process continued
  session, thinking blocks), auto-merge to session-<sid>.jsonl, snapshot.
- Tests: 643 pass. Devlog:
  docs/devlog/2026-08-07-opencode-multi-provider-client.org.

## Next

1. Standing candidate: settings panel phase 1 (#85).
2. opencode phase 2 when real traces exist: exotic providers (bedrock/
   vertex/azure), subagent session linking (ses_ parent lives in sqlite,
   not on the wire), copilot /models External-vs-bootstrap call.
3. BYO-Anthropic leg still untested live (no ANTHROPIC_API_KEY here).

## Don't repeat

- providerHosts must stay single-purpose model hosts ONLY — enrolling a
  shared host (github.com) decrypts unrelated authed traffic (0.16 scar).
- opencode config scan is a one-key regex on purpose — JSONC comment
  stripping breaks on URLs ("//").
- reference/ + live-trace strings never land in tracked files.

## Verify

git log --oneline -2                    # release commit on main
bun test 2>&1 | tail -3                 # 643 pass
cctrace opencode -- run -m opencode/deepseek-v4-flash-free "hi"
npm view @thevibeworks/cctrace version  # 0.38.0
