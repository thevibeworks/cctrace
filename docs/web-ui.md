# The web UI

One self-contained page serves the live view, `cctrace view` rebuilds, and
offline snapshots -- same UI, three ways in.

- **Inline row summaries** -- every request row reads left-to-right:
  model, requested reasoning effort (`effort high` / `xhigh` / `adaptive`
  / a token budget -- every wire shape the four clients send, tooltip
  names the field), thinking tokens, in/out tokens, a `≡` prompt-cache
  verdict (green hit with read/write arrows + hit %, amber cold write or
  miss; the tooltip states the absolute hold-until wall-clock, and the
  newest request says "expired" when the page renders past its deadline),
  estimated cost -- then right-aligned wire columns: body sizes, `ttft`,
  duration, time. count_tokens results, usage window percentages
  (5h / 7d / per-model), telemetry event counts, and error types keep
  their own chips.
- **First-token latency** -- streamed model calls carry a `ttft` column
  (measured live at the proxy pump; SSE events carry no timestamps, so a
  saved trace can't reconstruct it) and tok/s computed over the
  post-first-token stream -- slow-start vs slow-stream is one glance.
- **Category filter chips** with live counts -- only the categories the
  trace actually has (a Codex run shows no Count Tokens chip). Click to
  filter; combine with text search.
- **Split detail panel** -- click a row and the detail opens beside the list
  (deep-linkable by request id, click the id in the sticky toolbar to copy
  it). DevTools-style order: chips, then Headers and body folds (every
  fold has a copy button; bodies toggle pretty/raw), then the conversation
  with the streamed reply decoded from SSE; usage requests render limit
  bars. `j`/`k` walk the filtered list.
- **Sessions view** -- the reconstructed conversation on a rail, where a
  TURN is what a human means by one: user request (a `❯` row), the
  agent's work indented under it -- tool rows read `Edit(src/ui.ts)`,
  `Bash(Install deps)`, `Agent(general-purpose · goal)` with
  workspace-relative paths -- and the final response (`↳`). A real
  213-message trace reads as 3 turns. Harness-authored messages
  (recaps, reminders, notification wakeups -- role "user" on the wire,
  but not the human) wear a small SYS tag; subagent runs attach as
  branches at the spawning turn with their model and outcome; a
  `/model` switch marks an epoch; a compaction marks a break node with
  the context collapse in turns and tokens; superseded exchanges
  (rewinds, edits, injected recaps) sit grey at the ordinal they
  occupied. Every turn links back to its wire request; tokens, timing,
  cost, exact model ids, and effort levels live in hovers. Image
  attachments render as real thumbnails (click for full size) -- the bytes
  were already in the trace; remote image URLs are named, never fetched.
  A masked screen-share mode (header eye toggle) blurs session ids and
  account values.
- **Context view** -- the agent's context window over time, in a shell
  that reads like Chrome DevTools' Performance panel. An interactive
  OVERVIEW sits on top and never scrolls away: one stacked column per
  wire request (or per turn), colored by the six things a window is made
  of, with ✂ and an amber axis break marking compactions and rewinds, and
  a second track underneath showing where that step's wall-clock went
  (model / tools / waiting). Drag across it to select a range, drag the
  handles to resize it or the window to pan it, wheel to zoom in around
  the cursor, click a column to pin one step, `Esc` to peel back.
  A MARGIN beside the decks states the balance for the pinned step and
  repaints on every scrub: its prompt tokens, a six-color bar scaled
  against the model's context window, how far the chars/4 estimate reads
  under or over the billed prompt, and the six categories as ledger lines
  (system prompt, tool schemas, your messages, injected context,
  assistant replies, tool results) -- click a line to zoom the graph to
  it. Under them the step's links out, the top tool schemas by size,
  where the thread's time went, and, on a trace holding several sessions,
  the other threads: peak assembled context per thread, one scale, click
  to switch.
  What you select is then read three ways, one deck at a time:
  - **window** -- the pinned step as a context graph: an icicle where
    width is tokens and rows are levels, decomposing it into category ->
    group -> item, with tool results grouped by the tool that made them,
    schemas by MCP server, injections by producer. Click a node to zoom,
    a leaf to open its exact bytes below; row 1 is the margin's own six
    categories, so the graph reads as that bar growing downward. Every
    row names where it came from ("since turn 04 . step 2") and clicking
    that pins the step that first carried it in.
  - **stream** -- the agent's path as one linear stream of records:
    system prompt, the human's turns, the context the harness injected
    (inline, first-class, at the moment it entered), the model's
    thinking, each tool call fused with its result, the reply --
    kind-badged, in spine order, every record linked to its wire pair and
    addressed turn NN . step N exactly as the Sessions outline addresses
    it. A record list beside an inspector that reuses the detail panel's
    own block renderers. Three detail levels, filtering only, never
    summarizing (the bar says how many rows it hid): MAP is the skeleton
    (system, the human, the tool calls), READ drops the token budget
    banners and bare thinking, FULL is everything. A kind filter isolates
    one record type -- context-only is the context trajectory: you watch
    context enter the window inline with the reasoning that consumed it
    -- plus search.
  - **events** -- every injection with its producer (AGENTS.md, system
    reminders, recaps), every compaction with the tokens it reclaimed,
    every model switch and tool-schema change, each linked to its wire
    request.

  Because cctrace sits on the wire, every step is exact -- the captured
  request body IS the assembled context -- and every figure is anchored to
  the provider-reported prompt tokens of that same request. Estimates wear
  ≈ and never replace actuals.

  **Cost and quota** ride the same selection. The overview grows a third
  track: what each step cost, stacked cache read / cache write / input /
  output (most of a session's spend is re-reading the window, so the read
  band is usually the bar). Steps that bought their prefix twice wear an
  amber `$`, and the margin's "where the money went" block gives the
  split per component and per model, the pinned step's own bill
  ("≈$0.42 this step . 97% from cache"), and a bumps line that opens the
  events deck filtered to them. Each bump names its cause from the wire --
  cache expired (with the ttl and how long it idled), prefix changed (the
  system prompt, the tool schemas, a compaction, a model switch), or a
  retry after a request that failed and never banked its write -- with
  what a warm cache would have saved. A "quota" block shows the account
  limits as the client last polled them (5h / 7d / model-scoped, percent,
  absolute reset time, and the movement across this trace); clients that
  never poll show none. Every dollar is an estimate from catalog rates
  and says so; unpriced models show nothing rather than $0.
- **Session replay** -- re-experience a captured session as it happened, right
  inside the Sessions view: `←`/`→` step through turns (`shift` steps every
  wire request), `[`/`]` jump between working loops, `Space` plays at
  1/2/8/60x with long idle gaps compressed. Pause anywhere and the URL
  (`#/session/<key>/@<pair-id>`) deep-links that exact moment. Works on
  every trace ever captured -- live, snapshot, or `cctrace view` rebuild --
  because the wire is already a timeline.
- **The replay stage** -- entering replay turns the scrubber into a
  trajectory: five lanes over wall-clock (the human's prompts, the model's
  requests, tools running between them, subagents as stacked spans, the
  harness lane with compaction cuts and failed requests). Wheel to zoom
  around the cursor; the strip says more as you zoom in. Click a span to
  jump there, shift+drag to select a slice. The axis is the selected
  session's own time; idle gaps over five minutes fold to a hatched break
  (`//` 1h 29m), so a lunch break is not half the strip. Under the strip,
  the LOOP ROW: a live flowchart of the agent's loop -- human -> model ->
  calls? -> tools / agents / waiting -> back to model, or no -> answer ->
  human -- with the state at the cursor lit, the transition it came in by
  flowing, what is running and since when. The left pane
  carries the BEAT: what the agent did at this step (tool calls fused with
  results, spawns, the reply, the stated reasoning, the window delta) and
  the call tally so far. Every mark is a wire fact; nothing is inferred.
  On a live run the model chip beats the moment a request is forwarded
  ("thinking since 14:32:07") because the proxy announces requests as they
  go out, and replay tails: the cursor follows every pair that lands. `F`
  clears the chrome for presenting; Esc peels present -> replay -> view.
- **Estimated cost** -- every messages request shows an estimated USD cost
  (live models.dev pricing with an embedded offline fallback, cache
  read/write TTLs priced separately), with per-turn and per-thread totals
  in the Sessions view. Estimates, not bills.
- **Multi-instance aware** -- run cctrace in three repos at once and nothing
  gets lost: ports allocate predictably (8722, 8723, ...), `cctrace ps`
  lists every live instance with its URL and session, and the web UI header
  grows a switcher to jump between them.
- **Session continuity** -- `cctrace -- --continue` (or `--resume`) picks up
  where a previous traced run left off: every Claude Code request carries its
  session id on the wire, so cctrace finds the earlier runs' traces in the log
  dir by exact match and merges them in. Old turns keep their tokens, timing,
  and wire links instead of rendering as bare history; merged requests are
  badged `prev` with a toggle to hide them. `--fresh` opts out; `--with FILE`
  force-merges any trace file.
- **Offline snapshots** -- the saved `.html` embeds the full trace and renders
  the same UI with no server. Open it a year from now, it still works.
- **Stays fresh** -- a daily background check against npm (never blocks
  startup, fail-soft) offers new releases with an `upgrade now? [y/N]`
  prompt on interactive runs; declining snoozes that version. The header
  shows the running version, and an amber notice when a newer one exists.
  Opt out with `--no-update-check` or `CCTRACE_NO_UPDATE_CHECK=1`.
