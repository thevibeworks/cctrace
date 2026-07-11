# Design: Session Replay

Status: proposed (design only — no implementation yet)
Owner: cctrace core
Date: 2026-07-10

## Problem

A trace is a complete record of a session, but our views only show its final
state. When something goes wrong at turn 12 of 40 — a bad tool call, a context
blow-up, a wrong decision — you read the aftermath, not the moment. The
question users actually ask is temporal: *"what did the agent know, and what
was on the wire, when it did X?"*

Replay = re-experience the session as it happened, at any speed, from any
point.

## Jobs to be done

1. **Post-mortem debugging** — step through the session decision by decision,
   with the wire request that produced each turn one click away. "Why did it
   pick that file?" is answered by looking at the exact context it had then.
2. **Demo & share** — replay a session like asciinema for agent traffic.
   Deep-link a moment ("look at minute 14") instead of pasting screenshots.
3. **Audit & teaching** — watch context grow: what got injected when (system
   prompt changes, tool results, memory), how a subagent dispatch unfolds.
4. **Cost & performance** — watch token burn and cache hit-rate evolve; spot
   the request where the context ballooned.

## What the wire already gives us (and what it doesn't)

The key insight: **replay is a viewer-side feature.** Every pair already
carries `request.timestamp`, `response.timestamp`, and `duration` — the trace
*is* a timeline. P1 and P2 need zero capture changes and work on every trace
ever captured, including snapshots and `cctrace view` rebuilds.

What we do NOT have: intra-response chunk timing. `bodyRaw` stores the full
SSE text but not when each chunk arrived. So a token-by-token "typewriter"
replay of a streamed reply would be *simulated* pacing, not recorded truth.
We don't fake it: event-grade replay first (honest), recorded chunk timing
later as an opt-in capture extension (P3).

## UX model

Replay lives **inside the Session view** — it is a time cursor over the same
data, not a separate page. A transport bar appears above the conversation:

```
[⏮] [▶/⏸] [1x 2x 8x 60x]  ─────●────────────────  14:32 / 41:07  [live ⤓]
                            ^ scrubber = session minimap
```

- **Scrubber doubles as a minimap**: request density, error marks, and
  big-token turns drawn on the track. Valuable even when not playing.
- **Cursor semantics**: everything at or before the cursor renders normally;
  everything after is hidden. Both panes obey the cursor — the wire list
  shows requests made so far, the conversation shows turns completed so far,
  the usage chips show *cumulative usage at that moment*.
- **Idle compression**: real sessions have 20-minute thinking gaps. At 1x,
  inter-event gaps are capped (~2s); a "skip idle" indicator shows compressed
  time. Wall-clock purists can turn it off.
- **Keyboard**: space play/pause, ←/→ step one turn, shift+←/→ step one wire
  request. j/k stay reserved for the requests list.
- **Deep links**: `#/session/<key>/@<pair-id>` — anchor on pair id, not
  wall-clock offset, so links survive cross-run history merges and re-traces.
- **Live sessions**: entering replay detaches the live tail (the scrubber
  keeps growing at the right edge); a `live ⤓` button jumps back to now and
  re-attaches. Exactly the tail/pill interaction the session view already
  has, generalized to a cursor.

## Architecture

One pure function is the whole feature:

```
visibleAt(pairs, cursor) -> pairs'   // the wire as of the cursor
```

then the existing `buildSession(pairs')` reconstructs the conversation as it
stood at that moment — the attribution loop already handles partial history
(it is the same code path that renders mid-capture live sessions today).
Rendering stays: state -> full re-render, memoized per turn boundary if it
gets slow. No new data model, no parallel render path, no drift.

Playback is a `setTimeout` ladder over the sorted event boundaries
(request start / response end per pair), scaled by speed and idle-capped.
Pure and unit-testable: `nextTick(events, cursor, speed) -> {cursor', delay}`
goes in `summarize.ts`-style inline-injected code so live and snapshot pages
stay identical.

**Capture extension (P3 only):** record `chunkTimes: [[offsetMs, bytes],...]`
on streamed responses behind a flag (`--record-timing`). Bounded (cap entry
count, coalesce <10ms arrivals); versioned so old traces replay at event
grade and new ones at stream grade. This is the only part that touches
capture, which is why it comes last.

## Non-goals

- **Re-execution.** Replay renders recorded bytes; it never re-sends
  requests. There is no "resume from here" — that's a different product.
- **Editing/branching history.**
- **Video export.** The snapshot .html already embeds everything; a replay-
  capable snapshot IS the shareable artifact (P4 polishes this, e.g. start
  paused at an anchored moment).

## Phasing

| Phase | Ship | Needs capture change |
|-------|------|----------------------|
| P1 | Turn stepper: ←/→ walk the conversation as-of each turn, wire pane synced, cumulative usage at cursor | no |
| P2 | Transport bar: time-scaled play, scrubber/minimap, idle compression, deep-link anchors | no |
| P3 | `--record-timing`: chunk-timed streaming replay (true typewriter) | yes (opt-in) |
| P4 | Shareable replay snapshots (open paused at an anchor) | no |

P1 alone already answers the post-mortem job and is a weekend-sized change;
it also forces `visibleAt()` into existence, which P2 merely animates.

## Open questions

1. Scrubber granularity on multi-run sessions (history merges can span days —
   per-run segments on the track?).
2. Should the requests list (non-session view) also obey the cursor when
   replay is active, or stay full? Leaning: stay full, replay is a session-
   view concept.
3. `count_tokens` / usage-probe pairs during replay: show on the minimap as
   ticks, or hide as noise? Leaning: ticks, they mark turn boundaries well.
