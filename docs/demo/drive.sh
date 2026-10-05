#!/usr/bin/env bash
# Drive the INTERACTIVE take: a real Claude Code TUI session in tmux, one turn
# at a time. Same sandbox as docs/demo/capture.sh (build it with that script
# first, then launch the TUI inside tmux):
#
#   tmux new-session -d -s ccdemo -x 210 -y 52 \
#     "env HOME=$HOME/cctrace-demo/home bash --noprofile --norc"
#   tmux send-keys -t ccdemo "cd ~/cctrace-demo/cctrace && bun <repo>/src/cli.ts \
#     claude --mode mitm --redact-ids --no-open --fresh --dir ~/cctrace-demo/trace" Enter
#   # answer the trust + bypass-permissions dialogs once, then:
#   docs/demo/drive.sh 'first prompt' '/model sonnet' ... '/compact' 'last prompt'
#
# The TUI take is what the published sample is built from: it carries the
# things only an interactive session has — slash commands, a model switch
# mid-thread, and a real /compact boundary.
# A turn is settled only after it was SEEN working and then went quiet — the
# first version advanced during the few seconds before the model started, and
# queued the next prompt on top of a running turn.
set -uo pipefail
S=ccdemo
LOG=/tmp/tui-drive.log

busy() { tmux capture-pane -p -t "$S" | tail -12 | grep -qE "esc to interrupt|ctrl\+c to (stop|interrupt)"; }

settle() { # $1 = max seconds; returns when quiet for 15s after work was seen
  local max=${1:-900} idle=0 waited=0 started=0
  while [ "$waited" -lt "$max" ]; do
    if busy; then started=1; idle=0; else idle=$((idle + 1)); fi
    # Work seen, then 5 quiet samples (15s). Never started after 40s: a slash
    # command or a no-op — settled too.
    [ "$started" = 1 ] && [ "$idle" -ge 5 ] && return 0
    [ "$started" = 0 ] && [ "$waited" -ge 40 ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  echo "[drive] TIMEOUT after ${max}s" >> "$LOG"
  return 1
}

say() {
  echo "[drive] >>> $1" >> "$LOG"
  tmux send-keys -t "$S" -l "$1"
  sleep 0.8
  tmux send-keys -t "$S" Enter
  settle "${2:-900}"
  echo "[drive] --- settled ($(date +%H:%M:%S))" >> "$LOG"
  tmux capture-pane -p -t "$S" | tail -20 >> "$LOG"
  sleep 3
}

# Let whatever is running now finish before typing anything.
settle 900
for p in "$@"; do say "$p"; done
echo "[drive] DONE" >> "$LOG"
