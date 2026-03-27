# Skill Discovery v2 — Design Spec

> Agents discover skill gaps → orchestrator generates skills → dispatch uses them → performance tracks per-skill accuracy.

**Date:** 2026-03-28
**Status:** Draft
**Supersedes:** 2026-03-21-skill-discovery-design.md
**Reviewed by:** sonnet-reviewer, haiku-researcher (consensus dispatch)

---

## Problem Statement

The skill discovery pipeline is 60% built but disconnected:

1. **Skeletons are useless** — `checkAndGenerate()` produces TODO templates no one fills
2. **SkillCatalog is blind to project skills** — only reads hardcoded `catalog.json`, ignores `.gossip/skills/`
3. **Dispatch can't use new skills** — `findBestMatchExcluding()` scores 0 for skills not in `agent.skills[]`
4. **Performance is skill-blind** — `AgentScore.accuracy` is global; an agent great at security but bad at implementation gets one number
5. **Existing bugs** — `generateSkeleton()` overwrites human edits, skill name `_` vs `-` causes silent misses, `MAX_SCAN_LINES=500` can miss resolutions

## Design Overview

```
Agent calls suggest_skill() during task
         ↓
Appends to .gossip/skill-gaps.jsonl
         ↓
gossip_collect() → checkAndGenerate() checks thresholds
         ↓
Threshold hit (3+ suggestions, 2+ agents)
         ↓
collect() response includes: "N skills ready to build"
         ↓
Claude Code calls gossip_build_skills()
         ↓
MCP tool returns gap data (suggestions, reasons, context)
Claude Code (Opus) generates skill .md content
MCP tool writes file + updates catalog
         ↓
SkillCatalog hot-reloads from .gossip/skills/
         ↓
Next dispatch: AgentRegistry uses new skill in matching
         ↓
Phase 2: per-skill performance scoring
```

---

## Phase 1: Skill Generation + Dispatch Integration

### 1.1 Skill File Format

Location: `.gossip/skills/{name}.md`

```markdown
---
name: dos-resilience
description: Review code for DoS vectors — unbounded payloads, missing rate limits, resource exhaustion, queue backpressure. Use when reviewing security, API endpoints, or worker patterns.
generated_by: orchestrator
sources: 3 suggestions from sonnet-reviewer, haiku-researcher
status: active
---

# DoS Resilience

## Approach
1. Check HTTP endpoints for payload size limits (body, query, headers)
2. Verify rate limiting on public-facing routes
3. Look for unbounded allocations (arrays, buffers, streams without limits)
4. Check queue/worker patterns for backpressure handling
5. Verify timeout configuration on external calls

## Output
For each finding: file:line, severity (critical/high/medium/low), specific remediation.

## Don't
- Flag internal-only endpoints without justification
- Suggest rate limits without considering the use case
- Report theoretical DoS on endpoints behind auth + rate limits
```

**Frontmatter fields:**
- `name` (string, kebab-case) — canonical skill identifier
- `description` (string) — doubles as trigger text for task matching (inspired by skills.sh)
- `generated_by` (string) — `"orchestrator"` or `"manual"`
- `sources` (string) — traceability to gap suggestions
- `status` (`"active"` | `"draft"` | `"disabled"`) — disabled skills skipped in matching

### 1.2 MCP Tool: `gossip_build_skills`

**Purpose:** Returns pending skill gaps with context. Claude Code generates the content and the tool writes the file.

**Input:** None (reads gap log internally)

**Behavior:**
1. Read `.gossip/skill-gaps.jsonl` for pending skills at threshold
2. For each pending skill, collect: all suggestions (agent, reason, task_context)
3. Return structured data to Claude Code:
   ```
   Skills ready to build: 2

   1. dos-resilience
      Suggestions:
      - sonnet-reviewer: "no maxPayload on WebSocket handler" (task: security review of relay)
      - haiku-researcher: "unbounded queue in dispatch pipeline" (task: architecture review)
      - sonnet-reviewer: "no rate limiting on public endpoints" (task: API review)

   2. memory-optimization
      ...

   Write each skill as a .md file with frontmatter (name, description, status: active)
   and body sections (Approach, Output, Don't).
   Then call gossip_build_skills_save(skills: [...]) to persist them.
   ```
4. Claude Code generates content, calls back with the files
5. Tool writes to `.gossip/skills/`, appends `GapResolution` to gap log, updates catalog

**Two-step design (build + save):**
- `gossip_build_skills` — read-only, returns gap data
- `gossip_build_skills_save` — writes the generated skill files

This keeps Claude Code in the loop — it sees the gap data, writes the content, and confirms.

### 1.3 Overwrite Protection

**Bug found by sonnet-reviewer:** `generateSkeleton()` uses `writeFileSync` with no guard — overwrites human-edited files.

**Fix:**
- Before writing, check if file exists
- If exists and `generated_by` in frontmatter is NOT `"orchestrator"`, skip (user edited it)
- If exists and `status` is `"active"`, skip (already built)
- Only overwrite files with `status: "draft"` (the old skeleton format)
- `gossip_build_skills_save` also checks: if file exists and was manually created, warn Claude Code instead of overwriting

### 1.4 Skill Name Normalization

**Bug found by sonnet-reviewer:** `_` vs `-` causes silent dispatch misses. `agent.skills.includes(s)` is exact match.

**Fix:** Canonical form is **kebab-case** everywhere.
- `SkillGapTracker`: normalize on write (`security_audit` → `security-audit`)
- `SkillCatalog`: normalize on load (both default and project)
- `AgentRegistry.findBestMatchExcluding()`: normalize both sides before comparison
- `gossip_setup`: normalize skills in config.json

Add a shared `normalizeSkillName(name: string): string` utility:
```typescript
export function normalizeSkillName(name: string): string {
  return name.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}
```

### 1.5 SkillCatalog: Merge Default + Project Skills

**Current:** `SkillCatalog` constructor loads only `catalog.json` from package source.

**Change:**
- Constructor takes optional `projectRoot` parameter
- On load: read `catalog.json` (default skills), then scan `.gossip/skills/*.md` (project skills)
- Parse frontmatter from `.md` files to extract `CatalogEntry` fields
- Project skills override defaults by name (more specific)
- Add `source: 'default' | 'project'` to `CatalogEntry`
- Hot-reload: check `.gossip/skills/` mtime on each `matchTask()` call (same pattern as `PerformanceReader`)

```typescript
interface CatalogEntry {
  name: string;
  description: string;
  keywords: string[];        // extracted from description for matching
  categories: string[];
  source: 'default' | 'project';
}
```

**Keyword extraction from description:** Split description on common delimiters, filter stop words, deduplicate. This avoids requiring a separate `keywords` field in frontmatter — the description IS the matching surface.

### 1.6 Dispatch Integration

**Current formula:** `score = skillOverlap × perfWeight`
**Problem:** New project skills score 0 because they're not in `agent.skills[]` yet.

**New formula:**
```
score = (staticOverlap + projectMatchBoost + suggesterBoost) × perfWeight
```

Where:
- `staticOverlap` = count of matching skills from `agent.skills[]` (existing behavior)
- `projectMatchBoost` = 0.5 for each project skill whose description matches the task text (via `SkillCatalog.matchTask()`)
- `suggesterBoost` = 0.3 if this agent suggested the skill (looked up from gap log, cached)
- `perfWeight` = existing 0.5-1.5 from `PerformanceReader`

**Key insight from sonnet-reviewer:** The boost MUST be additive, not multiplicative. `0 × anything = 0`, so a pure multiplicative approach can never surface agents for skills they don't formally have.

**Implementation in `AgentRegistry`:**
1. `findBestMatchExcluding()` receives optional `taskText` parameter
2. If `taskText` provided, call `SkillCatalog.matchTask(taskText)` to get project skill matches
3. For each matched project skill, add `projectMatchBoost` to agents whose description aligns
4. Check gap log cache for suggester bonus
5. Multiply total by `perfWeight`

**Pre-dispatch step in `DispatchPipeline.dispatch()`:**
- Before calling `findBestMatch`, run `SkillCatalog.matchTask(task)` to get candidate skills
- Pass both `requiredSkills` and `taskText` to registry

### 1.7 Collect Response: Skill-Ready Signal

**Bug found by sonnet-reviewer:** No `CollectResult.skillsReady` field exists.

**Fix:** Add to `CollectResult` type:
```typescript
interface CollectResult {
  // ... existing fields ...
  skillsReady?: number;  // count of skills at threshold, ready for gossip_build_skills
}
```

In `gossip_collect` MCP handler, after building the response, check `gapTracker.getPendingSkills().length` and append to the response text:
```
🔧 2 skills ready to build. Call gossip_build_skills() to generate them.
```

### 1.8 Gap Log Fixes

**Bug: `MAX_SCAN_LINES=500` misses resolutions**
- Change: scan ALL entries for resolutions (they're rare). Only limit suggestion scanning.
- Alternative: use a separate `.gossip/skill-resolutions.json` file (simple object: `{ [skillName]: timestamp }`). Fast lookup, no scanning needed.
- **Recommendation:** Separate resolutions file. Simpler, no scanning edge cases.

**Bug: `truncateIfNeeded()` only runs in `generateSkeleton()`**
- Add truncation check in `suggest_skill` tool path (SkillTools.suggestSkill)
- Or: run truncation in `checkAndGenerate()` unconditionally (before threshold check)

**Bug: `collect()` discards `getSuggestionsSince()` return value**
- Remove the dead call or wire it into the collect response for diagnostics

---

## Phase 2: Per-Skill Performance Scoring

### 2.1 Signal Schema

**Key finding by haiku-researcher:** `ConsensusSignal` already has an optional `skill?` field (consensus-types.ts:59). It's just never populated.

**Change:** When consensus-engine creates signals, extract skill context from the task:
1. Look up `taskId` → `TaskCreatedEvent.skills[]`
2. Set `signal.skill = matchedSkill` (the primary skill relevant to the finding)
3. If multiple skills match, pick the most specific (project > default)

**Where:** `ConsensusEngine.synthesize()` and `gossip_record_signals` MCP tool (for native agent synthesis).

### 2.2 PerformanceReader: Per-Skill Scores

```typescript
interface AgentScore {
  // ... existing global fields unchanged ...
  skillScores: Map<string, {
    accuracy: number;
    uniqueness: number;
    reliability: number;
    totalSignals: number;
  }>;
}
```

**In `computeScores()`:**
- For signals with `skill` field: update both global AND per-skill scores
- For signals without `skill` field: update global only (backward compatible)
- Per-skill `reliability = accuracy * 0.7 + uniqueness * 0.3` (same formula)

### 2.3 Dispatch Weight: Skill-Specific

New method:
```typescript
getSkillDispatchWeight(agentId: string, skill: string): number {
  const score = this.getAgentScore(agentId);
  if (!score) return 1.0;

  // Per-skill score if enough data (min 5 signals)
  const skillScore = score.skillScores?.get(skill);
  if (skillScore && skillScore.totalSignals >= 5) {
    return 0.5 + skillScore.reliability;
  }

  // Fall back to global (min 3 signals)
  if (score.totalSignals >= 3) {
    return 0.5 + score.reliability;
  }

  return 1.0; // cold start — neutral
}
```

**Integration in `AgentRegistry.findBestMatchExcluding()`:**
- For each matched skill, use `getSkillDispatchWeight(agentId, skill)` instead of global `getDispatchWeight(agentId)`
- Average across matched skills if multiple

### 2.4 Cold-Start Handling

| Scenario | Behavior |
|----------|----------|
| New skill, new agent | Neutral (1.0) |
| New skill, experienced agent | Global reliability as proxy |
| Established skill, new agent | Neutral until 5 per-skill signals |
| Established skill, experienced agent | Per-skill weight |

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `packages/orchestrator/src/skill-name.ts` | `normalizeSkillName()` utility |
| `packages/orchestrator/src/skill-parser.ts` | Parse frontmatter from `.gossip/skills/*.md` |

### Modified Files
| File | Changes |
|------|---------|
| `apps/cli/src/mcp-server-sdk.ts` | Add `gossip_build_skills` + `gossip_build_skills_save` MCP tools. Add `skillsReady` to collect response. |
| `packages/orchestrator/src/skill-catalog.ts` | Accept `projectRoot`, load project skills from `.gossip/skills/`, hot-reload, add `source` to `CatalogEntry` |
| `packages/orchestrator/src/skill-gap-tracker.ts` | Overwrite protection, separate resolutions file, normalize names, fix truncation |
| `packages/orchestrator/src/agent-registry.ts` | Accept `taskText` in `findBestMatchExcluding()`, add project match boost + suggester boost (additive) |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Pre-dispatch skill matching, pass taskText to registry, wire skillsReady into collect |
| `packages/orchestrator/src/performance-reader.ts` | Per-skill scores in `AgentScore`, `getSkillDispatchWeight()` method |
| `packages/orchestrator/src/consensus-engine.ts` | Populate `skill` field on signals during synthesis (Phase 2) |
| `packages/tools/src/skill-tools.ts` | Add truncation check on suggest_skill path |
| `packages/orchestrator/src/types.ts` | Update `CatalogEntry`, `CollectResult` types |

---

## Testing Strategy

### Phase 1
1. **Skill generation e2e**: suggest_skill 3x from 2 agents → collect → gossip_build_skills → verify .md written
2. **Overwrite protection**: generate skill, manually edit, re-trigger threshold → verify no overwrite
3. **Catalog merge**: default + project skills loaded, project overrides default by name
4. **Dispatch integration**: new project skill matches task text → agent selected despite not having skill in config
5. **Name normalization**: `security_audit` and `security-audit` treated as identical everywhere

### Phase 2
6. **Per-skill signals**: consensus round → signals have skill field populated
7. **Per-skill dispatch weight**: agent with high security accuracy preferred for security tasks
8. **Cold-start**: new skill defaults to global reliability, then transitions to per-skill after 5 signals

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Claude Code doesn't call `gossip_build_skills` | Clear message in collect response + rules file instruction |
| Skill content quality varies | User can edit .md files; `status: draft` until reviewed |
| Gap log grows unbounded | Truncation on suggest_skill path + separate resolutions file |
| Per-skill data too sparse | Fall back to global; min 5 signals before trusting per-skill |
| Name collisions (project vs default) | Project wins by convention; warn in logs |

---

## Out of Scope

- Remote skill registry / npm distribution (deferred)
- Automatic skill assignment to agents (manual via config for now; dispatch boost handles routing)
- Skill versioning / changelog
- Cross-project skill sharing
