<p align="center"><img src="assets/cctrace-logo.svg" width="64" alt="cctrace"></p>

<h1 align="center">cctrace</h1>
<p align="center"><strong>See the whole agent session.</strong><br>Follow the work. Find what fills the context. Inspect every request.</p>

<p align="center">
  <a href="https://github.com/thevibeworks/cctrace/actions/workflows/test.yml"><img src="https://github.com/thevibeworks/cctrace/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="https://www.npmjs.com/package/@thevibeworks/cctrace"><img src="https://img.shields.io/npm/v/@thevibeworks/cctrace" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/thevibeworks/cctrace" alt="MIT license"></a>
</p>

<p align="center"><a href="https://thevibeworks.github.io/cctrace/">Interactive tour</a> · <a href="#quick-start">Install</a> · <a href="docs/web-ui.md">Docs</a> · <a href="README.zh-CN.md">简体中文</a></p>

[![cctrace Context view: request history, token composition, and the tools filling the window](docs/assets/context.png)](https://thevibeworks.github.io/cctrace/demo/sample.html#/context)

*The current UI, showing a real Claude Code session captured by cctrace (sandboxed and redacted — [how it is made](docs/demo/capture.sh)). [Open it and inspect the context, replay the session, or read the requests.](https://thevibeworks.github.io/cctrace/demo/sample.html#/context)*

cctrace records your coding agent's API traffic and turns it into a local,
explorable session. Works with **Claude Code, Codex, Grok, Kimi Code, and
opencode**; [capture coverage varies by client](docs/clients.md).

- **What happened?** Read human turns, follow tools and subagents, and replay the work.
- **What filled the context?** Inspect instructions, tool schemas, and tool results over time. See what compaction changed.
- **Where did the tokens go?** Check cache behavior and estimated cost, within a session or across runs.
- **What actually went out?** Open captured requests and responses, including first-party traffic beyond model calls.

## Quick start

Requires [Bun](https://bun.sh), `openssl`, and the agent CLI you want to trace.

```bash
npm install -g @thevibeworks/cctrace
cctrace                              # launches Claude Code and a local web UI
```

The terminal prints the Live UI URL. Use your agent normally; the browser
shows its requests as they arrive. Your trace is saved for later.

```bash
cctrace codex                        # also: grok, kimi, opencode
cctrace view                         # reopen a saved session
cctrace doctor                       # diagnose the current or latest context
cctrace insights --scan              # inspect usage and caching across runs
cctrace export                       # export a session as Markdown
```

For a standalone binary or agent argument pass-through, see [install options](docs/install.md).

## Security & privacy

cctrace runs a local TLS-intercepting proxy. First-party hosts are decrypted;
other hosts pass through as opaque tunnels by default. Credential fields are
redacted before storage. **Conversation content is preserved:** review traces
before sharing. cctrace does not upload your captures to a service; your agent
still contacts its configured providers. [Capture scope](docs/capture-modes.md)
· [Redaction details](SECURITY.md).

## Go deeper

[Web UI](docs/web-ui.md) · [Saved traces](docs/traces.md) · [Clients](docs/clients.md)
· [Live capture & resources](docs/live-resources.md) · [Changelog](CHANGELOG.md)

**For agents:** [llms.txt](llms.txt) · [cctrace skill](skills/cctrace/SKILL.md)
· [Context doctor](skills/cctrace-doctor/SKILL.md) · [Insights](skills/cctrace-insights/SKILL.md).
The CLI computes the facts; the skills help an agent interpret them.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE).
