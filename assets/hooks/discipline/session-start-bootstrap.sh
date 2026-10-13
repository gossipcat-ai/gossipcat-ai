#!/usr/bin/env bash
# gossipcat discipline hook — SessionStart bootstrap reminder
#
# Outputs a system reminder to stdout telling the orchestrator to call
# gossip_status() if it has not yet bootstrapped. Claude Code injects
# stdout from SessionStart hooks as system context at conversation start.

cat <<'REMINDER'
[gossipcat] BOOTSTRAP REQUIRED — call gossip_status() before dispatching any agents or acting on backlog items. This loads your operator playbook, agent roster, dispatch rules, and signal pipeline state. Without it you are operating blind. If you have already called gossip_status() this session, ignore this message.
REMINDER

# Durable dashboard→Claude inbox: report queued dashboard messages (fenced as
# untrusted data) and, outside confirmed channel mode, tell the session to run
# `gossipcat inbox wait` in the background. Fail-open: a missing/older
# gossipcat binary or any error prints nothing and never blocks the session.
# Set GOSSIPCAT_INBOX_HOOK=0 to disable.
if [ "${GOSSIPCAT_INBOX_HOOK:-1}" != "0" ] && command -v gossipcat >/dev/null 2>&1; then
  gossipcat inbox session-start 2>/dev/null || true
fi
exit 0
