# DESIGN.md — direction B, Claude Design System

A design proposal for the cctrace web UI, not the shipped material.
The shipped rules are `docs/design/ui.md` and `TASTE.md`.

Run `~/.claude/skills/design-skill/kit/check.sh docs/design/proposals/claude-cds`
after any edit. Last run: 0 fail, 0 warn.

## Direction

World: **none rolled — this is a governed context.** The design-skill's
own gate says an official system is the material: adopt it whole
(palette, geometry, type ramp, a11y contract) and spend judgement only
on what it leaves undecided. cctrace traces Claude Code; the system that
governs is Claude's.

Direction A's roll (`8e4546b4`, pool 7) covers the invented half of this
pair. This half is the standing exit played straight, which is why it is
worth building rather than describing: the interesting question is not
whether CDS is pretty, it is whether a 668-row wire tracer survives
inside it.

Chosen 2026-09-02. Scene: the same 01:00 engineer, but the argument is
that they have been reading Claude surfaces all day and this is one more.

Mode: **operate**, inside a system tuned for **read**. That tension is
the direction's whole risk and is stated in the review sheet.

Protected functions: identical to direction A's list — tail semantics,
keyboard, one row per fact, both themes, snapshot-without-server, the
category taxonomy, the context invariant, select-to-purge, masking.

## Palette: provenance — measured

Read from **claude.ai/new on 2026-09-02**, in the live page, via
`getComputedStyle` over every `--cds-*` custom property (769 resolved).
Light values off the running `.cds-root`; dark values off a probe
element carrying the app's own dark hooks. Geometry measured the same
way, not guessed: a CDS button is **32px tall, 8px radius, weight 400**;
the sidebar rule is **0.5px at 10% ink**; body type is **14px**.

| role | CDS token | light | dark |
|---|---|---|---|
| ground | `--cds-page-bg` | warm paper | near-black |
| raised | `--cds-surface-0/2` | paper / white | #151515 / #1a1a19 |
| ink | `--cds-text-primary` / `-secondary` | #0b0b0b / #52514e | #f0efec / #c3c2b7 |
| rule | `--cds-border` | 10% ink | 10% white |
| accent | `--cds-text-accent` | #184f95 | #6da7ec |
| brand | `--cds-clay` / `--cds-fill-brand` | #d97757 / #c6613f | same |

The irregularity kept: CDS's neutrals are warm and its accent is a cold
navy, while the brand ink (clay) is neither — three materials, not one
ramp. Note for the team: **the current CDS product accent is blue, not
orange.** Clay is identity, not interaction; a proposal that paints
buttons orange is not this system.

What CDS leaves undecided, and what we chose: **data colors.** A tracer
needs lanes and categories. Rather than invent a set, this takes the six
hues CDS already ships for git status (`--cds-*-git-*`: green, blue,
violet, gold, orange, gray), so a cctrace lane and a Claude Code diff
badge are the same six inks. Cost is one sequential ramp mixed off the
clay, so it can never read as a second categorical set.

`check.sh` palette warnings: none. Pure `#fff` appears in `tokens.css`
only, where CDS itself puts it (`--cds-surface-2`), and nowhere in app
code — the checker's rule, and the right one.

## The material

| Dimension | Value | Law |
|---|---|---|
| Faces | `anthropic-sans` / `anthropic-mono` are licensed and not ours to ship, so the stack is **CDS's own declared fallback chain** (system-ui …; ui-monospace …). Mono appears only where wire characters matter: urls, ids, numbers, payloads | one pairing axis |
| Scale | the CDS ramp unchanged: 11 / 12 / 13 / 14 / 15 / 22px, weights 400/500/600 | six sizes |
| Measure | 46rem on the conversation (a Claude reading measure), 68ch elsewhere | |
| Radius | `--radius: 8px` (measured), 12px on panels, 5px on small controls, full on chips | one corner language |
| Surfaces | bordered panels for discrete objects; rules between rows; CDS's two-layer shadows on overlays only | cards only for discrete objects |
| Density | 30px rows — **ours**, chosen inside the system's range. CDS ships type steps for compact surfaces (`--cds-font-size-body--xs`, `caption--xs`), not a row height; the height is our call and the honest cost of this direction | density inside the system's range |
| Motion | CDS durations only: 100ms micro, 180ms base, one easing. The live dot beats at 2.4s in flight; the playhead follows the pointer | reduced motion drops both |
| Icons | the product's client glyphs (`src/icons.ts`) plus four 16px line glyphs for destinations, so a collapsed rail still names its destinations | one set, one weight |
| zh mode | off | |

## Signature moves and device ration

1. **read / wire** — any assistant turn flips in place to the exact
   request that produced it. In a Claude-shaped product the conversation
   is the object and the HTTP is its detail; this is the one control
   that says so.
2. **the destination rail carrying the run's identity** — the card that
   answers "what am I looking at" is part of the navigation, not a strip
   above the content.
3. **the drawer takes width, never covers** — an inspector that hides
   the numbers it explains is not an inspector.

Clay ration: the product's own agency, and nothing else — the mark, the
single primary action on a screen, and the playhead (which is that
primary action, running; while it runs the button steps back to
secondary). Everything else interactive is CDS blue.

## Voice

CDS/Claude register: sentence case, nouns for destinations, verbs on
buttons ("Replay", "Export", "Close"), no exclamation marks. Wire
vocabulary stays exact — `cache_read`, `stop_sequence`, `ttft` — because
softening it would be the one place this system could make the task
harder.

## What the cold review changed

A reviewer with no build history audited this against the skill's rubric
and graded P0. Its first finding was about the evidence, not the design:
this container had no sans face at all (`fc-match sans-serif` resolved to
Liberation Mono), so every capture rendered the 14px sans body as mono —
the one thing this direction is. Fonts installed, everything recaptured;
the mono/sans split is now visible, and so is the CJK sample.

Fixed from that review:
- **Facts were clipped mid-token** at 768 and with the drawer open
  ("cache 25", "stop_se"). A row's summary now ellipsizes, and the
  transport columns drop in a decided order — clock first, then
  duration — so a row never cuts a value in half.
- **The rail is no longer a rebus.** The icon-only tier at 1000px hid
  every destination label and left four glyphs beside four numbers; the
  labelled rail now holds to the bottom-bar breakpoint, and the bottom
  bar is labelled too.
- **Lanes stopped being the semantic tokens.** `--lane-model` was
  exactly `--accent-hover`, `--lane-tools` exactly `--ok`,
  `--lane-waiting` exactly `--warn` — one value, three meanings, against
  ui.md's rule that accent, category and status are three inks. The
  lanes are now one measured step off their anchors (`--cds-aqua-350`
  for tools) and no lane equals a semantic token.
- **Runs became rows again** — they had grown into 104px cards showing
  6 of 48 runs. One row per run, identity left, numbers right, and the
  runs screen's rail card states what it is (all runs, 4 projects)
  instead of asserting one trace's identity over a list of everything.
- The conversation shares the header's left edge instead of floating in
  its own column, and its measure came down to 38rem (~76 characters in
  a real sans, not 110).
- j/k moves the focus, not just a highlight; rows are a listbox of
  options; typing in the search no longer drives the list.
- The five states are shown on the brand sheet rather than asserted:
  hover, focus, disabled-with-reason, loading, empty, error, live vs
  snapshot vs stopped, select-to-purge, masked identity.
- Two invented numbers removed: 151k against 186k is 19% under, not
  41%, and the two assistant turns no longer flip to the same request.

Still open: `read / wire` and the drawer are now captured
(`claude-cds-session-dark-1440-wire.png`,
`claude-cds-requests-dark-1440-drawer.png`), because the reviewer's
sharpest point stands — without them this reads as a Claude-coloured
admin panel, and with them it reads as this product.

Warnings that remain, with reasons:
- **3 corner radii besides pills (8 / 5 / 12px)**: these are CDS's own
  measured radii (`--cds-checkbox-radius` is 5px, panels 12px, controls
  8px). A governed adoption keeps the system's geometry; collapsing them
  to one would be our taste overruling the system we said we adopted.
- **tap targets under 44px**: the flagged ones are the demo page's own
  width and theme switcher. Inside the app, CDS's measured 32px control
  height stands — this is a pointer-first desktop tool, and at 620px and
  below the destinations become a 44px+ bottom bar.

## What implementing this costs

Token block plus roughly 260 lines of CSS, but unlike direction A the
**frame changes**: tabs become a destination rail, the session view
becomes conversation-first with the wire behind a control, and two
panels become drawers. Budget the session view rewrite, not the palette.

Known tension, now measured rather than guessed: this direction fits
**33 rows per 1000px** of list (30px rows); direction A fits **40**
(25px rows). One row in six is the price of the reading scale. Either
the operator accepts that, or the request list drops to CDS's `--xs`
type step and closes most of the gap. That decision belongs to whoever
watches a live capture scroll, not to this file.
