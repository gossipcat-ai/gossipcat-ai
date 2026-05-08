#!/usr/bin/env bash
# gossipcat discipline hook — PostToolUse signal-recording reminder for gossip_collect
#
# Reads stdin JSON: { tool_name, tool_input, tool_response, ... }
# If tool_input.consensus === true, outputs a strict-order reminder to stdout.
# Claude Code injects PostToolUse stdout as system context after the tool call.

set -euo pipefail

input="$(cat)"

is_consensus="$(printf '%s' "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    print('yes' if ti.get('consensus') == True else 'no')
except Exception:
    print('no')
" 2>/dev/null || echo 'no')"

if [ "$is_consensus" = "yes" ]; then
  echo "[gossipcat] EXECUTE NOW — record signals via gossip_signals before synthesizing or responding to user. Strict order: verify → signal → synthesize."
fi

exit 0
