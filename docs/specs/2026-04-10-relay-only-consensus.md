# Orchestrator-Selected Cross-Review (formerly Relay-Only Consensus Phase 2)

**Date:** 2026-04-10 (revised 2026-04-12)
**Status:** Spec (revised — NEEDS ANOTHER PASS before implementation)
**Branch:** TBD
**Designed via:** 3-agent parallel analysis + orchestrator synthesis
**Reviewed by:** sonnet-reviewer, haiku-researcher, gemini-reviewer (2026-04-10)

---

## Problem

The current 5-step consensus protocol requires ~15-20 orchestrator tool calls per round:

1. `gossip_dispatch(mode: "consensus", tasks: [...])`
2. Run native `Agent()` calls + `gossip_relay` each result
3. `gossip_collect(task_ids, consensus: true)` — triggers Phase 2 cross-review
4. Run cross-review `Agent()` calls + `gossip_relay_cross_review` each
5. `gossip_collect(consensus: true)` again — final synthesized consensus

Steps 2 and 4 require the orchestrator to manually launch native Agent() calls.
The MCP server **cannot** launch native Agent() calls — only the host LLM can.

This causes:
- Protocol fragility: conversation drops mid-round → round lost
- UX friction: ~15-20 tool calls per consensus round
- Fixed runtime assignment: every participating agent does Phase 2, regardless of whether they're the best choice for cross-review

## Key Insight (from user)

The real design question is NOT "native vs relay for Phase 2" — it's **"which
agents are best qualified to cross-review these specific findings?"** The
orchestrator already has the data to answer this: per-agent accuracy scores,
per-category competency profiles, and the categories of the actual findings in
the round.

Cross-reviewer selection should be driven by:
1. Agent accuracy score (prefer high-accuracy reviewers)
2. Category match (prefer reviewers strong in the finding's category)
3. Not-self (an agent doesn't cross-review its own findings)
4. Runtime cost (prefer relay when quality is comparable — faster, no tool-call friction)

This is orthogonal to the native/relay split. A strong relay agent should
cross-review instead of a weak native one. A strong native agent should
cross-review instead of a weak relay one. The orchestrator picks the best
advisors for each round.

## Revised Proposal

### Orchestrator-selected Phase 2 cross-reviewers

`gossip_collect(consensus: true)` becomes:

1. Server synthesizes Phase 1 findings
2. Server asks `PerformanceReader` which agents are best qualified to
   cross-review each finding (by category match + accuracy score)
3. Top-K reviewers are picked per finding (K=2 or K=3 depending on severity)
4. Reviewers execute Phase 2 via the shared cross-review tool loop
   (file_read, file_grep, file_search, memory_query, git_log — all runtimes)
5. Final synthesized consensus returned

Result:
- No native/relay protocol split
- Orchestrator (server) picks advisors based on competency data
- Phase 2 becomes a server-side operation like the current relay-only path,
  but with **selection** driving which agents participate
- Users don't need to reason about `fast_consensus: true` vs enhanced — the
  system auto-picks the best available cross-reviewers

### Tool-blindness must be fixed first (prerequisite)

The existing `consensus-engine.ts:crossReviewForAgent` path calls
`llm.generate(messages)` with no tools. Any relay agent taking that path is
tool-blind — it cannot verify citations by reading code. This must be fixed
before orchestrator-selected cross-review ships, because the new path routes
MORE traffic through `crossReviewForAgent`, not less.

Move the `file_read`/`file_grep`/`file_search`/`memory_query`/`git_log` inline
tool loop from `collect.ts:262-318` into
`consensus-engine.ts:crossReviewForAgent` (lines 481-509). All cross-reviewers
— native or relay — get the same tool set.

`MAX_VERIFIER_TURNS` bumps from 6 to 7 to accommodate the expanded tool set.

### Cross-reviewer selection heuristic

```
For each finding in Phase 1 results:
  category = finding.category  // already extracted by consensus-engine
  candidates = allAgents - finding.originalAuthor
  scoredCandidates = candidates.map(agent => ({
    agent,
    score: (agent.accuracy * 0.7) + (agent.categoryStrength[category] * 0.3)
  }))
  topK = scoredCandidates.sortBy(score).take(K)  // K=2 for medium, K=3 for critical
  reviewers[finding.id] = topK.map(c => c.agent)
```

Reviewers accumulate per finding, so a single finding can be checked by the
best 2-3 agents across the portfolio, regardless of runtime.

### Degenerate cases

- **Single-reviewer round**: if only one eligible reviewer exists, skip Phase 2
  and return Phase 1 results with a `consensus_verified: false` flag. Rare in
  practice (8 agents on relay today).
- **All reviewers below threshold**: if top-K all have accuracy < 0.3, emit a
  warning but proceed — low-quality consensus is still more grounded than no
  consensus. Dashboard should flag these rounds for operator review.
- **Tool unavailable**: if `crossReviewForAgent` can't load verifier tools
  (sandbox error, git unavailable), log and fall back to text-only review with
  a warning signal recorded.

## Implementation plan

### Step 1: Port tool loop to consensus-engine (~100 LOC)

Move `file_read`/`file_grep`/`file_search`/`memory_query`/`git_log` inline tool
access from `collect.ts:262-318` into
`consensus-engine.ts:crossReviewForAgent` (lines 481-509). This ensures all
cross-reviewers have tools regardless of selection path.

Bump `MAX_VERIFIER_TURNS` from 6 to 7 to accommodate the expanded tool set.

### Step 2: Add cross-reviewer selection (~80 LOC)

Add a `selectCrossReviewers(findings, allAgents, performanceReader)` function
to `consensus-engine.ts` that implements the selection heuristic above. Wire it
into `generateCrossReviewPrompts` so the returned prompts target the selected
reviewers, not every agent in the round.

### Step 3: Default server-side Phase 2 (~50 LOC)

Make `gossip_collect(consensus: true)` always run Phase 2 server-side via the
selected reviewers. The current two-phase block in `collect.ts:208-438` stays
only as a fallback when server-side Phase 2 fails (error path).

### Step 4: Update dispatch + docs (~30 LOC)

- `gossip_dispatch(mode: "consensus")` response no longer emits the 5-step warning
- New response: "Phase 1 dispatched. Run native Agent() calls, relay results,
  then call gossip_collect(consensus: true). Phase 2 cross-review is automatic
  and orchestrator-selected."
- Update CLAUDE.md + HANDBOOK.md consensus protocol section
- Document selection heuristic + degenerate cases

### Step 5: Dashboard visibility (~30 LOC)

Show per-round cross-reviewer selection rationale in consensus report view:
"gemini-tester chosen for data_integrity finding (accuracy=0.25, category
strength=0.6)". Makes the selection auditable.

## Future work

- **Durable coordinator**: persist state to JSON, recover on restart
- **Score-gated auto-default**: already implicit in selection — low-score
  agents naturally drop out of top-K
- **Native merge hybrid**: no longer needed — selection handles this

## Open issues from 2026-04-12 review

Spec reviewed by sonnet-reviewer + haiku-researcher. 12 issues must be resolved before implementation:

### Critical bugs in spec math (HIGH)

1. **`categoryStrength` is unbounded** — performance-reader.ts:359 accumulates additively, not as a ratio. Can reach 3.7+. Breaks the 0.7/0.3 weighting math. **Fix:** use `categoryAccuracy[category]` instead — proper [0,1] ratio with MIN_CATEGORY_N=5 gate.
2. **Category is agent-declared, not server-verified** — consensus-engine.ts:1562 reads whatever the agent wrote. Null category produces NaN in sort. **Fix:** call `extractCategories()` as authoritative, or add null guard that drops the category term when missing.
3. **Single-reviewer `consensus_verified:false` is wrong signal** — Phase 1 results were never cross-reviewed, not disputed. **Fix:** use `partialReview:true` flag, define partial-K as `min(K, eligibleCount)` requiring at least 1.
4. **K per severity undefined for HIGH** — spec says "K=2 medium, K=3 critical" but not K for HIGH. Fewer-than-K eligible case ambiguous. **Fix:** prescriptive table (critical=3, high/medium/low=2) + partial-K behavior.

### Architectural concerns (HIGH)

5. **Missing epsilon-greedy exploration** — top-K without exploration creates self-reinforcing advantage (Matthew effect). Weak agents starve. **Fix:** allocate 10-15% slots to below-median agents via round-robin or weighted-random.
6. **Signal pipeline starvation** — volume drops 50-90% for most agents under top-K. Mid-tier recovery slows due to confidence-gating. **Fix:** acknowledge tradeoff explicitly, consider batching to preserve signal volume.
7. **Enforcement asymmetry NOT solved** — two-phase path still requires orchestrator to call `gossip_relay_cross_review`. "Server-side enforcement" is aspirational for relay-only path only. **Fix:** acknowledge this is a soft enforcement improvement, not a hard one.
8. **Selection bias risk** — scoring miscalibration compounds in selectively-grounded path. **Fix:** dashboard monitoring of per-agent/category coverage.

### Implementation gaps (MEDIUM)

9. **K multiplier dispatch cost** — batching unspecified. 10 findings × K=2 = 20 naive dispatches vs 4 batched. **Fix:** `selectCrossReviewers` returns `Map<agentId, Set<findingId>>`, batches prompts per reviewer.
10. **FileTools/Sandbox dependency** — lives in apps/cli, not packages/orchestrator. ConsensusEngine can't import it. **Fix:** callback injection pattern — add `verifierToolRunner` to `ConsensusEngineConfig`.
11. **Zero-category-expert fallback undocumented** — e.g., "reentrancy" in a web-app codebase. **Fix:** explicit fallback — rank by accuracy alone when no agent has positive category strength.

### Quick wins (INSIGHT)

12. **Exclude circuit-open agents** — `PerformanceReader.isCircuitOpen()` not referenced in spec. One-line filter: `candidates.filter(a => !perfReader.isCircuitOpen(a.agentId))`.

Before implementation: another design pass incorporating all 12 fixes. P3 is deferred from this session's work.

## Test plan

- [ ] Tool loop port: verify file_read/file_grep/file_search/memory_query/git_log all work in crossReviewForAgent
- [ ] Selection heuristic: top-K by accuracy * 0.7 + category * 0.3
- [ ] Reviewer excludes the finding's original author
- [ ] Single-reviewer degenerate case returns consensus_verified: false
- [ ] Low-quality warning when top-K all < 0.3 accuracy
- [ ] MAX_VERIFIER_TURNS bump: no regressions on existing cross-review tests
- [ ] Dashboard shows selection rationale per finding
- [ ] Run existing 82 consensus-engine tests (no regressions)
