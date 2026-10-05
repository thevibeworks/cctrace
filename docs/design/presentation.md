# Public presentation

The README is the quick decision. The site is the product tour. The demo is
the proof. Lead with understanding a session; transport capture explains
where the evidence comes from.

## Audit (2026-09-14)

| Gap, in trust order | Work |
| --- | --- |
| Pages calls shipped sessions and multi-client support “coming soon” | Small: remove stale roadmap |
| The July GIF depicts an older UI; current context and session features are invisible at first glance | Medium: reproducible public demo and current screenshots |
| The README says “exactly two jobs” before describing many more; implementation detail buries user outcomes | Small: shorten and link to existing guides |
| Context diagnosis and insights across runs are absent from the first impression | Small: show the questions and commands |

This is a small open-source project. No new framework, analytics, animation
dependency, community badge wall, or build service is needed for this page.

## References inspected

From [the September 2026 HN thread](https://news.ycombinator.com/item?id=49686380):

| Reference | What earns its place |
| --- | --- |
| [Slices](https://con-dog.github.io/slices-demo/) | A working instrument is the visual: dense lanes, explicit state, stepping controls. Closest to the requested hacky feel. |
| [Specks](https://specks.nicotejera.com/) | Short introduction, readable screenshot, a tour ordered by actual work. |
| [Harbor](https://www.harborgit.com/) | Shows the application immediately and explains advanced features through concrete user problems. |
| [CAVE](https://mirekrusin.com/cave/) | Code as a first-class visual and a directly accessible playground. |
| [Canine](https://canine.sh/) | Strong type and developer-oriented installation; its larger marketing structure would overwhelm cctrace. |
| [Resterm](https://github.com/unkn0wn-root/resterm) | Screenshot-led README tour of a dense technical tool. Inspected as document structure, not animation. |

The first five were viewed in a browser. These are design judgments, not a
ranking of product quality or claims about untested animations.

## Reader questions

- What happened while the agent worked? Sessions, tools, reviewer branches, replay.
- What is filling the context? Composition over time, file and tool weights, compaction.
- Why did this run cost so much? Cache behavior, estimated cost, insights across runs.
- What actually went out? Captured requests, responses, host and credential handling.
- Can I use it now? One install, one command, runtime prerequisites stated.

## Demo provenance and upkeep

The sample is a REAL session, not a fixture. `docs/demo/capture.sh` records a
sandboxed Claude Code run: a clone of this repo at a neutral path, a demo
agent profile (`CLAUDE_CONFIG_DIR` → docs/demo/profile/, so no personal global
instructions, memory, or skills enter the context), `--redact-ids` on, and
seven scripted turns of real work — explore, read deep, diagnose a real bug,
fix it, have a subagent review it, run tests, summarize.

`bun run docs/demo/build.ts <trace>` renders that trace with the production
snapshot renderer and writes `docs/demo/sample.html` plus
`docs/assets/demo-data.js` (the landing chart, from the production context
calculator). It folds bodies to a page budget (src/fold.ts) so every request
still reaches the page, then applies two safety layers on top of capture-time
redaction: SCRUB rewrites machine-local identifiers, and a publish GATE greps
the finished html for home paths, keys, JWTs, operator hosts, and addresses —
a hit fails the build. Keep both lists narrow; the build reports per-rule hit
counts so a dead rule is visible.

Numbers on the page (tokens, cache reads, cost, timings) are what the wire
said. Nothing is illustrative anymore.

One substitution, disclosed: Claude Code reads the operator's own
`~/.claude/CLAUDE.md` even when HOME and CLAUDE_CONFIG_DIR both point at the
sandbox (measured 2026-09-14, cc 2.1.272 — it does not resolve that path from
the environment). The build replaces that block, in every form it reaches the
wire in, with docs/demo/profile/claude-user.md, sweeps any stray line, and
fails the gate if a single line of it survives. `DEMO_KEEP_OPERATOR_MEMORY=1`
publishes it as captured. Everything else is the wire.

The published sample is the INTERACTIVE take (docs/demo/drive.sh): a TUI
session carries what headless cannot — slash commands, a model switch mid
thread, and a real `/compact` boundary. `docs/demo/capture.sh` alone produces
the headless equivalent, fully unattended.

Screenshots in `docs/assets/` show this sample in the shipped UI, at 1440×850,
dark theme. Context is pinned with the inspector closed; Sessions shows the main
session; Requests shows the heaviest step. Regenerate and recapture after
material UI changes. The landing chart and sample always come from the same build.

Serve the repo with `python3 -m http.server 8733`, then open `/docs/`.
Check keyboard operation, narrow screens, reduced motion, copy feedback,
all three screenshots, and the linked sample before publishing. The context
walkthrough plays itself while in view (decision 2026-10-05: a still hero
read as a screenshot) and stops for good the moment the reader picks a
request or presses pause; reduced motion keeps it still on the peak step.
