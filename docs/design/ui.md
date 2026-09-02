# Design language: the cctrace web UI

The UI's job is to make wire traffic legible to a person under time pressure.
Two things follow from that job, and every rule below protects one of them.

**The material is the Claude Design System** (0.48). cctrace traces Claude
Code, so it reads as part of the same product — and this is a governed
context, so nothing is invented: the palette, geometry and type ramp were
MEASURED off claude.ai on 2026-09-02 (769 `--cds-*` custom properties
resolved in the live page, both themes) and adopted whole. Judgement is
spent only on what CDS leaves undecided: row density inside its range, and
the data colors a wire tracer needs. `docs/design/proposals/claude-cds/`
carries the provenance and the audit; the token block at the top of
`src/ui.ts` names the CDS token behind every value.

**The behaviour is an instrument.** Dense, quiet, fast, keyboard-first: a
reader at 01:00 asking why the last turn cost $2.40. Where the system's
reading comfort and the operator's density disagree, the answer is stated
per surface — request rows are 26px on a 27px pitch (37 per 1000px of
list, measured at 1440, against the 24 the old bordered cards fit), the
conversation is 14px at a 46rem measure — never split the difference
silently.

## Principles

1. **Information first.** Tabular numerals, one row per fact. Density is a
   feature; whitespace earns its place by grouping, not by decorating. If a
   designer's instinct says "add a card", add a column — and a list of
   requests is RULES between rows, never a stack of cards (cards are for
   discrete objects; a trace is continuous).
2. **Two faces, one job each.** The reading face (CDS's declared fallback
   sans) carries prose, labels and controls; mono carries the wire — urls,
   ids, status codes, byte counts, payloads, anything the reader compares
   column-wise. A conversation set in mono reads as a log; a url set in sans
   cannot be scanned. No webfonts ever (self-contained pages), so
   `anthropic-sans` / `anthropic-mono` — licensed, not ours to ship — are
   not used.
3. **One accent, and clay is not it.** Blue (`--accent`) means interactive
   or selected. Clay (`--clay`) is IDENTITY — the mark, and the single
   primary action on a screen (and the playhead, which is that action
   running). Category colors mark data, status colors (green/red/amber)
   mark state, and violet (`--purple`) marks notable-event folds — subagent
   spawns, skills, MCP calls. Nothing else gets color. A page that paints
   its buttons orange is not this system.
4. **Terminal semantics.** The live views behave like tail -f: newest at the
   bottom, stick when you're there, never yank the scroll while you're
   reading history — new activity is announced (pill), not imposed.
5. **Keyboard is a first-class citizen.** j/k, Esc, / — every affordance is
   discoverable (title attrs, empty-state hints) but never required.
6. **Motion budget: ~zero.** One heartbeat pulse on the live dot, smooth
   scrolling on USER-INITIATED jumps only (jump-to-latest, outline/turn
   jumps — never on render-time tail sticking, which would be constant
   motion), one 160ms opacity fade on a live-arrived row
   (feedback that a row just landed — never on bulk renders or filter
   re-renders). Everything else is instant. Respect `prefers-reduced-motion`.
7. **Both themes are real.** Dark is the native habitat; light must not be an
   afterthought. Every new color goes through the variable block, never
   inline.
8. **Degrade honestly.** Snapshot pages, view-rebuilds without project meta,
   sessions without usage data — every view must make sense with pieces
   missing, and must not pretend to know what it doesn't (no fake timing, no
   invented labels).

## Standing decisions

- Type is the CDS ramp, six sizes, and nothing else: 11 (`--text-xs`,
  dense columns and meta) / 12 (`--text-sm`, labels, chips, controls) / 13
  (`--text-code`, wire values) / 14 (`--text-body`, conversation and reading
  prose) / 15 (`--text-heading`, the destination title and the wordmark) /
  22 (`--text-title`, ONE display number per view — today only
  `.cx-bal-n`, the context view's balance). Weights are 400/500/600
  (measured: CDS controls are 400, not 600). The display size is licensed
  by a view whose whole job is one number and is spent once: a second 22px
  figure on the same page cancels the first. Anything outside the ramp is
  drift, not a decision.
- Geometry is CDS's, measured: `--radius` 8px (controls, rows, folds),
  `--radius-sm` 5px (small marks, chips-with-corners), `--radius-lg` 12px
  (panels, menus, overlays), `--radius-full` for pills and dots. Data
  glyphs (lane bars, category dots at 7-8px) keep 1-2px corners — they are
  data, not chrome. Rules are 1px at 10% ink (`--border`); 20%
  (`--border-strong`) is the hover step, and there is no third weight.
  Controls are 26px in the operator toolbar, 32px (`--control-h`) where the
  system's reading control belongs (the rail's destinations).
- Palette: CDS, measured off claude.ai 2026-09-02, defined once in the
  `:root` block with the CDS token named on every line. Never inline a hex.
- Data colors are the six hues CDS already ships for git status (green,
  blue, violet, gold, orange, gray, plus its aqua): one fixed hex per
  meaning, the SAME in both themes (a wire fact is not a chrome decision),
  mid-tone so it reads on paper and on near-black. They live in
  `src/categorize.ts` (request categories), `src/context.ts` (the six
  window categories) and the `--lane-*` tokens (where wall-clock went). A
  cctrace lane and a Claude Code diff badge are the same ink.
- Scrollbars are thin and quiet (styled once, globally).
- `::selection` and `:focus-visible` use the accent.
- Raw payloads live behind `<details>` folds; folds the user toggles must
  survive live re-renders (positional restore — mutations are tail-only).
- Per-fold actions (copy, raw/pretty mode) are small quiet buttons inside
  the fold summary (`.fold-btn`), never a second toolbar; they stop the
  click from toggling the fold.
- Voice splits cleanly: destinations, page titles and the run card use the
  system's register (sentence case, nouns for places, verbs on buttons —
  "Requests", "Sessions", "Replay"); the operator's own controls stay
  lowercase ("tail", "select", "purge", "prev runs"). Wire vocabulary is
  never softened into product words: `cache_read`, `stop_sequence`, `ttft`
  read exactly as they do on the wire, because softening them is the one
  place this system could make the task harder.
- The frame is a destination RAIL on the left and a work column on the
  right. The rail carries, top to bottom: the mark, the RUN CARD (client ·
  trace · session id · live/snapshot state — the card that answers "what am
  I looking at"), the destinations with their counts, and the page's own
  chrome in the foot (instance switcher, version, mask/theme/source). The
  work column's header then says what THIS destination is and spends the
  rest of its width on that destination's numbers. Identity belongs to the
  navigation, not to a strip above the content; the page must always answer
  "what am I looking at" without scrolling. Under 1000px the rail narrows,
  under 760px it becomes a labelled bottom bar with 44px targets — the
  labels hold as long as they can, because four glyphs beside four numbers
  is a rebus, not navigation.
- Every tool_use folds to one line. The reader's attention belongs to system
  prompt, user prompts, subagent spawns, skills/MCP calls, and the final
  reply — a Read/Bash dump never earns default expansion. Notable folds keep
  a colored title, not an open body.
- User-turn emphasis is spacing + a faint accent wash on the role bar,
  never a hard colored border (edges read as chrome; accent is reserved
  for interactive elements).
- Assistant reply text renders a safe markdown subset (code, headings,
  bold, http(s) links) — escape first, transform after; anything the
  subset doesn't cover stays literal.
- Floating chrome is limited to the tail pill and the nav rail; the rail is
  faint until hovered and every button names its keyboard shortcut.
- Hover detail is one page-wide `.tip` singleton (filled from `data-tip`,
  first line = heading, a line of exactly `---` = hairline section divider,
  a `> ` prefix = faint interaction hint). A plain `title=` is folded into
  it on first hover (moved to `data-tip` so the native tooltip never
  fires). A ~120ms show delay debounces mousing across a row of chips — a
  debounce, not motion. Max width 320px, below the threads pane's 400px.
- A tooltip on a truncated surface LEADS with the full text the surface cut
  off (capped ~600 chars); a divider, then metrics, then hints. Hover
  answers "what does the rest say" first and "what can I do" last.
- Tooltips anchored inside the threads pane fly out to the RIGHT of the
  pane, never below the row — a below-tip covers the very rows the user is
  scanning. The tip hides when a live re-render detaches its anchor.
- A symbol that is also a control (the ❯ fold gutter) carries its own
  tooltip explaining the control; the row around it keeps the content tip.
- Select-to-purge is the one destructive surface: entered explicitly
  (toolbar Select), rows grow a quiet ○/● check gutter, the purge button
  wears the state red, and a confirm dialog spells out that trace files are
  rewritten. Hidden on snapshots — no server, nothing to delete.
- `data-mask` marks identity values (session id, project/trace title, credits)
  that `body.masked` blurs for screen sharing; hover reveals one deliberately.
  Display-layer courtesy only — capture-time redaction is `src/redact.ts`.
- Deadlines render as ABSOLUTE wall-clock ("held until ~14:32"), never
  relative countdowns: a rendered page must not go stale, and ticking
  timers are motion. State that depends on "now" (cache expired) is
  computed at render time only.
- Toolbar grammar: scope narrows left to right — list group
  (filter + prev runs + select) · page group (tail · clear) · trace group
  (replay · ⌘ actions) holding the right edge in both views. Destinations
  are NOT in the toolbar: they live on the rail (below). Groups are
  spans (the session view hides groups, not ids), page/trace groups open
  with a hairline, labels are lowercase, and a pressed toggle wears a
  quiet accent tint — never a green fill (green is state, not preference).
- Request rows: the PEN first (the row's own stroke on a shared scale —
  full-scale deflection is 30s of wall-clock, the faint head is time to
  first token, the solid tail the streaming that followed, the ink is the
  category's), then method · status · category · url, then content chips
  (model · effort · think · in/out · ≡cache · cost · state), then wire
  transport as right-aligned columns (sizes · ttft · duration · time). The
  ≡ glyph (U+2261) is the cache mark — slim, layered, one monospace cell.
  The chip line ellipsizes as a LINE, never mid-token, and the transport
  columns drop in a decided order as the viewport narrows (bytes, clock,
  ttft, chips) so a row never cuts a value in half.
- A wait between two requests over two minutes becomes a hatched band that
  says how long ("1h 28m with nothing on the wire") — the same threshold
  the trajectory bar folds idle at. A list that silently closes the gap
  makes an hour of nothing look like the next line; the empty stretch is
  the answer to "what was it doing".
- A row that carries BOTH a label and a number gives the label a measure
  (~46ch) and puts the slack after the number, not between them. The
  right-edge columns are transport (turn address, clock); the number that
  says what the row is worth travels with its label. A 46ch cap plus a
  flexible spacer is the pattern (`.cx-ev-gap`, `.cx-prow-gap`) — an
  amount parked 800px from the words it belongs to is a hunt, not a column.
- Every view is two panes: a narrow left column that states what you are
  looking at, and a wide right column you work in — requests
  (list | detail), sessions (rail | convo), context (ledger | deck, and
  a pick opens the INSPECTOR beside the deck).
  The left column is fixed-measure; the right one scrolls.
  A view that is one full-width ribbon is the odd one out and reads as a
  different product.
- The context decks share ONE inspector: a right panel opened by a pick
  (an icicle node, a stream record, an event row), closed by × / Esc,
  absent otherwise — the deck gets its width back. Inside, the facets
  stand VERTICAL on the panel's left edge: a rail is a table of contents,
  not a toolbar; it grows down, never wraps, the labels line up, and it
  lists only the facets the wire can answer for that pick (a tab that
  would say "n/a" is not a tab). The head names the pick in its deck's
  own vocabulary — the category dot, the kind badge, the kind chip — and
  the facet body scrolls alone. A detail that opens UNDER the thing you
  clicked scrolls that thing away; a detail that is always open spends
  its width on "pick something".
- A control that scopes what is below it belongs to the FRAME, not to the
  scroll. The context overview brushes a range every deck under it reads;
  scrolling it away would leave the reader looking at filtered content
  with the filter off screen. Same rule as the toolbar and the tabs.
- A number is stated ONCE per view. If the same figure appears in a
  headline, a legend and a chart, two of the three are decoration —
  delete them or make each a genuinely different form (a list that is
  always the same six lines is not the same thing as a chart that
  reorders and rescales).

- The replay strip is the session view's FRAME element the way the
  context overview is the context view's: lanes x wall-clock, the playhead
  and the slice spanning every lane, never scrolled away. Reading depth is
  a function of zoom (map / read / full on `data-depth`), not a toggle.
  The strip's clickable UNIT is the turn: one block per working loop on
  the top lane, numbered at any depth the block can hold the number
  (the number is the point; the words wait for full depth), the tally on
  hover, and the block under the conversation's reading position lit —
  a 2px point per prompt was a target nobody could hit and a fact nobody
  could read.
  While replaying the page has ONE motion owner: the playhead. (The loop
  row's flowchart was the second, and it was deleted in 0.47 — a machine
  with three states never changes shape, so after one glance the drawing
  carried no information.) Nothing else tweens, counts, or ticks — a still
  frame is always complete. It drops under `prefers-reduced-motion`. The
  strip's axis is the SELECTED thread's own time with idle gaps over two
  minutes folded to a hatched break (`⧸⧸ 1h 29m`) — a session never sits
  in a quarter of a frame ruled by somebody else's hours, and a lunch
  break is not half the strip. The FUTURE is what dims — the veil right of the
  playhead — never the past: tinting what the reader is looking at costs
  the data its contrast.
- The dashboard (`src/dashboard.ts`) is part of this design system, not a
  side page: same variable block, same type scale, same lowercase labels,
  same small-button grammar for its group-by control, and the same client
  glyphs as the trace view header (both import `src/icons.ts` — one mark
  per CLI everywhere; never redraw a client icon locally). Rows follow the
  one-row-per-fact rule: identity left (dot · client · project · prompt ·
  sid), numbers right (size · pairs · tokens · when), tabular numerals.
  A row that can open something IS a link (live instance, rendered run
  snapshot); a row that can't (trace missing) says why, dimmed. "Missing"
  is decided by findTraceCarrier, not a single stat: a compressed or
  session-merged trace still opens.

## When adding UI

Ask, in order: does it help someone read a trace faster? Can it be a chip or
a row instead of a panel? Does it work in a snapshot with no server? Does it
work in light mode? Can the keyboard reach it? If any answer is no, redesign
before shipping.
