# Working with saved traces

## Where traces live

Every run writes into the **store**: `~/.local/share/cctrace/traces/<project-key>/`
(the data dir, `--data-dir` / `CCTRACE_DATA_DIR`), one dir per project cwd,
named the way Claude Code names its `~/.claude/projects/` entries, with a
`project.json` marker holding the exact path. A live run writes plain
`trace-<ts>.jsonl`; at exit it archives that (and any `session-<sid8>.jsonl`
it consolidated) to `.jsonl.zst` -- 40-90x smaller, every reader opens both.
`--dir DIR` writes somewhere else; `--no-compress` leaves the plain file.
One shared dir means the dashboard opens any run from any container that
mounts your home, `du -sh ~/.local/share/cctrace/traces` is the whole bill,
and `cctrace store` itemizes it. Design notes: [design/store.md](design/store.md).

Traces from before 0.41 sit in per-project `./.cctrace/` dirs. They are
still read for continuity (a resumed session finds its prior turns) and
`cctrace adopt` moves them into the store.

```bash
cctrace store                              # root, per-project sizes, total, reclaim hints
cctrace adopt                              # dry run: this project's ./.cctrace + every
                                           # legacy dir the run registry knows about
cctrace adopt --scan ~/wrk --yes           # walk a tree for .cctrace/ dirs and move them
cctrace adopt --scan ./mounts --rebase ./mounts=/Users/me/wrk
                                           # dirs mounted from another machine: key them by
                                           # that machine's project paths (dry run)
cctrace --data-dir /new/share adopt --scan ./mounts --rebase ./mounts=/Users/me/wrk --copy --zst --yes
                                           # compressed mirror of every legacy dir into a
                                           # fresh data dir; sources untouched
cctrace compress --all --yes               # then archive whatever is still plain
```

## Subcommands

Subcommands operate on traces already on disk -- no proxy, no Claude spawn.
They default to the current project's store dir (`--dir DIR` names another;
the housekeeping ones also take `--all` for every project in the store). The
housekeeping commands (`clean`/`merge`/`compress`/`purge`/`compact`) are
**dry-run by default** (they print an itemized plan and touch nothing); add
`--yes` to apply.

```bash
# Reopen a saved trace in the web UI -- no target needed
cctrace view                               # lists traces newest-first, Enter = newest
cctrace view latest                        # newest trace, no questions
cctrace view 4f9a2c1e                      # a Claude Code session id (or prefix)
cctrace view trace-2026-07-08              # or a filename fragment / path
cctrace view <target> --html               # write a self-contained snapshot .html
                                           # instead (shareable; huge traces choke
                                           # browsers -- the default serve doesn't)

# Reclaim space: drop regenerable .html snapshots, 0-byte aborted traces,
# orphaned .tmp files of an interrupted merge/compress (idle > 1h)
cctrace clean                              # dry run: lists what would go
cctrace clean --yes

# Consolidate a session's runs (--continue spans files) into one .jsonl.
# Every capture run already does this for its own session at exit
# (cctrace --no-auto-merge opts out); this is the whole-dir sweep.
cctrace merge                              # one session-<id>.jsonl per session
cctrace merge --prune --yes                # also remove fully-merged sources

# Archive: zstd (view reads .jsonl.zst / legacy .gz directly). Every run
# archives its own trace at exit; this catches killed runs and old dirs
cctrace compress --older-than 7 --yes      # only traces older than 7 days
cctrace compress --all --yes               # every project in the store

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
