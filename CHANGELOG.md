# Changelog

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
