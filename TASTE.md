# TASTE.md — design scars

Prior design rulings for the cctrace web UI. A scar is a rejection plus the
reasoning that killed it. Read this before any design verdict — these are
settled calls, not open questions. The *why* is the load-bearing part: a rule
with a why adapts to new cases; a naked ban fossilizes into style police.

The live rules are in `docs/design/ui.md`. This file is the graveyard behind
them — what we tried and rejected, so it stays rejected.

## 2026-07-20 rejected: inline per-turn metrics on outline rows
Numbers (tokens, cost, ttft, duration) sat inline on each turn row next to the
message text. Why: they fought the text for the same pixels — the row's one
job is to say WHICH turn this is, and a scannable list dies when every row is
half numbers. Moved every metric to the instant hover; the row is now
`[dot] [ordinal] [message]`.
Reuse: on a scannable outline or list, one fact per row — the identity. Push
stats to hover. If a metric must be inline, the row stopped being an outline.
Expires: never at terminal density.

## 2026-07-20 rejected: labeling prefix-divergent exchanges "↩ rewound"
The wire detection (history diverges from the spine's prefix) fires equally for
/rewind, an edited message, AND ephemeral injected exchanges (the auto-recap is
injected, answered, then dropped). "Rewound" asserted a user action that often
never happened. Why: a label must state what was OBSERVED, never an inferred
cause. Renamed to "superseded" — this exchange left history; the possible
causes are listed in the hover, not asserted in the label.
Reuse: name displays by the observed fact, not the guessed reason. When one
signal has several causes, list them; don't pick one and assert it.
Expires: never (this is invariant #9, trustworthy representation).

## 2026-07-20 rejected: three row grammars in one session card
A session card stacked epoch rows (glyph + T0), turn rows (dot + ordinal), and
thread cards (kind chip + label + meta) — with spawned agent threads detached
at the bottom even though the spawning turn is known. Why: it didn't read as
one session; the eye couldn't follow a single structure through three layouts.
Unified into one rail — a continuous vertical line, every row a node on one
shared gutter (`.rgut`), agents attached as branch rows at their spawn turn.
Reuse: a container that represents ONE thing gets ONE row grammar and one
gutter. Attach children on the same rail; never stack sub-layouts for kinds.
Expires: never.

## 2026-07-20 rejected: hard colored border for user-turn emphasis
User turns were set off with a hard accent-colored border on the role bar. Why:
edges read as chrome, and accent (blue) is reserved for interactive elements —
an accent border on a non-interactive role bar miscommunicates "clickable."
Replaced with spacing + a faint accent WASH (no edge).
Reuse: emphasize with space and a low-mix wash, not a hard border. Reserve
edges and full accent for interaction.
Expires: if accent stops meaning "interactive."

## 2026-07-22 rejected: ui.md over-claiming its own rules
The design bible said "type scale 11/12/13px only" and "one accent … nothing
else gets color," but the shipped, defensible reality has a 9-10px micro-tier
(badges/labels/tags), a 16px wordmark, and purple for notable-event folds
(subagent/skill/MCP). Why: the bible is a contract the next contributor reads
before touching UI — a rule stricter than the good code mis-teaches, and
someone "fixes" the code down to the false rule or adds a fifth color thinking
four is fine. Reconciled ui.md to the built reality (rules 2 and the type-scale
standing decision).
Reuse: audit the rules against the shipped code, not the code against a stale
rule. A design bible that lies is worse than none. When code and doc disagree
and the code is defensible, the doc is the bug.
Expires: never.
