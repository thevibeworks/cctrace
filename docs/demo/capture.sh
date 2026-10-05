#!/usr/bin/env bash
# Capture the public demo session: a REAL Claude Code run, recorded by cctrace.
#
# Everything in the capture is publishable by construction, not by scrubbing:
#   - the workspace is a clone of this public repo at a neutral path
#   - the agent runs with a SANDBOX HOME (docs/demo/profile/ as ~/.claude):
#     the operator's own global CLAUDE.md, memory, skills, agents and project
#     history never enter the context. CLAUDE_CONFIG_DIR alone is NOT enough —
#     Claude Code still reads $HOME/.claude/CLAUDE.md, which is how the
#     operator's personal instructions ended up in the first take.
#   - credentials never reach the trace (src/redact.ts, always on) and
#     --redact-ids masks account/session/device ids as they are captured
#   - the sandbox lives outside the checkout; nothing here is committed
#
# The turns are real work on this repo, run non-interactively, one at a time.
# Render the result with: bun run docs/demo/build.ts <trace>
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEMO_ROOT=${DEMO_ROOT:-$HOME/cctrace-demo}
WORKSPACE=$DEMO_ROOT/cctrace
SANDBOX_HOME=$DEMO_ROOT/home
TRACE_DIR=${TRACE_DIR:-$DEMO_ROOT/trace}
# cctrace chains through whatever proxy this machine needs for egress; without
# it, a cctrace that is itself being traced would chain through its own tracer.
EGRESS_PROXY=${EGRESS_PROXY:-}

note() { printf '==> %s\n' "$*"; }

# 1. Workspace: a clone, so demo edits never touch the real checkout.
mkdir -p "$DEMO_ROOT"
if [ ! -d "$WORKSPACE/.git" ]; then
  note "cloning workspace -> $WORKSPACE"
  git clone --quiet --depth 1 "file://$REPO_ROOT" "$WORKSPACE"
  git -C "$WORKSPACE" remote set-url origin https://github.com/thevibeworks/cctrace.git
fi
git -C "$WORKSPACE" config user.name "cctrace demo"
git -C "$WORKSPACE" config user.email "demo@cctrace.dev"
git -C "$WORKSPACE" checkout --quiet -- .

# 2. Sandbox HOME: the real config's AUTH, none of its content. Claude Code
#    authenticates from ~/.claude/.credentials.json plus the account block in
#    ~/.claude.json, so both are copied; everything that carries instructions,
#    memory, history or tooling is dropped and replaced by the demo profile.
note "building sandbox home -> $SANDBOX_HOME"
rm -rf "$SANDBOX_HOME"
mkdir -p "$SANDBOX_HOME/.claude"
cp "$HOME/.claude/.credentials.json" "$SANDBOX_HOME/.claude/.credentials.json"
chmod 600 "$SANDBOX_HOME/.claude/.credentials.json"
cp "$REPO_ROOT/docs/demo/profile/claude-user.md" "$SANDBOX_HOME/.claude/CLAUDE.md"
cp "$REPO_ROOT/docs/demo/profile/settings.json" "$SANDBOX_HOME/.claude/settings.json"
python3 - "$HOME/.claude.json" "$SANDBOX_HOME/.claude.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
cfg = json.load(open(src))
# Keep the account/onboarding state; drop every trace of real projects.
keep = {k: v for k, v in cfg.items() if k not in ("projects", "tipsHistory", "history", "cachedChangelog")}
keep.update({"projects": {}, "hasCompletedOnboarding": True, "autoUpdates": False,
             "theme": "dark", "bypassPermissionsModeAccepted": True})
json.dump(keep, open(dst, "w"))
PY

# 3. The turns: explore, read deep, diagnose a real bug, fix it, have a
#    subagent review it, run the tests, summarize.
cat > "$DEMO_ROOT/turns.sh" <<'TURNS'
#!/usr/bin/env bash
set -uo pipefail
cd "$WORKSPACE"
turn=0
say() {
  turn=$((turn + 1))
  printf '\n===== TURN %s =====\n%s\n\n' "$turn" "$1"
  if [ "$turn" = 1 ]; then
    claude -p "$1" --dangerously-skip-permissions --output-format text 2>&1 | tail -30
  else
    claude -p --continue "$1" --dangerously-skip-permissions --output-format text 2>&1 | tail -30
  fi
}
say 'In one sentence each: what does this project do, and which module decides which hosts the mitm proxy decrypts?'
say 'Read src/context.ts and the context-view parts of src/ui.ts, then explain end to end how a captured request body becomes the context graph the UI draws. Name the functions involved.'
say 'On the dashboard, a run row shows its client label only in some groupings (src/dashboard.ts, runIdentity). Read that code and explain exactly when the label goes missing and why.'
say 'Fix it with the smallest change that keeps the existing grouped-label behavior, then show me the diff.'
say 'Use a subagent to review that change for regressions in how the dashboard groups and labels runs.'
say 'Run the narrowest relevant tests for what you changed.'
say 'Summarize the change, what you verified, and what you did not.'
TURNS
chmod +x "$DEMO_ROOT/turns.sh"

# 4. Record it.
mkdir -p "$TRACE_DIR"
export WORKSPACE
cd "$WORKSPACE"
note "recording -> $TRACE_DIR"
env HOME="$SANDBOX_HOME" \
    ${EGRESS_PROXY:+HTTPS_PROXY="$EGRESS_PROXY" https_proxy="$EGRESS_PROXY"} \
  bun "$REPO_ROOT/src/cli.ts" claude \
    --mode mitm --redact-ids --no-open --no-update-check --no-compress --fresh \
    --dir "$TRACE_DIR" \
    --client-path "$DEMO_ROOT/turns.sh"

note "trace:"
ls -la "$TRACE_DIR"
cat <<EOF

Next: render it, and check the provenance the build prints.

  bun run docs/demo/build.ts $TRACE_DIR/trace-*.jsonl
  bun src/cli.ts doctor $TRACE_DIR/trace-*.jsonl   # what is in the window, and whose files

The interactive take (a real TUI session, with /model and /compact) is the
same sandbox driven through tmux: docs/demo/drive.sh.
EOF
