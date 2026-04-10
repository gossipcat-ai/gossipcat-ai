# Relay-Only Consensus Phase 2

**Date:** 2026-04-10
**Status:** Spec (revised after 3-agent review)
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
- Implementation complexity: ~230 LOC two-phase block in `collect.ts:209-438`

## Revised Proposal (post-review)

### Default: Keep 5-step protocol (no change)

The 5-step protocol remains the default. It was introduced specifically to fix
quality issues with relay-only consensus, and the data does not support reverting
that decision:

- gemini-reviewer accuracy is 0.11 (6x hallucination rate vs sonnet)
- Cross-review is the adversarial phase most likely to surface hallucinations
- The relay-only path (`collect.ts:205-207`) has NO `file_read`/`file_grep` tools
  (see Critical Finding below)

### Opt-in fast path: `fast_consensus: true`

Add `fast_consensus: true` parameter to `gossip_collect` for when speed > quality:

1. `gossip_dispatch(mode: "consensus", tasks: [...])`
2. Run native `Agent()` calls + `gossip_relay` each
3. `gossip_collect(consensus: true, fast_consensus: true)` — server runs Phase 2
   internally via relay agents, returns final result

**When to use:** iterative/low-stakes reviews, rapid prototyping, non-security code.
**When NOT to use:** security audits, correctness reviews, anything where
hallucinated findings would cause harm.

### Future: Score-gated auto-selection

When relay reviewers reach an accuracy threshold (e.g., `hallucination_rate < 5%`),
relay-only could become the auto-default. Until then, the opt-in flag is the
correct UX contract.

## Critical Finding: Tool-Blindness Regression

**Found by:** sonnet-reviewer (2026-04-10 review)

The two code paths in `collect.ts` are **NOT equivalent**:

- **Two-phase path** (`collect.ts:208-438`): cross-reviewers get `file_read` +
  `file_grep` via inline tool loop at `collect.ts:262-318`
- **Relay-only path** (`collect.ts:205-207`): calls `engine.run()` →
  `crossReviewForAgent` at `consensus-engine.ts:494` — `llm.generate(messages)`
  with **no tools argument**. Raw text generation only.

The original spec acknowledged relay cross-reviewers were "tool-blind" and that
the inline tool loop fixed it — then proposed defaulting to the path that **never
received that fix**. This was a direct contradiction.

### Required prerequisite (before `fast_consensus` can ship)

Move the `file_read`/`file_grep` tool loop from the two-phase block into
`consensus-engine.ts:crossReviewForAgent` (lines 481-509) so that relay
cross-reviewers ALWAYS have tool access, regardless of which path is taken.

Without this fix, `fast_consensus: true` would silently revert the tool-blindness
fix for all opt-in rounds.

## Evidence (from 3-agent review)

### All 3 agents converged on:

1. **Don't make relay-only the default** — quality contract must be preserved
2. **Implementation is technically sound** — the conditional flip works
3. **Quality tradeoff NOT acceptable** at current gemini accuracy (0.11)

### Enforcement asymmetry shifts, not solved (haiku-researcher)

Relay-only Phase 2 converts the enforcement problem from "orchestrator skips
steps 3-5" to "orchestrator skips calling gossip_collect entirely." The Stage 1
hard rejection hotfix from `project_consensus_enforcement.md` is still needed
regardless of this spec.

### Signal pipeline loss (haiku-researcher)

If Phase 2 defaults to relay-only, sonnet-reviewer stops accumulating cross-review
signals (agreement, disagreement, hallucination_caught). Round 694fd69a shows 10+
of sonnet-reviewer's 15 signals per round are cross-review actions. Removing this
removes the adversarial training that keeps it sharp.

### Resilience regression (sonnet-reviewer)

The two-phase flow persists `ctx.pendingConsensusRounds` at `collect.ts:389`,
allowing recovery on MCP restart. The relay-only path calls `runConsensus`
directly — synchronous, no intermediate persistence. MCP restart during
`engine.run()` loses the entire round with no recovery path.

### Self-assessment (gemini-reviewer)

gemini-reviewer self-assessed: "my hallucination rate makes me a net negative as
default cross-reviewer." Requested specialized skills + explicit self-correction
loop before taking this role. Also flagged that silent relay cross-review failures
(collect.ts:319-331) are dangerous — should fail loudly, not soft-log.

### Middle-ground: relay auto + optional native merge (haiku-researcher)

A hybrid approach preserves the 3-step UX while allowing quality opt-in:
- Phase 2a (auto): relay agents cross-review server-side
- Phase 2b (optional): orchestrator can add native cross-review results merged
  before synthesis
- Infrastructure supports this: `findingId`-based merging at
  `consensus-engine.ts:748-768`, pending native handling at `collect.ts:362-389`

This is a future enhancement, not in scope for the initial implementation.

## Implementation plan (revised)

### Step 1: Port tool loop to consensus-engine (~80 LOC)

Move `file_read`/`file_grep` inline tool access from `collect.ts:262-318` into
`consensus-engine.ts:crossReviewForAgent` (lines 481-509). This ensures relay
cross-reviewers always have tools regardless of which path is taken.

Expand the cross-review verifier tool set from 2 tools to 5:

| Tool | Purpose in cross-review |
|------|------------------------|
| `file_read` | Verify cited code exists at claimed line (already have) |
| `file_grep` | Search for identifiers in findings (already have) |
| `file_search` | Find related files when a finding names a function but not a file (NEW) |
| `memory_query` | Recall prior findings, prevent re-discovery and self-contradiction (NEW) |
| `git_log` | Verify "introduced in commit X" claims, check recency (NEW) |

Currently relay cross-reviewers get only `file_read` + `file_grep`
(collect.ts:262). Phase 1 relay workers have the full tool set via the Tool
Server (`mcp-server-sdk.ts:398`), but Phase 2 doesn't. Without memory access,
cross-reviewers can't check "did I already flag this?" The memory system exists
to prevent re-discovery and self-contradiction; excluding it from cross-review
defeats that purpose.

Also bump `MAX_VERIFIER_TURNS` from 6 to 7 to accommodate the expanded tool set.

### Step 2: Add `fast_consensus` parameter (~50 LOC)

In `apps/cli/src/handlers/collect.ts`:
- Add `fast_consensus` as optional param to `gossip_collect` tool schema
  (`mcp-server-sdk.ts` schema + `collect.ts` handler signature)
- At `collect.ts:205`, change condition to:
  `if (nativeAgentIds.size === 0 || fast_consensus)`
- The ~230 LOC two-phase block stays intact as the default path

### Step 3: Update dispatch instructions (~20 LOC)

- `gossip_dispatch(mode: "consensus")` response keeps the 5-step warning
- Add note: "For faster rounds with relay-only cross-review, pass
  `fast_consensus: true` to gossip_collect"

### Step 4: Update CLAUDE.md + HANDBOOK.md (~10 lines)

- Document `fast_consensus: true` flag with guidance on when to use it
- Keep 5-step as the documented default protocol

### Future work (separate PRs)

- **Durable coordinator**: persist coordinator state to JSON, recover on restart
- **Accuracy-weighted assignment**: route Phase 2 to strongest available reviewer
- **Score-gated auto-default**: auto-select relay-only when accuracy threshold met
- **Native merge hybrid**: relay auto Phase 2 + optional native merge

## Test plan

- [ ] 5-step consensus continues to work as default (no regression)
- [ ] `fast_consensus: true` activates relay-only Phase 2
- [ ] Relay cross-reviewers have `file_read`/`file_grep` in BOTH paths
- [ ] Verify `synthesize()` produces identical output regardless of reviewer identity
- [ ] Run existing 82 consensus-engine tests (no regressions)
- [ ] Test: relay cross-review failure produces visible warning, not silent skip
- [ ] Test: MCP restart mid-round in fast_consensus mode → clear error state
