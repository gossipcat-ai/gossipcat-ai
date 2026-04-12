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

  // Severity-scaled adaptive epsilon-greedy exploration.
  //
  // Two dimensions control epsilon:
  //   1. Signal starvation of below-median candidates (how much do they need data?)
  //   2. Finding severity (how expensive is a bad cross-review?)
  //
  // Signal-based epsilon (how starved are below-median candidates?):
  //   - Any candidate has <10 cross-review signals in 30 days → starvation=0.30
  //   - All candidates have 10-50 signals → starvation=0.15
  //   - All candidates have >50 signals → starvation=0.05
  //
  // Severity scaling (how much accuracy risk can we tolerate?):
  //   - critical → sevScale=0.15  (explore minimally — accuracy paramount)
  //   - high     → sevScale=0.35
  //   - medium   → sevScale=0.70
  //   - low      → sevScale=1.00  (explore freely — cheapest place to learn)
  //
  // Final epsilon = starvation * sevScale
  // Example: signal-starved (0.30) + critical finding (0.15) → epsilon=0.045
  // Example: signal-starved (0.30) + low finding (1.00) → epsilon=0.30
  //
  // This addresses three v3.1 review findings:
  //   - 30% epsilon on critical findings was too aggressive (haiku-researcher)
  //   - Exploration should happen where error cost is lowest (haiku-researcher)
  //   - getRecentCrossReviewCount is new — must be added to PerformanceReader (sonnet-reviewer)
  //
  // NOTE: adaptive epsilon mitigates selection bias, not washout directly.
  // Agents that regressed after falling out of selection (stale scores) are
  // caught by the 30-day signal expiry in readSignals() — their old scores
  // decay toward neutral, increasing their chance of re-entering the below-
  // median pool and getting explored.
  const belowMedian = scoredCandidates.filter(c =>
    c.score <= medianScore(scoredCandidates) && !topK.includes(c)
  )
  if (belowMedian.length === 0) { /* no candidates to explore — skip */ }
  else {
    const minSignals = Math.min(...belowMedian.map(c =>
      performanceReader.getRecentCrossReviewCount(c.agent.agentId, 30)
    ))
    const starvation = minSignals < 10 ? 0.30
                     : minSignals > 50 ? 0.05
                     : 0.15
    const sevScale = finding.severity === 'critical' ? 0.15
                   : finding.severity === 'high'     ? 0.35
                   : finding.severity === 'low'      ? 1.00
                   : 0.70  // medium (default)
    const epsilon = starvation * sevScale

    if (topK.length === K && Math.random() < epsilon) {
      // Weight toward the most signal-starved candidate
      const weights = belowMedian.map(c => {
        const signals = performanceReader.getRecentCrossReviewCount(c.agent.agentId, 30)
        return 1 / (1 + signals)  // inverse signal count — fewer signals = higher weight
      })
      const totalWeight = weights.reduce((a, b) => a + b, 0)
      let r = Math.random() * totalWeight
      let pick = belowMedian[0]
      for (let i = 0; i < belowMedian.length; i++) {
        r -= weights[i]
        if (r <= 0) { pick = belowMedian[i]; break }
      }
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
| Matthew effect / signal starvation | Severity-scaled adaptive epsilon: `starvation * sevScale`. Starvation: 30%/<10 signals, 15%/10-50, 5%/>50. Severity: critical=0.15, high=0.35, medium=0.70, low=1.00. Weighted toward most-starved candidate. Critical findings get ~4.5% max epsilon; low findings get full 30%. |

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
entries instead of 7. Adaptive epsilon-greedy exploration compensates by giving
signal-starved agents higher exploration rates (up to 30% for agents with <10
recent signals). Net effect:

- **Strong agents (acc > 0.6):** signal volume drops ~30% (still sufficient);
  epsilon drops to 5% when all below-median agents are well-established
- **Mid-tier agents (0.3-0.6):** signal volume drops ~40-60%; exploration
  provides a floor that scales with signal starvation
- **Weak agents (acc < 0.3):** mostly excluded by score, but new weak agents
  get 30% epsilon rate until they accumulate 10+ signals — prevents the
  3-month washout period identified in v2 review
- **New agents (0 signals):** highest exploration priority via inverse-signal
  weighting — the system actively seeks signal data for unknowns

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
- Severity-scaled adaptive epsilon-greedy exploration
- Add `getRecentCrossReviewCount(agentId, days)` to `PerformanceReader` (~10 LOC)
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
- [ ] Selection: severity-scaled epsilon (starvation * sevScale) produces correct rates
- [ ] Selection: critical findings get ~4.5% max epsilon, low findings get ~30%
- [ ] Selection: inverse-signal weighting biases toward most-starved candidate
- [ ] Selection: new agent with 0 signals gets highest exploration weight
- [ ] Selection: belowMedian.length === 0 skips exploration entirely (no Infinity smell)
- [ ] PerformanceReader.getRecentCrossReviewCount returns correct counts within 30d window
- [ ] Batching: `Map<agentId, Set<findingId>>` grouping correct
- [ ] K table: critical=3, high/medium/low=2
- [ ] Partial-K: 1 eligible → partialReview flag set
- [ ] Zero eligible: Phase 2 skipped, partialReview flag set, warning logged
- [ ] Low-quality warning when top-K all < 0.3
- [ ] Synthesize produces identical output regardless of reviewer identity
- [ ] Run existing 865+ consensus-engine tests (no regressions)
