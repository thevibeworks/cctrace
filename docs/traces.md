# Working with saved traces

Subcommands operate on traces already on disk -- no proxy, no Claude spawn.
The housekeeping commands (`clean`/`merge`/`compress`/`purge`) are **dry-run
by default** (they print an itemized plan and touch nothing); add `--yes` to
apply.

```bash
# Reopen a saved trace in the web UI -- no target needed
cctrace view                               # lists traces newest-first, Enter = newest
cctrace view latest                        # newest trace, no questions
cctrace view 4f9a2c1e                      # a Claude Code session id (or prefix)
cctrace view trace-2026-07-08              # or a filename fragment / path
cctrace view <target> --html               # write a self-contained snapshot .html
                                           # instead (shareable; huge traces choke
                                           # browsers -- the default serve doesn't)

# Reclaim space: drop regenerable .html snapshots + 0-byte aborted traces
cctrace clean                              # dry run: lists what would go
cctrace clean --yes

# Consolidate a session's runs (--continue spans files) into one .jsonl
cctrace merge                              # one session-<id>.jsonl per session
cctrace merge --prune --yes                # also remove fully-merged sources

# Archive for backup: zstd (view reads .jsonl.zst / legacy .gz directly)
cctrace compress --older-than 7 --yes      # only traces older than 7 days

# Drop noise categories (telemetry, count_tokens, external) from saved traces
cctrace purge --yes                        # rows, not disk -- compress is for space

# Fold redundant bodies in saved traces (-95%+ on real sessions)
cctrace compact --yes                      # superseded request bodies -> stubs; the
                                           # session view renders identically
cctrace compact --zstd --yes               # and archive the result

# Which cctrace sessions are live right now, and on which port?
cctrace ps                                 # URL, PID, client, project, session
```

## Housekeeping guarantees

Housekeeping never shrinks your data. `clean` only deletes an `.html` whose
source `.jsonl`/`.jsonl.gz` still exists (checked, not assumed -- an orphan
snapshot is kept). `merge` and `compress` union with existing outputs, so
re-running them can only grow a merged file or archive. `merge` only prunes a
source when *every* pair in it was attributed to a session, so a trace holding
OAuth/usage/telemetry (no session id) is never deleted out from under you.
And every deletion re-checks that the file didn't change since the plan, so
housekeeping while a live capture is appending is safe.

`compact` is the one deliberate exception, and it says so: each API turn
re-sends the whole conversation, so most trace bytes are redundant request
bodies. It keeps the longest request per conversation epoch in full and folds
the superseded ones to small stubs (plus meta-only collapsing for repetitive
telemetry/external noise, keeping first/last/largest/slowest and every error).
No request/response pair is ever deleted, responses are never touched, and
the reconstructed session view renders identically -- what you lose is the
exact wire bytes of the superseded request bodies. Dry-run by default.
