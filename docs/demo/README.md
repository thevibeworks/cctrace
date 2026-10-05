# The public demo

The demo is a REAL Claude Code session doing real work on this repository,
captured by cctrace and rendered by the shipped UI. Not a benchmark task, not
a fixture: the reader sees an agent explore cctrace, diagnose a bug, fix it,
have a subagent review it, run the tests, and summarize. Provenance and the
one disclosed substitution: docs/design/presentation.md.

Decision 2026-09-16: the SWE-bench-style take (a pinned third-party repo in a
throwaway container) was prepared and then dropped. The demo should show the
tool on its own codebase, with the interactive beats only a TUI session has.

## Files

| File | Job |
| --- | --- |
| capture.sh | Builds the sandbox (workspace clone + sandbox HOME with auth only) and records a headless take: seven scripted turns, fully unattended |
| drive.sh | Drives the INTERACTIVE take through tmux, one prompt at a time, settling only after work was seen and went quiet. The published sample came from this |
| build.ts | Renders a trace to sample.html + assets/demo-data.js. Folds bodies to a page budget, scrubs machine-local identifiers, substitutes the operator's global CLAUDE.md, and FAILS on any publish-gate hit |
| shoot.ts | The three landing screenshots from the served sample |
| profile/ | The demo agent's global instructions and settings, the only instructions that reach the wire on purpose |
| setup.sh, full-surface-playbook.md | The older full-surface take (MCP, OAuth, tunnels). Kept as the wire-coverage checklist; not the published sample |

## Capture

Headless, unattended:

```sh
DEMO_ROOT=/path/on/a/bind/mount docs/demo/capture.sh
```

Interactive (what the published sample is): run capture.sh once for the
sandbox, then launch the TUI in a fresh tmux shell with only HOME set and
drive it:

```sh
tmux new-session -d -s ccdemo -x 210 -y 52 "env HOME=$DEMO_ROOT/home bash --noprofile --norc"
tmux send-keys -t ccdemo "cd $DEMO_ROOT/cctrace && bun <repo>/src/cli.ts claude --mode mitm --redact-ids --no-open --fresh --dir $DEMO_ROOT/trace" Enter
# answer the trust + bypass-permissions dialogs once, then
docs/demo/drive.sh 'first prompt' '/model sonnet' ... '/compact' 'last prompt'
```

DEMO_ROOT must survive the machine you capture on. The default
`$HOME/cctrace-demo` is container-local in deva and the source trace of the
current sample was lost with a container recreate. Put it on a bind mount,
outside the checkout.

## Build and check

```sh
bun run docs/demo/build.ts $DEMO_ROOT/trace/trace-*.jsonl     # sample.html + demo-data.js
bun src/cli.ts doctor $DEMO_ROOT/trace/trace-*.jsonl          # what is in the window, whose files
python3 -m http.server 8795                                   # from the repo root
bun run docs/demo/shoot.ts                                    # docs/assets/{session,context,requests}.png
```

The build prints per-rule scrub counts and the gate result. A gate hit is a
failed build, not a warning. Read the rendered page before committing:
Sessions, Context, Requests, replay, a narrow screen. Pattern checks do not
catch a paraphrased personal instruction.

## Rebuild without the source trace

The sample embeds every pair it renders (`window.__PAIRS__`), already
scrubbed. When the source trace is gone, recover it from the published file
and build from that; the result is the same session through the current UI:

```sh
bun -e 'const h=require("fs").readFileSync("docs/demo/sample.html","utf8");const s=h.indexOf("window.__PAIRS__ = ")+19;const p=JSON.parse(h.slice(s,h.indexOf(";</script>",s)));require("fs").writeFileSync("test-output/demo/trace-2026-09-14T04-18-54.jsonl",p.map(x=>JSON.stringify(x)).join("\n")+"\n")'
bun run docs/demo/build.ts test-output/demo/trace-2026-09-14T04-18-54.jsonl
```

The 2026-09-14 take was rebuilt this way on 2026-10-05, when the gate grew
the operator-identity rule (organization, account and device ids that
Claude Code's telemetry carries under keys `--redact-ids` does not know).

## Publish

The site is GitHub Pages from `main:/docs`; the sample is live once
docs/demo/sample.html is committed. Page weight is a trade: the published
sample carries every body in full (10.4 MB, 2.4 MB gzipped) so every request
on the page opens; `--bytes N` folds the oldest bodies to stubs for a smaller
page, and a published stub has no server to fetch its bytes back from.
