# Design language: the cctrace web UI

The UI's job is to make wire traffic legible to a person under time pressure.
The aesthetic follows from that job: it should feel like a well-kept terminal
— dense, quiet, fast — not like a dashboard product. Every rule below exists
to protect that feeling.

## Principles

1. **Information first.** Monospace, tabular numerals, one row per fact.
   Density is a feature; whitespace earns its place by grouping, not by
   decorating. If a designer's instinct says "add a card", add a column.
2. **One accent.** Blue (`--accent`) means interactive. Category colors mark
   data, status colors (green/red/amber) mark state, and purple (`--purple`)
   marks notable-event folds — subagent spawns, skills, MCP calls. Nothing
   else gets color. If everything glows, nothing does.
3. **Terminal semantics.** The live views behave like tail -f: newest at the
   bottom, stick when you're there, never yank the scroll while you're
   reading history — new activity is announced (pill), not imposed.
4. **Keyboard is a first-class citizen.** j/k, Esc, / — every affordance is
   discoverable (title attrs, empty-state hints) but never required.
5. **Motion budget: ~zero.** One heartbeat pulse on the live dot, smooth
   scrolling on USER-INITIATED jumps only (jump-to-latest, outline/turn
   jumps — never on render-time tail sticking, which would be constant
   motion), one 160ms opacity fade on a live-arrived row
   (feedback that a row just landed — never on bulk renders or filter
   re-renders). Everything else is instant. Respect `prefers-reduced-motion`.
6. **Both themes are real.** Dark is the native habitat; light must not be an
   afterthought. Every new color goes through the variable block, never
   inline.
7. **Degrade honestly.** Snapshot pages, view-rebuilds without project meta,
   sessions without usage data — every view must make sense with pieces
   missing, and must not pretend to know what it doesn't (no fake timing, no
   invented labels).

## Standing decisions

- Type scale is 11/12/13px for text and rows — new row UI picks from those
  three. Badges, small-caps labels, and tags drop to a 9-10px micro-tier
  (`.cat-badge`, `.klabel`, `.tcompact-label`, `.sum-tag`). Above 13px there
  are exactly two: the header wordmark (16px) and ONE display number per
  view — today only `.cx-bal-n` (24px), the context view's balance. The
  display size is licensed by a view whose whole job is one number, and it
  is spent once: a second 24px figure on the same page cancels the first.
  That is the whole closed set — anything else is drift, not a decision.
- System monospace stack; no webfonts ever (self-contained pages).
- GitHub-dark derived palette, defined once in `:root` variables.
- Scrollbars are thin and quiet (styled once, globally).
- `::selection` and `:focus-visible` use the accent.
- Raw payloads live behind `<details>` folds; folds the user toggles must
  survive live re-renders (positional restore — mutations are tail-only).
- Per-fold actions (copy, raw/pretty mode) are small quiet buttons inside
  the fold summary (`.fold-btn`), never a second toolbar; they stop the
  click from toggling the fold.
- The header carries run identity (client · project · session id) — the page
  must always answer "what am I looking at" without scrolling.
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
- Toolbar grammar: scope narrows left to right — view tabs · list group
  (filter + prev runs + select) · page group (tail · clear) · trace group
  (replay · ⌘ actions) holding the right edge in both views. Groups are
  spans (the session view hides groups, not ids), page/trace groups open
  with a hairline, labels are lowercase, and a pressed toggle wears a
  quiet accent tint — never a green fill (green is state, not preference).
- Request rows: content chips left (model · effort · think · in/out ·
  ≡cache · cost · state), wire transport as right-aligned columns (sizes ·
  ttft · duration · time). The ≡ glyph (U+2261) is the cache mark — slim,
  layered, one monospace cell.
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
  While replaying the page has TWO motion owners, both deliberate: the
  playhead, and the loop row's lit edge — the flowchart of Claude Code's
  loop under the strip draws the transition in progress as a flowing
  dash (a static lit chip failed to read as "the loop is running" on
  inspection, 2026-08-29). Nothing else tweens, counts, or ticks — a
  still frame is always complete; the model box's heartbeat fires only
  while a request is actually in flight. Both drop under
  `prefers-reduced-motion`. The strip's axis is the SELECTED thread's own
  time with idle gaps over five minutes folded to a 28px hatched break
  (`⧸⧸ 1h 29m`) — a session never sits in a quarter of a frame ruled by
  somebody else's hours, and a lunch break is not half the strip. The FUTURE is what dims — the veil right of the
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
