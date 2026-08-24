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
- **Context view** -- what the model is actually carrying around, and what
  is eating the window, laid out as a ledger. A sticky MARGIN states the
  balance for the picked step and never scrolls away: its prompt tokens, a
  six-color bar scaled against the model's context window, how far the
  chars/4 estimate reads under or over the billed prompt, and the six
  categories as ledger lines (system prompt, tool schemas, your messages,
  injected context, assistant replies, tool results) -- click a line to
  zoom the graph to it. Under them the step's links out, the top tool
  schemas by size, and, on a trace holding several sessions, the other
  threads: peak assembled context per thread, one scale, click to switch.
  The CANVAS beside it: a trajectory chart with one stacked bar per
  request (or per turn) where ✂ and an amber axis break mark compactions
  and rewinds -- watch the bars drop; the picked step as a context graph
  -- an icicle where width is tokens and rows are levels, decomposing it
  into category -> group -> item, with tool results grouped by the tool
  that made them, schemas by MCP server, injections by producer (click a
  node to zoom, a leaf to open its exact bytes below; row 1 is the
  margin's own six categories, so the graph reads as that bar growing
  downward); and the events -- every injection with its producer --
  AGENTS.md, system reminders, recaps -- every compaction with the tokens
  it reclaimed, every model switch and tool-schema change, each linked to
  its wire request.
  Because cctrace sits on the wire, every step is exact -- the captured
  request body IS the assembled context -- and every figure is anchored to
  the provider-reported prompt tokens of that same request. Estimates wear
  ≈ and never replace actuals.
- **Session replay** -- re-experience a captured session as it happened, right
  inside the Sessions view: `←`/`→` step through turns (`shift` steps every
  wire request), `Space` plays at 1/2/8/60x with long idle gaps compressed,
  and the scrubber doubles as a session minimap (turns, errors, probes).
  Pause anywhere and the URL (`#/session/<key>/@<pair-id>`) deep-links that
  exact moment. Works on every trace ever captured -- live, snapshot, or
  `cctrace view` rebuild -- because the wire is already a timeline.
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
