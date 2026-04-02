# Contextual Skill Injection

## Problem

All enabled skills are injected into every dispatch, regardless of task relevance. As agents accumulate skills over time (via `gossip_skills develop`), this creates:

1. **Token waste**: 5+ skills = 15-20KB of irrelevant prompt per dispatch
2. **Signal dilution**: Model attention spread across irrelevant instructions
3. **Conflicts**: Skills for different domains may give contradictory guidance
4. **Unbounded growth**: No mechanism to retire or scope skill injection

## Design

### Skill Modes

Each skill slot gets a `mode` field:

```typescript
interface SkillSlot {
  skill: string;
  enabled: boolean;
  source: 'config' | 'manual' | 'auto' | 'imported';
  version: number;
  boundAt: string;
  mode: 'permanent' | 'contextual';  // NEW
}
```

| Mode | Behavior | Default for |
|------|----------|-------------|
| `permanent` | Injected on every dispatch | Config-sourced skills (role skills like `code-review`, `typescript`) |
| `contextual` | Injected only when task matches activation keywords | Auto-developed skills (from `gossip_skills develop`) |

### Keyword Matching

Contextual skills activate based on keyword matching against the task description.

**Keywords source** (checked in priority order):
1. Skill frontmatter `keywords` field (explicit, highest priority)
2. Skill frontmatter `category` field (maps to a default keyword set)
3. Skill filename as fallback keyword

**Frontmatter example:**

```yaml
---
name: trust-boundary-validation
category: trust_boundaries
keywords: [auth, authentication, authorization, session, cookie, token, path traversal, symlink, injection, security]
mode: contextual
---
```

**Default keyword sets by category** (used when frontmatter has no explicit keywords):

| Category | Default keywords |
|----------|-----------------|
| `trust_boundaries` | auth, authentication, authorization, session, cookie, token, path, traversal, injection, middleware, permission, role, privilege, acl |
| `injection_vectors` | injection, xss, sql, sanitize, escape, template, eval, exec, html, uri, command |
| `input_validation` | validation, schema, zod, parse, sanitize, input, form, request, coerce, transform |
| `concurrency` | race condition, concurrent, mutex, lock, atomic, parallel, deadlock, semaphore |
| `resource_exhaustion` | memory, leak, unbounded, growth, limit, cap, timeout, pool, cache, backpressure, buffer, queue, throttle |
| `type_safety` | type guard, generic, cast, assertion, narrowing, discriminated, satisfies |
| `error_handling` | error handling, catch, throw, exception, retry, fallback, recovery, graceful |
| `data_integrity` | data integrity, migration, serialize, deserialize, corrupt, consistency, invariant, transaction, rollback, idempotent |

**Matching algorithm:**
- **Word-boundary matching** using `\b` regex (not substring) to prevent false positives
  (`auth` matches "auth middleware" but NOT "author" or "auto-disable")
- **Minimum 2 keyword hits** required to activate a contextual skill — single keyword
  matches are too noisy (e.g., `async` appears in nearly all TypeScript task descriptions)
- Multi-word keywords (e.g., "race condition", "type guard") match as phrases
- Case-insensitive
- No NLP/embedding required — deterministic and fast

### Token Budget

**Permanent skills are uncapped. Contextual skills have a separate budget.**

- **Max contextual skills per dispatch**: 3 (configurable via `MAX_CONTEXTUAL_SKILLS`)
- Permanent skills are always injected (they define the agent's role)
- Contextual skills sorted by keyword match count (more matches = higher relevance)
- If > 3 contextual skills qualify, lowest-relevance are dropped

**Why not a single budget?** A mature agent with 4 permanent skills would get at most
1 contextual slot under a combined cap — effectively disabling the contextual system.
Separate budgets ensure contextual skills always have room to activate.

**Return type change** — `loadSkills()` returns structured result:

```typescript
interface LoadSkillsResult {
  content: string;           // concatenated skill markdown (for prompt injection)
  loaded: string[];          // skills that were injected
  dropped: string[];         // contextual skills that matched but exceeded budget
  activatedContextual: string[]; // contextual skills that activated (for counter tracking)
}
```

This lets the dispatch pipeline track activations and surface dropped skills in logs.

### Changes to `loadSkills()`

Current signature:
```typescript
function loadSkills(agentId: string, skills: string[], projectRoot: string, index?: SkillIndex): string
```

New signature:
```typescript
function loadSkills(agentId: string, skills: string[], projectRoot: string, index?: SkillIndex, task?: string): LoadSkillsResult
```

Logic:
1. Resolve all enabled skills from index (or config fallback)
2. Partition into permanent and contextual (based on `mode` in slot or frontmatter)
3. Always include all permanent skills
4. For contextual: word-boundary match keywords against `task` string, require 2+ hits
5. Sort matched contextual by hit count (descending)
6. Apply contextual budget (max 3)
7. Return structured result

**loadSkills() remains read-only.** Counter tracking (activation counts, dispatch counts)
is handled by the caller (`dispatch-pipeline.ts`) using the returned `activatedContextual`
array. This preserves the function's pure read contract.

### Changes to Skill Generation

`gossip_skills(action: "develop")` changes:
- Generated skills get `mode: contextual` in frontmatter
- Generated skills get `keywords` array in frontmatter based on category defaults
- LLM prompt template updated to include `keywords` and `mode` fields
- `validateSkillContent()` updated to check for `keywords` in frontmatter
- `SkillIndex.bind()` stores `mode: 'contextual'` on the slot

### Changes to `SkillIndex`

- `bind()` accepts optional `mode` in options: `{ source?, enabled?, mode? }`
- Default mode: `'permanent'` for manual/config binds, `'contextual'` for auto binds
- `getEnabledSkills()` unchanged (returns all enabled — filtering happens in loadSkills)
- New method: `getSkillMode(agentId, skill): 'permanent' | 'contextual'`

### Changes to `skill-parser.ts`

- Add `category` and `mode` fields to `SkillFrontmatter` interface
- Parse both from YAML frontmatter (already parses `keywords`)

### Skill Lifecycle

**Counter storage:** Activation counters live in a separate file `.gossip/skill-counters.json`,
NOT in `skill-index.json`. This avoids per-dispatch writes to the index (which only writes
on bind/unbind/enable/disable). Counters are written once per `gossip_collect` call (batched),
not per dispatch.

```typescript
interface SkillCounters {
  [agentId: string]: {
    [skillName: string]: {
      totalDispatches: number;       // times the agent was dispatched
      activations: number;           // times this skill's keywords matched
      lastActivatedAt: string;       // ISO timestamp
      recentWindow: boolean[];       // circular buffer of last 20 dispatches (true=activated)
    }
  }
}
```

**Auto-disable stale contextual skills:**
- After 30 dispatches without activation (tracked via `totalDispatches - activations`
  since last activation), auto-disable with log
- Disabled skills can be re-enabled manually or re-developed
- Threshold configurable: `SKILL_STALE_THRESHOLD: 30`

**Promotion (rolling window):**
- Uses `recentWindow` circular buffer of last 20 dispatch outcomes (activated or not)
- If activation rate > 80% in the window AND window is full (20+ dispatches), promote
  to permanent
- Rolling window avoids survivorship bias from cumulative counts
- Threshold configurable: `SKILL_PROMOTION_RATE: 0.8`, `SKILL_PROMOTION_MIN_WINDOW: 20`

**Counter write strategy:**
- `dispatch-pipeline.ts` accumulates counter updates in memory during the session
- `gossip_collect` flushes counters to disk (batched write, not per-dispatch)
- On process crash, at most one session's counter data is lost — acceptable since
  counters are statistical, not transactional

### Migration

Existing skills get mode based on source:
- `source: 'config'` → `mode: 'permanent'`
- `source: 'manual'` → `mode: 'permanent'`
- `source: 'auto'` → `mode: 'contextual'`
- `source: 'imported'` → `mode: 'contextual'` if skill has `keywords` in frontmatter,
  `'permanent'` otherwise

No breaking changes — missing `mode` defaults to `'permanent'` (current behavior).

`seedFromConfigs()` updated to accept optional `mode` parameter per skill.

## Files to Modify

| File | Change |
|------|--------|
| `packages/orchestrator/src/skill-index.ts` | Add `mode` to SkillSlot, update bind(), add getSkillMode() |
| `packages/orchestrator/src/skill-loader.ts` | Add task parameter, implement word-boundary matching + budget, return structured result |
| `packages/orchestrator/src/skill-generator.ts` | Add keywords + mode to LLM prompt template, update validateSkillContent() |
| `packages/orchestrator/src/skill-parser.ts` | Add `category` and `mode` fields to SkillFrontmatter |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Pass task to loadSkills(), track counters in memory, flush on collect |
| `apps/cli/src/mcp-server-sdk.ts` | Pass mode to bind in develop action |
| `apps/cli/src/handlers/collect.ts` | Flush skill counters on collect |
| `tests/orchestrator/skill-loader.test.ts` | Test word-boundary matching, 2-hit minimum, budget, permanent vs contextual |
| `tests/orchestrator/skill-index.test.ts` | Test mode field, migration, promotion |

## Orchestrator Behavior

The main orchestrator (Claude Code session) interacts with the contextual skill system
at three points: skill development, dispatch-time awareness, and lifecycle management.

### When to develop skills

The orchestrator should develop skills when:

1. **`gossip_collect` reports auto-developed skills** — the system handled it automatically.
   Verify the generated skill makes sense; if not, unbind and re-develop manually.
2. **`gossip_scores()` shows accuracy < 0.3 for an agent** — check which categories are
   weak (visible in competency profiles), then develop skills for those categories.
3. **A hallucination is caught during verification** — if the error maps to a known
   category (e.g., agent missed a path traversal → `trust_boundaries`), develop immediately.

The orchestrator should NOT:
- Develop skills preemptively for categories that haven't failed yet
- Stack multiple skills in the same category for one agent (one per category is enough)
- Develop skills for agents that are already high-accuracy (> 0.7)

### Category selection guide

| Symptom | Category |
|---------|----------|
| Agent misses auth/permission issues | `trust_boundaries` |
| Agent misses XSS/SQL injection | `injection_vectors` |
| Agent doesn't validate external input | `input_validation` |
| Agent misses race conditions | `concurrency` |
| Agent misses unbounded growth/leaks | `resource_exhaustion` |
| Agent has wrong type assertions | `type_safety` |
| Agent misses error handling gaps | `error_handling` |
| Agent misses data corruption/schema issues | `data_integrity` |

### Dispatch-time behavior

The orchestrator does NOT manually select skills per dispatch. The system handles it:

1. Permanent skills are always injected (agent's role skills)
2. Contextual skills activate automatically based on task keywords
3. If the orchestrator notices a relevant contextual skill was NOT activated (visible
   in `LoadSkillsResult.dropped`), it can re-dispatch with more specific task wording
   that includes the skill's keywords

### Lifecycle management

At session end or during `gossip_scores()` review:

1. Check `gossip_skills(action: "list")` — look for contextual skills with low activation
2. If a skill was auto-disabled (stale), decide: re-develop with better keywords, or leave disabled
3. If a skill was auto-promoted to permanent, verify it belongs there — demote if the
   promotion was driven by false-positive keyword matches
4. Keep permanent skills to ≤ 3 per agent to leave room for contextual activation

## Agent Instructions

Agents receive skills as part of their prompt (injected between MEMORY and CONTEXT sections).
The following rules apply to how agents should interpret injected skills:

### Skill priority

1. **Agent instructions** (`instructions.md`) — highest priority, defines role and base rules
2. **Permanent skills** — always present, extends the agent's core capabilities
3. **Contextual skills** — task-specific, provides domain expertise for the current task

If a contextual skill contradicts the agent's base instructions, the instructions win.
If two contextual skills contradict each other (shouldn't happen with proper keyword
matching, but possible), the agent should follow the one most relevant to the task.

### What agents should do with skills

- Follow the skill's `## Methodology` section as a checklist
- Use the skill's `## Quality Gate` before submitting findings
- If a skill's `## When This Skill Activates` section doesn't match the current task,
  the agent should note this and skip the skill's methodology (false activation)

### What agents should NOT do

- Cite skill content as evidence (skills are instructions, not code)
- Apply a skill's rules to code outside the skill's domain
- Ignore their base instructions because a skill says otherwise

### Instruction updates needed

When this feature ships, update each agent's `instructions.md` to include:

```markdown
## Skills

You may receive contextual skills injected into your prompt. These provide domain-specific
methodology for the current task. Follow their ## Methodology as a checklist. If a skill
doesn't match your current task (false activation), skip it and focus on your base review.
```

This is a one-time addition, not per-skill.

## Non-Goals

- No LLM-based skill matching (too slow, adds latency to every dispatch)
- No dynamic skill generation at dispatch time
- No cross-agent skill sharing (each agent has its own skill slots)
- No skill versioning/rollback beyond the existing version counter
- No per-dispatch writes to skill-index.json (counters in separate file, flushed on collect)
