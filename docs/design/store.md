# The trace store

Where traces live, why they live there, and the rules every reader and
writer follows. Introduced in 0.41 (devlog 2026-08-18).

## The problem it replaces

Before 0.41 every run wrote `./.cctrace/trace-<ts>.jsonl` next to the
project. That was the right first move (the trace sits with the work it
traces) and the wrong steady state:

- Traces scattered across every project dir the user ever ran cctrace in.
  A real audit found 73 GB across ~50 `.cctrace/` dirs; nobody can `du`
  that, and cleaning meant visiting each dir.
- The registry (`<data-dir>/instances/`) is shared across the host and
  every container that mounts `$HOME`, but the traces were not: a
  tombstone recorded `/Users/.../proj/.cctrace/trace-x.jsonl`, and from
  any other container (which mounts only its own workspace) 255 of 272
  finished runs read "trace missing" on the dashboard.
- Nothing compressed by default. Session traces are 40-90x compressible
  (each API turn re-sends the whole conversation), and the codec ships in
  the runtime. Leaving them raw was pure waste.

## Layout

```
<data-dir>/                        ~/.local/share/cctrace (XDG data)
  instances/<run-id>.json          registry: live entries + tombstones
  mitm/                            CA identity
  traces/                          THE STORE
    <project-key>/                 one dir per project cwd
      project.json                 { "path": "/abs/project/path" }
      trace-<ts>.jsonl             a LIVE run (plain, appended per pair)
      trace-<ts>.jsonl.zst         a finished single-run trace
      session-<sid8>.jsonl.zst     a session consolidated across runs
```

`project-key` is the absolute cwd with every non-`[A-Za-z0-9-]` byte
replaced by `-` — Claude Code's own `~/.claude/projects/` convention, so a
Claude Code user recognises the dir at a glance. The `project.json` marker
holds the exact path (the key is lossy: `foo.bar` and `foo-bar` collide),
so listings and headers never guess the project from the key.

`--dir DIR` still overrides everything (write there, read only there); the
store is the default, not a cage.

## Rules

- Capture writes PLAIN `.jsonl`, one line per pair, appended as it
  happens. Plain is what `view --tail`, torn-line recovery and a killed
  run all rely on; the compressed form is a rest state, not a wire state.
- At exit everything the run touched goes to rest as `.zst`
  (`restTracesOnExit` in cli.ts):
  - auto-merge (a session that spans runs) still writes a plain
    `session-<sid8>.jsonl` as a union of the sources and of any prior
    `.jsonl`/`.zst`/`.gz` output of that session (or blocks if a prior can't
    be fully read — merge never shrinks); the archive step then streams it
    to `session-<sid8>.jsonl.zst`, and because that plain file is a
    verified superset it MAY overwrite the prior `.zst` (`supersedesArchive`
    — the one sanctioned overwrite in storage.ts);
  - the run's own `trace-<ts>.jsonl` streams to `.jsonl.zst` (union path
    if an archive somehow already exists) and is unlinked only after a
    decode pass counts every byte back. Two attempts: a CONNECT tunnel
    closing as the child dies logs its meta pair AFTER the exit event, so
    the first pass can find the file grew mid-stream — it refuses to seal
    (drops the fresh archive), the second pass seals;
  - leftovers from killed runs are compressed the same way: a plain
    `trace-*`/`session-*.jsonl` (only names cctrace mints — a `train.jsonl`
    under `--dir` is the user's) idle > 24h that no heartbeat-fresh registry
    entry claims, where "claims" matches the recorded path AND the same
    name under this side's store dir (a run in another container records
    the trace under its own $HOME). A day, not an hour, because static
    (`-s`) and legacy node runs don't register — an open session is never
    silent that long, a killed run's leftover always is. The sweep is per
    project dir, so it costs what this project costs.
  - the supersedes overwrite is stamped: the merge plan records the prior
    archive's size + mtime, and the archive step overwrites only while the
    file on disk is still exactly that one — a concurrent exit of the same
    session that landed a fresh archive in between forces the union path.
    The union path is damage-aware like merge's prune rule (a torn line in
    either input keeps the plain file). Temp names carry the pid so two
    exits in one dir never truncate each other's in-flight write.
  - `--no-compress` keeps everything plain (debugging the writer, tail with
    other tools).
- Codec: zstd level 9 with a 128 MB window (`windowLog 27`, the largest a
  default decoder accepts). Measured on a real 119 MB session trace: 87x
  at ~1 GB/s; level 19 gives the same 87x at 53 MB/s, level 3 with the
  default 8 MB window only 33x — the redundancy is one request body apart,
  so the window is what matters, not the search effort. Streaming
  file-to-file, so a multi-GB trace compresses in ~250 MB of RSS.
- Every reader accepts `.jsonl`, `.jsonl.zst`, `.jsonl.gz` (`readTraceText`).
- Housekeeping invariants are unchanged (see storage.ts): plan/apply,
  dry-run by default, union-never-shrink, re-stat before every unlink.

## Registry and dashboard

Tombstones record the store path, which every container sharing the data
dir can resolve, so `/api/runs` and `/view/<run-id>` open from anywhere.
`findTraceCarrier` still resolves renames (`.zst`, `session-<sid8>`) and,
last, the same basename in the project's store dir — the fallback that
opens a trace adopted from a legacy dir without touching its tombstone.

## Legacy `./.cctrace` dirs

A run in a project with a legacy `./.cctrace` prints one line naming it
and `cctrace adopt`. Continuity readers (`--continue` prior-turn merge,
`cctrace view <sid>`) read the legacy dir alongside the store so nothing
regresses on upgrade day; captures never write there. Housekeeping
commands run without `--dir` act on both dirs in place (headed per dir),
so `cctrace compress --yes` shrinks a legacy dir even before it is
adopted.

`cctrace adopt [DIR...] [--scan ROOT] [--yes]` moves legacy dirs into the
store: with no DIR it takes the cwd's `./.cctrace` plus every legacy dir
the registry knows (`dirname(tombstone.logFile)`) that resolves locally;
`--scan ROOT` walks for `.cctrace/` dirs (depth-capped, skips node_modules
and .git). Same-filesystem moves are renames; cross-filesystem copies are
size-verified before the source is unlinked. A live run's file (heartbeat-
fresh, or written in the last two minutes) is never moved. A name the
store already holds (a session continued after the upgrade has a
store-side `session-<sid8>` archive) is never overwritten: the legacy copy
lands as `<stem>.legacyN.<ext>`, still a trace every reader merges by sid.
Tombstones that named a moved file are re-pointed (atomically). Dry-run by
default. `--rebase FROM=TO` covers legacy dirs mounted from another machine
(a container that sees the host's `~/wrk` under `./mounts`): the project
path — hence the store key and the marker — is what the originating host
calls it, and the live check and re-pointing compare that same path,
because a shared registry records host-side paths. `--copy` leaves the
sources (a re-runnable mirror: names the store already holds are skipped,
`.html` snapshots are not mirrored) and `--zst` archives plain traces on
the way in (streamed, decode-verified before anything is unlinked) — with
`--data-dir` pointing at a fresh dir, that is a compressed copy of every
legacy dir the originals never notice.

## Ports

The live UI walks 8722..8821 (100 ports) — the same range the discovery
sweep probes — before falling back to an OS-assigned port. Env `PORT` is
not honored: a fixed range is the whole port story, no wrapper needed.
