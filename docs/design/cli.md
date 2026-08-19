# cctrace CLI — trace-management command reference

(Moved verbatim from CLAUDE.md 2026-07-30. The cctrace skill at
skills/cctrace/SKILL.md teaches agents to drive the CLI; `cctrace --help`
has the terse form. Keep this in sync when the CLI surface changes.)

Every trace-reading command defaults to the current project's store dir
(`<data-dir>/traces/<project-key>/`, docs/design/store.md); `--dir DIR`
names another; a legacy `./.cctrace` still holding traces is read
alongside (captures never write there; housekeeping acts on it too, in
place, headed per dir). clean/merge/compress/purge/compact also take
`--all` (every project dir in the store, output headed per dir).

```bash
cctrace view                              # no target: list traces newest-first and
                                          # pick one (TTY prompt, Enter = newest;
                                          # non-TTY prints the list and a hint).
                                          # Rows are IDENTITY-first — client · sid8 ·
                                          # "first prompt…" · size · age — joined from
                                          # the registry (firstPrompt stamped at capture
                                          # time via server onPrompt) with a bounded
                                          # head-read fallback (peekTrace: head bytes
                                          # only, small archives decompressed, big ones
                                          # skipped) for pre-0.25 traces
cctrace view latest                       # reopen the newest trace directly
cctrace view <file|session-id|fragment>   # reopen a trace in the web UI: serves it
                                          # from the live web server (registers in
                                          # the instance registry, mode "view").
                                          # The page reads as a DOCUMENT (PageMeta.mode
                                          # "view" -> IS_VIEW/IS_READING in ui.ts):
                                          # status chip says "view" never live/offline,
                                          # conversation opens at the top, no auto-tail
                                          # — the WS stays as the data channel only
                                          # (--port N; --serve = legacy alias)
                                          # Traces STREAM in (readTracePairs in
                                          # src/history.ts: plain/.zst/.gz, line by
                                          # line, never the whole file as one string)
                                          # and open from the TAIL: the newest 256 MB
                                          # of decoded lines (TAIL_BYTES) are kept, a
                                          # notice says how many older lines were left
                                          # out; a session id budgets newest file
                                          # first. It's a log — the latest is what you
                                          # open for; a 2 GB trace opens in seconds
cctrace view <target> --full              # every pair, no tail budget (a huge trace
                                          # can then cost GBs of memory + browser)
cctrace view <target> --html              # write a snapshot .html instead (shareable,
                                          # but a big session renders 100s of MB)
cctrace view <target> --slice a..b        # narrow to a slice window first (the @a..b
                                          # of a slice deep link) — with --html this
                                          # is the small shareable artifact
cctrace view <target> --tail              # follow the trace file live (tail -f the
                                          # .jsonl: poll + complete-lines-only via
                                          # followTrace in src/view.ts; mode "tail" —
                                          # live UI behavior + a "tail" status chip;
                                          # the deva case: a sibling container shares
                                          # the .jsonl but not the capture's port)
cctrace clean [--all] [--yes]             # rm regenerable .html + 0-byte traces + orphaned
                                          # .tmp of an interrupted atomic write (idle > 1h)
cctrace merge [--prune] [--all] [--yes]   # one deduped session-<id>.jsonl per session
                                          # (whole-dir sweep; every capture run already
                                          # merges its OWN session at exit — and archives
                                          # the result, see below)
cctrace compress [--older-than N] [--all] [--yes]
                                          # zstd archive: streamed file-to-file, level 9
                                          # with a 128MB window (87x on session traces,
                                          # ~1GB/s), decode-verified before the plain
                                          # source goes; view reads .zst/.gz directly.
                                          # Every capture run archives its own trace at
                                          # exit (--no-compress opts out) and sweeps
                                          # plain leftovers of killed runs in its dir
                                          # (minted names only, idle > 24h, not a live-
                                          # registered file — recorded or store-mapped), so
                                          # this is the whole-dir / whole-store catch-up
cctrace purge [--drop|--keep CATS] [--yes]# drop categories (default telemetry,tokens,external)
cctrace compact [--zstd] [--yes]          # fold redundant bodies: superseded messages request
                                          # bodies -> stubs (longest per thread-epoch kept
                                          # full; session view renders identically), noise
                                          # cats -> meta-only except first/last/largest/
                                          # slowest/errors; never deletes pairs
cctrace spec [target] [--out F] [--md]    # observed-wire catalog from saved traces: endpoints,
             [--diff CATALOG.json]        # methods, header NAMES, body field SHAPES (types +
                                          # presence counts), SSE event types — observations
                                          # with provenance (samples, first/last seen, client
                                          # UAs), never inferred truth (no OpenAPI guessing;
                                          # a projection can derive from the catalog later).
                                          # Values redacted by design except negotiation
                                          # headers (content-type, anthropic-version/-beta)
                                          # and model ids — regression-tested. No target =
                                          # every trace in the dir. --diff prints what changed
                                          # vs a saved catalog ("+ request header x-claude-
                                          # code-agent-id") — the wire changelog behind
                                          # thevibeworks/claude-code-http-spec
cctrace ps [--json]                       # live instances (URL, pids, client, project, session)
cctrace history [--limit N | --all]       # global run log: every traced run (live + past),
          [--json]                        # newest first, across all projects sharing the
                                          # data dir; rows whose trace file doesn't resolve
                                          # here (another container's, never adopted) dim
cctrace store [--json]                    # the store: root, one row per project (size,
                                          # traces + plain count, newest, path from the
                                          # project.json marker), total, and the reclaim
                                          # commands — "where did 73 GB go" in one screen
cctrace title [target] [--dir DIR | --all] [--force] [--json]
                                          # the DATA side of session naming: list the
                                          # sessions that still need a name, each with
                                          # its spine digest (human prompts + agent FINAL
                                          # answers, main chat only — no tool calls, no
                                          # sub-agents). --json is the cctrace-title
                                          # skill's input; the model work is that skill
                                          # (subagent fan-out), never cctrace
cctrace title set <session-id|key> "<title>" [--dir DIR]
                                          # record one title (atomic); titles.json per
                                          # store dir, shown in dashboard/history/picker/
                                          # header
cctrace adopt [DIR...] [--scan ROOT] [--rebase FROM=TO] [--copy] [--zst] [--yes]
                                          # move legacy ./.cctrace dirs into the store: no
                                          # DIR = cwd's + every legacy dir the registry
                                          # knows (dirname of tombstone logFiles) that
                                          # resolves here; --scan walks a tree (depth 8,
                                          # skips node_modules/.git/...). Moves traces,
                                          # archives and .html; same-fs = rename, EXDEV =
                                          # copy + size check + unlink; skips live-
                                          # registered files, files written < 2 min ago,
                                          # and names already in the store; re-points
                                          # registry entries; rmdir's an emptied legacy
                                          # dir. --rebase FROM=TO: legacy dirs mounted
                                          # from another machine under FROM belong to
                                          # projects at TO there — keys, markers, the
                                          # live check and re-pointing use that machine's
                                          # paths (the shared registry records them).
                                          # --copy: sources stay (re-runnable; names the
                                          # store already holds are skipped, .html is
                                          # not mirrored). --zst: plain traces arrive as
                                          # <name>.jsonl.zst, streamed + decode-verified.
                                          # Dry-run by default
cctrace --version                         # print version (+ newer version if known)
```
