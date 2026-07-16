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
   data, status colors (green/red/amber) mark state. Nothing else gets color.
   If everything glows, nothing does.
3. **Terminal semantics.** The live views behave like tail -f: newest at the
   bottom, stick when you're there, never yank the scroll while you're
   reading history — new activity is announced (pill), not imposed.
4. **Keyboard is a first-class citizen.** j/k, Esc, / — every affordance is
   discoverable (title attrs, empty-state hints) but never required.
5. **Motion budget: ~zero.** One heartbeat pulse on the live dot, one smooth
   scroll on "jump to latest", one 160ms opacity fade on a live-arrived row
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

- Type scale is 11/12/13px only. New UI picks from those three.
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
- Floating chrome is limited to the tail pill and the nav rail; the rail is
  faint until hovered and every button names its keyboard shortcut.

## When adding UI

Ask, in order: does it help someone read a trace faster? Can it be a chip or
a row instead of a panel? Does it work in a snapshot with no server? Does it
work in light mode? Can the keyboard reach it? If any answer is no, redesign
before shipping.
