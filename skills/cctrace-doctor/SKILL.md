---
name: cctrace-doctor
description: >
  Diagnose a traced agent session's CONTEXT: what the model's window is
  made of, what in it is dead weight, duplicated, or harness noise, and
  what to change so the next session spends its attention on the task.
  Use when the user asks "what is eating my context", "why is this session
  so heavy", "context doctor", "audit the context", "what's duplicated in
  the window", "is my CLAUDE.md too big", "which tools/MCP servers cost
  me tokens", "context health", "doctor this session", or wants a
  context report for a session or across the store. cctrace computes the
  facts and fires fixed rules (`cctrace doctor --json`); this skill reads
  them, drills into the evidence with `--show`, and writes the diagnosis
  with concrete recommendations. cctrace never reasons; this skill is the
  doctor.
---

# cctrace-doctor — read one session's context, say what to cut

Every request a traced agent makes carries its whole assembled context.
`cctrace doctor` reads one session's main thread, takes its latest request
window (the exact context the model last saw), and reports its
composition, its duplicates, its injections and its timeline, plus the
findings a fixed rule set fires. You turn that into a diagnosis the user
can act on: what is noise, what is repeated, what harms attention, and
what lever removes it.

## When to use

- The user asks why a session is heavy, slow, expensive, or "forgetful".
- The user wants their CLAUDE.md / hooks / MCP set / tool habits audited
  against what actually lands in the window.
- A sweep: "doctor every session this week" — fan out (below).
- YOU are running under cctrace (`CCTRACE_TRACE_FILE` is in your env) and
  want to see your own context: `cctrace doctor` with no target diagnoses
  the run you are in.

## Steps

1. **Get the facts.**

   ```bash
   cctrace doctor --json                        # this run (traced) or the newest trace
   cctrace doctor <session-id|file|latest> --json
   cctrace doctor <target> --peak --json        # the heaviest window instead of the latest
   cctrace doctor <target> --step <pair-id> --json
   cctrace doctor <target> --thread <key-fragment> --json   # a subagent's window
   cctrace doctor <target>                      # the terminal glance (same facts)
   ```

   The JSON has one section per question:

   - `window` — the diagnosed step: `est` per category (system / tools /
     user / inject / assistant / toolResult / total), `share` in %,
     `actual` (the provider's prompt-token count: input + cacheRead +
     cacheWrite), `calibration` = actual/est, `unaccounted` = the tokens
     the body does not show at 4 chars/token.
   - `signal` — the attention split: `task` (the human's words + the
     model's prose), `overhead` (system + schemas + injections), `work`
     (tool results, tool calls, thinking).
   - `system.blocks[]` — each system block with `tokens`, `head`,
     `cacheControl`, `versions` (how many distinct texts it had over the
     thread), `billing` (Claude Code's mutating header block — expected),
     and `sections[]` split on markdown headings with a `key` each.
   - `tools` — `count`, `tokens`, `byOrigin[]` (builtin vs one node per MCP
     server, with `called` and `unused[]`), `unused` (names + tokens paid
     on every request for tools the thread never called), `top[]`.
   - `injections` — in the window: `recurring[]` (the per-step nudges:
     terminal caveat, tokens left, output style, date, idle nudge — kind,
     count, tokens), `oneOff[]` (project instructions, hook output, file
     contents, notifications, continuation summaries — each with `kind`,
     `tokens`, `head`, and for instruction blocks `parts[]` = one entry per
     file with its size), `reminderBlocks`.
   - `conversation` — real user messages and tokens; assistant text vs
     thinking vs tool-call tokens.
   - `results` — tool results `byTool[]` (count, tokens, errors),
     `largest[]`, `errors`, `over` (results past the big-result rule).
   - `duplicates` — `exact[]` (byte-identical blocks after whitespace
     folding: `count`, `tokens` per copy, `wasted` beyond the first,
     `keys`), `near[]` (line-set overlap ≥ 0.5 between big blocks:
     `similarity`, both keys), `rereads[]` (the same tool asked the same
     target again: Read of one path, one Bash command, one URL — with the
     result tokens that sit in the window per ask).
   - `timeline` — `steps`, `peak` (tokens, pair, time), `modelWindow` and
     `peakPct`, `compactions[]`, `cache` (hit % over the thread, bumps by
     cause), `injectionsByProducer[]` (every injection the thread received,
     by producer), `systemChanges`, `growth[]` (sampled est/actual per step).
   - `findings[]` — `level` high/warn/info, `title`, `detail`, `tokens`,
     `rule` (the threshold that fired), and `show` (the key that opens the
     evidence). `rules` lists every threshold.
   - `session.threads[]` — every thread (chat / agent / utility) with its
     peak prompt size, so you can name a heavy subagent and re-run with
     `--thread`.

2. **Look at the evidence before judging it.** Every item has a key; print
   the text behind it:

   ```bash
   cctrace doctor <target> --show sys:1          # a system block
   cctrace doctor <target> --show sys:1/3        # one section of it
   cctrace doctor <target> --show tool:mcp__x__y # a tool schema
   cctrace doctor <target> --show inj:0          # an injected block (turn 0)
   cctrace doctor <target> --show res:118        # a tool result at turn 118
   cctrace doctor <target> --show dup:<hash>     # the first copy of a duplicate group
   cctrace doctor <target> --show user:52        # a human message
   ```

   Read the biggest one-off injection, the largest result, and the first
   copy of the top duplicate group. A 12k "file contents" block is a fact;
   whether it belonged in the window is a judgment you can only make after
   reading its head.

3. **Write the diagnosis.** Short, numbers first, one idea per line:

   - One line of identity: session, client, model, turns/steps, which
     window (latest/peak/step) and its actual vs estimated size. If
     `calibration` is far from 1, say once that shares rank and absolute
     figures do not.
   - The composition as the six shares, then the three-way signal split.
     The sentence that matters: "the task is N% of what the model reads".
   - What is dead weight, in descending tokens: unused tool schemas (name
     the MCP server), oversized system sections, one-off injections that
     stayed for the whole session, recurring nudges.
   - What is duplicated: exact groups (what, how many, wasted), re-reads
     (which file/command, how many times), near-duplicates (what changed
     between copies).
   - What harmed attention: error results still in the window, giant
     results, instruction files delivered more than once, compactions and
     the peak vs the model window, cache bumps and their causes.
   - Recommendations: 3–6, each tied to one finding and one lever.

4. **Recommend levers that exist.** Match the finding to the fix:

   - **Unused MCP server schemas** → disable the server for this project
     (`claude mcp remove <name>` or drop it from `.mcp.json` /
     `settings.json`), or keep it and accept the per-request cost. Name
     the tokens per request × steps = tokens per session.
   - **Unused built-in schemas** — not the user's lever in Claude Code;
     say so rather than inventing a flag.
   - **A big system section** ("Memory", output style, a long CLAUDE.md
     rendered into the system prompt) → trim that file; quote its heading
     and size. `parts[]` on the project-instructions injection says which
     file is the weight (global CLAUDE.md vs project vs local vs MEMORY.md).
   - **Hook output in the thousands** (SessionStart hook additional
     context) → have the hook print a pointer, not the document.
   - **The same file read N times / the same command re-run** → a
     CLAUDE.md rule ("read a file once; grep a range instead of re-reading
     whole files"), `Read` with offset/limit, piping through `head`, or
     delegating the read to a subagent so the parent keeps only the answer.
   - **A tool result over ~8k tokens** → cap it at the source (`| head`,
     `--max-count`, a narrower glob), or send it to a subagent.
   - **Error results piling up** → nothing to remove after the fact; the
     rule is to fix the command before retrying it verbatim.
   - **Instruction files delivered more than once** (worktree entry,
     `/clear` + resume) → note it as harness behaviour; the lever is fewer
     worktree hops per session, or a smaller CLAUDE.md so each copy costs
     less.
   - **Peak near the model window / compactions** → shorter sessions per
     task, `/clear` between unrelated tasks, subagents for bulk reads.
   - **Cache hit below ~85% with `invalidated` bumps** → something in the
     prefix changed: `systemChanges` > 0 names a system block that
     changed; `tools` events name schema loads. Long idle gaps show as
     `expired`.

   Prefer one CLAUDE.md line the user can paste over a paragraph of
   advice. Give the token figure the change would save on every request.

5. **A sweep across sessions** (the user asks for the week, the project,
   or the store): list targets with `cctrace history --json` or `cctrace
   view` (non-TTY lists), then fan out — one subagent per 4–8 sessions,
   each running `cctrace doctor <sid> --json` and returning ONLY: the
   session id, its signal split, its top three findings with tokens, and
   the one lever it recommends. Aggregate in the main thread: the
   findings that repeat across sessions are the rules worth writing.

## Honesty rules (cctrace's own)

- Every token figure from the body is an ESTIMATE (≈4 chars/token); the
  provider count in `window.actual` is the truth for that step. Write
  "≈" on estimates, never on `actual`. Dense content (code, JSON, CJK)
  and anything the provider expands server-side make `calibration` run
  above 1 — shares still rank, absolute figures do not; say so once.
- The window is the MAIN thread's by default. Subagent windows are
  separate contexts; `session.threads[]` lists them with their peaks —
  diagnose one with `--thread` before claiming anything about it.
- A finding is a threshold that fired, not a verdict; `rule` says which.
  Argue with the rule when the context justifies it (a 20k CLAUDE.md can
  be exactly right for a repo the agent must never misread).
- Never quote a system prompt, a tool result or a file back to the user
  at length: `--show` is for you to read, the report names heads and
  sizes. Traces are sensitive (skills/cctrace/SKILL.md, Privacy).
