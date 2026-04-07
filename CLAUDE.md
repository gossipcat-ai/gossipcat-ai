# CLAUDE.md

## Gossipcat — Multi-Agent Orchestration

**FIRST:** Call `gossip_status()` to load fresh session context. This triggers bootstrap
regeneration from the latest `next-session.md` — reading the `.gossip/bootstrap.md` file
directly may return stale content from a previous session. **Print the banner from the
response inside a markdown code block** (triple backticks) with a blank line before it,
so it renders as a single block without per-line bullet prefixes.

Call `gossip_setup(mode: "merge", ...)` to refresh after adding/removing agents.
Call `gossip_session_save()` before ending your session to preserve context.

**After dispatching agents:** Always print a visible dispatch summary so the user can see
what's running. Use a code block with this format:
```
┌─ gossipcat dispatch ────────────────────────┐
│  task-id  → agent-name (relay|native)       │
│  task-id  → agent-name (relay|native)       │
│  task-id  → agent-name (relay|native)       │
└─────────────────────────────────────────────┘
```
This is important — relay agents run invisibly without terminal indicators. The user needs
to see what was dispatched and track task IDs for progress checks.

**After consensus:** Verify ALL UNVERIFIED findings against the code before presenting
results. UNVERIFIED means the cross-reviewer couldn't check — you can and must. Do not
show raw consensus results with unexamined UNVERIFIED findings.

**Resolving findings in the dashboard:** When you record ANY signal — not just
UNVERIFIED resolutions — you MUST include `finding_id`. The format is
`<consensus_id>:<finding_id>` (e.g., `b81956b2-e0fa4ea4:sonnet-reviewer:f1`).
This is the primary key that links signals back to specific findings in specific
consensus rounds. Without it, the signal pipeline is unauditable — you can see an
agent got penalized but can't trace which finding caused it.

```
gossip_signals(action: "record", signals: [{
  signal: "unique_confirmed",  // or "hallucination_caught", "agreement", etc.
  agent_id: "<who found it>",
  finding: "<description>",
  finding_id: "<consensus_id>:<agent:fN>"  // ← MANDATORY for all signals
}])
```

**Every signal needs a finding_id.** Signals without finding_id break back-search:
dashboard finding → signal → agent score adjustment becomes opaque.

## Agent Accuracy — Skill Development

When an agent has low accuracy or repeated hallucinations, **use the skill system, not
instruction edits.** Instructions (`.gossip/agents/<id>/instructions.md`) are the base
prompt — they set role and rules. Skills (`.gossip/agents/<id>/skills/*.md`) are
specialized knowledge injected per-dispatch based on the agent's actual failure patterns.

**How to improve a struggling agent:**
1. Check `gossip_scores()` to identify low-accuracy agents
2. Call `gossip_skills(action: "develop", agent_id: "<id>", category: "<category>")`
   - This generates an agent-specific skill file from their failure data
   - Categories: `trust_boundaries`, `injection_vectors`, `input_validation`,
     `concurrency`, `resource_exhaustion`, `type_safety`, `error_handling`, `data_integrity`
3. Bind if not auto-bound: `gossip_skills(action: "bind", agent_id: "<id>", skill: "<name>")`
4. Verify with `gossip_skills(action: "list")` — skill should show as enabled

**Skill resolution order:** agent-local → project-wide → bundled defaults.
Agent-local skills (from `develop`) override defaults with targeted improvements.

**Do NOT:** Edit `instructions.md` to fix accuracy. Instructions set the base contract.
Skills are the mechanism for targeted, evidence-based improvement.

---

## Scoped Agent Contract

When an agent is dispatched with `write_mode: "scoped"`:
- **Can:** `file_write`, `file_delete` (within scope), `file_read` (anywhere), `run_tests`, `run_typecheck`, `git status/diff/log/show`
- **Cannot:** `shell_exec` (except read-only git), `git_commit`, `git_branch`
- **Orchestrator commits** on behalf of scoped agents after verifying their output
- **Worktree agents** have full shell + git access within their isolated branch

This is intentional: scoped agents write files, the orchestrator validates and commits.
