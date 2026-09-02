# DESIGN.md — direction A, "the recorder"

A design proposal for the cctrace web UI, not the shipped material.
The shipped rules are `docs/design/ui.md` and `TASTE.md`; this file says
what this proposal is made of, so the team can judge it and so it can be
implemented without guessing.

Run `~/.claude/skills/design-skill/kit/check.sh docs/design/proposals/recorder`
after any edit. Last run: 0 fail, 0 warn.

## Direction

World: **candidate #1, "the strip-chart recorder"** (a multi-channel
recorder: paper roll, pen carriage, engraved panel), on the design-skill
floor kit re-inked from the material. Roll key `8e4546b4`; pool 7 (my 7
candidates; no deck card scored affinity for "wire tracer web UI for AI
coding agents: requests, session replay over time, context budget, cost",
so the deck stayed a challenger). Assigned candidate #1. Chosen
2026-09-02 because the product's hardest surface — a session as lanes
over wall-clock, scrubbed — is literally what a chart recorder is, and
the audience already reads instruments.

Hand rejected:
- **Almanac tear-off page** — declined (neither axis): a page per day
  fights a session that runs across days. Raise kept: its *fixed margin
  of standing facts*, which is why the ledger's balance never scrolls.
- **Library card catalog** — competitive on identification, declined on
  clarity: cards are discrete objects, a trace is continuous. Raise
  kept: the card's *one-object-per-row* discipline in the runs list.
- **Film slate and edge code** — competitive on clarity (timecode is
  honest addressing), declined on identification: the audience debugs,
  it does not edit. Raise kept: *every frame carries its own address*,
  which is why every row keeps its wall-clock column.

Also written down and kept off the list (the rut): the DevTools network
panel (the category default, and what cctrace ships today), the pastel
SaaS analytics dashboard (its predictable opposite), and ticker tape /
punched paper (the literal reading of "wire").

Scene: one engineer, second monitor, 01:00, dark room, a 668-pair trace
open, asking why the last turn cost $2.40 and what the agent did with it.

Mode: **operate** on every surface. Density is a feature.

Protected functions (a redesign that breaks one is costume): tail -f
semantics (newest at the bottom, never yank the scroll, announce with a
pill); j/k, `/`, Esc; one row per fact; both themes real; snapshot pages
work with no server; the three-view split and its rail | work geometry;
the strip as a frame element that never scrolls away; the six context
categories summing to the window; select-to-purge as the one destructive
surface; `data-mask` for screen sharing.

## Palette: provenance

Authored from the material — chart stock, fiber-tip pen inks, instrument
enamel — by eye at 1x, **not sampled from a scan**. Stated plainly so the
next person improves the provenance rather than trusting it.

| role | light: the roll on the desk | dark: the recorder's screen |
|---|---|---|
| ground | chart stock, warm (hue 88) | enamel, green-black (hue 175) |
| ink | graphite, cool (hue 250) | paper white under the lamp (95) |
| rule | printed salmon grid (hue 32) | dim phosphor rule (hue 165) |
| accent | pen 2, ink blue (hue 250) | the same pen, luminous |

The irregularity kept: four materials, four hues, and they disagree —
the stock is warm, the graphite is cool (ink is never the paper's hue),
the printed grid is the only chromatic neutral and is *lighter* than
diluted graphite would be, and the enamel is green because instrument
cases were. Strategy: restrained (the accent is under 2% of any
viewport). Dark is not the light theme inverted; it is the second
observed object.

Data colors are the **pens** and are identical in both themes, because a
wire fact is not a chrome decision: model / tools / waiting / subagents,
mid-tone so the same ink reads on cream and on enamel. Cost is a
sequential ramp of one ink (pen pressure), never a second categorical
set. Green / amber / red stay state and are never spent on data.

`check.sh` palette warnings: none.

## The material

Tokens in `tokens.css`; `app.css` and `index.html` use tokens only.

| Dimension | Value | Law |
|---|---|---|
| Faces | one system mono for everything, one system sans at 10px for engraved panel labels only | no webfonts ever — the product ships one self-contained HTML file |
| Scale | 10 / 11 / 12 / 13 / 15 / 24px — six sizes, three weights (400/500/700) | the 24px display is spent once per view (the context balance) |
| Measure | 74ch on prose | |
| Radius | `--radius: 2px`, and 0 on the chart itself | instruments and paper have no rounded corners |
| Surfaces | rules, never cards; the printed grid is the ground of every work surface | structure before shadow |
| Density | 25px rows measured (40 per 1000px of list), 3px vertical padding; direction B fits 33 | never delete information to breathe |
| Motion | two owners only: the carriage under the pointer, and the live lamp's 2.4s beat while a request is in flight. 90ms micro / 160ms base | everything else instant; reduced motion drops both |
| Icons | the product's existing client glyphs (`src/icons.ts`), unchanged | one set, one weight, one mark per CLI everywhere |
| zh mode | off (English-only surface today; the CJK route in the kit is unused) | |

## Signature moves and device ration

Signature, and no others:
1. **The carriage** — one hairline with a head and a readout. It is the
   playhead on the session strip, the hover readout on any timed
   surface, and the pin in the context deck. One object, three surfaces,
   learned once.
2. **The printed rule as ground** — the work surface is ruled stock, so
   an empty list still reads as paper with nothing printed on it yet.
3. **The pens** — four inks that mean four wire facts everywhere they
   appear.

Per page: one masthead device (the identity strip) and one section-label
device (the 10px engraved panel label). Uppercase appears exactly once,
on the category badge.

## Voice

Lowercase labels, verbs on buttons, the wire's own vocabulary
(`cache_read`, `stop_sequence`, `ttft`) never softened into product
words. Numbers state their unit and their estimate marker (`≈`, `est`).
Deadlines are absolute wall-clock, never countdowns.

## What the cold review changed

A reviewer with no build history audited this against the skill's rubric
(fresh context, evidence-first). It graded P0 and was right about the
thing that mattered: the requests view was the DevTools network panel
with the world applied as a background texture, which is the exact rut
DESIGN.md says was kept off the list. Two structural changes answer it:

- **The paper advances with the clock.** The blank between two rows is
  the wait between two requests, drawn to scale, and a gap over five
  minutes folds to a hatched band that says how long ("1h 28m with
  nothing on the wire"). The ruled ground now measures something, the
  empty stretch is the answer to "what was it doing", and no table can
  say it.
- **The pen channel.** Every row opens with its own stroke on a shared
  scale — the light part is time to first token, the solid part the
  rest, the ink is its channel's pen. The row is a recording before it
  is a record.

Also fixed from that review: the inspector actually closes (Esc / ×) —
it used to drop to a full-width block under the deck, the shape ui.md
rejects; the rail is never deleted at narrow widths, it becomes a pane
with a visible `detail` / `list` toggle; the toolbar scrolls instead of
clipping at 768; rows, threads, turn rows and icicle nodes carry real
roles, focus and Enter/Space, and the global j/k no longer fires while
you type in the filter; the five states are shown on the brand sheet
(hover, focus, disabled-with-reason, loading, empty, error, select-to-
purge, masked identity) instead of being asserted in prose; the
dashboard states its own identity (all runs, 4 projects) instead of
borrowing one trace's, its rows are links, and a trace that is not on
this machine sits there dimmed saying so.

Two number bugs it caught, on the one view whose point is that the
numbers reconcile: 151k against 186k is 19% under, not 41% (41% was the
quota line), and the step's turn was stated twice with two values.

Colour was cut from fourteen inks to seven: a category's mark is now the
pen of the channel it belongs to (messages and count_tokens are the
model pen, mcp is the tools pen, oauth is the agents pen), telemetry is
grey, external is the one ink outside the channels, and the cost ramp is
one ink's pressure. Same ink, same meaning, everywhere.

Still open, and the team should weigh it: the session, context and
dashboard layouts are the shipped layouts re-inked. The reviewer's
verdict — "a new palette and vocabulary on an unchanged product" — is
now false for the requests view and still true for the other three.
Whether that is a defect or the point is the decision this proposal
exists to force.

`check.sh` and `render-check.mjs` warnings that remain, with reasons:
- 4 tap targets under 44px at 390: all four are the DEMO page's own
  width and theme switcher, not product surface. Inside the app, rows
  and controls grow to 36 / 30px under 520px.
- the 2px inset accent on a selected row is a selection mark, not the
  decorative side-stripe the anti-pattern list bans; it is what the
  shipped UI already uses and what the keyboard needs to track.

## What implementing this costs

The token block plus roughly 320 lines of CSS inside `src/ui.ts`, and
almost no markup change: today's classes map one to one (`.row`,
`.cat-badge`, `.fold`, the strip's lanes, the ledger). The two new
behaviors are the carriage as a shared object and the ruled ground.
The risk to test first: the grid must stay under the text on a low-end
panel — if it reads as noise at 100% zoom on a cheap monitor, drop the
minor rule and keep the major.
