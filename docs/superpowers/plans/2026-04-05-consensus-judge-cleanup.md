# Consensus Judge Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Phase 3 (verifyUnverified) and ConsensusJudge — redundant verification layers superseded by orchestrator verification.

**Architecture:** Pure deletion. Remove ~500 lines of dead/redundant code across consensus-engine, consensus-coordinator, dispatch-pipeline, mcp-server-sdk, and index exports. No new code, no new features.

**Tech Stack:** TypeScript, Jest

---

### Task 1: Remove Phase 3 from consensus-engine.ts (run method)

**Files:**
- Modify: `packages/orchestrator/src/consensus-engine.ts:113-125`

- [ ] **Step 1: Remove Phase 3 block from `run()` method**

Replace lines 113-125 (the Phase 3 block + timing adjustment) with clean timing that omits `verifyMs`:

```typescript
// REMOVE these lines (113-121):
//    // Phase 3: Orchestrator verification of UNVERIFIED findings
//    let verifyMs = 0;
//    if (report.unverified.length > 0) {
//      process.stderr.write(`[consensus] Phase 3: verifying ${report.unverified.length} unverified findings\n`);
//      const verifyStart = Date.now();
//      await this.verifyUnverified(report, successful);
//      verifyMs = Date.now() - verifyStart;
//      process.stderr.write(`[consensus] After verification: ...`);
//    }

// REPLACE lines 123-125 with (remove verifyMs from timing):
    const totalMs = Date.now() - consensusStart;
    const timing = { totalMs, perAgent, crossReviewMs, synthesizeMs };
    process.stderr.write(`[consensus] Total: ${Math.round(totalMs / 1000)}s (cross-review: ${Math.round(crossReviewMs / 1000)}s, synthesis: ${Math.round(synthesizeMs / 1000)}s)\n`);
```

- [ ] **Step 2: Verify no type errors**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`

If `verifyMs` is referenced in the `timing` type or `formatReport`, update those too — remove the `verifyMs` parameter.

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/consensus-engine.ts
git commit -m "refactor: remove Phase 3 verification from consensus run()"
```

---

### Task 2: Remove Phase 3 from consensus-engine.ts (synthesizeWithCrossReview method)

**Files:**
- Modify: `packages/orchestrator/src/consensus-engine.ts:1573-1581`

- [ ] **Step 1: Remove Phase 3 block from `synthesizeWithCrossReview()`**

Delete lines 1573-1581:

```typescript
// REMOVE:
//    // Run UNVERIFIED verification (Phase 3)
//    const successful = results.filter(r => r.status === 'completed' && r.result);
//    if (report.unverified.length > 0) {
//      await this.verifyUnverified(report, successful);
//      report.summary = this.formatReport(
//        report.confirmed, report.disputed, report.unverified, report.unique,
//        report.newFindings, successful.length, report.rounds, undefined, report.insights,
//      );
//    }
```

- [ ] **Step 2: Commit**

```bash
git add packages/orchestrator/src/consensus-engine.ts
git commit -m "refactor: remove Phase 3 from synthesizeWithCrossReview()"
```

---

### Task 3: Delete verifyUnverified method and related helpers

**Files:**
- Modify: `packages/orchestrator/src/consensus-engine.ts:740-912`

- [ ] **Step 1: Delete the `verifyUnverified` method**

Delete the entire `private async verifyUnverified(...)` method (lines 740-912, ~170 lines). This includes the method body with LLM calls, citation extraction, and verdict application.

- [ ] **Step 2: Remove `verifyMs` from `formatReport` if present**

Check if `formatReport` at line 1388 accepts a `verifyMs` parameter in its timing object. If the timing type includes `verifyMs`, remove it from the type and from `formatReport`'s usage.

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator/consensus-engine --no-coverage 2>&1 | tail -10`
Expected: Tests pass (Phase 3 was best-effort, no tests depend on it directly)

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/consensus-engine.ts
git commit -m "refactor: delete verifyUnverified method (~170 lines)"
```

---

### Task 4: Remove ConsensusJudge from consensus-coordinator.ts

**Files:**
- Modify: `packages/orchestrator/src/consensus-coordinator.ts`

- [ ] **Step 1: Remove judge import (line 5)**

```typescript
// REMOVE:
import { IConsensusJudge } from './consensus-judge';
```

- [ ] **Step 2: Remove judge field and setter (lines 30, 46-48)**

```typescript
// REMOVE from class fields:
  private consensusJudge: IConsensusJudge | null = null;

// REMOVE setter:
  setConsensusJudge(judge: IConsensusJudge): void {
    this.consensusJudge = judge;
  }
```

- [ ] **Step 3: Remove judge integration block (lines 96-143)**

Delete the entire "Consensus Judge Integration" block from `runConsensus()`:

```typescript
// REMOVE lines 96-143:
//      // Consensus Judge Integration
//      const agentTaskIdMap = new Map<string, string>();
//      ... (entire judge verify + verdict application block)
```

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors (judge was optional, never called from other files)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/consensus-coordinator.ts
git commit -m "refactor: remove ConsensusJudge from consensus-coordinator"
```

---

### Task 5: Remove judge from dispatch-pipeline.ts and mcp-server-sdk.ts

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts:876-878`
- Modify: `apps/cli/src/mcp-server-sdk.ts:480-501`

- [ ] **Step 1: Remove judge setter from dispatch-pipeline.ts**

Remove the `setConsensusJudge` method (lines 876-878):

```typescript
// REMOVE:
  setConsensusJudge(judge: IConsensusJudge): void {
    this.consensusCoordinator.setConsensusJudge(judge);
  }
```

Also remove the `IConsensusJudge` import if it exists at the top of the file.

- [ ] **Step 2: Remove judge wiring from mcp-server-sdk.ts**

Delete lines 480-501 (the entire judge initialization block):

```typescript
// REMOVE:
  // Wire Consensus Judge (uses dedicated LLM, optionally from consensus_judge config)
  try {
    const { ConsensusJudge } = await import('@gossip/orchestrator');
    ... (entire try/catch block)
  }
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts apps/cli/src/mcp-server-sdk.ts
git commit -m "refactor: remove judge wiring from pipeline and MCP server"
```

---

### Task 6: Delete consensus-judge.ts and clean up exports

**Files:**
- Delete: `packages/orchestrator/src/consensus-judge.ts`
- Modify: `packages/orchestrator/src/index.ts:64-65`

- [ ] **Step 1: Delete the consensus-judge.ts file**

```bash
rm packages/orchestrator/src/consensus-judge.ts
```

- [ ] **Step 2: Remove exports from index.ts**

Remove lines 64-65:

```typescript
// REMOVE:
export { ConsensusJudge } from './consensus-judge';
export type { IConsensusJudge, JudgeVerdict } from './consensus-judge';
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit --project tsconfig.json 2>&1 | head -20`
Expected: No errors (all consumers removed in Tasks 4-5)

- [ ] **Step 4: Commit**

```bash
git add -A packages/orchestrator/src/consensus-judge.ts packages/orchestrator/src/index.ts
git commit -m "refactor: delete consensus-judge.ts and remove exports"
```

---

### Task 7: Clean up tests and dead docs

**Files:**
- Delete: `tests/orchestrator/consensus-judge.test.ts`
- Modify: `tests/orchestrator/citation-verification.test.ts:201`
- Delete: `NATIVE_JUDGE_DESIGN.md`

- [ ] **Step 1: Delete consensus-judge.test.ts**

```bash
rm tests/orchestrator/consensus-judge.test.ts
```

- [ ] **Step 2: Update stale comment in citation-verification.test.ts**

Replace line 201-202:

```typescript
// BEFORE:
// verifyNegativeClaim tests removed — replaced by ConsensusJudge (consensus-judge.test.ts)
// verifyCitations on confirmed findings is tested via the synthesize integration test above

// AFTER:
// verifyCitations on confirmed findings is tested via the synthesize integration test above
```

- [ ] **Step 3: Delete NATIVE_JUDGE_DESIGN.md**

```bash
rm NATIVE_JUDGE_DESIGN.md
```

- [ ] **Step 4: Run full test suite**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: All tests pass (minus the deleted test file)

- [ ] **Step 5: Commit**

```bash
git add -A tests/orchestrator/consensus-judge.test.ts tests/orchestrator/citation-verification.test.ts NATIVE_JUDGE_DESIGN.md
git commit -m "chore: delete judge tests, stale comments, and dead design doc"
```

---

### Task 8: Rebuild MCP bundle and verify

**Files:**
- Build output: `dist-mcp/mcp-server.js`

- [ ] **Step 1: Rebuild MCP bundle**

Run: `npm run build:mcp 2>&1`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run full test suite one final time**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 3: Commit build output if needed**

```bash
git add dist-mcp/
git commit -m "build: rebuild MCP bundle after judge cleanup"
```
