# Changelog

## Unreleased

- Added the Context view — a third page tab (#/context) answering "what is the model actually carrying around, and what is eating the window", request by request. Borrowed from dsh-context's design (context stats, composition bar, per-request history chart, events, per-step decomposition) with cctrace's structural advantage: every captured request body IS the fully assembled context, so per-step composition is exact and every step is anchored to the provider-reported prompt tokens from the same wire pair. The page is a sheet with a margin (see the next entry): a sticky left column carrying the balance — the picked step's prompt tokens, the six-category bar against the model's context window, the estimate reconciled against the billed prompt, six ledger lines that are also the graph's zoom control, the step's links out to the wire and the timeline, the heaviest tool schemas, and the other threads in the trace — beside a canvas carrying trajectory (one stacked column per wire request or per turn, compaction/rewind cuts raised as an axis break, hover scrubs, click pins, arrows walk), inside this step (the icicle), and what changed it (injections with producer labels — AGENTS.md, environment context, system reminders' own opening words — compactions with the reclaimed delta, model switches, tool-schema and system-prompt changes, filterable, each linked to its wire request at its turn.step address). Estimates are chars/4 marked with ~ and always sit next to the provider-reported actuals; the window denominator comes from models.dev (limit.context now rides the pricing catalog) with the 1m-context beta header honored, and no percentage renders without a known window
- Re-staged the Context view as a ledger. It first shipped as five equal-weight sections stacked down a 1100px ribbon, and three things were wrong with that. The page's own answer arrived fifth: "what is eating my window" sat below the fold behind three sections you scrolled past. The same six numbers were rendered three times on the way there - the composition legend, the detail strip's six tracked rows, and row 1 of the icicle - about 500px of vertical space that said nothing new, plus a chips row repeating est/prompt/window a fourth time. And 340px of a 1440px viewport was dead while a 17-bar chart sat pinned at 9px per bar, reading as broken rather than small. The view has a real invariant - the six categories sum to the assembled window, chars/4 reconciles against the provider's billed prompt, the whole sits against the model's limit - so it gets the form an invariant deserves: a margin that states the balance and never scrolls away, beside a canvas you work in. Measured on a real 479k-token session, the answer (tool results 62%, and inside it Read ~139k = 54% of the request) now sits at 374-476px at every viewport down to 1280x800; it used to start around 890px. It also makes the view match the product - requests is list|detail, sessions is rail|convo, and context was the only full-width ribbon. The rejected arrangement is recorded in TASTE.md
- Context view details that came with the re-staging: the six category numbers are rendered once, as the margin's ledger, and every line is a control that zooms the graph to its category (the chart is the other rendering, and it reorders under the size lens and disappears when you zoom - the ledger is the invariant that does not); the margin re-reconciles live as you scrub the trajectory; the balance states how far chars/4 reads under or over the billed prompt instead of just printing both numbers; trajectory columns grow to fill the canvas so a short thread is not 9px bars in a 1000px field; a compaction/rewind is raised out of the row as a full-height amber axis break, the same amber the replay track already paints for that wire fact; counts caption the thing they count (91 wire requests . 8 working loops on the trajectory, 132 injections . 1 compaction . 4.7k reclaimed on the events) instead of an orphan chips row, and "turns" is spelled out as message turns vs working loops, which are different numbers the page was showing side by side; an event's token delta now sits beside its label instead of 800px away at the right edge, where the turn address and clock belong; the graph's pane scrolls inside itself so an open tool result can't push the events off the page; and at 960px and under the margin unsticks into a multi-column band above the canvas

- The data layer is src/context.ts (composition, per-item breakdown, per-thread timeline + events), pure and unit-tested like session.ts, inlined into the page the same way — snapshots and cctrace view pages get the full Context view offline
- Added multi-modal rendering: image attachments now render as real thumbnails (click for full size) in the request detail panel, the session view, and the context graph — the bytes were already in the trace (Anthropic base64 sources, and the OpenAI dialect now keeps a data: URL instead of dropping it at normalization). Wire-controlled fields are validated, not trusted (media type shape, base64 alphabet); a REMOTE image url renders as a named note and is never fetched — the viewer must not issue requests to wire-named resources
- Context history bars carry each step's cache story in the hover (cache read N, % of prompt, or "cold: the whole prompt billed at full input price"), and turn-granularity bars are labeled with the outline's turn ordinals
- The context graph is an ICICLE (flame graph): rows top-down, width proportional to tokens, every child inside its parent's span. Row 1 is the composition bar's own six categories in the same order and hues, so the graph reads as that bar growing downward into its parts. Click a node to zoom (breadcrumb home; percentages stay against the whole request, never the zoom), a leaf to open its exact bytes in the pane below. "What is eating my context window" is a profiling question, so it gets the form profilers use - chosen over a treemap because here the labels are the answer (Bash, Read, token budget) and a treemap can only whisper them on hover. Slivers merge into one countable "+N smaller" rather than sub-pixel confetti; metrics drop before the label does; red marks a leaf that failed, never a group that contains one; tips fly up so they never cover the rows being scrubbed; labelled nodes are keyboard-reachable. The nested-fold form it replaces is recorded in TASTE.md. The grouping is the question each category answers - tool results by the tool that produced them (Bash x189 = 38% of the window on a real trace, the widest block on its row, where the old flat list buried it in 200 rows), schemas split built-ins from each MCP server, injections by producer (97 token-budget banners as ONE node), the system prompt per block, the conversation per turn. The "by size" (default) / "in order" lens ranks INSIDE a category, never the categories themselves - re-ranking row 1 would break the correspondence with the bar above. Under the graph, the pane opens whatever node is selected (a leaf's bytes, a group's heaviest 15 items as lazy folds, a container's children ranked) and defaults to the heaviest group, so the section opens on the answer
- Fixed "<1%" being written raw into the page in three places (the composition legend, the step detail rows, the graph) - it parses as the start of a tag; the fragment checker in the test harness caught it
- Fixed the composition mis-reading harness overhead as the human's words: the per-turn <total_tokens> ... tokens left banner Claude Code appends to every user turn, and SessionStart hook additional context: output, now classify as injected context. Measured on a real 91-step session they were 97 of 99 "user" blocks - the session reads user 4% / inject 20% instead of user 12% / inject 10%. Prefix matches only; a message that merely mentions the tag is still the human's
- Added threads in this trace to the Context view: one trace routinely holds several sessions (a /clear rotates the sid, a resume merges a prior run) and each session several threads, and the tab used to show exactly one of them with no way across. It is both the switcher and the comparison - peak assembled context per thread, grouped by session, all bars on one scale, the % against each thread's own model window - and it sits at the foot of the margin, so switching sheets never needs a scroll. Rendered only when the trace has more than one thread
- Added the trajectory gutter to the sessions rail (dsh's Trajectory tab reads an agent's path as a shape; the rail already IS that path, it just carried no magnitude): one track per wire step, filled to how full the window was, the fill split into the prefix read from cache and what was billed fresh. Down the rail that column is the context trajectory - it climbs, a compaction drops it, the next step runs cold, then warms again. Denominator is the model's window when models.dev knows it, else the thread's own peak, and the hover names which. The replay track marks compaction/rewind pairs too
- The Context view links back into the timeline: the margin's "this step" block carries "turn NN . step N ->" beside "wire ->", the reverse of the convo pane's "context ->"
- Context view performance on long sessions: the per-thread timeline caches per thread (bounded) instead of one slot, the graph rides a small LRU keyed by pair, the graph pane repaints on a short settle while the detail strip follows the pointer, and a page-wide pairId index replaces the pairs.find() calls the session and context layers were making inside per-turn loops. A real 567-pair / 232 MB page renders the context route in ~60ms

## 0.43.1

- Fixed every proxy-capture run (`cctrace claude`, `codex`, `grok`, `kimi`, `opencode`, live or `-s`) dying right after "MITM proxy listening" with `Error: instanceId is not defined`: 0.42.0's background exit seal passed the run id into the spawn, but the id was declared inside the live-mode block. Hoisted; `tsc` flagged it (the repo's typecheck is not gated — 47 pre-existing errors — so it shipped in 0.42.0 and 0.43.0)
- Fixed `cctrace title --json`: the `--all` per-project `==` headers went to stdout and corrupted the JSON, and a big list (243 KB) was truncated at the 64 KB pipe buffer because `process.stdout.write` returns on backpressure at exit — now quiet under `--json` and written with `Bun.write`, which drains fully. (The cctrace-title skill's work list)

## 0.43.0

- Reworked cctrace title: cctrace no longer calls a model itself (0.42.0 shelled out to claude -p). It is now the DATA layer — it extracts each session's spine (your prompts + the agent's final answers, no tool calls, no sub-agent context) into a digest and stores/serves the titles a namer hands back — and the naming is an agent skill, cctrace-title, that fans the digests out across Claude Code's own subagents and writes each result back. cctrace title / --all / --json lists the sessions that still need a name with their digests; cctrace title set <id> "<title>" [--dir DIR] records one. The dashboard, history, view picker and header show titles exactly as before. Rationale: naming is a concurrent model workflow, and Claude Code already runs those well — a skill that uses subagents beats a CLI subprocess fan-out, and keeps cctrace free of a model dependency
- Added the cctrace-title skill (skills/cctrace-title/) implementing that workflow: get the work list (cctrace title --json), name each session with subagents in parallel, write back with cctrace title set

## 0.42.0

- Added cctrace title — a human name for every session, generated by a model from the conversation's spine: the human's prompts and the agent's FINAL answers per turn, main chat threads only (no tool calls, no tool results, no sub-agent context). The digest is capped and front/back weighted (what was asked for + where it ended) and goes to your own claude -p (sonnet by default, --model to change; your auth and quota — cctrace has no key of its own). Titles land in titles.json in each project's store dir, keyed by session id, and show in the dashboard, cctrace history, the view picker and the trace header. Dry-run lists the sessions that would be named; --yes runs them (one model call each, --jobs N in parallel); --force re-names
- Changed the exit close-out to not make the shell wait: the merge + archive housekeeping now runs in a detached background helper, so cctrace returns as soon as the trace is safely written. The plain .jsonl is complete on disk the moment the session ends; the compressed .zst (and any session merge) land moments later and the run's dashboard row re-points itself. The dir-wide leftover scan is gone from the hot path. CCTRACE_SYNC_SEAL=1 keeps the old inline behavior; static mode (-s) still seals inline since its snapshot is the deliverable

## 0.41.1

- Fixed the header totals chip's "in": it counted uncached input tokens only, so a session that read 400k tokens from cache showed "in 2.1k ... $5.62" — nonsense next to its cost. "in" is now total input (uncached + cache read + cache written), the same number the exit report and the dashboard use; the hover breaks it down
- Fixed the trace size a view reports for an archived source: it showed the .zst file size (27.8 MB for a 140 MB trace, "only 77 requests?"). The chip now shows the decoded trace size, the hover adds what it occupies on disk, and dashboard rows label an archived size "on disk (zst)"

## 0.41.0

- Changed where traces live: every run now writes into the trace store, ~/.local/share/cctrace/traces/[project-key]/ (the data dir; --data-dir / CCTRACE_DATA_DIR move it), one dir per project cwd named the way Claude Code names ~/.claude/projects/ entries, with a project.json marker holding the exact path. Per-project ./.cctrace dirs were the right first move and the wrong steady state: a real audit found 73 GB spread across ~50 of them, and because the run registry is shared across containers while those dirs were not, 255 of 272 finished runs on the dashboard read "trace missing" from any container but the one that wrote them. The store rides the same shared dir as the registry, so the dashboard and /view/[run-id] open any run from anywhere; --dir DIR still overrides. Legacy ./.cctrace dirs are read for continuity (a resumed session still finds its prior turns, cctrace view [sid] still merges them) and print a one-line hint; cctrace adopt moves them into the store
- Added compression at rest by default: a run's trace is plain .jsonl while live (tail-able, torn-line recoverable) and is archived to .jsonl.zst at exit, along with any session-[sid].jsonl the exit auto-merge wrote — streamed file-to-file at zstd level 9 with a 128 MB window, which measured 87x on a real 119 MB session trace at ~1 GB/s (level 19: the same 87x at 53 MB/s; level 3 with the default window: 33x — the redundancy is one request body apart, so the window is what matters), and decode-verified before the plain source is unlinked. Leftover plain traces from killed runs in the same project dir (cctrace-minted names only, idle over a day, not claimed by any live registry entry — matched under both the recorded path and this side's store path, since another container records the same trace under its own home) are archived by the next exit; the archive frames carry checksums so on-disk corruption is detected by every reader. --no-compress keeps the plain file. cctrace compress uses the same streamed codec, so archiving a multi-GB dir no longer holds whole files in memory
- Added cctrace store — the store root, one row per project (size, trace count, how many are still plain, newest, path), the total, and the commands that reclaim space; and cctrace adopt [DIR...] [--scan ROOT] [--yes] — moves legacy ./.cctrace dirs into the store (no DIR: this project's plus every legacy dir the run registry knows about that resolves here; --scan walks a tree), same-disk moves are renames, cross-disk copies are size-verified before the source goes, live and just-written files are never moved, and registry entries naming a moved file are re-pointed; --rebase FROM=TO adopts legacy dirs mounted from another machine (a container seeing the host's ~/wrk under ./mounts) under that machine's project paths, so store keys, project.json markers, the live-run check and re-pointing all agree with what the shared registry recorded; --copy leaves the sources in place (a re-runnable mirror: what the store already holds is skipped, .html snapshots are not mirrored) and --zst archives plain traces on the way in (streamed zstd, decode-verified before anything is unlinked) — together they build a compressed copy of every legacy dir into a fresh --data-dir without touching the originals. Dry-run by default
- Added orphaned .tmp cleanup to cctrace clean: an interrupted atomic write (a run killed mid-archive at exit, a ctrl-c'd merge) leaves [name].tmp next to the trace; clean lists and removes those once idle over an hour, never a fresh one that a housekeeping step may still be writing
- Added --all to clean/merge/compress/purge/compact — act on every project dir in the store, output headed per project. All trace-reading subcommands (view/spec included) default to the current project's store dir instead of ./.cctrace
- Changed the port walk from 10 to 100 ports (8722..8821) — the same range the discovery sweep probes — and dropped env PORT honoring (the portless-style route): a fixed, predictable range is the whole port story, no wrapper needed. The legacy 9317..9326 sweep is gone with it (live entries are found through the registry heartbeat regardless of port)
- Changed how traces are read: view, the run catalog's peek, --continue's prior-turn merge and the resume guess all STREAM a trace now (plain, .zst or .gz, line by line — readTracePairs in src/history.ts) instead of holding the whole decoded file as one string, which OOM'd on real multi-GB session traces and cannot even represent one past 2 GB. And they read from the tail: it's a log, the latest is what you open for, so a view keeps the newest 256 MB of decoded lines (a normal session trace fits whole; a 1.7 GB one opens in 3 s to its newest 160 pairs) and prints exactly what it left out — "showing the newest N pairs (X of Y decoded; M older lines left out)"; cctrace view --full loads everything. A session id is budgeted newest file first, so the oldest turns fall off, never the latest. The whole-file zstd decode that remains (merge/purge/compact) uses node:zlib, the same codec that writes the frames
- Changed cctrace adopt to recognise a plain trace whose archive the store already holds (same decoded size — a mirror built earlier with --copy --zst, or the exit-time archive of that run): it is skipped as already archived instead of moving in as a .legacyN duplicate; a grown twin still collides and keeps its own copy
- Fixed the dashboard's history rows and /view/[run-id] for traces that moved: findTraceCarrier now also looks in the project's store dir by the same names (trace, .zst/.gz forms, session-[sid8] file), so a tombstone that still names a legacy path opens once the trace was adopted — or was captured straight into the shared store by another container

## 0.40.0

- Added GET /s/[sid-prefix] — the short session jump: a redirect to /trace#/session/[sid-prefix], which lands on that session's conversation (live pages enter scrolled to the newest turn); /s alone means the newest session. Resolution stays the page's job — sid8 prefix match, graceful fallback to the newest thread — so the server holds no state and the browser bar keeps the self-describing hash URL. This is the link a statusline can afford to print: claude-code-statusline's trace chip now emits [base]/s/[sid8] instead of the generic /trace landing page

## 0.39.1

- Fixed finished runs wrongly dimming as "trace not on this host": the dashboard and /view/[run-id] judged a run by a single stat of the tombstone's recorded path, but that path routinely stops being the trace's real name on the same machine — cctrace compress renames it to .jsonl.zst (or legacy .gz), and a later run's exit auto-merge absorbs earlier traces of the session into session-[sid].jsonl and prunes the source. Both surfaces now resolve the actual carrier (the file itself, its compressed sibling, or the session file the run's id points into), so those rows keep opening and the copy button names a path that exists; only a trace that truly is not reachable (deleted, or recorded by another machine) dims, with the honest label "trace missing"

## 0.39.0

- Changed root URL (/) to redirect to the dashboard instead of showing a single instance's live trace. Navigating to cctrace.localhost (or any bookmark of the root) now lands on the all-runs overview; the live trace moved to /trace. Auto-open from the CLI, dashboard live-instance links, instance switcher links, and cctrace ps all point to /trace directly. The WebSocket connects origin-relative, so no plumbing changed

## 0.38.1

- Replaced the hand-rolled markdown renderer with marked.js (GFM): assistant text in the session view now renders tables, ordered/unordered lists, task lists, blockquotes, horizontal rules, strikethrough, and nested formatting instead of just fenced code + bold + headings. The marked UMD bundle is vendored at src/vendor/marked.umd.js and embedded in the page at serve time, so snapshots and compiled binaries stay self-contained with no CDN dependency. Raw HTML in model output is escaped (same security posture as before)

## 0.38.0

- Added opencode as a traced client (#89): cctrace opencode wraps opencode.ai's multi-provider CLI with the same mitm front door. There is no single wire for opencode — the model you pick decides which provider gets the call — so the dialect is detected per request from the wire shape: the OpenCode Zen gateway mounts Anthropic and OpenAI endpoints side by side (opencode.ai/zen/v1/messages and /responses|/chat/completions) and both reconstruct into one session. Zen model calls carry the session id in the x-opencode-session header, so cross-run continuity, view-by-session-id, and the exit consolidation into session-[sid].jsonl all work like they do for Claude; verified live against the zen gateway, including a two-process continued session merging into one 4-turn conversation
- Added provider-host enrollment for multi-provider clients: a wire table can now list providerHosts — single-purpose LLM API hosts the client's catalog can route to (Anthropic, OpenAI, OpenRouter, Copilot, Gemini, xAI, DeepSeek, Groq, Mistral for opencode) — which join the mitm include-list unconditionally, safe because decrypting a model-API host can only capture model traffic; shared hosts (github.com, googleapis.com) deliberately stay opaque tunnels. Custom providers enroll automatically from every baseURL in the opencode.json(c) files opencode itself would read, the same auto-enroll codex got for config.toml
- Added OpenCode Zen pricing: the models.dev opencode provider joins the pricing catalog last in trust order, so zen-only models (deepseek-v4-flash-free, big-pickle, ...) get cost chips while resold claude/gpt/grok ids keep their originating provider's rates

## 0.37.0

- Fixed the huge-session exit looking hung: the exit auto-merge parsed every trace file in the log dir with zero output — on a 2.5 GB dir that was ~22 s of silence at 7 GB peak memory before the prompt returned. A scoped merge now substring-scans for the run's session ids first, so unrelated traces are never JSON-parsed and the common nothing-to-consolidate exit concludes from the scan alone (measured 5.9 s, 2.5 GB peak on the same dir); files over 16 MB print scanning/reading progress lines headed by a note that ctrl-c is safe (writes are atomic, sources stay until fully merged), and merged session files write in 8 MB chunks instead of one giant string. cctrace merge gets the same progress lines

- Fixed codex session reconstruction for the responses-lite protocol (codex-tui >= ~0.146, x-openai-internal-codex-responses-lite): response.completed now arrives with an empty output array, which reconstructed every assistant reply as nothing and dropped the session's final answer entirely — the adapter now grafts the output_item.done items back into the completed object, and a stream cut mid-answer assembles the partial text from output_text.delta events (previously lost under lite, where deltas are the only copy)
- Fixed the codex system prompt and first-prompt identity: the leading run of developer messages (identity, memory, permissions, collaboration mode, plugins — five in codex 0.146) now folds into the system prompt instead of rendering as a fake user turn, and the AGENTS.md digest / environment_context wrappers that ride user messages no longer win the turn snippet, the thread signature, or the registry's first-prompt — the human's actual prompt does

## 0.36.0

- Changed the default UI port from 9317 to 8722 — TRAC on a phone keypad, so the address is memorable instead of arbitrary; the walk is now 8722..8731 and the discovery sweep still covers the legacy 9317..9326 range, so live instances of older versions keep showing up in ps, the switcher, and the dashboard through the transition (--port and env PORT behavior unchanged)
- Changed capture-time identity masking to opt-in: session/user/device uuids now pass through unmasked by default — they are workflow identity, not credentials, and sid-keyed features (view by session id, the registry catalog, cross-run continuity) work better on real ids; --redact-ids or CCTRACE_REDACT_IDS=1 restores the masking for traces that will leave your machine, and credentials (tokens, keys, cookies) remain always redacted with no opt-out

## 0.35.0

- Added direct open for finished runs: a dashboard row now opens /view/[run-id], a snapshot the serving instance renders on demand from that run's trace — the id resolves through the registry server-side (the page never names a file), and a run with a known session id merges every trace of that session, the same continuity cctrace view gives; the old copy-view-cmd click became a small copy button on the row
- Added run stats to the dashboard: on-disk size (re-stat'd per request), pairs and message counts, tokens in/out, and estimated cost — the numbers are stamped into the run's registry tombstone at exit, so the page shows real details without ever reading a trace
- Added dashboard grouping and paging: group runs by project, by client, or flat by time (remembered per browser), newest first everywhere, and show-more steps of 100 instead of a hard 50-row cap
- Added a dashboard entry to every page: an always-visible grid icon in the trace view header (on http-served pages), and capture startup now prints the dashboard URL next to the Live UI line
- Added --bypass-host (#83): appends the named host to the traced child's NO_PROXY (repeatable, inherited values preserved), so a tool that misbehaves whenever a proxy is present — wrangler swaps its HTTP stack and discards custom agents — talks direct with its normal behavior; the only capture loss is that host's ~100-byte tunnel audit line
- Fixed three CONNECT-layer gaps (#82): a non-443 CONNECT port now rides through to the upstream fetch on the MITM path (an enrolled host on :8443 no longer got re-fetched on :443), IPv6 literal targets like [::1]:443 parse bracket-aware instead of mangling at the first colon, and a tunnel that cannot reach its origin (or a chained proxy that refuses) answers 502 before closing — a bare reset used to be indistinguishable from cctrace dying; the tunnel's meta pair records the 502 too
- Changed the session view to render the last turn unclamped — the final answer is what you came back to read, so it no longer hides behind a show-all click; your own expand/collapse choices now survive live re-renders
- Moved the per-client icon glyphs to one shared module (src/icons.ts), so the dashboard rows and the trace view header wear identical marks per CLI
- Filed the settings-surface design (docs/design/settings.md, #85): a read-only run-config panel first; a defaults file later, with capture-widening flags deliberately excluded

## 0.34.0

- Added find in session: a toolbar search field on the sessions view (press /) that matches the conversation's text including folded tool bodies — Enter/shift+Enter cycle hits, the jump opens exactly the folds that hold the match and lands with a one-breath amber flash; the one thing the browser's own Ctrl+F can't do over closed folds
- Added cctrace history: the global run log — every traced run this data dir knows about (live and past), newest first across all projects and containers; rows whose trace file doesn't resolve locally list dimmed, and any row opens with cctrace view [SESSION]
- Added --inform-agent: appends a short note to the traced agent's system prompt (claude only) saying it runs under a tracing proxy, where the live UI serves, and how to bypass the proxy for the one command that misbehaves behind one — born from a real session that lost 1.5h to wrangler silently swapping undici's dispatcher because HTTPS_PROXY was set; the equivalent instructions-file snippet for other clients lives in docs/agent-awareness.md
- Added env PORT honoring when --port is absent, so a portless-style wrapper routes the live UI behind a stable name (portless trace cctrace claude -> https://trace.localhost); the consumed PORT is stripped from the traced child so its own dev servers don't collide with the route
- Fixed the pulse strip covering the session's last line: both session panes now keep clearance above the strip, so the newest turn reads above it instead of beneath it

## 0.33.0

- Added an exit auto-merge: when a run ends, it folds its own session's traces into one session-[sid].jsonl and prunes only sources whose every pair landed in the merged file — a resumed session becomes one file instead of one per run; --no-auto-merge opts out, --fresh already did
- Hardened merge against two silent-loss edges: a source file holding torn or damaged lines is never pruned (the parser skips those bytes, so no output would hold them), and a session whose existing merged output can't be fully read is skipped and reported instead of overwritten — merge never shrinks anything it couldn't fully see
- Changed the sessions sidebar to hold still: sessions sort by newest activity, threads by conversation start, and a subagent card always nests under its dispatching thread instead of jumping between renders; the subagent's header grows a "parent thread" jump that lands at its spawn turn
- Added full session dumps from the actions menu: /api/session.jsonl (the exact pair set cctrace merge writes) and /api/session.md, a readable transcript with full user and assistant text and one line per tool call
- Added /dashboard on every live and view server: verified live instances on top, recent past runs below, one page for all projects and containers sharing the data dir
- Added codex custom-provider auto-enroll: every model_providers base_url in $CODEX_HOME/config.toml joins the intercept set, so a custom relay is captured without --intercept-host
- Fixed tool previews for foreign wire surfaces (kimi's path-style Read arguments, codex argv-array shell commands, MCP tools) that rendered as empty parens, and fixed mitm --messages-only dropping model calls a custom provider mounts at the path root — the filter now shares the page's own predicate

- Added wall-clock timestamps to the session view: every conversation turn's role bar shows its wire time (24h, hover for the full date — user turns inherit the time of the request that carried them), and the outline's user-prompt, recap, and injected-row hovers now name their moment alongside the metrics the step rows already carried
- Redesigned the toolbar around a left-to-right scope grammar: view tabs, then the list group (filter · prev runs · select), then page behavior (tail · clear — Auto-scroll is now "tail"), then the trace controls (replay · ⌘ actions) holding the right edge in both views; groups separate with hairlines, labels read lowercase, and pressed toggles wear a quiet accent tint instead of a green fill — green stays reserved for state
- Changed the end-of-run messages into a receipt: what was traced (pair count, per-category breakdown, wall-clock, on-disk size), whose session (ids, primary model, tokens in/out with cache share, estimated cost), and what failed (status codes, dropped responses, in-stream errors) — computed from the run's own pairs, prior-run merges excluded
- Fixed the header session id carrying a dead mask attribute — sid blurring now follows the mask picker exactly (and stays excluded by default: a local uuid is not a credential)

## 0.31.0

- Added trace identity to the traced client's environment in the proxy modes (mitm/base-url): `CCTRACE_TRACE_FILE` always, `CCTRACE_SERVER_PORT` + `CCTRACE_INSTANCE_ID` on live runs — subprocesses of a traced session (statuslines, hooks, nested agents) can now tell they're captured and where the live UI serves without sniffing proxy plumbing or scanning the instance registry; node mode has exported these names since day one
- Moved the session view's trace controls (replay, ⌘ actions) to the page's right edge: the requests view's filter input already held them there, so the controls now keep one position in both views instead of hugging the tabs when the filter is hidden
- Changed every toolbar, header, and replay-bar tooltip to the page's designed tip grammar — a heading, a plain-words line, and interaction hints as faint "> " rows (Esc leaves selection, shift+drag slices, purge says "no undo" up front); the chrome now speaks the same hover language the data surfaces already do
- Changed the version badge hover into a miniature release note: a one-line slogan, the traced clients, and the freshest features — a reader who wonders "what is this page" gets the pitch and what's new in one hover

## 0.30.0

- Moved trace actions out of the page header into the toolbar, where the other trace-level controls live — the header keeps identity and page chrome only
- Changed housekeeping actions from copy-a-command rows to actually running on the page: purge telemetry/tokens/external shows live pair counts and rides the existing purge path (memory + file rewrite + broadcast, with the same confirm), and compact runs plan → confirm → apply against a new /api/compact endpoint with the CLI's re-stat discipline (a live capture appending mid-flight is skipped, never torn); merge and compress stay terminal-only — they sweep the whole log dir, which is more than a page should reach for
- Added the trace file's on-disk size to the header totals rollup ("… · 41.2MB"), streaming live as the .jsonl grows; the hover names the file state and points at compact
- Changed the pulse to stand out: taller and brighter with an accent wash, the ✻ spins and breathes while the session is fresh and settles when idle, a rotating verb leads while work is in flight, and a changed action line gets one 160ms fade — the same motion budget as live-arrived rows

## 0.29.0

- Added rich tool bodies in the session view: Edit and MultiEdit folds open to a git-style diff of exactly what changed (removed block, added block, hostile content escaped), Write shows its content as additions, TodoWrite renders a live checklist with per-status glyphs, ExitPlanMode renders its plan as markdown, AskUserQuestion lists its questions and options, and Workflow names its phases — the raw input JSON stays one fold deeper
- Added an actions menu (⌘ in the header) on served pages: download the full snapshot .html, or the observed-wire spec as .json/.md, straight from the running server with the CLI's redaction rules; destructive housekeeping (compact, purge, merge, compress) deliberately stays in the terminal — clicking one copies the command
- Changed masking to a user-owned category set: right-click the eye to choose what blurs (project/trace title, session ids, usage/credits); session ids are excluded by default — a local uuid is not a credential, and a blurred header chip read worse than it protected

## 0.28.0

- Added cctrace view --tail (alias --live): follow a running capture's trace file like tail -f — a second window (or a sibling container sharing the .jsonl but not the capture's port) gets a live view server that polls the file, ingests complete new lines, and streams them to the page; torn tail lines are held until their newline arrives, truncations rescan with id-dedup, and the status chip says "tail"
- Added the pulse: a terminal-like status line at the bottom of the session view on live and tail pages — what the model last did (tool labels from the newest reply), how long ago, and the one cache deadline that matters, absolute while it holds and an amber "expired" once passed
- Added loading verbs: pages open with a ccx-style rotating gerund ("Reticulating…", "Teeing…") instead of a blank screen while the wire loads
- Added the cache "expired" state to the request detail panel and the session outline hover — on the newest model call only, since any later hit refreshes the TTL and older deadlines mean nothing; live pages now flip to "expired" the moment the deadline passes instead of waiting for a reload
- Fixed duplicate row broadcasts when a followed trace file is rewritten mid-tail (purge): pairs the server already holds are no longer re-announced to connected pages

## 0.27.0

- Added timeline slices to replay: shift+drag on the scrubber selects a range; both panes rebuild from that window's pairs only, playback and stepping bound to it, and the selection renders as a band on the track with a chip naming the range and its pair count
- Added slice export: the chip's export button (and `cctrace view <target> --slice a..b`) produces a snapshot holding exactly the window's pairs — a small shareable artifact for pointing someone at "the part where it went wrong", instead of a whole-session page running hundreds of MB
- Added slice deep links: a selected range writes `#/session/<key>/@a..b` (the window's edge pair ids, which survive cross-run merges); opening one restores the slice paused at its end, and single-moment `@id` links work unchanged
- Changed scrubbing and Home/End to stay inside an active slice — the cursor can no longer leave the window and show an empty conversation that reads as data loss; a shift-click selecting nothing clears instead of filtering everything out

## 0.26.0

- Added steps to the session outline: each assistant message in a turn is one step of the agentic loop — one wire request — carrying a faint sub-ordinal (".1 .2 .3") under the turn's "01" and "step 2 of 4" in its hover; the conversation pane's intermediate messages wear the same address ("01.2") on their role bar, so both panes share one numbering down to the single request
- Added per-step outcomes: a step whose tool call came back is_error wears a quiet "tool err" mark on the row, with the exact count in the hover
- Added the wire stop reason to the final response's hover ("stop: end_turn"); a final that stopped at tool_use says the loop was cut mid-work instead of pretending the response finished
- Changed the continuation summary to head its turn as a recap node: a neutral dot and a small-caps recap tag instead of the human's ❯ prompt glyph, with a hover explaining the harness injected it as the model's entire memory of the conversation above — the outline and conversation pane now share one detector so they can never disagree

## 0.25.1

- Fixed every live and view page failing to load in 0.25.0 with "Cannot access 'META' before initialization": the view-mode check read META above its declaration, killing the whole page script; snapshot pages were unaffected because their code path short-circuits before the read
- Added live-page boot execution to the test suite: the non-snapshot script path (WebSocket connect, init/pair frames, view-mode boot) now runs under the DOM stub, so a declaration-order bug in the page script fails a unit test instead of shipping

## 0.25.0

- Added cctrace spec: an observed-wire catalog built from saved traces — endpoints, methods, statuses, header names, body field shapes (types + presence counts), and SSE event types, every entry stamped with sample counts and first/last-seen. Observations with provenance, never inferred truth: no OpenAPI guessing, values redacted by design except content-negotiation headers and model ids (regression-tested — auth material, prompts, and ids cannot enter the artifact). Volatile path segments normalize ({uuid}, {hex}, {n}, {token}) so catalogs compare cleanly
- Added cctrace spec --diff: compare against a previously written catalog and print what changed on the wire ("+ request header x-claude-code-agent-id", "+ sse event ...", "+ request field output_config.effort") — the changelog of the API surface a client actually calls; --md renders the catalog as a readable document
- Added identity-first rows to the cctrace view picker: client, session id, and the user's first real prompt instead of indistinguishable timestamp filenames. Identity is stamped into the instance registry at capture time (the first genuine prompt seen on the wire; probes, harness prompts, and title-gen wrappers filtered) with a bounded head-read fallback for older traces — the menu stays instant
- Changed cctrace view pages to read as documents: the status chip says "view" (never "live" or a false "offline"), the conversation opens at the top like a snapshot, and nothing auto-tails; the WebSocket stays only as the data channel
- Changed entering the sessions view to position both panes instantly — the threads outline scrolls to the active session and the conversation lands on the newest turn (live) or the top (view/snapshot); arrival is positioning, not animation
- Fixed cctrace spec on multi-GB log dirs: traces fold into the catalog one file at a time instead of loading every pair at once (a real dir OOM'd the process)

## 0.24.1

- Added a tooltip on the outline's ❯ fold gutter: hovering the symbol itself now explains the fold toggle before you click it
- Added sectioned tooltip layout: content first (the full text or file detail the row truncated), a hairline divider, then metrics, then faint interaction hints -- one reading order everywhere
- Added tool-fold hovers that lead with the tool's name and the full detail the row cut off (the complete file list of an Edit, the whole Bash command), then the click hint
- Changed sidebar tooltips to fly out to the right of the threads pane instead of dropping over the rows below it, and capped tooltip width at 320px -- a hover no longer blankets the outline you are scanning
- Changed live conversation re-renders to patch only the nodes whose content actually changed: an expanded final response, an open fold, or a text selection is no longer rebuilt when a new request lands elsewhere in the session
- Fixed the session-header id copy giving no feedback; it now flashes a green "copied" like every other click-to-copy on the page
- Fixed tooltips lingering on screen after a live re-render replaced the element under the mouse
- Changed this changelog to the flat claude-code-style format: one section per version, verb-led bullets, no categories

## 0.24.0

- Added select-to-purge in the Requests view: a toolbar Select button enters selection mode, "all shown" selects the filtered list, and purge deletes the chosen pairs from the page and the backing .jsonl trace file(s) -- atomic rewrite, archives preserved, files changed mid-flight skipped, every connected page drops the rows
- Added header trace totals: requests, in/out tokens, and estimated cost for the whole trace, live-updating, with the breakdown in the hover
- Added click-to-copy on the header trace title -- copies the project-relative .cctrace/trace-<ts>.jsonl path ready for cctrace view
- Added outline turn folding: clicking a turn head's ❯ gutter collapses the loop's agent work under the prompt line ("⋯ N" marks what's hidden); fold state survives live re-renders, truth markers never fold away
- Added tool previews covering the full Claude Code tool surface (MultiEdit, SlashCommand, AskUserQuestion, ExitPlanMode, Workflow, TaskUpdate, MCP resources, worktrees, and more); task-tracking TaskCreate no longer renders as a subagent spawn
- Changed tooltips on truncated surfaces to lead with the full text the row cut off, then the metrics
- Changed view pages to resolve projectPath to the repo root, so tool-call file paths render workspace-relative in served views and snapshots too
- Fixed the request-row entry animation firing on every bulk and filter re-render; live arrivals keep their single 160ms fade, everything else is instant

## 0.23.0

- Changed the sessions outline to count turns the way a human does: one turn = user request -> agent work -> final response, not one wire message (a real 213-message trace reads as 3 turns); ordinals are bare, zero-padded, 1-based, shared with the convo role bars
- Added ToolName(args) labels that say what each tool touched, in workspace terms: file paths relativize to the traced CLI's working directory, Read shows its line window, Bash leads with the model's own intent line, spawn labels name the real tool, agent type, and goal
- Changed harness-authored user-role messages to never read as the human: recap/tool-load/notification/reminder messages wear a small-caps SYS tag; role:system wire messages are harness-authored by definition
- Added a ❯ prompt glyph on user rows (the shell's own "your turn" marker); the rail line skips user heads so it spans a turn's work
- Changed the cache chip to lead with the layered-cache glyph (U+2261) and state the absolute hold-until wall-clock, never a ticking countdown; the newest model call renders "expired" when the page is drawn past its deadline
- Changed request rows to read content chips then right-aligned wire columns: model, effort, think, in/out, cache, cost, then sizes, ttft, duration, time
- Changed thread/session model chips to wear the identifier color with the wire facts (exact model ids, effort levels, 1m-context beta) in the hover

## 0.22.0

- Added requested reasoning effort as a row chip and detail param chip, covering every wire shape seen in real traces (Anthropic output_config.effort, thinking.effort, budget_tokens, adaptive; OpenAI reasoning.effort and reasoning_effort)
- Added a "stopped early" warn chip on truncated pairs -- cctrace keeps capturing after a CLI abort, so the partial reply is saved and now discoverable
- Added click-to-copy on the request id in the sticky detail toolbar
- Added designed tooltips page-wide: every title= folds into the structured hover panel with a 120ms show delay, so the native ~1s unstyled tooltip never fires
- Added mask mode: a header eye toggle blurs identity values (session ids, trace title, usage credits) for screen sharing; hover a blurred value to reveal it
- Added copy buttons to every conversation fold, body fold, and user/assistant text block
- Changed the detail panel order to chips -> Headers -> Body -> conversation, so reaching Headers no longer means scrolling past the whole conversation
- Fixed conversation and detail text sitting under the floating nav rail

## 0.21.0

- Fixed a /rewind being displayed as "compacted": boundary classification now reads index geometry (a fold's surviving tail aligns at shifted indices, a rewind's shared content is a same-index prefix), and the degenerate first-message anchor with zero verified context is rejected
- Fixed failed requests piling up as orphan rows at the thread tail: they now collect per timeline position and render as one collapsed run at the exact spot the storm hit ("21 failed requests · 429"), red dot on the rail, wire pair linked; failed pairs never claim turns

## 0.20.0

- Changed the sessions outline to name the tools on tool-only assistant turns (Bash, Read, skill ccx, Task) instead of a content-free "tools..."; thinking-only turns read "thinking...", empty ones "(no text)"
- Changed ui.md to document the shipped type scale and one-accent rule; added TASTE.md, a scar ledger of past design rejections

## 0.19.0

- Added cctrace kimi: traces the Kimi Code CLI through the same mitm path; Kimi's OpenAI Chat Completions wire adapts into the Responses object model, so sessions, attribution, compact, and the UI stay on one code path
- Added durable kimi session identity from the request body's prompt_cache_key, stable across subagents, auto-compaction, and --resume
- Added kimi auto-compaction reconstruction, marker-gated so a subagent sharing the session key is never false-claimed
- Added image_url tool-result parts rendering as image blocks
- Changed kimi coding-plan models to price as estimates at the equivalent pay-per-token rates via catalog aliases
- Fixed mitm tests leaking a proxied dev shell's env vars into the suite

## 0.18.0

- Added the sessions layer: messages -> threads -> sessions -> project, sessions listed newest-first as collapsible sections, a single-chat session absorbing its card into the header
- Added the session rail: turn dots carry the wire verdict, model epochs mark /model switches inside the thread, subagent threads attach as branch rows with their outcome inline, superseded exchanges sit grey at the ordinal they occupied
- Added content-verified per-turn attribution (index-first, verified against each pair's assembled response, content-scan on drift); every assistant turn links back to its wire request
- Added compaction reconstruction and display: post-compact packings merge back in, full /compact continuations reunify structurally, every boundary renders as a rail row + dashed divider with the context collapse in the hover
- Added the trace title to every page header: <project>/<trace-file.jsonl>
- Added terminal quiet mode (output buffers while the traced client owns the screen), --continue/--resume session preload, and the commit hash in --version
- Changed thread identity to the conversation, not the model -- the model is a quiet right-aligned chip
- Changed weak prompt-cache hits (under 90%) to amber -- most of the context was re-billed at full input price
- Fixed injected recap exchanges and compaction repacks displaying as "rewound"; fixed parallel Task spawns with identical prompts all matching the first dispatch; fixed turn jumps past the first model epoch scrolling to the wrong place

## 0.17.0

- Added DevTools-style request inspection: a size column from wire-stamped body bytes, a Headers section with parsed k/v tables and raw toggle, body view toggles (pretty JSON vs as-logged raw, parsed SSE vs raw text)
- Added session error metrics: wire errors, truncated streams, and tool failures aggregated per thread and session -- red chips, "N err" badges, a rollup line
- Added cctrace compact: folds redundant bytes out of saved traces without deleting pairs -- superseded request bodies become stubs, noise categories keep exemplar bodies; measured -95%+ on real multi-GB traces
- Added the run catalog: capture runs tombstone instead of vanishing, and cctrace view offers "recent runs elsewhere" across projects
- Changed the conversation design: quieter user-turn emphasis, assistant replies render a safe subset of markdown (escaped first)
- Changed --capture-external to cap external bodies at 64KB; enrolled hosts still capture in full

## 0.16.0

- Changed capture scope to tunnel-by-default: the mitm proxy decrypts only first-party, pinned, and enrolled hosts; everything else passes through as an opaque byte-counted tunnel -- no forged certs, so cert-pinning tools keep working; --capture-external restores decrypt-everything
- Changed response capture to be binary-safe: undecodable bodies summarize instead of decoding tarballs into mojibake
- Changed the purge default drop to telemetry,tokens,external
- Changed timestamps to render 24h everywhere
- Changed the category bar to show only categories the trace contains
- Added cctrace view with no target listing traces newest-first with a TTY pick prompt, and "latest" opening the newest directly
- Added a 160ms opacity fade on live-arrived rows; bulk renders stay instant

## 0.15.0

- Added first-token latency: the capture pump stamps firstByteMs and firstTokenMs live on every streamed pair (SSE events carry no timestamps, saved traces cannot backfill it); ttft renders as a chip, in the detail panel, and on session turns, and tok/s divides by post-first-token streaming time

## 0.14.0

- Added the client plugin layer: one module per client (claude, codex, grok) with binary discovery and a declarative wire table; adding a client is one file plus a registry entry
- Added OpenAI Responses dialect session reconstruction for codex and grok: input[] normalizes into the same turn/block model, threads key on the wire conv header, prewarm probes classify as utility
- Added pricing from the models.dev catalog (24h-TTL fail-soft cache); the embedded Claude table stays as the offline fallback

## 0.13.0

- Fixed a cross-instance stream leak: the page baked an absolute WebSocket URL, so behind port forwards a view page could attach to a different instance's live stream; the socket now connects origin-relative
- Fixed codex through the proxy: WebSocket upgrades are refused fast (501) so clients fall back to HTTP at once, and request bodies forward as raw untouched bytes (the lossy text decode corrupted codex's zstd bodies)
- Fixed sidechain session reconstruction: threads group by the x-claude-code-agent-id header or a reminder-skipping first-message signature, so main + subagents no longer collapse into one thread
- Added client labeling on every captured pair, a client chip in the header, and a CLIENT column in ps
- Added sticky detail toolbar and a quiet nav rail (top/bottom, prev/next turn, user prompts, system prompt; keys g/G, j/k, p/u, s)
- Changed live runs to stop writing a snapshot .html at exit -- the .jsonl is the deliverable; cctrace view serves by default and --html writes the snapshot
- Changed the session view to fold every tool_use to one line; focus goes to user prompts, subagent spawns, skill and MCP calls

## 0.12.0

- Added long-window zstd compress: a real 375MB trace archived to 5.7MB (63x, byte-identical round trip)
- Added cctrace purge: drop whole categories from saved traces, dry-run by default
- Added make publish with project-local .npmrc + .env token handling

## 0.11.0

- Added cctrace view --serve: serve a saved trace from the live web server instead of writing a hundreds-of-MB snapshot
- Added client profiles (first cut): cctrace codex and cctrace grok trace the OpenAI Codex and Grok CLIs through mitm
- Changed categorization to shape-first: /v1/messages and OpenAI shapes on any host classify as Messages, so third-party providers no longer drown in External
- Fixed the "Identifier 'pairs' has already been declared" snapshot corruption diagnosis: written by a stale pre-0.5.0 binary, not current escaping

## 0.10.0

- Fixed subprocess TLS trust: mitm mode exports a combined CA bundle (system CAs + mitm CA) as SSL_CERT_FILE / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / NIX_SSL_CERT_FILE, so curl, gh, and python children of the traced CLI stop dying on TLS
- Fixed cctrace ps lying across pid namespaces: liveness is now heartbeat + /api/self port probe keyed by run id, never pid
- Added port-walk discovery (9317..9326) that finds live instances even after a wiped registry
- Changed the version badge to the header's top-right

## 0.9.0

- Added an update checker: a daily background npm query (fail-soft, cached), a TTY upgrade prompt, and an amber "vX available" link in the UI
- Added prompt-cache hit/miss verdicts: one compact chip per request (hit % of prompt, cold write, miss), matching colored dots in the session view
- Added snapshot self-check and per-item self-repair: a corrupt pair degrades to one visible "broken item" card instead of blanking the page
- Fixed generated markup grammar: chip values escape, ANSI control sequences strip, and a parse5-backed test sweeps every fragment from hostile captures

## 0.8.0

- Added the cctrace agent skill (skills/cctrace/SKILL.md): teaches Claude Code agents to run traced sessions, read the UI, and work saved traces
- Added multi-instance support: an instance registry, cctrace ps, a "⇄ N more" header switcher, and predictable port allocation from 9317
- Added session replay (P1+P2): a time cursor over the wire with step/play/speeds, a scrubber minimap, and @<pair-id> deep links
- Added estimated cost everywhere: per request, per turn, per thread, from an embedded sticker-price table with Anthropic cache multipliers

## 0.7.0

- Added the session id to the tab title, so multiple live UIs stay tellable apart
- Added tail -f behavior to the session view: lands on the newest turn, sticks to the bottom, never yanks the scroll while reading history ("new activity" pill instead); folds survive live re-renders
- Added UI polish: quiet scrollbars, live/offline status dot, keyboard hints, prefers-reduced-motion respected
- Added docs/design/: the UI design language and the session-replay proposal

## 0.6.1

- Added run identity to the header: project name and the current session id (click to copy), extracted from the pairs so snapshots show it too

## 0.6.0

- Fixed a dropped connection crashing cctrace mid-session: ReadableStream.tee() replaced with a guarded pump, uncaught-exception handlers keep the proxy serving, idleTimeout 0 and a 5s flush cap protect exit
- Changed the MITM CA to live in XDG data (~/.local/share/cctrace) instead of cache -- identity material must not sit where cleanup tools sweep; a pre-0.6 CA migrates once, preserving identity
- Added --data-dir / CCTRACE_DATA_DIR as the documented storage override
- Added truncated: true on responses whose upstream died before finishing

## 0.5.0

- Added cctrace view <target>: rebuild a snapshot from a saved trace by path, session id, or filename fragment
- Added storage subcommands clean / merge / compress, all dry-run by default, with data-safety invariants (union with existing outputs, re-stat before unlink, tmp+rename)
- Fixed snapshot corruption on hostile payloads: </script> in content and $-substitution sequences both regression-tested away
- Changed the MITM CA to one cache dir for every install method

## 0.4.0

- Added cross-run session continuity: --continue / --resume merge prior runs' traces of the same session into the live UI, matched by the wire session id
- Added the Session view: wire threads beside the reconstructed conversation, per-turn usage attributed to the wire request that produced it
- Added the split detail panel, hash-routed request details, the conversation view, inline row summaries, and the usage-limits panel
- Added claude CLI pass-through (everything after -- goes to Claude verbatim) and make build / make install for a standalone binary
- Changed prev/next and j/k to walk the filtered list

## 0.3.0

- Added full interception of non-Anthropic hosts via per-host certs minted on first contact; blind tunnel stays as the fallback
- Added the count_tokens category and logged tunneled CONNECTs
- Added the GitHub Pages landing page

## 0.2.0

- Added the theme toggle (system / light / dark, persisted, FOUC-free)
- Added the brand icon and GitHub link in the header
- Changed publishing to @thevibeworks/cctrace on npm

## 0.1.1

- Fixed redaction to cover request/response bodies and URLs, not just headers -- one choke point (src/redact.ts) before the .jsonl, the .html, and the WebSocket
- Fixed the env injected into Claude: SSL_CERT_FILE and HTTP_PROXY dropped, NODE_EXTRA_CA_CERTS suffices
- Added bilingual README, SECURITY.md, CONTRIBUTING.md, and CI

## 0.1.0

- Initial public release: mitm / base-url / node capture modes, the Capturer abstraction, the live categorized web UI, offline snapshots, blind tunnel for hosts we can't terminate, and header redaction
