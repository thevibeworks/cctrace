# cctrace CLI — trace-management command reference

(Moved verbatim from CLAUDE.md 2026-07-30. The cctrace skill at
skills/cctrace/SKILL.md teaches agents to drive the CLI; `cctrace --help`
has the terse form. Keep this in sync when the CLI surface changes.)

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
cctrace clean [--yes]                     # rm regenerable .html + 0-byte traces
cctrace merge [--prune] [--yes]           # one deduped session-<id>.jsonl per session
                                          # (whole-dir sweep; every capture run already
                                          # merges its OWN session at exit)
cctrace compress [--older-than N] [--yes] # zstd archive; view reads .zst/.gz directly
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
cctrace --version                         # print version (+ newer version if known)
```
