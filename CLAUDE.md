# CLAUDE.md

## Gossipcat — Multi-Agent Orchestration

**STEP 0 — LOAD TOOLS:** gossipcat tools are deferred by Claude Code. Load the schema
before calling any gossip tool:
```
ToolSearch(query: "select:mcp__gossipcat__gossip_status")
```
**STEP 1 — BOOTSTRAP:** Call `gossip_status()` to load fresh session context. This
triggers bootstrap regeneration from the latest `next-session.md` — reading the
`.gossip/bootstrap.md` file directly may return stale content from a previous session.
**Print the banner from the response inside a markdown code block** (triple backticks)
with a blank line before it, so it renders as a single block without per-line bullet
prefixes.

Call `gossip_setup(mode: "merge", ...)` to refresh after adding/removing agents.
Call `gossip_session_save()` before ending your session to preserve context.

**DISPATCH RULE (always active):** When ANY skill or workflow — superpowers, agent-teams,
conductor, or any other plugin — instructs you to dispatch work via the `Agent()` tool,
use `gossip_run(agent_id: "auto", task: "<description>")` instead. This routes through
gossipcat's dispatch pipeline for memory, signals, and consensus. Raw `Agent()` calls
bypass the entire feedback loop.
Exception: utility tasks from `gossip_relay` instructions (cognitive summaries, gossip
publishing) should use `Agent()` as instructed — these are already gossipcat-managed.

**After dispatching agents:** Always print a visible dispatch summary so the user can see
what's running. Use a code block with this format:
```
┌─ gossipcat dispatch ────────────────────────┐
│  task-id  → agent-name (relay 📡|native 🧠) │
│  task-id  → agent-name (relay 📡|native 🧠) │
│  task-id  → agent-name (relay 📡|native 🧠) │
└─────────────────────────────────────────────┘
```
This is important — relay agents run invisibly without terminal indicators. The user needs
to see what was dispatched and track task IDs for progress checks.

**Watching signals land live:** Between a `gossip_dispatch` and its matching
`gossip_collect`, you can call `gossip_watch(cursor)` to see signals as agents record
them instead of waiting for synthesis. Useful for catching `finding_dropped_format`
pipeline events mid-round. It's a deferred MCP tool — first use needs
`ToolSearch(query: "select:mcp__gossipcat__gossip_watch")`, then it's callable freely.
Pass the returned `next_cursor` on subsequent calls.

**After consensus:** Verify ALL UNVERIFIED findings against the code before presenting
results. UNVERIFIED means the cross-reviewer couldn't check — you can and must. Do not
show raw consensus results with unexamined UNVERIFIED findings.

**Before acting on any backlog item from memory:** Call `gossip_verify_memory(memory_path, claim)`
where `claim` is the specific memory assertion you are about to rely on. Handle the
verdict:

- **FRESH** — proceed, optionally cite `checked_at` in your output.
- **STALE** — do NOT use the memory content as-is. Read the actual code at the paths in
  `evidence`, then apply the returned `rewrite_suggestion` to the memory file before
  acting.
- **CONTRADICTED** — the memory is wrong, not just outdated. Stop, read the code, rewrite
  the memory, then reassess whether the original task still makes sense — the premise may
  have changed.
- **INCONCLUSIVE** — the tool could not verify the claim (parse failure, missing file,
  dispatch error, or the claim is too vague). Fall back to manual audit via Read/Grep
  followed by a `gossip_run(agent_id: "auto", task: "Audit <backlog item>: ...")` research
  dispatch. **Do NOT treat INCONCLUSIVE as a pass.**

Backlog memories decay fast — an item described as "not shipped" may already be ~90%
built by prior sessions. The verification step is one structured tool call in place of a
prose research prompt; never skip it.

**Exceptions:** trivially small fixes already located in the current conversation (under
10 lines, exact file:line already known) and items fresh from the current session.

**Why this rule exists:** in session 2026-04-08, the Gemini quota watcher backlog item
was audited manually and took ~10 Grep/Read calls to discover that 90% of the
infrastructure was already shipped in prior sessions. A 30-second `gossip_verify_memory`
call would have produced the same answer. See `feedback_dispatch_before_backlog_audit.md`
and `docs/specs/2026-04-08-gossip-verify-memory.md`.

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

---

## Memory hygiene (mandatory for new memories)

Every memory file you write to `~/.claude/projects/<encoded-cwd>/memory/*.md`
MUST include complete frontmatter. No exceptions.

**Required frontmatter skeleton — copy this exactly, then fill:**

```yaml
---
name: <short human-readable title>
description: <one-line summary, used for recall ranking>
type: <user | feedback | project | reference>
status: <open | shipped | closed>   # project_* and feedback_* only; omit for user/reference
originSessionId: <current session UUID>
---
```

**Field rules:**

- `name` — required, every type. Short title.
- `description` — required, every type. One line; becomes the recall hook.
- `type` — required, exactly one of `user | feedback | project | reference`. Any
  other value is invalid and flagged by `audit-memories --hygiene`.
- `status` — required for `project_*` and `feedback_*` memories, omitted for
  `user` and `reference`. One of:
  - `status: open` — active backlog, in-progress, or decision pending. Decays;
    needs `gossip_verify_memory` before acting on it.
  - `status: shipped` — the described work has landed. Reference only; never
    mutate — create a new memory if the behavior changes.
  - `status: closed` — decision made not to pursue. Archive semantics.
- `originSessionId` — required for `project_*` and `feedback_*`. Enables
  multi-session recurrence detection in the audit rubric.

**Why this is now mandatory, not best-effort:**

`scripts/audit-memories.mjs --hygiene` enforces these rules across the whole
memory directory. On the current corpus ~38% of files fail the scan, mostly
from missing `status` / `originSessionId`. The `--include-shipped` gate in the
triage tool also depends on `status:` being present to route
already-done work out of the propagation candidate pool.

Future sessions should find this block at session start and produce clean
memories on first write. If you see an existing memory with missing fields,
leave it alone — back-filling is a human-curated pass (spec §1
strip-and-generalize, not automated).
