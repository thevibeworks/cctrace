---
name: cctrace-title
description: >
  Name cctrace sessions with human titles by fanning the work out across
  Claude Code subagents. Use whenever the user wants to title, name, label,
  or rename their cctrace traces / sessions — "title my sessions", "name the
  untitled traces", "give these runs proper names", "title everything in the
  store", "rename this session". cctrace extracts each session's spine (the
  human's prompts + the agent's final answers, no tool calls, no sub-agent
  context); this skill turns those digests into titles and writes them back
  so they show in the dashboard, `cctrace history`, the view picker and the
  trace header. cctrace itself never calls a model — this skill is the namer.
---

# cctrace-title — name captured sessions with subagents

cctrace stores traces per project under the trace store. Each session can
carry a human title in that project's `titles.json`. cctrace produces the
spine digest and stores the result; YOU generate the names, in parallel,
using Claude Code's own subagents. cctrace never spawns a model.

## When to use

The user wants their cctrace sessions named/titled/labeled/renamed, for one
project or across the whole store.

## Steps

1. **Get the work list.** Emit the sessions that still need a title, with
   their digests, as JSON:

   ```bash
   cctrace title --json            # this project (cwd's store dir)
   cctrace title --all --json      # every project in the store
   cctrace title --dir DIR --json  # a specific store dir
   cctrace title --force --json    # include already-named sessions (re-title)
   ```

   Each entry is:
   `{ key, sid, source, storeDir, project, loops, digest }`
   - `digest` — the session spine: `[n] USER: …` / `[n] AGENT: …` lines, the
     human's prompts and the agent's FINAL answers only (tool calls, tool
     results and sub-agent threads are already stripped). Long sessions are
     front/back-weighted with a `[… N omitted …]` marker.
   - `key` + `storeDir` — what you write the title back with.

   If the list is empty, tell the user everything is already named (or run
   with `--force` to redo) and stop.

2. **Name each session — fan out.** Do NOT name them one at a time in the
   main thread. Launch subagents (the Task tool) in parallel, batching the
   sessions across them (e.g. 8–12 per subagent for a large store). Give
   each subagent its slice of `{key, storeDir, digest}` entries and these
   naming rules:

   > For each digest, write ONE title: 4–9 words, specific to what was
   > actually done or asked — name the component, bug, or feature. No
   > trailing period, no quotes, no leading "Session about". Prefer the
   > concrete outcome over the opening request when they differ. Reply with
   > `<key>\t<title>` per line.

   Have each subagent WRITE ITS OWN RESULTS BACK (below) and return only a
   count — don't route long titles back through the main thread.

3. **Write titles back.** For each named session:

   ```bash
   cctrace title set <key> "<title>" --dir <storeDir>
   ```

   `set` sanitizes and atomically records the title. `<key>` is the entry's
   `key` (a session id, or `file:<name>` for a trace with no wire session).

4. **Confirm.** Re-run `cctrace title --json` (or `--all`) and report how
   many sessions now have titles and how many, if any, still don't.

## Notes

- Scope by project: `cctrace title --json` uses the current directory's
  store; `--all` sweeps every project (each entry carries its own
  `storeDir`, so writes land in the right file). Prefer `--all` only when
  the user asks for the whole store — it can be hundreds of sessions.
- Titles are cheap and overwritable: re-run with `--force` to re-name.
- The digest is capped (~12 KB). If a digest is thin (a one-exchange
  session), a short factual title is fine — don't invent detail.
- This is naming only. To capture, view, merge, or compress traces, use the
  `cctrace` skill instead.
