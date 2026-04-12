---
status: proposal
---

# Orchestrator-Selected Cross-Review

**Date:** 2026-04-10 (v3: 2026-04-12)
**Status:** Spec (ready for implementation)
**Branch:** TBD
**Designed via:** 3-agent parallel review × 2 rounds + orchestrator synthesis
**Reviewed by:** sonnet-reviewer, haiku-researcher, gemini-reviewer

---

## Problem

The current 5-step consensus protocol requires ~15-20 orchestrator tool calls
per round, and every participating agent does Phase 2 regardless of whether
they're the best choice for cross-review. The MCP server cannot launch native
Agent() calls — only the host LLM can — making steps 2 and 4 fragile.

## Design

### Core idea

The orchestrator (server) picks the **best cross-reviewers per finding** based
on competency data — not every agent, and not by runtime. Phase 2 becomes a
server-side operation where the selection algorithm drives which agents
participate.

### Selection heuristic

```
For each finding in Phase 1 results:
  category = extractCategories(finding.content) ?? finding.declaredCategory
  candidates = allAgents
    .filter(a => a.agentId !== finding.originalAuthor)
    .filter(a => !performanceReader.isCircuitOpen(a.agentId))

  scoredCandidates = candidates.map(agent => ({
    agent,
    score: (agent.accuracy * 0.7) +
           ((agent.categoryAccuracy[category] ?? 0) * 0.3)
  }))

  K = (finding.severity === 'critical') ? 3 : 2
  eligible = scoredCandidates.filter(c => c.score > 0)
  topK = eligible.sortBy(score, desc).take(min(K, eligible.length))

  // Epsilon-greedy exploration: 15% chance of replacing the weakest
  // top-K slot with a random below-median agent. Prevents Matthew
  // effect where strong agents compound advantage and weak agents
  // starve of cross-review signal data.
  if (topK.length === K && Math.random() < 0.15) {
    const median = medianScore(scoredCandidates)
    const exploreCandidates = scoredCandidates.filter(c =>
      c.score <= median && !topK.includes(c)
    )
    if (exploreCandidates.length > 0) {
      const pick = exploreCandidates[randomInt(exploreCandidates.length)]
      topK[topK.length - 1] = pick  // replace weakest top-K slot
    }
  }

  reviewers[finding.id] = topK.map(c => c.agent)
```

**Key design decisions:**

| Issue | Resolution |
|-------|-----------|
| `categoryStrength` is unbounded | Use `categoryAccuracy[category]` — proper [0,1] ratio with MIN_CATEGORY_N=5 gate at `performance-reader.ts:510` |
| Category can be null (agent omitted attribute) | Server-side `extractCategories(finding.content)` as authoritative; fall back to agent-declared; if still null, drop the 0.3 term (compete on accuracy alone) |
| Circuit-open agents selected | Excluded via `!performanceReader.isCircuitOpen()` filter |
| Zero-category-expert scenario | Falls back to pure accuracy ranking when `categoryAccuracy[category]` is undefined for all candidates (the `?? 0` default handles this) |
| K per severity | critical=3, high/medium/low=2 |
| Fewer-than-K eligible | Use `min(K, eligible.length)`, minimum 1. If zero eligible → skip Phase 2 for this finding, tag as `partialReview: true` |
| Matthew effect / signal starvation | 15% epsilon-greedy exploration replaces the weakest top-K slot with a random below-median agent |

### Batching

Findings are assigned to reviewers per-finding, but reviewers see **all their
assigned findings in a single prompt** (existing `buildCrossReviewPrompt`
already bundles per-reviewer). `selectCrossReviewers` returns
`Map<agentId, Set<findingId>>` (reviewer → assigned findings), not a
per-finding dispatch.

With 5 findings and K=2, the naive per-finding approach would be 10 dispatches.
Batched by reviewer, it's at most `candidates.length` dispatches (typically 3-4),
same order as today.

### Degenerate cases

| Case | Behavior |
|------|----------|
| **1 eligible reviewer** | Proceed with K=1, tag report as `partialReview: true` |
| **0 eligible reviewers** (all circuit-open or all are the author) | Skip Phase 2 for this finding, tag as `partialReview: true`, log warning |
| **All top-K below accuracy 0.3** | Proceed with warning signal `low_quality_cross_review`, dashboard flags round for operator review |
| **Tool unavailable** (sandbox error, git unavailable) | Fall back to text-only review with warning signal recorded |

`partialReview: true` is semantically distinct from `consensus_verified: false`.
Partial means "we tried, fewer reviewers than intended." Unverified means "peers
couldn't check." The dashboard should display them differently.

### Enforcement

Phase 2 enforcement is **soft, not hard.** For relay-only rounds, Phase 2 runs
server-side automatically — the orchestrator calls `gossip_collect(consensus: true)`
and gets synthesized results. For rounds with native Phase 1 agents, the
orchestrator must still relay native results before Phase 2 can run. Missing
`gossip_relay` calls still silently abort Phase 2 (the enforcement asymmetry
from round `1537efbb`). The `session_save` refuse-gate (shipped `8d65825`) and
the auto-advance timeout (shipped `08c984e`) provide defense-in-depth but are
not true hard enforcement.

### Signal pipeline impact

Top-K selection reduces cross-review signal volume for non-selected agents.
At current portfolio (8 agents, K=2-3), each finding generates 2-3 cross-review
entries instead of 7. The 15% epsilon-greedy exploration partially compensates
by giving below-median agents occasional exposure. Net effect:

- **Strong agents (acc > 0.6):** signal volume drops ~30% (still sufficient)
- **Mid-tier agents (0.3-0.6):** signal volume drops ~60%; recovery is slower
  but not blocked (exploration provides a floor)
- **Weak agents (acc < 0.3):** mostly excluded except via exploration; this is
  **correct** — reducing their noise is the whole point

### Grounding

Citation verification at `consensus-engine.ts:724-744` is unchanged. Selection
uses pre-computed accuracy/categoryAccuracy scores (which are themselves grounded
in citation-verified signals). The reward loop remains: citation verification →
signal → score → selection → more citation verification. Selection introduces
**selection bias** (miscalibrated scores → wrong reviewers → errors go uncaught
longer) but does not break grounding. Dashboard should monitor per-agent/category
cross-review coverage to detect bias accumulation.

### Tool set for cross-review

All cross-reviewers — native or relay — get the same tool set via a callback
injection pattern (`verifierToolRunner` in `ConsensusEngineConfig`):

| Tool | Purpose |
|------|---------|
| `file_read` | Verify cited code exists at claimed line |
| `file_grep` | Search for identifiers in findings |
| `file_search` | Find related files when finding names a function but not a file |
| `memory_query` | Recall prior findings, prevent re-discovery |
| `git_log` | Verify "introduced in commit X" claims |

`MAX_VERIFIER_TURNS` = 7 (bumped from 6 for the expanded tool set).

The inline tool loop currently in `collect.ts:262-318` moves to
`consensus-engine.ts:crossReviewForAgent` via callback injection — the engine
calls `verifierToolRunner(agentId, messages)` and the CLI layer provides the
`FileTools`/`Sandbox` implementation. This keeps `consensus-engine.ts` free of
filesystem dependencies.

## Implementation plan

### Step 1: Tool loop port via callback injection (~120 LOC)

- Add `verifierToolRunner?: (agentId: string, messages: any[]) => Promise<any>`
  to `ConsensusEngineConfig`
- Move `file_read`/`file_grep`/`file_search`/`memory_query`/`git_log` tool loop
  from `collect.ts:262-318` into `crossReviewForAgent` (calls the callback
  when available, falls back to text-only when not)
- CLI layer provides the callback implementation backed by `FileTools`/`Sandbox`
- Bump `MAX_VERIFIER_TURNS` from 6 to 7

### Step 2: Cross-reviewer selection (~100 LOC)

- Add `selectCrossReviewers(findings, allAgents, performanceReader)` function
  returning `Map<agentId, Set<findingId>>`
- Uses `categoryAccuracy` (not `categoryStrength`), null-guards category,
  excludes circuit-open agents, applies K per severity table
- 15% epsilon-greedy exploration of below-median agents
- Server-side `extractCategories()` as authoritative category source

### Step 3: Default server-side Phase 2 (~50 LOC)

- `gossip_collect(consensus: true)` runs Phase 2 server-side via selected
  reviewers
- `partialReview: true` flag on report for findings with < K reviewers
- Two-phase block in `collect.ts:208-438` stays as error/native fallback

### Step 4: Update dispatch + docs (~30 LOC)

- `gossip_dispatch(mode: "consensus")` response: simplified 3-step protocol
  (Phase 2 is automatic)
- CLAUDE.md + HANDBOOK.md updated
- Selection heuristic documented with K table + exploration %

### Step 5: Dashboard + monitoring (~40 LOC)

- Per-round: show selection rationale ("gemini-tester chosen for data_integrity
  finding: accuracy=0.25, categoryAccuracy=0.6")
- Per-agent: cross-review coverage by category (detect selection bias)
- `partialReview` rounds flagged visually

## Test plan

- [ ] Tool loop port: all 5 tools work in crossReviewForAgent via callback
- [ ] Callback fallback: crossReviewForAgent works text-only when no callback
- [ ] Selection: top-K by `accuracy * 0.7 + categoryAccuracy * 0.3`
- [ ] Selection: circuit-open agents excluded
- [ ] Selection: original author excluded
- [ ] Selection: null category falls back to accuracy-only ranking
- [ ] Selection: epsilon-greedy fires ~15% of the time (statistical test)
- [ ] Batching: `Map<agentId, Set<findingId>>` grouping correct
- [ ] K table: critical=3, high/medium/low=2
- [ ] Partial-K: 1 eligible → partialReview flag set
- [ ] Zero eligible: Phase 2 skipped, partialReview flag set, warning logged
- [ ] Low-quality warning when top-K all < 0.3
- [ ] Synthesize produces identical output regardless of reviewer identity
- [ ] Run existing 865+ consensus-engine tests (no regressions)
