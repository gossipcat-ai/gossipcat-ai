# DX Overhaul — Batch 2: Tool Consolidation (27 → 12)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate 27 MCP tools into 12 (8 core + 4 power-user). Hard cutover — no deprecation wrappers. Clean API for new users.

**Architecture:** All tools in `apps/cli/src/mcp-server-sdk.ts`. Strategy: extract handler logic into shared functions, delete old registrations, register new unified tools. MCP SDK throws on duplicate names so each tool name must appear exactly once.

**Tech Stack:** TypeScript, Zod schemas, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-31-dx-overhaul-design.md` (Batch 2)

---

## Strategy: Hard Cutover (Option B)

No deprecation wrappers. Old tool names are deleted, new names registered. This means:
- Existing bootstrap.md, dispatch rules, and memory references to old names break immediately
- All docs must be updated in the same commit
- Simpler code — no wrapper overhead, no dual registrations

## Tool Fate Map

| Old Tool(s) | → New Tool | Action |
|-------------|-----------|--------|
| `gossip_relay_result` + `gossip_run_complete` | `gossip_relay` | Extract shared handler, delete both, register new |
| `gossip_agents` + `gossip_status` | `gossip_status` | Combine outputs, delete `gossip_agents` |
| `gossip_record_signals` + `gossip_retract_signal` | `gossip_signals` | Unified with action param, delete both |
| 5 skill tools | `gossip_skills` | Unified with action param, delete all 5 |
| `gossip_dispatch` + `gossip_dispatch_parallel` + `gossip_dispatch_consensus` | `gossip_dispatch` | Unified with mode param, replace in-place |
| `gossip_collect` + `gossip_collect_consensus` | `gossip_collect` | Already has consensus param, delete `gossip_collect_consensus` |
| `gossip_run` + `gossip_orchestrate` | `gossip_run` | Add agent_id:"auto", delete `gossip_orchestrate` |
| `gossip_bootstrap` | *(removed)* | Delete — auto-called on boot |
| `gossip_update_instructions` | *(absorbed into gossip_setup)* | Delete — add mode to setup |
| `gossip_log_finding` + `gossip_findings` | *(removed)* | Delete entirely |
| `gossip_plan` | `gossip_plan` | Keep |
| `gossip_scores` | `gossip_scores` | Keep |
| `gossip_setup` | `gossip_setup` | Keep + extend |
| `gossip_session_save` | `gossip_session_save` | Keep |
| `gossip_tools` | `gossip_tools` | Keep, update listing |

---

### Task 1: Merge gossip_relay_result + gossip_run_complete → gossip_relay

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Extract shared handler**

Read both `gossip_relay_result` (lines 1682-1770) and `gossip_run_complete` (lines 1850-1924). They're nearly identical. Extract the handler body into:

```ts
async function handleNativeRelay(task_id: string, result: string, error?: string): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // ... shared handler body from gossip_relay_result ...
}
```

- [ ] **Step 2: Delete both old registrations, register gossip_relay**

Delete the `server.tool('gossip_relay_result', ...)` and `server.tool('gossip_run_complete', ...)` blocks. Register:

```ts
server.tool(
  'gossip_relay',
  'Feed a native agent result back into gossipcat. Call after Agent() completes a dispatched task.',
  {
    task_id: z.string().describe('Task ID returned by dispatch'),
    result: z.string().describe('The agent output/result text'),
    error: z.string().optional().describe('Error message if the agent failed'),
  },
  async ({ task_id, result, error }) => handleNativeRelay(task_id, result, error)
);
```

- [ ] **Step 3: Update all NATIVE_DISPATCH instruction strings**

```bash
grep -n 'gossip_relay_result\|gossip_run_complete' apps/cli/src/mcp-server-sdk.ts
```

Replace every occurrence in instruction text with `gossip_relay`. There are 4 sites:
- `gossip_dispatch` single native path (~line 877)
- `gossip_dispatch_parallel` native path (~line 963)
- `gossip_dispatch_consensus` native path (~line 1211)
- `gossip_run` native path (~line 1817)

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "refactor: merge gossip_relay_result + gossip_run_complete into gossip_relay"
```

---

### Task 2: Merge gossip_agents + gossip_status → unified gossip_status

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Read both handlers**

`gossip_agents` (lines 1332-1371) and `gossip_status` (lines 1376-1395).

- [ ] **Step 2: Replace gossip_status handler with combined output**

Keep the `gossip_status` registration. Replace its handler to include both system status AND agent list. Delete the `gossip_agents` registration entirely.

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: merge gossip_agents into gossip_status"
```

---

### Task 3: Merge signals tools → gossip_signals

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Delete both old registrations, register gossip_signals**

Delete `gossip_record_signals` and `gossip_retract_signal`. Register unified tool with `action` param. Use `.superRefine()` for conditional validation:

```ts
server.tool(
  'gossip_signals',
  'Record or retract consensus performance signals.',
  {
    action: z.enum(['record', 'retract']).default('record'),
    // record params
    task_id: z.string().optional(),
    signals: z.array(z.object({
      signal: z.enum(['agreement', 'disagreement', 'unique_confirmed', 'unique_unconfirmed', 'new_finding', 'hallucination_caught']),
      agent_id: z.string(),
      counterpart_id: z.string().optional(),
      finding: z.string(),
      evidence: z.string().optional(),
    })).optional(),
    // retract params
    agent_id: z.string().optional(),
    reason: z.string().optional(),
  },
  async (params) => {
    await boot();
    if (params.action === 'retract') {
      if (!params.agent_id || !params.task_id || !params.reason) {
        return { content: [{ type: 'text' as const, text: 'Error: retract requires agent_id, task_id, and reason' }] };
      }
      // ... retract handler logic ...
    } else {
      if (!params.signals || params.signals.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: record requires signals array' }] };
      }
      // ... record handler logic ...
    }
  }
);
```

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor: merge gossip_record_signals + gossip_retract_signal into gossip_signals"
```

---

### Task 4: Merge 5 skill tools → gossip_skills

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Delete all 5 old registrations**

Delete: `gossip_build_skills`, `gossip_develop_skill`, `gossip_skill_index`, `gossip_skill_bind`, `gossip_skill_unbind`.

- [ ] **Step 2: Register gossip_skills with action param**

```ts
server.tool(
  'gossip_skills',
  'Manage agent skills. Actions: list, bind, unbind, build, develop.',
  {
    action: z.enum(['list', 'bind', 'unbind', 'build', 'develop']),
    agent_id: z.string().optional(),
    skill: z.string().optional(),
    enabled: z.boolean().optional(),
    category: z.string().optional(),
    skill_names: z.array(z.string()).optional(),
    skills: z.array(z.object({ name: z.string(), content: z.string() })).optional(),
  },
  async (params) => {
    await boot();
    switch (params.action) {
      case 'list': // ... gossip_skill_index body ...
      case 'bind': {
        if (!params.agent_id || !params.skill) return { content: [{ type: 'text' as const, text: 'Error: bind requires agent_id and skill' }] };
        // ... gossip_skill_bind body ...
      }
      case 'unbind': {
        if (!params.agent_id || !params.skill) return { content: [{ type: 'text' as const, text: 'Error: unbind requires agent_id and skill' }] };
        // ... gossip_skill_unbind body ...
      }
      case 'build': // ... gossip_build_skills body ...
      case 'develop': {
        if (!params.agent_id || !params.category) return { content: [{ type: 'text' as const, text: 'Error: develop requires agent_id and category' }] };
        // ... gossip_develop_skill body ...
      }
    }
  }
);
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: merge 5 skill tools into gossip_skills with action param"
```

---

### Task 5: Unify gossip_dispatch with mode param

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

This is the riskiest task. The existing `gossip_dispatch` registration is replaced in-place with the unified version.

- [ ] **Step 1: Extract handler functions**

Extract the handler bodies from all three dispatch tools into named functions:
- `handleDispatchSingle(params)` — from `gossip_dispatch`
- `handleDispatchParallel(params)` — from `gossip_dispatch_parallel`
- `handleDispatchConsensus(params)` — from `gossip_dispatch_consensus`

- [ ] **Step 2: Delete gossip_dispatch_parallel and gossip_dispatch_consensus registrations**

- [ ] **Step 3: Replace gossip_dispatch with unified handler**

```ts
server.tool(
  'gossip_dispatch',
  'Dispatch tasks to agents. Modes: single (one agent), parallel (fan out), consensus (parallel + cross-review).',
  {
    mode: z.enum(['single', 'parallel', 'consensus']).default('single'),
    // single mode
    agent_id: z.string().optional().describe('Agent ID (required for single mode)'),
    task: z.string().optional().describe('Task (required for single mode)'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
    scope: z.string().optional(),
    timeout_ms: z.number().optional(),
    plan_id: z.string().optional(),
    step: z.number().optional(),
    // parallel/consensus mode
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
      write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
      scope: z.string().optional(),
    })).optional().describe('Task array (required for parallel/consensus)'),
  },
  async (params) => {
    await boot();
    await syncWorkersViaKeychain();
    switch (params.mode) {
      case 'single': {
        if (!params.agent_id || !params.task) {
          return { content: [{ type: 'text' as const, text: 'Error: single mode requires agent_id and task' }] };
        }
        return handleDispatchSingle(params);
      }
      case 'parallel': {
        if (!params.tasks?.length) {
          return { content: [{ type: 'text' as const, text: 'Error: parallel mode requires tasks array' }] };
        }
        return handleDispatchParallel(params.tasks, false);
      }
      case 'consensus': {
        if (!params.tasks?.length) {
          return { content: [{ type: 'text' as const, text: 'Error: consensus mode requires tasks array' }] };
        }
        return handleDispatchConsensus(params.tasks);
      }
    }
  }
);
```

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: unify gossip_dispatch with mode param (single/parallel/consensus)"
```

---

### Task 6: Merge collect + absorb orchestrate

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Delete gossip_collect_consensus**

`gossip_collect` already has `consensus: boolean` param. Delete `gossip_collect_consensus` registration. Ensure `gossip_collect`'s consensus path includes skill gap suggestions (port from `gossip_collect_consensus` if missing).

Add runtime validation: when `consensus: true`, require explicit `task_ids` (reject empty array):

```ts
if (consensus && (!task_ids || task_ids.length === 0)) {
  return { content: [{ type: 'text' as const, text: 'Error: consensus mode requires explicit task_ids' }] };
}
```

- [ ] **Step 2: Add agent_id:"auto" to gossip_run**

In `gossip_run`'s handler, add an early check before the native/relay branch:

```ts
if (agent_id === 'auto') {
  const result = await mainAgent.handleMessage(task, { mode: 'decompose' });
  return { content: [{ type: 'text' as const, text: result }] };
}
```

Update gossip_run's description to mention the auto option.

- [ ] **Step 3: Delete gossip_orchestrate**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: merge gossip_collect_consensus, absorb gossip_orchestrate into gossip_run"
```

---

### Task 7: Absorb update_instructions + remove dead tools

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Extend gossip_setup with update_instructions mode**

Add `'update_instructions'` to the mode enum. Add optional params `instruction_agent_ids`, `instruction_update`, `instruction_mode` for the update path. When `mode: 'update_instructions'`, run the logic from `gossip_update_instructions`.

- [ ] **Step 2: Delete gossip_update_instructions**

- [ ] **Step 3: Delete gossip_bootstrap**

- [ ] **Step 4: Delete gossip_log_finding and gossip_findings**

- [ ] **Step 5: Fix dead reference in gossip_session_save**

Find line ~2502:
```ts
output += '\n\n---\nNext session: gossip_bootstrap() will load this context automatically.';
```
Replace with:
```ts
output += '\n\n---\nNext session: bootstrap context will load automatically on MCP connect.';
```

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor: absorb update_instructions into setup, remove bootstrap/log_finding/findings"
```

---

### Task 8: Update gossip_tools, bootstrap, and dispatch rules

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts` (gossip_tools listing)
- Modify: `packages/orchestrator/src/bootstrap.ts` (tool table)
- Modify: `.claude/rules/gossipcat.md` (dispatch rules)
- Modify: `CLAUDE.md` (remove gossip_bootstrap reference if present)

- [ ] **Step 1: Rewrite gossip_tools listing**

Replace the hardcoded array with the 12 new tools:

```ts
const tools = [
  { name: 'gossip_run', desc: 'Run a task on one agent. Use agent_id: "auto" for auto-decompose.' },
  { name: 'gossip_dispatch', desc: 'Dispatch tasks. Modes: single, parallel, consensus.' },
  { name: 'gossip_collect', desc: 'Collect results. Use consensus: true for cross-review.' },
  { name: 'gossip_relay', desc: 'Feed native Agent() result back into gossipcat.' },
  { name: 'gossip_signals', desc: 'Record or retract consensus performance signals.' },
  { name: 'gossip_status', desc: 'Show system status and configured agents.' },
  { name: 'gossip_setup', desc: 'Create/update team configuration or update agent instructions.' },
  { name: 'gossip_session_save', desc: 'Save session summary for next session context.' },
  { name: 'gossip_plan', desc: 'Plan task with write-mode suggestions.' },
  { name: 'gossip_scores', desc: 'View agent performance scores and dispatch weights.' },
  { name: 'gossip_skills', desc: 'Manage agent skills: list, bind, unbind, build, develop.' },
  { name: 'gossip_tools', desc: 'List available tools (this command).' },
];
```

- [ ] **Step 2: Update bootstrap.ts tool table**

Read `packages/orchestrator/src/bootstrap.ts`, find `renderTeamPrompt()`, update the tool table to list only the 12 new tools.

- [ ] **Step 3: Rewrite .claude/rules/gossipcat.md**

Full narrative rewrite:
- Subagent Override: reference `gossip_relay` (not `gossip_relay_result`/`gossip_run_complete`)
- Dispatch patterns: use `gossip_dispatch(mode: ...)` syntax
- Consensus workflow: `gossip_dispatch(mode: "consensus")` + `gossip_collect(consensus: true)`
- Signal recording: reference `gossip_signals` (not `gossip_record_signals`)

- [ ] **Step 4: Update CLAUDE.md if needed**

Remove any references to `gossip_bootstrap()`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts packages/orchestrator/src/bootstrap.ts .claude/rules/gossipcat.md CLAUDE.md
git commit -m "docs: update tool listing, bootstrap, and dispatch rules for 12-tool API"
```

---

### Task 9: Rebuild MCP bundle and verify

- [ ] **Step 1: Build**

```bash
npm run build --workspaces 2>&1 | grep -v 'error TS'
npm run build:mcp
```

- [ ] **Step 2: Verify 12 new tools registered**

```bash
for tool in gossip_run gossip_dispatch gossip_collect gossip_relay gossip_signals gossip_status gossip_setup gossip_session_save gossip_plan gossip_scores gossip_skills gossip_tools; do
  count=$(grep -c "'$tool'" dist-mcp/mcp-server.js)
  echo "$tool: $count"
done
```

- [ ] **Step 3: Verify old tools removed**

```bash
for tool in gossip_orchestrate gossip_dispatch_parallel gossip_dispatch_consensus gossip_collect_consensus gossip_relay_result gossip_run_complete gossip_record_signals gossip_retract_signal gossip_agents gossip_update_instructions gossip_bootstrap gossip_log_finding gossip_findings gossip_skill_index gossip_skill_bind gossip_skill_unbind gossip_build_skills gossip_develop_skill; do
  count=$(grep -c "server.tool.*'$tool'" dist-mcp/mcp-server.js 2>/dev/null || echo 0)
  echo "$tool: $count (should be 0)"
done
```

- [ ] **Step 4: Commit bundle**

```bash
git add dist-mcp/mcp-server.js
git commit -m "build: rebuild MCP bundle with 12-tool API surface"
```
