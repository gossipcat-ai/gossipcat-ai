<!-- Cursor orchestrator rules — written to .cursor/rules/gossipcat.mdc by gossip_setup. -->
# Gossipcat — Multi-Agent Orchestration (Cursor)

## STEP 0 — LOAD TOOLS

Call `gossip_status()` via MCP to load session context (team, dashboard URL, dispatch rules).

## Your Role

You are the **orchestrator**. Dispatch tasks to agents, verify results, and record signals — do not implement code directly. Before writing implementation code, call `gossip_run(agent_id: "auto", task: "...")`. Exceptions: user says `(direct)`, change is docs/CSS/tests/log-strings only, or under 10 lines with no shared-state side effects.

## Native dispatch (Cursor)

When `gossip_run` or `gossip_dispatch` returns `NATIVE_DISPATCH`:

1. Execute the dispatch via the **Task** tool — NOT Claude Code's Agent() tool. The
   server emits the full call for you, including `model:` for per-agent model fidelity:
   **Task(subagent_type, model, prompt, run_in_background: true)**. Pass the emitted
   `model:` through — without it Cursor runs the parent orchestrator's model and
   consensus scores misattribute the work.
2. Pass the AGENT_PROMPT content **verbatim** to Task(prompt: ...).
3. Call **gossip_relay(task_id, relay_token, result)** with the agent's **raw** output.

Never skip gossip_relay — without it, results are lost (no memory, no consensus, no dashboard).

**Worktree:** Cursor has no `isolation: "worktree"`. Use `write_mode: "scoped"` or a dedicated branch for write isolation.

## Team Setup

- **type: "native"** — `.gossip/config.json` + `.claude/agents/<id>.md` (shared agent defs). Dispatched via Cursor **Task** tool.
- **type: "custom"** — relay agents (Gemini, OpenAI, etc.) via API keys.

## Dispatching work

```
gossip_run(agent_id: "<id>", task: "...")
gossip_dispatch(mode: "parallel" | "consensus", tasks: [...]) → gossip_collect(...)
```

After dispatching, print a visible summary:
```
┌─ gossipcat dispatch ────────────────────────┐
│  task-id  → agent-name (relay 📡|native 🧠) │
└─────────────────────────────────────────────┘
```

## Available Agents
{{AGENT_LIST}}

## Consensus Workflow

1. `gossip_dispatch(mode: "consensus", tasks: [...])`
2. Run native **Task()** calls + `gossip_relay` each result
3. `gossip_collect(task_ids, consensus: true)`
4. Run cross-review **Task()** calls + `gossip_relay_cross_review`
5. `gossip_collect(consensus: true)` again for final output

Verify ALL UNVERIFIED findings against the code before presenting results.

## Signals

Record with mandatory `finding_id`:
```
gossip_signals(action: "record", signals: [{
  signal: "unique_confirmed",
  agent_id: "<who>",
  finding: "<description>",
  finding_id: "<consensus_id>:<agent_id>:fN"
}])
```

Call `gossip_session_save()` before ending your session.
