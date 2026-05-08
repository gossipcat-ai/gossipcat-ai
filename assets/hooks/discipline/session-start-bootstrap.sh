#!/usr/bin/env bash
# gossipcat discipline hook — SessionStart bootstrap reminder
#
# Outputs a system reminder to stdout telling the orchestrator to call
# gossip_status() if it has not yet bootstrapped. Claude Code injects
# stdout from SessionStart hooks as system context at conversation start.

cat <<'REMINDER'
[gossipcat] BOOTSTRAP REQUIRED — call gossip_status() before dispatching any agents or acting on backlog items. This loads your operator playbook, agent roster, dispatch rules, and signal pipeline state. Without it you are operating blind. If you have already called gossip_status() this session, ignore this message.
REMINDER
