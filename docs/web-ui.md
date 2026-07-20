# The web UI

One self-contained page serves the live view, `cctrace view` rebuilds, and
offline snapshots -- same UI, three ways in.

- **Inline row summaries** -- every request row reads at a glance: model,
  in/out tokens, a prompt-cache verdict (green hit with read/write arrows +
  hit %, amber cold write or miss -- the session view's wire rows carry a
  matching dot, so cache breaks stand out), count_tokens results, usage
  window percentages (5h / 7d / per-model), telemetry event counts, error
  types.
- **First-token latency** -- every streamed model call shows a `ttft` chip
  (measured live at the proxy pump; SSE events carry no timestamps, so a
  saved trace can't reconstruct it) and tok/s computed over the
  post-first-token stream -- slow-start vs slow-stream is one glance.
- **Category filter chips** with live counts -- only the categories the
  trace actually has (a Codex run shows no Count Tokens chip). Click to
  filter; combine with text search.
- **Split detail panel** -- click a row and the detail opens beside the list
  (deep-linkable by request id). Messages render conversation-first with the
  streamed reply decoded from SSE; usage requests render limit bars; raw
  headers/bodies stay one fold away. `j`/`k` walk the filtered list.
- **Sessions view** -- the reconstructed conversation on a rail: sessions
  group their threads (main chat, subagent runs attached as branches at
  the turn that spawned them, utility noise collapsed), a `/model` switch
  marks an epoch, a compaction marks a break node with the context
  collapse in turns and tokens, and superseded exchanges (rewinds, edits,
  injected recaps) sit grey at the ordinal they occupied. Every turn
  links back to its wire request; tokens, timing, and cost live in
  instant hovers.
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
  gets lost: ports allocate predictably (9317, 9318, ...), `cctrace ps`
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
