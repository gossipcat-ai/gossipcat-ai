#!/usr/bin/env bash
# gossipcat worktree sandbox hook (Layer 2 of issue #90).
#
# PreToolUse hook: denies Edit/Write/MultiEdit/NotebookEdit/Bash tool calls
# that target absolute paths outside the agent's worktree cwd. Cooperates with:
#   - Layer 1: SCOPE_NOTE prompt injection (apps/cli/src/sandbox.ts)
#   - Layer 3: post-hoc git porcelain audit (apps/cli/src/sandbox.ts)
#
# Only gates when cwd matches a gossipcat worktree namespace:
#   - .claude/worktrees/agent-*  (native subagent worktrees)
#   - /tmp/gossip-wt-*           (relay worktrees via WorktreeManager)
#   - /private/tmp/gossip-wt-*   (macOS resolves /tmp → /private/tmp)
#
# Exit 0 + JSON = allow/deny via harness protocol. Never exit 2.
#
# Fail-open behavior (intentional):
#   - jq missing → allow (hooks must not brick the agent on missing deps).
#   - jq parse failure or empty stdin → allow (malformed payloads are harness
#     bugs, not attacks; blocking legitimate tool calls on harness bugs is
#     worse than letting them through — Layer 1 and Layer 3 still apply).
#
# Path normalization:
#   - Use `realpath -m` when available (GNU/coreutils; accepts non-existent paths).
#   - Fall back to `python3 -c 'os.path.realpath(...)'` (macOS default realpath
#     doesn't support -m or requires existing paths on older releases).
#   - Fall back to pure-bash `..`-collapse if neither tool works.
#   - If ALL strategies fail for the cwd OR a given path, fail-secure deny.
#
# NOTE: we intentionally do NOT use `set -e` / `set -o pipefail` / `set -u`.
# A failing jq, an empty array expansion, or a grep-no-match would abort the
# hook with a non-zero exit and no JSON output — violating the
# "exit 0 + structured JSON" harness contract (issue #90 bypass 4).

log_warn() { printf '[gossipcat worktree-sandbox-hook] %s\n' "$*" >&2; }

emit_deny() {
  # $1 = reason string. Always exits 0 with structured JSON.
  local reason="$1"
  local json=""
  if command -v jq >/dev/null 2>&1; then
    json="$(jq -n --arg reason "$reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }' 2>/dev/null)"
  fi
  if [ -z "$json" ]; then
    # Hand-rolled JSON fallback. Escape backslashes and double quotes.
    local esc="$reason"
    esc="${esc//\\/\\\\}"
    esc="${esc//\"/\\\"}"
    # Also collapse newlines into literal \n so the JSON stays on one line.
    esc="${esc//$'\n'/\\n}"
    json="{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"${esc}\"}}"
  fi
  printf '%s\n' "$json"
  exit 0
}

# Normalize an absolute path. Echoes the normalized path on stdout, or nothing
# (and returns 1) on failure. Never writes to stderr on expected fallbacks.
normalize_path() {
  local p="$1"
  if [ -z "$p" ]; then
    return 1
  fi

  # Strategy 1: GNU realpath -m. Handles non-existent paths + .. segments.
  local out
  out="$(realpath -m -- "$p" 2>/dev/null)"
  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  # Strategy 2: python3 os.path.realpath. Portable on macOS without GNU realpath.
  # Do NOT pass `--` here: unlike realpath, python3 `-c SCRIPT ARGS...` puts
  # every subsequent token directly into sys.argv, so `--` would become
  # sys.argv[1] and the real path would be sys.argv[2]. That silently caused
  # every normalization to collapse to `<cwd>/--`, making unrelated paths
  # prefix-match each other.
  out="$(python3 -c 'import os,sys
print(os.path.realpath(sys.argv[1]))' "$p" 2>/dev/null)"
  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  # Strategy 3: pure-bash .. / . collapse. Does NOT resolve symlinks but at
  # least catches the common escape pattern of .. segments. Better than
  # nothing — still returns a usable canonical prefix.
  case "$p" in
    /*) ;;
    *) return 1 ;;  # pure-bash strategy only supports absolute inputs
  esac

  local result="/"
  local part
  local -a stack=()
  # Iterate components via read -d.
  local saved_ifs="$IFS"
  IFS='/'
  # shellcheck disable=SC2086
  set -f
  local parts
  # Read into positional params.
  # (Avoids associative array edge cases under bash 3.x on macOS.)
  set -- $p
  set +f
  IFS="$saved_ifs"
  for part in "$@"; do
    case "$part" in
      ''|'.') : ;;
      '..')
        if [ "${#stack[@]}" -gt 0 ]; then
          # Remove last element portably.
          unset "stack[$((${#stack[@]} - 1))]"
          # Re-compact the sparse array.
          if [ "${#stack[@]}" -gt 0 ]; then
            stack=("${stack[@]}")
          else
            stack=()
          fi
        fi
        ;;
      *) stack+=("$part") ;;
    esac
  done
  if [ "${#stack[@]}" -eq 0 ]; then
    printf '/'
    return 0
  fi
  for part in "${stack[@]}"; do
    result="${result%/}/${part}"
  done
  printf '%s' "$result"
  return 0
}

# Returns 0 if target (arg 2) is inside base (arg 1) or equal to it.
path_is_inside() {
  local base="$1"
  local target="$2"
  if [ "$target" = "$base" ]; then
    return 0
  fi
  case "$target" in
    "$base"/*) return 0 ;;
  esac
  return 1
}

# --- Main flow ---

if ! command -v jq >/dev/null 2>&1; then
  log_warn 'jq not found; skipping path gating (allow)'
  exit 0
fi

payload="$(cat)"

# Empty stdin → fail-open allow. Harness quirk, not an attack.
if [ -z "$payload" ]; then
  exit 0
fi

# Validate JSON. Invalid → fail-open allow with a stderr warning.
if ! printf '%s' "$payload" | jq -e . >/dev/null 2>&1; then
  log_warn 'invalid JSON payload; allowing'
  exit 0
fi

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)"

# Missing cwd → nothing to gate against → allow.
if [ -z "$cwd" ]; then
  exit 0
fi

# Distinguish orchestrator from subagent using $CLAUDE_PROJECT_DIR as anchor.
# The orchestrator runs with its project dir as cwd; subagents run inside a
# gossipcat worktree. We only gate subagents.
#
# When $CLAUDE_PROJECT_DIR is set and non-empty:
#   - Normalise it once.
#   - A cwd that matches <proj>/.claude/worktrees/agent-* or a relay worktree
#     path means we are in a subagent context → IS_SUBAGENT=1.
#   - Any other cwd (including the project root itself) → orchestrator → allow.
#
# When $CLAUDE_PROJECT_DIR is unset (old harness / tests without env):
#   - Fall back to glob-only match on well-known namespace patterns. This
#     preserves relay worktree coverage (/tmp/gossip-wt-*) on old harnesses.
IS_SUBAGENT=0
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  proj_norm="$(normalize_path "$CLAUDE_PROJECT_DIR")"
  if [ -n "$proj_norm" ]; then
    case "$cwd" in
      "${proj_norm}/.claude/worktrees/agent-"*) IS_SUBAGENT=1 ;;
      /tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
      /private/tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
    esac
  fi
  # Defense-in-depth: if the anchored match above did not flag it, still check
  # the glob fallback. This catches mismatched CLAUDE_PROJECT_DIR (e.g. a
  # harness bug or a spoofed env that points to the wrong project) while keeping
  # the known-safe relay worktree patterns gated unconditionally.
  if [ "$IS_SUBAGENT" -eq 0 ]; then
    case "$cwd" in
      */.claude/worktrees/agent-*) IS_SUBAGENT=1 ;;
      /tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
      /private/tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
    esac
  fi
else
  # Fallback: no CLAUDE_PROJECT_DIR env — use glob match only.
  case "$cwd" in
    */.claude/worktrees/agent-*) IS_SUBAGENT=1 ;;
    /tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
    /private/tmp/gossip-wt-*) IS_SUBAGENT=1 ;;
  esac
fi

# Orchestrator (or non-gossipcat cwd) → pass through without gating.
[ "$IS_SUBAGENT" -eq 0 ] && exit 0
# Subagent falls through to existing path-gating logic below (unchanged).

# Case-insensitive tool-name match (portable: no bash 4+ ${var,,}).
tool_name_lc="$(printf '%s' "$tool_name" | tr '[:upper:]' '[:lower:]')"

# Collect candidate absolute paths, one per line.
candidates=""

case "$tool_name_lc" in
  edit|write|notebookedit)
    cand="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    [ -n "$cand" ] && candidates="$cand"
    ;;
  multiedit)
    # Top-level file_path is the primary target. Also scan edits[].file_path
    # for defense in depth (old/new schema variants).
    top="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    [ -n "$top" ] && candidates="$top"
    edit_paths="$(printf '%s' "$payload" | jq -r '(.tool_input.edits // []) | .[]?.file_path // empty' 2>/dev/null)"
    if [ -n "$edit_paths" ]; then
      if [ -n "$candidates" ]; then
        candidates="${candidates}
${edit_paths}"
      else
        candidates="$edit_paths"
      fi
    fi
    ;;
  bash)
    # Extract EVERY absolute-path token from the command. The previous
    # version piped grep through `head -n1`, dropping all but the first
    # token — an attacker could hide an escape behind a safe prefix, e.g.
    #   cat /wt/safe && cp /wt/src /etc/x
    #
    # Broaden the pre-slash delimiter class to cover shell metacharacters:
    #   whitespace, =, >, <, ;, |, (, ), {, }, ,, &, `
    # Backtick matters: `x=`cat /wt/safe`/etc/passwd` encloses a command
    # substitution that returns a path, and the literal `/etc/passwd` after
    # the closing backtick is appended as a string. Without ` in the
    # delimiter class, grep would refuse to split at the backtick and the
    # absolute-path token `/etc/passwd` would be missed.
    cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    if [ -n "$cmd" ]; then
      candidates="$(printf '%s\n' "$cmd" \
        | grep -oE '(^|[[:space:]=><;\|(){},&`])/[^[:space:]"'"'"'`;\|><(){},&]+' 2>/dev/null \
        | sed -E -e 's/^[[:space:]=><;\|(){},&`]//')"
    fi
    ;;
  *)
    # Non-gated tool.
    exit 0
    ;;
esac

# Trim leading whitespace from each candidate BEFORE blank-line strip, then
# drop blank lines. Leading whitespace matters because:
#   1. An attacker could submit `{"file_path":" /etc/passwd"}` — jq extracts
#      the value verbatim, and a purely blank-line strip leaves a line whose
#      first character is a space, not `/`. The later `case [!/]*` match
#      would then mis-classify it as a relative path and allow it.
#   2. For Bash candidates the grep output already starts at the path, but
#      being defensive here costs nothing.
candidates="$(printf '%s' "$candidates" | sed -E 's/^[[:space:]]+//; /^[[:space:]]*$/d')"
if [ -z "$candidates" ]; then
  exit 0
fi

# Normalize cwd once. Unable to normalize → fail-secure deny.
cwd_norm="$(normalize_path "$cwd")"
if [ -z "$cwd_norm" ]; then
  emit_deny "BOUNDARY CHECK FAILED: unable to normalize cwd '${cwd}' (no realpath/python3 available). Refusing to gate without a canonical base."
fi

# Iterate over each candidate path. Deny on the first that escapes cwd.
while IFS= read -r path_arg; do
  [ -z "$path_arg" ] && continue

  # Relative → allow (Layer 1 handles the prompt side, Layer 3 audits porcelain).
  case "$path_arg" in
    ./*|[!/]*) continue ;;
  esac

  # Absolute path → normalize, then prefix-compare against cwd_norm.
  path_norm="$(normalize_path "$path_arg")"
  if [ -z "$path_norm" ]; then
    emit_deny "BOUNDARY CHECK FAILED: unable to normalize '${path_arg}' for ${tool_name}. Refusing to allow without a canonical form."
  fi

  # Allowlist: Claude Code auto-memory lives at ~/.claude/projects/*/memory/*.
  # These files are managed by the built-in memory system, not repo state.
  # Blocking them breaks memory-save flow when working inside a worktree.
  home_norm="$(normalize_path "$HOME")"
  if [ -n "$home_norm" ]; then
    case "$path_norm" in
      "${home_norm}/.claude/projects"/*/memory/*) continue ;;
    esac
  fi

  if ! path_is_inside "$cwd_norm" "$path_norm"; then
    emit_deny "BOUNDARY ESCAPE: ${tool_name} targets '${path_arg}' (normalized: '${path_norm}') outside worktree cwd '${cwd_norm}'. Use a relative path (./...) inside the worktree."
  fi
done <<EOF
$candidates
EOF

exit 0
