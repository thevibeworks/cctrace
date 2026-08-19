# Proposal: a settings surface for cctrace

Status: proposal (2026-08-06). Not scheduled; this doc is the design
groundwork so implementation is a mechanical step, not a design fight.

## The problem

cctrace configuration today lives in three places with no shared view:

1. CLI flags per run (`--capture-external`, `--intercept-host`,
   `--bypass-host`, `--messages-only`, `--fresh`, ...)
2. Env vars (`CCTRACE_DATA_DIR`, `CCTRACE_NO_UPDATE_CHECK`)
3. Browser localStorage per UI concern (theme, mask categories, dashboard
   grouping, fold defaults)

That split is mostly CORRECT — capture scope is a per-run decision and
should stay on the command line; display taste is a per-browser decision
and should stay in localStorage. The gap is visibility and defaults:
nothing shows the effective configuration of a run, and a preference like
"always messages-only in this project" has no home besides shell aliases.

## What settings actually exist (inventory)

Capture (per run, security-relevant, CLI-only today):
  mode, capture-external, intercept-host, bypass-host, messages-only,
  fresh / no-auto-merge / with, data-dir, port, no-open, inform-agent

Viewer (per browser, localStorage today):
  theme, mask categories, dashboard group-by, prior-runs toggle,
  tail/autoscroll defaults

Environment (per install):
  update check opt-out, data dir, default client paths

## Design

Two pieces, deliberately small:

### 1. A read-only "run config" panel (ship first)

A gear icon in the trace view header (same `icon-btn` family as mask/theme)
opening a panel that shows the EFFECTIVE run configuration: mode, intercept
set, bypass set, capture caps, data dir, log file, version, update state.
Data is already known to the server; expose as `/api/config`.

Value: today a user cannot answer "is this run capturing external bodies?"
without re-reading their shell history. This panel is the honest half of
"settings" — see what is, before editing what will be.

The dashboard gets the same panel scoped to install-level facts (data dir,
registry size, version, update state) — served by every instance, linked
from the dashboard header with the same gear icon.

### 2. A defaults file (ship second, maybe never)

`<data-dir>/config.json` (+ optional per-project `.cctrace/config.json`)
holding DEFAULTS for a small allowlist of flags: `messagesOnly`,
`interceptHosts`, `bypassHosts`, `noOpen`, `port`, `noUpdateCheck`.
Precedence: CLI flag > project file > data-dir file > built-in.

Capture-scope defaults (`captureExternal`) stay out of the file on
purpose: widening capture is a per-run, eyes-open decision, and a
forgotten config file that silently decrypts everything is exactly the
kind of surprise cctrace exists to prevent.

Editing stays in an editor. A web form that writes config files crosses a
line: the UI (which renders wire-derived, hostile data) gains write access
to capture behavior. The panel links to the file path; it does not edit it.

## What we will NOT build

- No settings page that edits localStorage toggles already reachable in
  one click where they apply (theme button, mask menu, group-by control).
  A settings page that duplicates in-place controls is where consistency
  goes to die.
- No account/cloud/sync anything.

## Open questions

- Should `--intercept-host` defaults be per-project rather than global?
  (A remote MCP host is usually a project fact.) Leaning yes: project file.
- `/api/config` redaction: the intercept set can name internal hosts —
  fine for the local UI, but slice/snapshot exports must not embed it.
