#!/usr/bin/env bash
# gossipcat discipline hook — PreToolUse finding_id validator for gossip_signals
#
# Reads stdin JSON: { tool_name, tool_input, ... }
# If action === "record" AND a consensus_id is present (directly or on any
# signal), warns on stderr for every signal missing finding_id.
#
# NEVER blocks — always exits 0.

set -euo pipefail

input="$(cat)"

# Only act on record actions
action="$(printf '%s' "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    print(ti.get('action', ''))
except Exception:
    print('')
" 2>/dev/null || true)"

if [ "$action" != "record" ]; then
  exit 0
fi

# Check if any consensus_id is present (top-level or on any signal)
has_consensus_id="$(printf '%s' "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    # Top-level consensus_id field
    if ti.get('consensus_id'):
        print('yes')
        sys.exit(0)
    # Any signal in signals[] has consensus_id
    for sig in ti.get('signals', []):
        if sig.get('consensus_id'):
            print('yes')
            sys.exit(0)
    print('no')
except Exception:
    print('no')
" 2>/dev/null || echo 'no')"

if [ "$has_consensus_id" != "yes" ]; then
  # Parallel-mode dispatch (no consensus_id) — no warning needed
  exit 0
fi

# Warn for each signal that lacks finding_id (python writes directly to fd 2)
printf '%s' "$input" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    ti = d.get('tool_input', {})
    signals = ti.get('signals', [])
    for i, sig in enumerate(signals):
        if not sig.get('finding_id'):
            print(f'[gossipcat] WARNING: signal #{i+1} is missing finding_id; consensus signals require it for dashboard back-trace', file=sys.stderr)
except Exception:
    pass
" || true

exit 0
