# Security Policy

cctrace intercepts real, credentialed traffic between Claude Code and Anthropic.
We take that seriously. This document explains what the tool does with sensitive
data and how to report a problem.

## What cctrace protects

Every captured request/response pair passes through a single redaction step
(`src/redact.ts`) before it reaches **any** sink — the `.jsonl` log, the
self-contained `.html` snapshot, or the live WebSocket:

- **Headers** — `authorization`, `x-api-key`, `cookie`, and similar are masked to
  a first-10/last-4 preview.
- **Bodies** — credential fields (`access_token`, `refresh_token`,
  `client_secret`, `code`, `api_key`, …) are masked in JSON and form-encoded
  bodies. Conversation content in `/v1/messages` is left intact.
- **URLs** — credential-bearing query params (e.g. OAuth `?code=`) are masked.

The CA and leaf private keys are generated locally under `.cache/mitm/` with
`0600` permissions and never leave your machine. The `.cctrace/` output directory
is gitignored by default.

## What it does not protect

- A trace is still a record of your real session. **Review it before sharing.**
  Redaction targets known credential shapes; it is not a guarantee that a novel
  secret embedded in a message body will be caught.
- The MITM CA, while trusted only by the Claude process cctrace launches, exists
  on disk while cctrace runs. Keep `.cache/mitm/` private.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(https://github.com/thevibeworks/cctrace/security/advisories/new).

Include what you observed, how to reproduce it, and the impact. We aim to
acknowledge within a few days. Credential-leak-to-disk reports are treated as the
highest priority.

## Supported versions

cctrace is pre-1.0; security fixes land on the latest release. Please run the
newest tag before reporting.
