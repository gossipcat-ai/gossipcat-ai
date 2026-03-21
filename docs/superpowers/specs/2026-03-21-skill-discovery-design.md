# Skill Discovery System — Design Spec

> Agents learn what skills they're missing, the orchestrator tracks gaps, and the system generates skeleton skills when patterns emerge.

**Date:** 2026-03-21
**Status:** Draft
**Motivation:** Phase 1 security review missed 19 vulnerabilities because (1) the security_audit skill had no DoS/resource exhaustion checklist, (2) agents couldn't report skill gaps, (3) the orchestrator couldn't detect unmatched skills at dispatch time, and (4) new Claude Code sessions didn't know WHEN to use multi-agent dispatch.

---

## Problem Statement

Three failures exposed by the Phase 1 security review:

1. **Blind spots in skill content** — The `security-audit.md` skill covers OWASP Top 10 but omits DoS, resource exhaustion, backpressure, WebSocket-specific attacks, and resource cleanup. Agents followed their checklist faithfully — the checklist was incomplete.

2. **No skill discovery** — When an agent encounters code patterns outside its skill set (e.g., WebSocket DoS vectors), it has no mechanism to report the gap. The insight dies with the task.

3. **No workflow guidance** — The setup wizard generates rules teaching HOW to dispatch (`gossip_dispatch_parallel`) but not WHEN to use multi-agent vs single-agent. New sessions default to single-agent patterns.

## Design Overview

Six components, no architectural changes:

```
┌─────────────────────────────────────────────────────────────┐
│                     DISPATCH TIME                           │
│                                                             │
│  TaskDispatcher                                             │
│    ├── Decompose task → extract requiredSkills              │
│    ├── Check catalog.json → match skills to known skills    │
│    ├── Check agent registry → any agent have this skill?    │
│    ├── Read gap log → threshold check for skeleton gen      │
│    └── Warn: "dos_resilience exists but no agent has it"    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                    EXECUTION TIME                           │
│                                                             │
│  WorkerAgent                                                │
│    ├── Execute task with injected skills                    │
│    ├── Notices gap → calls suggest_skill tool               │
│    ├── Tool logs to .gossip/skill-gaps.jsonl                │
│    └── Worker keeps working (non-blocking)                  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                   POST-TASK                                 │
│                                                             │
│  Orchestrator                                               │
│    ├── Surfaces skill suggestions in task result            │
│    ├── Gap log reaches threshold (3x, 2+ agents)           │
│    ├── Generate skeleton → .gossip/skills/<name>.md         │
│    └── User reviews, edits, assigns to agents manually     │
└─────────────────────────────────────────────────────────────┘
```

## Component 1: `suggest_skill` Tool

A new tool in the tool-server that workers call mid-task when they notice a skill gap.

### Interface

```typescript
{
  name: "suggest_skill",
  description: "Suggest a skill that would help with the current task. Non-blocking — logs the suggestion and you keep working.",
  args: {
    skill_name: string,      // e.g. "dos_resilience"
    reason: string,          // why the agent thinks it needs this
    task_context: string     // what it was doing when it noticed the gap
  }
}
```

### Behavior

- Returns immediately: `"Suggestion noted: 'dos_resilience'. Continue with your current skills."`
- Appends to `.gossip/skill-gaps.jsonl`:

```jsonl
{"skill":"dos_resilience","reason":"WebSocket server has no maxPayload or connection rate limiting","agent":"gemini-reviewer","task_id":"abc123","timestamp":"2026-03-21T14:30:00Z"}
```

- Worker continues working — this is advisory, non-blocking
- After task completes, orchestrator reads suggestions and includes them in the result

### Registration (Issue #1 fix)

The `suggest_skill` tool must be registered in **two places**:

1. **Tool definitions** — Add `SKILL_TOOLS` to `packages/tools/src/definitions.ts` and include in `ALL_TOOLS` export. This is what makes the LLM see the tool as callable:
```typescript
export const SKILL_TOOLS: ToolDefinition[] = [
  {
    name: 'suggest_skill',
    description: 'Suggest a skill that would help with the current task. Non-blocking — logs the suggestion and you keep working.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name (e.g. "dos_resilience")' },
        reason: { type: 'string', description: 'Why you need this skill' },
        task_context: { type: 'string', description: 'What you were doing when you noticed the gap' }
      },
      required: ['skill_name', 'reason', 'task_context']
    }
  }
];

export const ALL_TOOLS: ToolDefinition[] = [...FILE_TOOLS, ...SHELL_TOOLS, ...GIT_TOOLS, ...SKILL_TOOLS];
```

2. **Tool execution** — Add `SkillTools` class in `packages/tools/src/skill-tools.ts` and wire into `ToolServer.executeTool()` switch:
```typescript
case 'suggest_skill':
  return this.skillTools.suggestSkill(args as { skill_name: string; reason: string; task_context: string });
```

### Agent ID Propagation

The `suggest_skill` tool needs the calling agent's ID to log who made the suggestion. The ToolServer already receives the `envelope.sid` (sender ID) in `handleToolRequest`. Pass `envelope.sid` as an additional parameter to `executeTool` so `suggest_skill` can log it:

```typescript
// tool-server.ts handleToolRequest:
result = await this.executeTool(toolName, args, envelope.sid);

// executeTool signature:
async executeTool(name: string, args: Record<string, unknown>, callerId?: string): Promise<string>
```

### File Location

- New file: `packages/tools/src/skill-tools.ts` — `SkillTools` class with `suggestSkill()` method
- Edit: `packages/tools/src/definitions.ts` — Add `SKILL_TOOLS` to `ALL_TOOLS`
- Edit: `packages/tools/src/tool-server.ts` — Import SkillTools, add switch case, pass callerId
- Gap log location: `.gossip/skill-gaps.jsonl` (append-only, gitignored)

### Why JSONL

- Append-only — no need to parse-and-rewrite the whole file
- Easy to grep and filter
- No serialization overhead

**Concurrency note (Issue #4 fix):** JSONL append safety relies on the ToolServer being a single process that handles RPC requests sequentially. All `suggest_skill` calls go through the same ToolServer instance via relay RPC, so writes are serialized. If the architecture ever changes to multiple ToolServer instances, this must be revisited (e.g., file locking or per-instance log files).

## Component 2: Skill Catalog

A `catalog.json` in `packages/orchestrator/src/default-skills/` indexing all available skills with keywords for task matching.

### Format

```json
{
  "version": 1,
  "skills": [
    {
      "name": "security_audit",
      "description": "OWASP Top 10, injection, auth, secrets, path traversal, error leakage, DoS, resource exhaustion",
      "keywords": ["security", "vulnerability", "injection", "auth", "owasp", "secrets", "dos", "rate-limit"],
      "categories": ["review", "security"]
    },
    {
      "name": "dos_resilience",
      "description": "DoS vectors, rate limiting, resource exhaustion, backpressure, payload limits, connection caps",
      "keywords": ["dos", "rate-limit", "resource", "exhaustion", "websocket", "payload", "memory", "connection"],
      "categories": ["review", "security"]
    },
    {
      "name": "code_review",
      "description": "Bug finding, edge cases, naming, structure, error handling",
      "keywords": ["review", "bugs", "quality", "patterns", "logic"],
      "categories": ["review"]
    },
    {
      "name": "testing",
      "description": "AAA pattern, unit/integration/e2e, mocking, deterministic tests, behavior-focused",
      "keywords": ["test", "unit", "integration", "e2e", "mock", "coverage"],
      "categories": ["implementation", "testing"]
    },
    {
      "name": "typescript",
      "description": "Strict typing, interface-first, discriminated unions, readonly, type safety",
      "keywords": ["typescript", "types", "generics", "interfaces", "strict"],
      "categories": ["implementation"]
    },
    {
      "name": "implementation",
      "description": "TDD, small functions, error handling, test coverage, <300 line files",
      "keywords": ["implement", "build", "feature", "tdd", "code"],
      "categories": ["implementation"]
    },
    {
      "name": "debugging",
      "description": "Reproduce, isolate, hypothesize, test, fix, verify with regression tests",
      "keywords": ["debug", "bug", "error", "trace", "root-cause", "reproduce"],
      "categories": ["investigation"]
    },
    {
      "name": "research",
      "description": "Source prioritization, triangulation, conflicting info, gaps analysis, BLUF answers",
      "keywords": ["research", "docs", "compare", "analyze", "summarize"],
      "categories": ["investigation"]
    },
    {
      "name": "documentation",
      "description": "API docs, guides, ADRs, README, changelog, stale doc detection",
      "keywords": ["docs", "readme", "changelog", "adr", "guide"],
      "categories": ["documentation"]
    },
    {
      "name": "api_design",
      "description": "REST conventions, HTTP verbs, status codes, error shapes, pagination, versioning",
      "keywords": ["api", "rest", "endpoint", "http", "pagination", "versioning"],
      "categories": ["design"]
    },
    {
      "name": "system_design",
      "description": "Components, data flow, failure modes, trade-offs, scale, graceful degradation",
      "keywords": ["architecture", "design", "scale", "components", "trade-offs"],
      "categories": ["design"]
    }
  ]
}
```

### Orchestrator Usage — Two Integration Points (Issue #3 fix)

Catalog checks run at **two levels**, because `gossip_dispatch` bypasses TaskDispatcher entirely:

**A. High-level path (`gossip_orchestrate` → TaskDispatcher):**

1. TaskDispatcher decomposes task → extracts `requiredSkills` (existing behavior)
2. **New:** For each required skill, check if any registered agent has it via `registry.findBySkill()`
3. If no agent has it but `catalog.json` has it → warn: `"Skill 'dos_resilience' exists in catalog but no agent has it assigned. Add it to an agent's skills in gossip.agents.json."`
4. If no agent has it and catalog doesn't have it → warn: `"No skill found matching 'dos_resilience'. Consider creating one in .gossip/skills/."`

**B. Low-level path (`gossip_dispatch` / `gossip_dispatch_parallel` → MCP server):**

The MCP server already loads skills via `loadSkills(agent_id, projectRoot)`. Add a lightweight catalog check here:

```typescript
// In gossip_dispatch handler, after loadSkills:
const { checkSkillCoverage } = await import('./skill-catalog-check');
const warnings = checkSkillCoverage(agent_id, task, catalogPath);
// Prepend warnings to the task result when collected
if (warnings.length) {
  entry.skillWarnings = warnings;
}
```

This is a keyword-match heuristic (not LLM decomposition) — scan the task description for catalog keywords and warn if the assigned agent doesn't have the matching skill. Lightweight enough to run on every dispatch.

**New file:** `apps/cli/src/skill-catalog-check.ts` — reads `catalog.json`, matches task text against skill keywords, returns warnings for unmatched skills.

### Warning Output (Issue #2 fix)

Warnings surface in **two places**:

1. **DispatchPlan** — Add `warnings: string[]` field to the `DispatchPlan` interface in `packages/orchestrator/src/types.ts`:
```typescript
export interface DispatchPlan {
  originalTask: string;
  subTasks: SubTask[];
  strategy: 'single' | 'parallel' | 'sequential';
  warnings: string[];  // NEW: skill gap warnings from catalog check
}
```

2. **gossip_collect results** — When collecting task results, append any `skillWarnings` from the task entry:
```typescript
// In gossip_collect handler:
if (t.skillWarnings?.length) {
  resultText += `\n\n⚠️ Skill gaps detected:\n${t.skillWarnings.map(w => `  - ${w}`).join('\n')}`;
}
```

### Catalog Validation

On boot, the orchestrator cross-references:
- Every `.md` file in `default-skills/` should have a catalog entry
- Every catalog entry should have a corresponding `.md` file
- Mismatches logged as warnings (not errors — non-blocking)

## Component 3: Gap Log → Skeleton Skill Generation

The orchestrator tracks `suggest_skill` calls over time and generates skeleton skills when patterns emerge.

### Gap Tracking

- `.gossip/skill-gaps.jsonl` accumulates suggestions from all agents across all tasks
- On each `gossip_dispatch` or `gossip_orchestrate` call, the orchestrator scans the gap log

### JSONL Schema (Issue #5 fix)

Two entry types in the JSONL — suggestions and resolutions:

```typescript
/** A skill suggestion from a worker agent */
interface GapSuggestion {
  type: 'suggestion';
  skill: string;
  reason: string;
  agent: string;
  task_id: string;
  timestamp: string;
}

/** Marks a skill as resolved (skeleton generated) */
interface GapResolution {
  type: 'resolution';
  skill: string;
  skeleton_path: string;
  triggered_by: number;  // count of suggestions that triggered this
  timestamp: string;
}

type GapEntry = GapSuggestion | GapResolution;
```

When scanning the log, filter by `type: 'suggestion'` and exclude any skill that has a `type: 'resolution'` entry. This prevents re-generating skeletons for already-resolved gaps.

**Log size bound:** Only scan the last 500 lines of the JSONL. Older entries are unlikely to be relevant, and this prevents unbounded growth from slowing dispatch. If the file exceeds 5000 lines, truncate to the last 1000 on next write.

### Threshold Logic

```typescript
function shouldGenerateSkeleton(entries: GapEntry[], skillName: string): boolean {
  const resolved = entries.some(e => e.type === 'resolution' && e.skill === skillName);
  if (resolved) return false;

  const suggestions = entries.filter(e => e.type === 'suggestion' && e.skill === skillName);
  const uniqueAgents = new Set(suggestions.map(e => e.agent));
  return suggestions.length >= 3 && uniqueAgents.size >= 2;
}
```

**Why 3 suggestions from 2+ agents:** A single agent might hallucinate a skill need. Multiple agents independently suggesting the same skill = real gap. Three occurrences avoids acting on noise.

### Skeleton Template

```markdown
# {Skill Name}

> Auto-generated from {N} agent suggestions. REVIEW AND EDIT BEFORE ASSIGNING TO AGENTS.

## Suggested By
- {agent1}: "{reason1}"
- {agent2}: "{reason2}"
- {agent3}: "{reason3}"

## What You Do
[TODO: Define what this skill covers]

## Approach
[TODO: Fill in your checklist — use the reasons above as starting points]

## Output Format
[TODO: Define expected output structure]

## Don't
[TODO: Add anti-patterns to avoid]
```

### Placement and Safety

- Skeletons go to `.gossip/skills/` (project-level, not `default-skills/`)
- NOT LLM-generated — template only, with agent reasons quoted verbatim
- User must manually: (1) review and edit the skeleton, (2) add the skill name to an agent's `skills` array in `gossip.agents.json`
- No auto-assignment, no auto-injection into prompts
- After skeleton generation, append a `GapResolution` entry to the JSONL:
```jsonl
{"type":"resolution","skill":"dos_resilience","skeleton_path":".gossip/skills/dos-resilience.md","triggered_by":3,"timestamp":"2026-03-21T15:00:00Z"}
```
- Surface to user: `"Created draft skill 'dos_resilience' based on 3 agent suggestions. Review at .gossip/skills/dos-resilience.md before assigning to agents."`

### Filename Convention (Issue #6 fix)

Skill names use underscores internally (`dos_resilience`) — this matches `gossip.agents.json` skill arrays and catalog entries. Filenames use hyphens (`dos-resilience.md`) — this matches existing `default-skills/` convention.

The mapping rule: `skillName.replace(/_/g, '-') + '.md'`

This is already implemented in `skill-loader-bridge.ts` (underscore-to-hyphen normalization). The same function must be used in `skill-gap-tracker.ts` for skeleton filenames.

### File Location

- New file: `packages/orchestrator/src/skill-gap-tracker.ts`
- Reads/writes `.gossip/skill-gaps.jsonl`
- Generates skeletons to `.gossip/skills/`

## Component 4: Security Audit Skill — New Categories

Append four new categories to `packages/orchestrator/src/default-skills/security-audit.md`:

```markdown
9. **DoS / Resource exhaustion** — Are there payload size limits on all inputs?
   Connection caps? Rate limiting on endpoints and tool execution?
   Unbounded queues, maps, or arrays that grow without TTL-based cleanup?
10. **Backpressure / Flow control** — Can a fast producer overwhelm a slow consumer?
    Are there timeouts on all async operations? TTL enforcement on messages?
    What happens when a buffer fills up — does it drop, block, or crash?
11. **WebSocket / Network** — Origin validation on upgrade requests?
    Message size limits (maxPayload)? Auth verification on reconnect?
    Connection rate limiting? Presence/identity spoofing via forged sender IDs?
12. **Resource cleanup** — Are timers cleared on shutdown? Connections closed?
    Maps and caches pruned with TTL? What happens to in-flight tasks
    when a worker disconnects mid-execution?
```

These categories would have caught: S1 (no maxPayload), S2 (no connection rate limiting), S3 (auth spam), H11 (TTL not enforced), H12 (presence spoofing), H13 (tool rate limiting), S7 (unbounded task map).

## Component 5: Setup Wizard — Workflow Rules

Add a "When to Use Multi-Agent Dispatch" section to the generated `gossipcat.md` rules file in `apps/cli/src/setup-wizard.ts`.

### New Section (appended after existing dispatch rules)

```markdown
## When to Use Multi-Agent Dispatch (REQUIRED)

These tasks MUST use parallel multi-agent dispatch. Never use a single agent or Explore subagent.

| Task Type | Why Multi-Agent | Split Strategy |
|-----------|----------------|----------------|
| Security review | Different agents catch different vulnerability classes | Split by package |
| Code review | Cross-validation finds bugs single reviewers miss | Split by concern (logic, style, perf) |
| Bug investigation | Competing hypotheses tested in parallel | One agent per hypothesis |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension (scale, security, DX) |

### Single agent is fine for:
- Quick lookups ("what does function X do?")
- Simple implementation tasks
- Running tests
- File reads / grep searches

### Pattern:
\`\`\`
gossip_dispatch_parallel(tasks: [
  {agent_id: "<reviewer>", task: "Review packages/relay/ for <concern>"},
  {agent_id: "<tester>", task: "Review packages/tools/ for <concern>"}
])
Agent(model: "sonnet", prompt: "Review packages/orchestrator/ for <concern>", run_in_background: true)
\`\`\`
Then synthesize all results — cross-reference findings, deduplicate, resolve conflicts.
```

## Component 6: Suggestion Surfacing in Results (Issue #7 fix)

`WorkerAgent.executeTask()` returns `Promise<string>`. We don't change this signature — instead, the MCP server correlates suggestions after the task completes.

### Flow

1. Worker calls `suggest_skill` during task → ToolServer appends to `.gossip/skill-gaps.jsonl` with the `task_id`
2. The MCP server generates the `task_id` at dispatch time (already does this: `randomUUID().slice(0, 8)`)
3. The `task_id` must be passed to the worker so it can include it in `suggest_skill` calls. Add it to `executeTask`:

```typescript
// worker-agent.ts — pass taskId in the system prompt context:
async executeTask(task: string, context?: string, skillsContent?: string, taskId?: string): Promise<string> {
  // taskId is available to the LLM via context, and the suggest_skill tool
  // receives it as an implicit parameter injected by the ToolServer
}
```

**Simpler approach:** The ToolServer already knows the caller's agent ID from `envelope.sid`. The MCP server can query the gap log by agent ID + time range (task start → task end) instead of requiring `task_id` correlation:

```typescript
// In gossip_collect, after task completes:
const gapTracker = new SkillGapTracker(gapLogPath);
const suggestions = gapTracker.getSuggestionsSince(entry.agentId, entry.startedAt);
if (suggestions.length) {
  entry.result += `\n\n---\n⚠️ Skill gaps suggested by ${entry.agentId}:\n` +
    suggestions.map(s => `  - ${s.skill}: ${s.reason}`).join('\n');
}
```

This avoids changing the `executeTask` signature and keeps the worker unaware of task IDs.

## Component 7: Worker Agent — Skill Awareness

Update the worker system prompt in `packages/orchestrator/src/worker-agent.ts` to teach agents about `suggest_skill`.

### Updated System Prompt

```typescript
const systemPrompt = `You are a skilled developer agent. Complete the assigned task using the available tools.

If you encounter patterns or domains that your current skills don't cover adequately, call suggest_skill with the skill name and why you need it. This won't give you the skill now — it helps the system learn what skills are missing for future tasks.

Examples of when to suggest:
- You see WebSocket code but have no DoS/resilience checklist
- You see database queries but have no SQL optimization skill
- You see CI/CD config but have no deployment skill

Do not stop working to suggest skills. Note the gap, call suggest_skill, keep going with your best judgment.${skillsContent || ''}${context ? `\n\nContext:\n${context}` : ''}`;
```

## Files Changed/Created

| File | Action | Component |
|------|--------|-----------|
| `packages/tools/src/skill-tools.ts` | Create | SkillTools class with suggestSkill() |
| `packages/tools/src/definitions.ts` | Edit | Add SKILL_TOOLS to ALL_TOOLS |
| `packages/tools/src/tool-server.ts` | Edit | Import SkillTools, add switch case, pass callerId |
| `packages/orchestrator/src/default-skills/catalog.json` | Create | Skill catalog index |
| `packages/orchestrator/src/skill-gap-tracker.ts` | Create | Gap log reader, threshold check, skeleton gen |
| `packages/orchestrator/src/task-dispatcher.ts` | Edit | Catalog check in decompose(), warnings in DispatchPlan |
| `packages/orchestrator/src/types.ts` | Edit | Add `warnings: string[]` to DispatchPlan |
| `apps/cli/src/skill-catalog-check.ts` | Create | Lightweight keyword-match for low-level dispatch path |
| `apps/cli/src/mcp-server-sdk.ts` | Edit | Catalog check on dispatch, surface suggestions in collect |
| `packages/orchestrator/src/default-skills/security-audit.md` | Edit | Add 4 DoS/resource categories |
| `apps/cli/src/setup-wizard.ts` | Edit | Workflow rules section in generated gossipcat.md |
| `packages/orchestrator/src/worker-agent.ts` | Edit | Skill awareness in system prompt |
| `.gitignore` | Edit | Add `.gossip/skill-gaps.jsonl` |

## Security Constraints

- **No remote skill fetching** — all skills are local files only
- **No auto-injection** — skeleton skills require human review + manual assignment to agents in `gossip.agents.json`
- **No LLM-generated skill content** — skeletons use a fixed template with verbatim agent quotes only
- **Gap log is append-only** — JSONL format, gitignored, no execution of content
- **suggest_skill is fire-and-forget** — cannot modify agent behavior mid-task
- **Catalog is static** — read at dispatch time, not modifiable by agents

## Testing Strategy

- **suggest_skill tool:** Unit test — call tool, verify JSONL written with correct format
- **Catalog matching:** Unit test — given requiredSkills and catalog, verify correct warnings
- **Gap tracker threshold:** Unit test — given N entries, verify skeleton generated only at threshold
- **Skeleton generation:** Unit test — verify template output matches expected format
- **Integration:** Dispatch a task to an agent working on WebSocket code with no DoS skill → verify suggest_skill called → verify gap logged → after 3 suggestions verify skeleton generated
- **Setup wizard:** Snapshot test — verify generated gossipcat.md includes workflow rules section
