#!/usr/bin/env bash
# Prepare a bare deva container for the full-surface demo session.
# Idempotent: safe to re-run. Spec: docs/devlog/2026-07-24-full-surface-demo-session.org
# Playbook: docs/demo/full-surface-playbook.md
set -euo pipefail

KIT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$KIT_DIR/../.." && pwd)
WORKSPACE=/home/deva/projects/cctrace
GITHUB_URL=https://github.com/thevibeworks/cctrace.git

note() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }

[ "$HOME" = /home/deva ] || warn "HOME is $HOME, not /home/deva — is this a deva container?"

# 1. Demo workspace: a clone separate from the bind-mounted repo, so demo
#    commits and .cctrace traces never land in the real checkout.
if [ ! -d "$WORKSPACE/.git" ]; then
  note "cloning workspace -> $WORKSPACE"
  mkdir -p "$(dirname "$WORKSPACE")"
  git clone --quiet "$REPO_ROOT" "$WORKSPACE"
  git -C "$WORKSPACE" remote set-url origin "$GITHUB_URL"
else
  note "workspace exists: $WORKSPACE"
fi
# Demo commit identity — masked by construction, never the operator's.
git -C "$WORKSPACE" config user.name "cctrace demo"
git -C "$WORKSPACE" config user.email "demo@cctrace.dev"

# 2. cctrace compiled binary (the `-- --continue` act needs it; bun eats a
#    leading -- on source runs).
if ! command -v cctrace >/dev/null 2>&1; then
  note "installing cctrace from the workspace clone"
  (cd "$WORKSPACE" && bun install --frozen-lockfile && make install)
else
  note "cctrace present: $(cctrace --version)"
fi

# 3. Bare demo profile. Back up whatever the container already had, once.
mkdir -p ~/.claude
for f in CLAUDE.md settings.json; do
  if [ -f ~/.claude/$f ] && [ ! -f ~/.claude/$f.pre-demo.bak ]; then
    cp ~/.claude/$f ~/.claude/$f.pre-demo.bak
  fi
done
cp "$KIT_DIR/profile/claude-user.md" ~/.claude/CLAUDE.md
cp "$KIT_DIR/profile/settings.json" ~/.claude/settings.json
note "installed demo ~/.claude/CLAUDE.md + settings.json (originals: *.pre-demo.bak)"

# 4. The cctrace skill (real copy, no symlinks) — Act 4's self-referential beat.
mkdir -p ~/.claude/skills
rm -rf ~/.claude/skills/cctrace
cp -R "$REPO_ROOT/skills/cctrace" ~/.claude/skills/cctrace
note "installed ~/.claude/skills/cctrace"

# 5. Workspace MCP config: one stdio server + one remote HTTP server.
cp "$KIT_DIR/profile/mcp.json" "$WORKSPACE/.mcp.json"
note "installed $WORKSPACE/.mcp.json (everything: stdio, deepwiki: http)"

# 6. Warm the npx cache for the stdio server so session startup is quick.
#    (Act 3 has its own npm tunnel beat; this fetch happens before tracing.)
timeout 30 npx -y @modelcontextprotocol/server-everything </dev/null >/dev/null 2>&1 || true

# 7. Preflight probes.
note "claude: $(claude --version 2>&1 | head -1)"
DW=$(curl -s -o /dev/null -w '%{http_code}' -X POST https://mcp.deepwiki.com/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  --max-time 15 || true)
if [ "$DW" = 200 ]; then note "deepwiki mcp reachable (200)"; else warn "deepwiki mcp probe returned '$DW' — Act 4's http beat may fail"; fi

cat <<EOF

Ready. Launch the take:

  cd $WORKSPACE
  cctrace claude --intercept-host mcp.deepwiki.com --no-open

Then follow docs/demo/full-surface-playbook.md act by act.
EOF
