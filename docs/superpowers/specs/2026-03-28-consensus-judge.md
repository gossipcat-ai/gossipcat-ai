# Consensus Judge — Design Spec

> A post-consensus verification agent that reads confirmed findings against actual code, catching hallucinations that slip through when all agents agree on something false.

**Date:** 2026-03-28
**Status:** Ready for implementation
**Dependencies:** ATI v3 Phase 1 (shipped), Consensus Protocol (shipped), Citation Verification (shipped)

---

## Problem Statement

When multiple agents unanimously agree on a false finding, the consensus engine has no mechanism to catch it. Citation verification only runs on disagreements. The regex-based `verifyNegativeClaim` approach is too limited — it can't understand "the validation is insufficient" vs "there is no validation."

**Evidence:** In this session, gemini-reviewer claimed "SAFE_NAME regex does not prevent dots" (it does — whitelist regex excludes dots). gemini-tester and gemini-implementer both confirmed it. The finding passed consensus as "confirmed" despite being factually wrong. Only a manual Sonnet dispatch caught the error.

## Design

### What It Does

After consensus produces confirmed findings, `sonnet-consensus-judge` is dispatched as a native Sonnet agent. It reads each confirmed finding, checks the cited code via tool access, and returns a verdict per finding.

### Judge Dispatch

One dispatch per consensus round. The judge receives ALL confirmed findings in a single prompt and returns a JSON array of verdicts.

```typescript
interface JudgeVerdict {
  index: number;
  verdict: 'VERIFIED' | 'REFUTED' | 'UNVERIFIABLE';
  evidence: string;
}
```

### Judge Prompt

```
System: You are a code verification judge. Your ONLY job is to check whether
confirmed findings about code are factually accurate. You are NOT reviewing
the code yourself — you are verifying other agents' claims.

For each finding:
1. Read the cited file and line using the file_read tool
2. Check if the specific claim is factually true
3. Return your verdict with evidence

Be skeptical. Agents frequently:
- Claim code "does not validate" when validation exists nearby
- Cite line numbers that don't match their claim
- Describe regex/logic incorrectly (confuse whitelist with blacklist)
- Say something is "missing" when it exists in a different form

User: Verify these confirmed findings:

<confirmed_findings>
{numbered list of findings with originating agent, finding text, cited file:line}
</confirmed_findings>

For each finding, read the cited code, then return ONLY a JSON array:
[{ "index": 1, "verdict": "VERIFIED|REFUTED|UNVERIFIABLE", "evidence": "..." }]
```

### Pipeline Integration

In `dispatch-pipeline.ts`, inside `collect()`, after `ConsensusEngine.run()` returns:

```typescript
// Inside the existing try block where perfWriter is scoped...
// After category extraction, before task cleanup:

if (consensusReport.confirmed.length > 0 && this.consensusJudge) {
  try {
    const verdicts = await this.consensusJudge.verify(consensusReport.confirmed);
    const now = new Date().toISOString();

    // FIX: Process refuted verdicts in descending index order to avoid splice corruption
    const refuted = verdicts
      .filter(v => v.verdict === 'REFUTED')
      .sort((a, b) => b.index - a.index); // descending

    for (const v of refuted) {
      const idx = v.index - 1;
      const finding = consensusReport.confirmed[idx];
      if (!finding) continue;

      consensusReport.confirmed.splice(idx, 1);
      finding.tag = 'disputed';
      consensusReport.disputed.push(finding);

      perfWriter.appendSignal({
        type: 'consensus', signal: 'hallucination_caught',
        agentId: finding.originalAgentId, outcome: 'judge_refuted',
        evidence: v.evidence, timestamp: now, taskId: finding.id,
      } as any);
      for (const confirmerId of finding.confirmedBy) {
        perfWriter.appendSignal({
          type: 'consensus', signal: 'hallucination_caught',
          agentId: confirmerId, outcome: 'confirmed_hallucination',
          evidence: `Confirmed refuted finding: ${v.evidence}`,
          timestamp: now, taskId: finding.id,
        } as any);
      }
    }

    // Emit verified signals (no array mutation needed)
    for (const v of verdicts.filter(v => v.verdict === 'VERIFIED')) {
      const finding = consensusReport.confirmed.find((_, i) => i === v.index - 1 - refuted.filter(r => r.index <= v.index).length);
      if (!finding) continue;
      perfWriter.appendSignal({
        type: 'consensus', signal: 'consensus_verified',
        agentId: finding.originalAgentId,
        evidence: v.evidence, timestamp: now, taskId: finding.id,
      } as any);
    }
  } catch (err) {
    log(`Consensus judge failed: ${(err as Error).message}`);
  }
}
```

> **Review fix (H1):** Refuted verdicts processed in descending index order to prevent splice corruption.
> **Review fix (M1):** perfWriter is used inside the existing try block where it's already scoped.

### Signals Emitted

| Verdict | Signal | Who | ATI Effect |
|---------|--------|-----|------------|
| VERIFIED | `consensus_verified` | originating agent | +accuracy |
| REFUTED | `hallucination_caught` (outcome: `judge_refuted`) | originating agent | -accuracy (hallucination) |
| REFUTED | `hallucination_caught` (outcome: `confirmed_hallucination`) | each confirming agent | -accuracy (confirmed a hallucination) |
| UNVERIFIABLE | (none) | — | Finding stays confirmed, no signal |

### Keep verifyCitations, Remove verifyNegativeClaim

> **Review fix (M2, L1):** `verifyCitations` on confirmed findings is a cheap structural check (no LLM call). The judge is a semantic check. Keep both — they're complementary, not redundant. When judge is disabled, `verifyCitations` is the only defense.

- **Remove** `verifyNegativeClaim` from `consensus-engine.ts` — replaced by the judge (proven too imprecise via regex)
- **Keep** `verifyCitations` on confirmed findings in `synthesize()` — cheap pre-filter that catches file-not-found, line-beyond-length, keyword-mismatch
- **Add** judge as a post-consensus step in `dispatch-pipeline.ts` — runs AFTER `verifyCitations` has already caught the obvious structural issues

---

## Architecture

### New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `packages/orchestrator/src/consensus-judge.ts` | Format prompt, parse verdicts, apply demotions + signals | ~80 |
| `tests/orchestrator/consensus-judge.test.ts` | Unit tests with mocked agent | ~100 |

### Modified Files

| File | Change |
|------|--------|
| `packages/orchestrator/src/dispatch-pipeline.ts` | Call judge after consensus in `collect()` |
| `packages/orchestrator/src/consensus-engine.ts` | Remove `verifyNegativeClaim` only. Keep `verifyCitations` on confirmed findings. |
| `packages/orchestrator/src/consensus-types.ts` | Add `consensus_verified` signal, `judge_refuted` and `confirmed_hallucination` outcomes |
| `packages/orchestrator/src/performance-reader.ts` | Add `consensus_verified` to `SIGNAL_WEIGHTS` with `{ accuracy: 0.1 }` (same weight as `agreement`) |
| `apps/cli/src/mcp-server-sdk.ts` | Wire judge at boot (create Sonnet worker for judge role) |

### How the Judge Dispatches

The judge is NOT a separate always-running agent. It's created on-demand inside `collect()`:

```typescript
// In consensus-judge.ts
export class ConsensusJudge {
  constructor(
    private worker: WorkerLike,  // a Sonnet worker with file_read tools
  ) {}

  async verify(confirmed: ConsensusFinding[]): Promise<JudgeVerdict[]>;
}
```

> **Review fix (H2):** The judge does NOT reuse an existing worker. `WorkerAgent.executeTask` is not reentrant — concurrent calls corrupt state. Instead, the judge uses a **dedicated LLM call** via `ILLMProvider.generate()` directly (no worker needed). The judge only needs to read files and reason about code — it sends findings in the prompt and asks for verdicts. File reading is done by the judge class itself (same pattern as `verifyCitations`), not via tool calls.

```typescript
export class ConsensusJudge {
  constructor(
    private llm: ILLMProvider,
    private projectRoot: string,
  ) {}

  async verify(confirmed: ConsensusFinding[]): Promise<JudgeVerdict[]>;
}
```

In the MCP server, after boot:
```typescript
// Wire consensus judge with a dedicated LLM (Sonnet preferred, falls back to main)
const judgeLlm = /* create Sonnet provider if key available, else use main LLM */;
const judge = new ConsensusJudge(judgeLlm, process.cwd());
mainAgent.pipeline.setConsensusJudge(judge);
```

> **Review fix (M3):** The judge reads cited files directly via `fs.readFileSync` and includes relevant code snippets in the prompt. Finding text is escaped: `finding.replace(/<\/?confirmed_findings>/gi, '')` before injection into the prompt (same pattern as consensus-engine.ts:89 which escapes `<data>` tags).

---

## Cost

- One Sonnet call per consensus round
- ~2K input tokens (findings + system prompt), ~500 output tokens (JSON verdicts)
- ~$0.01 per round
- Only runs when confirmed findings exist

---

## Elimination Criteria

The judge is training wheels. Once ATI profiles are mature, it becomes redundant:

- All agents have >20 tasks of profile data
- Team hallucination rate < 5%
- No refuted findings in last 10 consensus rounds

Disable via `.gossip/config.json`:
```json
{ "consensusJudge": false }
```

---

## Testing Strategy

### ConsensusJudge (unit, mocked worker)

- Given 3 confirmed findings, mock worker returns VERIFIED/REFUTED/UNVERIFIABLE → correct demotions applied
- Refuted finding removed from confirmed, added to disputed
- Hallucination signal emitted for originating agent
- Confirmed_hallucination signal emitted for each confirming agent
- Verified finding emits consensus_verified signal
- Unverifiable finding stays confirmed, no signal
- Worker timeout/error → all findings stay confirmed, warning logged

### Integration

- Full dispatch → consensus → judge → verify refuted finding is demoted in final report
- Verify ATI signals from judge verdicts appear in agent-performance.jsonl

---

## Security

- Judge prompt receives finding text (from agents) — already in the consensus pipeline, no new trust boundary
- Judge has read-only tool access — cannot modify files
- Judge verdicts are validated (must be valid JSON array with known verdict values)
- Judge failure is non-blocking — pipeline continues with all findings confirmed
