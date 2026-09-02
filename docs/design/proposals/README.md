# Two design directions for the cctrace web UI

2026-09-02. Two complete worlds for the same product, built on the same
sample data so they can be judged on the same facts. Nothing here is
wired into `src/ui.ts` — these are proposals, and the decision is the
deliverable.

    docs/design/proposals/
      index.html          the review sheet: both lockups, the same screen
                          side by side, what differs, how to review
      recorder/           direction A — designed here, from /design-skill
        index.html          the demo (5 screens, 3 widths, both themes)
        tokens.css          the palette and the scale
        app.css             the surface
        logo.svg            the mark
        DESIGN.md           world, provenance, ration, cost to ship
      claude-cds/         direction B — the Claude Design System, adopted
        (same five files)

## How to look at it

    python3 -m http.server 8795 --directory docs/design/proposals
    open http://localhost:8795/

The review sheet frames both demos side by side and switches screen,
theme and width for both at once. Each demo also runs standalone
(`/recorder/`, `/claude-cds/`) with its own screen / width / theme bar.
Everything is static: no build, no network, no server logic.

Drive them, do not just look: `j`/`k` through rows, `/` to search, click
a turn block, drag the playhead, open an icicle node, press `esc`, flip
the theme, set the width to 390.

## A — "the recorder"

A trace is a recording, so the page is the chart it was written on:
ruled stock, four fiber pens, one carriage that stands wherever you
point. Mono everywhere, 25px rows, no radius above 2px. Dark is the
instrument's screen at night; light is the paper roll on the desk.

Made with our own `/design-skill` at direction scope: seven candidate
worlds, the dice assigned candidate #1 (roll `8e4546b4`), three
challengers fused and judged, the winner built and the raises kept.
`recorder/DESIGN.md` records all of it.

## B — Claude Design System

cctrace traces Claude Code, so it reads as part of the same product.
This is a governed context, so nothing is invented: the palette,
geometry and type ramp were **measured off claude.ai on 2026-09-02** —
769 `--cds-*` custom properties read out of the live page, both themes,
plus the real control geometry (32px buttons, 8px radius, weight 400,
0.5px rules at 10% ink, 14px body). `claude-cds/tokens.css` names the
CDS token behind every value, and `claude-cds/DESIGN.md` records what
CDS leaves undecided and what we decided instead.

Two things worth knowing before the meeting: the current CDS product
accent is **blue**, not orange — clay is identity, not interaction; and
`anthropic-sans` / `anthropic-mono` are licensed faces we do not ship,
so the demo renders CDS's own declared fallback chain.

## Audited, not just built

Both directions were reviewed cold (fresh context, evidence first) against
the design instrument's rubric, and both graded P0 on the first pass:
direction A's requests view was the DevTools panel with a texture behind
it, and direction B's captures rendered its sans body as mono because this
container shipped no sans face. Both were fixed — A's list now advances
with the clock and draws each request as a stroke; B was recaptured with
real fonts — along with clipped facts at narrow widths, fake keyboard
support, unshown states, colliding inks and three invented numbers. Each
`DESIGN.md` records the audit and what remains open.

## The decision

Everything else follows from one question: **is cctrace a piece of lab
equipment, or part of Claude?**

Keeping today's UI is the third, free option, and it is not a bad one —
it is the category's default (GitHub-dark, tabs, one accent), which is
exactly why it reads as a devtools panel rather than as ours. Compare
against it with:

    bun src/cli.ts view <trace> --no-open --port 8791

## Evidence

Both directions pass the design-skill's binding checks:

    ~/.claude/skills/design-skill/kit/check.sh docs/design/proposals/recorder     # 0 fail, 0 warn
    ~/.claude/skills/design-skill/kit/check.sh docs/design/proposals/claude-cds   # 0 fail, 0 warn
    node ~/.claude/skills/design-skill/kit/render-check.mjs \
      http://localhost:8795/recorder/ http://localhost:8795/claude-cds/           # 0 fail

Rendered captures at 390 / 768 / 1440 in both themes are in
`test-output/design-review/` (gitignored). Every warning that remains is
recorded with its reason in the direction's `DESIGN.md`.

All sample data is wire-shaped and invented — no real session content,
no paths, no ids from anyone's trace.
