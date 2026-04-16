#!/usr/bin/env bash
# gossipcat worktree sandbox hook (Layer 2 of issue #90).
#
# PreToolUse hook: denies Edit/Write/Bash tool calls that target absolute
# paths outside the agent's worktree cwd. Cooperates with:
#   - Layer 1: SCOPE_NOTE prompt injection (apps/cli/src/sandbox.ts)
#   - Layer 3: post-hoc git porcelain audit (apps/cli/src/sandbox.ts)
#
# Only gates when cwd matches a gossipcat worktree namespace:
#   - .claude/worktrees/agent-*  (native subagent worktrees)
#   - /tmp/gossip-wt-*           (relay worktrees via WorktreeManager)
#   - /private/tmp/gossip-wt-*   (macOS resolves /tmp → /private/tmp)
#
# Exit 0 + JSON = allow/deny via harness protocol. Never exit 2.
# Degrades to allow (log warning) if jq is missing — hooks must not brick
# the agent on missing deps.
set -euo pipefail

log_warn() { printf '[gossipcat worktree-sandbox-hook] %s\n' "$*" >&2; }

if ! command -v jq >/dev/null 2>&1; then
  log_warn 'jq not found; skipping path gating (allow)'
  exit 0
fi

payload="$(cat)"
tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

# Only gate gossipcat-owned worktrees. Any other cwd → allow.
case "$cwd" in
  */.claude/worktrees/agent-*) ;;
  /tmp/gossip-wt-*) ;;
  /private/tmp/gossip-wt-*) ;;
  *) exit 0 ;;
esac

# Extract the candidate path token based on tool.
path_arg=""
case "$tool_name" in
  Edit|Write)
    path_arg="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"
    ;;
  Bash)
    # Scan the command for absolute path tokens. First absolute token wins.
    # `|| true` keeps pipefail from tripping when grep finds no match.
    cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
    # shellcheck disable=SC2001
    path_arg="$(printf '%s\n' "$cmd" | { grep -oE '(^|[[:space:]=])/[^[:space:]"'"'"'`]+' || true; } | head -n1 | sed -e 's/^[[:space:]=]//')"
    ;;
  *)
    exit 0
    ;;
esac

# Empty or relative → allow (Layer 1 covers prompt-side, Layer 3 audits).
case "$path_arg" in
  ''|./*|[!/]*) exit 0 ;;
esac

# Absolute path. Allow only if inside the worktree cwd.
case "$path_arg" in
  "$cwd"|"$cwd"/*) exit 0 ;;
esac

# Deny with structured JSON.
reason="BOUNDARY ESCAPE: ${tool_name} targets '${path_arg}' outside worktree cwd '${cwd}'. Use a relative path (./...) inside the worktree."
jq -n --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
exit 0
