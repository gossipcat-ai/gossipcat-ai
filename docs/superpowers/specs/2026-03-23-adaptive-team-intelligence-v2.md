# Adaptive Team Intelligence — Design Spec v2

> When you dispatch parallel agents with overlapping skills, the orchestrator automatically differentiates them — each agent gets a unique focus lens so you get complementary coverage, not duplicate findings.

**Date:** 2026-03-23
**Status:** Ready for implementation (Tier 1+2 MVP)
**Supersedes:** `2026-03-21-adaptive-team-intelligence-design.md`
**Dependencies:** Skill Discovery System (shipped), TaskGraph + Supabase sync (shipped)
**Reviewed by:** 6-agent consensus (4 Gemini + 2 Claude Opus), findings consolidated

---

## What Changed from v1

| Issue | v1 | v2 | Source |
|-------|----|----|--------|
| Integration point | mcp-server-sdk.ts | dispatch-pipeline.ts | 5/5 agents |
| Lens injection | Custom format, two-pass rewrite | Existing `assemblePrompt({ lens })` + `DispatchOptions.lens` | Architect |
| performance-tracker.ts | Single file, 3 responsibilities | Split: agent-scorer.ts + performance-store.ts | Architect |
| Tier 1 scope | Detection + recommendations | Detection only (recs come from Tier 3) | Architect |
| MVP scope | All 3 tiers | Tier 1 (detect) + Tier 2 (lenses) only | 5/5 agents |
| Lens visibility | Invisible | Logged at dispatch time | Product |
| Scoring model | 3-axis cheap LLM | Deferred to Phase 2 (questionable with cheap models) | Architect + Product |
| Score data overlap | Separate from memory-writer | Must replace hardcoded {3,3,3} when Tier 3 ships | Product |
| JSONL versioning | None | `version: 1` field on all entries | Architect |
| Lens quality | No check | Semantic overlap guard before injection | Product |
| Outcome tracking | Phase 2 | Deferred (high risk, noisy heuristics) | 5/5 agents |

---

## Problem Statement

When multiple agents share the same skills, they produce duplicate perspectives. A reviewer and debugger both having `code_review` is complementary (different presets), but two reviewers with identical skills is wasteful. The orchestrator needs to:

1. **Detect** skill overlap within a team (Tier 1 — boot time)
2. **Differentiate** co-dispatched agents at runtime (Tier 2 — dispatch time)
3. **Optimize** skill distribution based on performance (Tier 3 — deferred)

## Design Overview — Three Tiers

```
┌─────────────────────────────────────────────────────────────┐
│  TIER 1: OVERLAP DETECTION (boot time)              MVP     │
│                                                             │
│  Analyze gossip.agents.json → detect same-preset overlap    │
│  → log advisory warnings (one-time, not repeated)           │
│  → no config changes, no recommendations                    │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  TIER 2: DYNAMIC LENS GENERATION (dispatch time)    MVP     │
│                                                             │
│  Co-dispatched agents with overlapping skills               │
│  → orchestrator generates unique "lens" per agent           │
│  → lens passed via DispatchOptions.lens                     │
│  → assemblePrompt({ lens }) handles formatting              │
│  → LOG applied lenses for transparency                      │
│  → graceful degradation on failure                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  TIER 3: EVOLUTIONARY RESHAPING (over time)      DEFERRED   │
│                                                             │
│  Score agent outputs → store in JSONL                       │
│  → after 20+ tasks, propose config changes                  │
│  → user approves → skills redistributed                     │
│  → DEFERRED: ships after Tier 1+2 prove value               │
└─────────────────────────────────────────────────────────────┘
```

**Approval model:** All config changes require user approval. Dynamic lenses (Tier 2) are runtime-only and don't modify config.

---

## Tier 1: Overlap Detection (MVP)

### Preset-Aware Overlap Analysis

Uses the existing `AgentConfig.preset` field from `gossip.agents.json`. Overlap is classified as:

- **REDUNDANT** — same preset, shared skills (e.g., two `reviewer` agents with `code_review`)
- **COMPLEMENTARY** — different presets, shared skills (e.g., `reviewer` + `debugger` with `code_review`)

```
              preset      code_review  security_audit  debugging  typescript
gemini-rev    reviewer       ✓              ✓             ✓          ✓
sonnet-dbg    debugger       ✓                            ✓
gemini-tst    tester                                      ✓          ✓

Same-preset overlaps: none → no action
Cross-preset overlaps: complementary → no action (but lenses apply at dispatch)
```

### Boot-Time Warning

On first dispatch only (not repeated), the orchestrator logs:

```
[gossipcat] Skill overlap: gemini-reviewer ∩ gpt-reviewer (both reviewers): code_review, security_audit
```

Advisory only. Suppressed when there are no overlaps, and shown at most once per boot to avoid warning fatigue.

### No Config Changes in Tier 1

v1 had Tier 1 proposing config changes after 20+ tasks. This is wrong — Tier 1 can only detect overlaps, not evaluate which agent is better. All recommendations require Tier 3 performance data. Tier 1 is detection only.

---

## Tier 2: Dynamic Lens Generation (MVP)

### When Lenses Apply

Lenses are generated when **two or more agents are co-dispatched for the same task** (via `dispatchParallel` or `gossip_orchestrate` decomposition) AND they share at least one skill.

**No lens needed:**
- Single agent dispatch
- Co-dispatched agents with zero skill overlap
- Agents already fully differentiated by preset + skills

### Lens Format

Uses the existing `assemblePrompt({ lens })` plumbing in `prompt-assembler.ts`:

```markdown
--- LENS ---
Your focus for this task: {generated focus directive}
While other agents may review the same code, your unique contribution is {differentiation}.
Prioritize depth over breadth in your focus area.
--- END LENS ---
```

This is already supported by `assemblePrompt` at line 28-30 of `prompt-assembler.ts`. No new format needed.

### Lens Generation

A lightweight LLM call (using the configured `utility_model` or falling back to `main_agent`) generates lenses for all co-dispatched agents in one call:

```typescript
interface LensAssignment {
  agentId: string;
  focus: string;
  avoidOverlap: string;
}

async function generateLenses(
  agents: Array<{ id: string; preset: string; skills: string[] }>,
  task: string,
  sharedSkills: string[]
): Promise<LensAssignment[]>;
```

**System prompt:**
```
You are assigning review focuses to {N} agents working on the same task.
Each agent should have a UNIQUE focus that avoids duplicating another's work.
Consider their presets and skills when assigning focus areas.

Agents: {agent list with presets and skills}
Task: {task description}
Shared skills: {overlapping skills}

Return JSON array of { agentId, focus, avoidOverlap } for each agent.
```

**Example output** for a security review dispatched to gemini-reviewer + gemini-tester:

| Agent | Preset | Lens Focus |
|-------|--------|------------|
| gemini-reviewer | reviewer | "Focus on vulnerability identification — injection, auth bypass, DoS vectors." |
| gemini-tester | tester | "Focus on security testing gaps — missing test coverage for auth edge cases, untested error paths." |

### Lens Quality Check

After generating lenses, verify they are actually differentiated. If two lenses share >50% of their non-stop-word tokens, log a warning and fall back to preset-based defaults:

```typescript
function areLensesDifferentiated(lenses: LensAssignment[]): boolean {
  // Compare each pair — if any pair shares >50% significant words, reject
}
```

### Lens Visibility

Lenses are logged at dispatch time for transparency and trust:

```
[gossipcat] Applied lenses:
  gemini-reviewer → vulnerability identification (injection, auth bypass, DoS)
  gemini-tester → security testing gaps (auth edge cases, untested error paths)
```

This builds user trust. Once trust is established, the log level can be reduced.

### Lens Cost

One utility model call per parallel dispatch. ~200 input tokens, ~150 output tokens. ~$0.0001 per dispatch.

### Integration Point

**File:** `packages/orchestrator/src/dispatch-pipeline.ts` — in `dispatchParallel()`

The integration uses the existing plumbing — no structural rewrite needed:

1. Before the dispatch loop, detect overlaps among co-dispatched agents
2. If overlaps exist, call `lensGenerator.generateLenses()` (single LLM call)
3. Store lenses in `Map<string, string>` keyed by agentId
4. Pass lens into each `dispatch()` call via `DispatchOptions.lens`
5. `dispatch()` passes `options.lens` to `assemblePrompt({ lens: options.lens })`

```typescript
// In dispatchParallel(), before the dispatch loop:
const overlapResult = this.overlapDetector?.detect(taskDefs.map(d => this.registryGet(d.agentId)!));
let lensMap: Map<string, string> | null = null;
if (overlapResult?.hasOverlaps && this.lensGenerator) {
  try {
    const lenses = await this.lensGenerator.generateLenses(
      overlapResult.agents, taskDefs[0]?.task, overlapResult.sharedSkills
    );
    lensMap = new Map(lenses.map(l => [l.agentId, l.focus]));
    log(`Applied lenses:\n${lenses.map(l => `  ${l.agentId} → ${l.focus.slice(0, 80)}`).join('\n')}`);
  } catch (err) {
    log(`Lens generation failed: ${(err as Error).message}. Dispatching without lenses.`);
  }
}

// In the dispatch loop:
for (const def of taskDefs) {
  const lens = lensMap?.get(def.agentId);
  const { taskId, promise } = this.dispatch(def.agentId, def.task, {
    ...def.options,
    lens,
  });
  // ...
}
```

And in `dispatch()`, line ~145:
```typescript
const promptContent = assemblePrompt({
  memory: memory || undefined,
  skills,
  lens: options?.lens,  // NEW — one line
  sessionContext: sessionContext || undefined,
  chainContext: chainContext || undefined,
});
```

### Graceful Degradation (from v1 Fix 3)

If lens generation fails (network error, rate limit, bad JSON):
- Log warning: `[gossipcat] Lens generation failed: {error}. Dispatching without lenses.`
- Dispatch all agents with normal skill content, no lenses
- Do NOT fail the parallel dispatch

---

## Tier 3: Evolutionary Reshaping (DEFERRED)

> This section documents the design for future implementation. Ship Tier 1+2 first and prove value before building Tier 3.

### Why Deferred

1. **Cold start problem:** Requires 20+ tasks before producing any recommendations. Users with fewer tasks see an empty feature.
2. **LLM-as-judge limitations:** A cheap model scoring expensive model outputs produces false precision. Three-axis scoring (relevance/accuracy/uniqueness) from haiku/flash will be highly correlated.
3. **Outcome tracking is noisy:** Git-commit correlation has estimated 40%+ false positive rate on busy codebases.
4. **Score data conflict:** Current codebase writes hardcoded `{relevance: 3, accuracy: 3, uniqueness: 3}` at `dispatch-pipeline.ts:319,560`. Tier 3 must replace these, not supplement them with a separate JSONL.

### Design (for future reference)

**Signal A — Orchestrator Judgment:** Post-collect LLM call scoring agent outputs. When implemented, should:
- Replace hardcoded {3,3,3} in memory-writer with actual scores
- Use `main_agent` model (not cheap), limited to uniqueness dimension only
- Be async fire-and-forget, never blocking collect
- Use a different provider than the majority of agents to avoid scoring bias

**Signal B — Outcome Tracking:** Correlate agent findings with git commits. When implemented:
- Trigger on `gossipcat reshape` invocation (not fire-and-forget — evidence appears days later)
- Tighten correlation: require commit message reference or line-range intersection
- Cap outcome signal weight vs judgment signals

**Recommendation Engine:** `gossipcat reshape` CLI command that analyzes performance data and proposes config changes. Requires user approval. Config backup before applying changes.

**Storage:**
- Local: `.gossip/agent-performance.jsonl` — append-only, scan last 500, truncate at 5000
- All entries include `version: 1` field for schema evolution
- Supabase: optional analytics sync (local is source of truth)

---

## Utility Model Configuration

Lens generation requires a cheap LLM call. Add an optional `utility_model` field to `gossip.agents.json`:

```json
{
  "main_agent": { "provider": "google", "model": "gemini-2.5-pro" },
  "utility_model": { "provider": "google", "model": "gemini-2.5-flash" },
  "agents": { ... }
}
```

If `utility_model` is not set, fall back to `main_agent`. The `LensGenerator` accepts an `ILLMProvider` via constructor injection.

**Construction path:** During `doBoot()` in `mcp-server-sdk.ts`, create the utility provider alongside the main agent provider. Pass it to `DispatchPipeline` config.

---

## Files Changed/Created

| File | Action | Component |
|------|--------|-----------|
| `packages/orchestrator/src/overlap-detector.ts` | Create | Preset-aware skill overlap analysis |
| `packages/orchestrator/src/lens-generator.ts` | Create | Dynamic lens generation via LLM |
| `packages/orchestrator/src/types.ts` | Modify | Add `LensAssignment`, `OverlapResult` types; add `lens` to `DispatchOptions` |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Modify | Wire overlap detection + lens generation into `dispatchParallel`, pass `lens` in `dispatch()` to `assemblePrompt` |
| `packages/orchestrator/src/index.ts` | Modify | Export new modules |
| `apps/cli/src/mcp-server-sdk.ts` | Modify | Create utility model provider in `doBoot()`, pass to pipeline config |
| `apps/cli/src/config.ts` | Modify | Parse `utility_model` from gossip.agents.json |
| `tests/orchestrator/overlap-detector.test.ts` | Create | Overlap classification tests |
| `tests/orchestrator/lens-generator.test.ts` | Create | Lens generation with mocked LLM |
| `tests/orchestrator/dispatch-pipeline-lens.test.ts` | Create | Integration: dispatch with lenses |

---

## Security Constraints

- **Lens generation is non-privileged** — lenses modify emphasis, not capabilities
- **Prompt injection in lens output** — use JSON mode/structured output for the generation call; validate output shape
- **No automated config changes** — Tier 1+2 are runtime-only; all config changes (Tier 3) require user approval

---

## Testing Strategy

### Overlap Detector (unit)

- Given agents with same preset + shared skills → classify as REDUNDANT
- Given agents with different presets + shared skills → classify as COMPLEMENTARY
- Given agents with no shared skills → no overlaps detected
- Given a single agent → no overlaps

### Lens Generator (unit, mocked LLM)

- Happy path: mock LLM returns valid JSON → correct `LensAssignment[]` returned
- LLM returns malformed JSON → graceful fallback, empty result, warning logged
- LLM call throws (network error) → graceful fallback, empty result, warning logged
- Verify prompt includes agent presets, skills, task, and shared skills
- Lens quality check: two identical lenses → rejected, fall back to defaults
- Lens quality check: two differentiated lenses → accepted

### Dispatch Pipeline Integration (unit, mocked)

- `dispatchParallel` with overlapping agents → lenses generated and passed via `DispatchOptions.lens`
- `dispatchParallel` with no overlaps → no lens generation call made
- `dispatch` with `options.lens` → `assemblePrompt` receives lens parameter
- Lens generation failure → dispatch proceeds without lenses, warning logged

### End-to-End (integration)

- Dispatch two overlapping agents → verify lenses appear in system prompts
- Dispatch two non-overlapping agents → verify no lens injection
- Single agent dispatch → no lens generation

---

## Reviewer Fixes Carried Forward from v1

### Fix 1: `preset` not `role` — Resolved (uses existing `AgentConfig.preset`)
### Fix 3: Lens failure graceful degradation — Incorporated into Tier 2 spec
### Fix 4: Prompt injection — Use JSON mode for lens generation call
### Fix 7: Config backup before reshape — Deferred with Tier 3
### Fix 8: JSONL concurrency — Deferred with Tier 3
### Fix 9: `gossipcat reshape` with 0 tasks — Deferred with Tier 3

### New from v2 review:

### Fix 12: Lens visibility logging
Lenses are logged at dispatch time for transparency. See Tier 2 "Lens Visibility" section.

### Fix 13: Use existing assemblePrompt plumbing
No custom lens format. Use `assemblePrompt({ lens })` which already exists at `prompt-assembler.ts:28-30`.

### Fix 14: Pass lens via DispatchOptions
Add `lens?: string` to `DispatchOptions`. No two-pass rewrite of `dispatchParallel` — use a pre-loop lens generation step and pass through existing `dispatch()`.

### Fix 15: Lens quality guard
Check for semantic overlap between generated lenses before injection. Fall back to preset-based defaults if lenses are too similar.

### Fix 16: Hardcoded score data
When Tier 3 ships, it MUST replace the `{ relevance: 3, accuracy: 3, uniqueness: 3 }` defaults at `dispatch-pipeline.ts:319,560` with actual scored values. Do not create a second score data source.

### Fix 17: Scoring model bias
When Tier 3 ships, use a different provider for scoring than the majority of agents, or limit scoring to the "uniqueness" dimension only.
