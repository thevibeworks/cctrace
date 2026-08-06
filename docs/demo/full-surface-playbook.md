# Full-surface demo playbook

Operator checklist for the scripted, real-work Claude Code session traced
end-to-end by cctrace in a bare deva container. One trace, three jobs:
README demo material, a stress fixture for src/session.ts, and an
observation instrument for wire shapes not yet captured on purpose.

Spec and rationale: docs/devlog/2026-07-24-full-surface-demo-session.org
(acts are ordered by wire class, not the docs feature taxonomy).

How to read the acts: each step is `you type/press -> expected wire
artifact (where to verify)`. Type prompts verbatim — they name tools
explicitly on purpose; this is a demo, and the soft assertion tier absorbs
whatever the agent does differently.

## 0 · Prep

On the host:

- [ ] Launch a bare-profile deva container over the cctrace checkout
      (`deva -Q ...`): auth credentials mounted, personal profile NOT
      mounted. The demo account should be a work/demo account — its
      account id still reaches Class B endpoints.
- [ ] Note the forwarded port range (cctrace walks 9317..9326); the live
      UI is reached through the forward, hence `--no-open`.

Inside the container:

- [ ] `bash docs/demo/setup.sh` — idempotent. It installs:
      - workspace clone at /home/deva/projects/cctrace (demo git identity
        "cctrace demo <demo@cctrace.dev>"; origin -> github)
      - demo profile: ~/.claude/CLAUDE.md (docs/demo/profile/claude-user.md)
        + bare settings.json (originals backed up as *.pre-demo.bak)
      - ~/.claude/skills/cctrace (real copy)
      - workspace .mcp.json: `everything` (stdio) + `deepwiki` (http)
      - compiled cctrace binary if missing (the `-- --continue` act
        needs the compiled binary; bun eats a leading `--` otherwise)
- [ ] `claude` once WITHOUT cctrace if login is needed — finish auth
      before the take so Act 1 opens clean. Exit immediately.
- [ ] Optional speed knob: permission prompts are Class E (no wire
      footprint), so pre-allowing `Bash(bun test:*)` etc. in
      ~/.claude/settings.json changes pacing, not the trace. Default is
      bare: approve by hand.

## 1 · Masking model

Three layers, each with a different job. The bare profile is the fourth:
nothing personal is in context by construction, so the demo CLAUDE.md is
SUPPOSED to be read on the wire.

1. Capture time (src/redact.ts, always on): OAuth tokens, auth headers,
   credential body fields, and identity fields (account/session/device
   uuids) are redacted before any pair touches disk, the websocket, or a
   snapshot. The raw trace is credential-safe by construction.
2. Screen time (UI mask toggle, eye glyph in the header): blurs session
   ids, trace title, usage/credits chips for screenshots and screen
   shares. Hover reveals one value at a time. Use it for every README
   screenshot; it is display-layer only.
3. Fixture time (tests/sanitize-trace.ts): equality-preserving hash
   tokens, zero original text — structure survives, content does not.
   Only the sanitized fixture is ever committed.

Rules of the take:

- The raw trace stays in the workspace clone's .cctrace/ (gitignored),
  never in the real checkout, never in git.
- Screenshots: mask toggle ON unless the shot is specifically about an
  identity element.
- Known gap: sanitize-trace.ts currently keeps only /v1/messages pairs.
  Tunnel meta-pairs, oauth, and MCP JSON-RPC survive only in the raw
  archive — structural verification of Classes B/C/D runs against the
  raw merged trace, not the fixture. Extending sanitize is follow-up
  work (see section 9).

## 2 · Launch

```
cd /home/deva/projects/cctrace
cctrace claude --intercept-host mcp.deepwiki.com --no-open
```

mitm auto-selects (native binary). Deliberately NOT --capture-external:
opaque tunnel meta-pairs are part of the story. Open the printed URL
through the forwarded port; leave the Requests view visible while you
drive, switch to Sessions between acts.

## Act 1 · warm-up + epochs (Class A: model, reasoning)

- [ ] `/model`, keep the default (Enter)
      -> nothing on the wire (telemetry at most). Say so in the demo:
      local UI is invisible to a tracer.
- [ ] `In one sentence: what does this repo do?`
      -> first pairs land: haiku utility probes (tiny system prompt — the
      quota/naming shape) + the real call with full system prompt, the
      demo CLAUDE.md visible inside, tool definitions, cache_control.
      Verify: Requests view, first Messages pair; expand Body > system.
- [ ] `/model sonnet`
- [ ] `One sentence: which single file here is riskiest to touch, and why?`
      -> epoch t1 on the same thread (threadEpochs); thread model chip
      becomes a set ("fable-5 +1" or similar). Verify: Sessions view,
      thread card t0/t1 rows + convo divider at the switch.
- [ ] `ultrathink: why might a MITM proxy break TLS trust for
      subprocesses spawned by the CLI it is tracing?`
      -> thinking blocks in the response, effort/think chips on the row.
- [ ] Deliberate unknowns, while we are in the model act (log what you
      see in section 7's table; these are observations, not assertions):
      - `/model` picker: if an effort/reasoning slider is present, cycle
        it low -> high with a one-line prompt at each stop
        -> does output_config.effort track the slider?
      - `/fast` on, one-line prompt, `/fast` off
        -> diff the two pairs: header? model id? param? (Opus-only
        feature — if unavailable, note the refusal, that is data too.)

## Act 2 · monitor + wakeups (Class A: harness-authored turns)

- [ ] `Run a background Bash job that appends a tick line to
      /tmp/demo-ticks.log every 20 seconds for one minute, then use
      Monitor to watch the file and tell me when the third tick lands.`
      -> Bash run_in_background + Monitor tool_use; the wakeup arrives as
      a "[SYSTEM NOTIFICATION" user-role message. Verify: Sessions
      outline — the wakeup heads a CLI-authored turn (no human ❯ mark);
      reminder-only nudges absorb as sys tags.

## Act 3 · the real task (Class A bulk: plan, subagents, tools, abort)

- [ ] shift+tab into plan mode, then:
      `Plan a small documented change: a doc note explaining how --fresh
      and --with flow from args.ts into history.ts, plus one unit test
      pinning that behavior.`
      -> plan-agent traffic; ExitPlanMode tool_use on approval.
- [ ] Approve the plan, then:
      `Track this as tasks. Use an Explore agent and a general-purpose
      agent IN PARALLEL: one maps how --fresh flows from args.ts through
      cli.ts into history.ts, the other maps --with. When both return,
      use AskUserQuestion to ask me where the doc note belongs
      (docs/traces.md vs CLAUDE.md) before writing anything. Then add
      the note and a unit test in tests/history.test.ts, and run bun test.`
      -> TaskCreate; two parallel subagent request streams stamped
      x-claude-code-agent-id; Glob/Grep/Read pairs; AskUserQuestion;
      Edit/Write; Bash test run. Verify: Sessions view — two agent
      branches under the main thread, spawn folds with inline outcomes
      ("N turns · out … · $…").
- [ ] Answer the AskUserQuestion when it comes (pick docs/traces.md).
- [ ] During one long generation: press Esc ONCE, wait for the abort.
      -> truncated: true on that pair; "stopped early" chip (guarded
      pump kept the partial). Then: `Continue where you left off.`
- [ ] `Use WebFetch on the Bun docs page about test filtering
      (https://bun.com/docs/cli/test) and cross-check the test filter
      flag you used.`
      -> server tool blocks (web_fetch / web_search shapes).
- [ ] `Run: npm view @modelcontextprotocol/server-everything version`
      -> ONE opaque tunnel meta-pair for registry.npmjs.org: host, byte
      counts, duration, no bodies. The scoped-capture beat — call it out.
- [ ] `Commit the change locally with a concise message. Do not push.`
      -> commit lands with the demo git identity; the git traffic itself
      is local (nothing on the wire — say so).
- [ ] Watch for (section 7): any extra tiny model call right after a
      permission decision -> the auto-mode classifier question.

## Act 4 · MCP (Class A + C)

- [ ] `Call the everything MCP server's echo tool with the message
      "stdio leaves no wire trace".`
      -> mcp__everything__echo tool defs + tool_use INSIDE the messages
      body; ZERO network pairs for the server itself. This is the
      contrast case — state it explicitly.
- [ ] `Ask the deepwiki MCP server what the thevibeworks/cctrace repo
      does.`
      -> JSON-RPC pairs on mcp.deepwiki.com (enrolled via
      --intercept-host); purple MCP fold in the convo. Without
      enrollment these would be one opaque tunnel line.
- [ ] `Use the cctrace skill: list the live cctrace instances and
      describe what THIS session looks like in the trace so far.`
      -> Skill invocation (skill body lands in context, "skill · cctrace"
      fold) + claude reading its own trace through the UI API. The
      self-referential beat.

## Act 5 · context lifecycle (Class A: repack; Class B on demand)

- [ ] `/context`, then `/cost`
      -> local renders, nothing on the wire (playbook says so; the demo
      narrator should too).
- [ ] `/usage`
      -> /api/oauth usage/credits pairs (Class B, mitm-only) with limit
      bars in the detail panel.
- [ ] `/compact focus on what changed in the codebase`
      -> the repack: continuation summary becomes msg[0], sig splits,
      REUNIFICATION stitches it back into the pre-compact conversation.
      Verify: Sessions view — break node "compacted · N -> M turns",
      dashed divider, tagged continuation-summary turn.
- [ ] `Post-compact check: list the files we touched this session.`
      -> post-compact turns append at the timeline tail; thread identity
      holds.
- [ ] Optional (only if the take is going well — this is the riskiest
      beat): /rewind one checkpoint back, then send a variant prompt:
      `Actually, summarize the test we added in one line instead.`
      -> same-index-prefix geometry: superseded rows render grey at
      their timeline position, never mislabeled as a compact.

## Act 6 · session boundaries (Class D)

- [ ] `/clear`, then: `Quick: what version is in package.json?`
      -> sid rotates; second session section appears in the same trace
      (session-scoped threads, `[`/`]` to switch).
- [ ] Exit claude (Ctrl+D). Let cctrace finish its flush.
- [ ] `cctrace claude --intercept-host mcp.deepwiki.com --no-open -- --continue`
      then: `What did we do last session?`
      -> history.ts loads the prior trace on the sid match; prior pairs
      stamped pair.prior; old turns regain wire links in the new UI.
- [ ] Exit. `cctrace claude -- -p "print the repo name from package.json"`
      -> headless one-shot: third sid, distinct shape (no TUI probes).

## 7 · Deliberate unknowns — the observation log

Fill this in during the take; whatever we find feeds extractors
(extractEffort-style), not prose. Copy into the run devlog afterwards.

| probe | where | observed wire fact |
|---|---|---|
| /fast on/off | Act 1 | header? model id? param? |
| effort slider per level | Act 1 | output_config.effort values? |
| auto-mode permission classifier | Act 3 | extra model call? which model? |
| ToolSearch mid-thread growth | any | tools array grows + "Tool loaded." turn? |
| /rewind geometry | Act 5 | same-index prefix confirmed? |

## 8 · Post-run pipeline (each subcommand is itself a demo beat)

```
cctrace ps                          # live instances (should be none after exit)
cctrace view latest                 # reopen the trace; screenshots happen here
cp .cctrace/trace-*.jsonl /tmp/demo-raw-archive/   # raw archive BEFORE mutating
cctrace merge --yes                 # one deduped session-<sid>.jsonl per session
cctrace compact --yes               # fold superseded bodies (session view identical)
cctrace purge --drop telemetry --yes
```

Screenshots (mask toggle ON): Requests view with the chip row; a detail
panel with Headers + cache verdict; Sessions view with the two agent
branches + the compact break node; the replay scrubber mid-session.

## 9 · Verification + fixture cut

Structural verification runs against the RAW merged session (pre-purge
archive), two tiers, per the devlog:

- Hard (must hold or the take is retried): >=2 models in one thread's
  epoch list; >=1 compact boundary with reunification; >=2 subagent
  branches linked to spawn folds; >=1 truncated pair; >=1 tunnel
  meta-pair; enrolled-host MCP pairs present; >=3 wire session ids; >=1
  pair.prior-stamped pair.
- Soft (report, don't fail): specific tool names, server-tool blocks,
  thinking blocks, AskUserQuestion.

tests/verify-demo-trace.ts encodes these (to be written with the first
successful take — presence of structure is the contract, exact content
never is).

Fixture cut, version-stamped so staleness is legible:

```
bun tests/sanitize-trace.ts .cctrace/session-<sid>.jsonl \
    tests/fixtures/full-surface-session-cc<claude-code-version>.jsonl.zst
```

Follow-up (not this run): extend sanitize-trace.ts beyond /v1/messages so
tunnel/oauth/MCP pairs can ship in the fixture too.

## 10 · Abort and retry rules

- Acts are ordered so an early abort still yields a usable partial trace
  (epochs and subagents land before the fragile compact/rewind beats).
- If a beat misfires (agent satisfies the prompt without the named
  tool), keep going — soft tier absorbs it. Only hard-tier misses
  justify a retake.
- A full take burns low single-digit dollars (the parallel-agent act
  dominates); budget two or three takes.
- If cctrace itself misbehaves mid-take: the trace up to that point is
  still valid (.jsonl is append-only); file the bug — the
  session-legibility arc found three of its own bugs exactly this way.
