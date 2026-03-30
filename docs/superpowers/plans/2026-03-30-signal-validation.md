# Signal Validation at Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-layer validation to agent-performance.jsonl writes — writer rejects structurally invalid signals, ingestion points enforce business rules.

**Architecture:** `validateSignal()` in PerformanceWriter throws on bad data (Layer 1). ConsensusEngine and MCP tools validate context-specific rules before calling writer (Layer 2). Migration retracts 46 existing bad signals via append-only entries.

**Tech Stack:** TypeScript, Jest, Zod (MCP tool schemas)

**Spec:** `docs/superpowers/specs/2026-03-30-signal-validation-design.md`

---

### Task 1: Add `validateSignal()` to PerformanceWriter

**Files:**
- Modify: `packages/orchestrator/src/performance-writer.ts`
- Test: `tests/orchestrator/performance-writer.test.ts`

- [ ] **Step 1: Write failing tests for validation**

Add these test cases to `tests/orchestrator/performance-writer.test.ts`:

```typescript
describe('validateSignal — rejects invalid signals', () => {
  it('rejects signal with empty taskId', () => {
    expect(() => writer.appendSignal({
      type: 'consensus', taskId: '', signal: 'agreement',
      agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('taskId');
  });

  it('rejects signal with missing agentId', () => {
    expect(() => writer.appendSignal({
      type: 'consensus', taskId: 't1', signal: 'agreement',
      agentId: '', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('agentId');
  });

  it('rejects signal with invalid timestamp', () => {
    expect(() => writer.appendSignal({
      type: 'consensus', taskId: 't1', signal: 'agreement',
      agentId: 'a', evidence: 'e', timestamp: 'not-a-date',
    })).toThrow('timestamp');
  });

  it('rejects signal with unknown consensus signal type', () => {
    expect(() => writer.appendSignal({
      type: 'consensus', taskId: 't1', signal: 'made_up' as any,
      agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('signal');
  });

  it('rejects signal with unknown type field', () => {
    expect(() => writer.appendSignal({
      type: 'unknown' as any, taskId: 't1', signal: 'agreement',
      agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('type');
  });

  it('accepts valid consensus signal', () => {
    expect(() => writer.appendSignal({
      type: 'consensus', taskId: 't1', signal: 'agreement',
      agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z',
    })).not.toThrow();
  });

  it('accepts valid impl signal', () => {
    expect(() => writer.appendSignal({
      type: 'impl', signal: 'impl_test_pass',
      agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
    })).not.toThrow();
  });

  it('accepts valid meta signal', () => {
    expect(() => writer.appendSignal({
      type: 'meta', signal: 'task_completed',
      agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
    })).not.toThrow();
  });

  it('rejects unknown impl signal enum', () => {
    expect(() => writer.appendSignal({
      type: 'impl', signal: 'fake_impl' as any,
      agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('signal');
  });

  it('rejects unknown meta signal enum', () => {
    expect(() => writer.appendSignal({
      type: 'meta', signal: 'fake_meta' as any,
      agentId: 'a', taskId: 't1', timestamp: '2026-03-30T10:00:00Z',
    })).toThrow('signal');
  });

  it('appendSignals rejects batch with any invalid signal', () => {
    expect(() => writer.appendSignals([
      { type: 'consensus', taskId: 't1', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
      { type: 'consensus', taskId: '', signal: 'agreement', agentId: 'a', evidence: 'e', timestamp: '2026-03-30T10:00:00Z' },
    ])).toThrow('taskId');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/orchestrator/performance-writer.test.ts --no-coverage`
Expected: 10 new tests FAIL (no validation exists yet)

- [ ] **Step 3: Implement `validateSignal()` in PerformanceWriter**

Replace the contents of `packages/orchestrator/src/performance-writer.ts` with:

```typescript
// packages/orchestrator/src/performance-writer.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PerformanceSignal } from './consensus-types';

const VALID_CONSENSUS_SIGNALS = new Set([
  'agreement', 'disagreement', 'unverified', 'unique_confirmed',
  'unique_unconfirmed', 'new_finding', 'hallucination_caught',
  'category_confirmed', 'consensus_verified', 'signal_retracted',
]);

const VALID_IMPL_SIGNALS = new Set([
  'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected',
]);

const VALID_META_SIGNALS = new Set([
  'task_completed', 'task_tool_turns',
]);

function validateSignal(signal: PerformanceSignal): void {
  if (!signal || typeof signal !== 'object') {
    throw new Error('Signal validation failed: signal must be an object');
  }
  if (typeof signal.agentId !== 'string' || signal.agentId.length === 0) {
    throw new Error('Signal validation failed: agentId must be a non-empty string');
  }
  if (typeof signal.taskId !== 'string' || signal.taskId.length === 0) {
    throw new Error('Signal validation failed: taskId must be a non-empty string');
  }
  if (typeof signal.timestamp !== 'string' || !isFinite(new Date(signal.timestamp).getTime())) {
    throw new Error('Signal validation failed: timestamp must be a valid ISO-8601 string');
  }

  switch (signal.type) {
    case 'consensus':
      if (!VALID_CONSENSUS_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown consensus signal "${signal.signal}"`);
      }
      break;
    case 'impl':
      if (!VALID_IMPL_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown impl signal "${signal.signal}"`);
      }
      break;
    case 'meta':
      if (!VALID_META_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown meta signal "${signal.signal}"`);
      }
      break;
    default:
      throw new Error(`Signal validation failed: unknown type "${(signal as any).type}"`);
  }
}

export class PerformanceWriter {
  private readonly filePath: string;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'agent-performance.jsonl');
  }

  appendSignal(signal: PerformanceSignal): void {
    validateSignal(signal);
    appendFileSync(this.filePath, JSON.stringify(signal) + '\n');
  }

  appendSignals(signals: PerformanceSignal[]): void {
    if (signals.length === 0) return;
    for (const s of signals) validateSignal(s);
    const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
    appendFileSync(this.filePath, data);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/orchestrator/performance-writer.test.ts --no-coverage`
Expected: ALL tests pass (existing + new)

- [ ] **Step 5: Run full test suite to check for breakage**

Run: `npx jest --no-coverage`
Expected: If any existing tests break, they are writing invalid signals — fix them by adding valid `taskId`/`timestamp` fields. This is expected and desirable.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/performance-writer.ts tests/orchestrator/performance-writer.test.ts
git commit -m "feat: add validateSignal to PerformanceWriter — rejects structurally invalid signals"
```

---

### Task 2: Fix ConsensusEngine — empty taskId fallback + evidence cap + verifyCitations

**Files:**
- Modify: `packages/orchestrator/src/consensus-engine.ts`
- Test: `tests/orchestrator/consensus-e2e.test.ts` (existing)

- [ ] **Step 1: Write failing test for verifyCitations I/O error**

Add to an appropriate test file (create `tests/orchestrator/verify-citations.test.ts` if needed):

```typescript
import { ConsensusEngine } from '@gossip/orchestrator';

describe('verifyCitations — I/O error handling', () => {
  it('returns false on I/O read error (benefit of doubt)', async () => {
    // Create engine with a non-existent projectRoot to trigger I/O errors
    const engine = new ConsensusEngine({
      llm: { generate: async () => '' } as any,
      registryGet: () => undefined,
      projectRoot: '/nonexistent/path/that/triggers/io/error',
    });
    // Access private method via prototype for testing
    const result = await (engine as any).verifyCitations('Found bug at real-file.ts:999');
    // Should return false (benefit of doubt), not true (fabricated)
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/verify-citations.test.ts --no-coverage`
Expected: FAIL — currently returns `true` on I/O error

- [ ] **Step 3: Fix `verifyCitations` catch block**

In `packages/orchestrator/src/consensus-engine.ts`, find the catch block around line 516-519:

```typescript
// BEFORE:
      } catch {
        // File read failed — treat as fabricated
        return true;
      }

// AFTER:
      } catch {
        // File read failed — benefit of doubt, not fabricated
        return false;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/orchestrator/verify-citations.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Fix all 9 empty-taskId emit sites**

In `packages/orchestrator/src/consensus-engine.ts`, in the `synthesize()` method, create a helper at the top of the method (after `agentTaskIds` is built around line 224):

```typescript
    // Helper: get taskId with recoverable fallback (never empty string)
    const getTaskId = (agentId: string): string => {
      const id = agentTaskIds.get(agentId);
      if (id && id.length > 0) return id;
      log(`[consensus] WARNING: no taskId for agent "${agentId}", using fallback`);
      return `unknown-${consensusId}-${agentId}`;
    };
```

Then replace all 9 occurrences of `agentTaskIds.get(entry.agentId) ?? ''` and `agentTaskIds.get(entry.originalAgentId) ?? ''` with the helper:

- Line 241: `taskId: getTaskId(entry.agentId),`
- Line 259: `taskId: getTaskId(entry.agentId),`
- Line 288: `taskId: getTaskId(entry.peerAgentId),`
- Line 305: `taskId: getTaskId(entry.agentId),`
- Line 329: `taskId: getTaskId(entry.agentId),`
- Line 379: `taskId: getTaskId(entry.originalAgentId),`
- Line 399: `taskId: getTaskId(entry.originalAgentId),`
- Line 412: `taskId: getTaskId(entry.originalAgentId),`
- Line 424: `taskId: getTaskId(entry.originalAgentId),`

Verify none remain: `grep -n "agentTaskIds.get.*?? ''" packages/orchestrator/src/consensus-engine.ts` should return 0 results.

- [ ] **Step 6: Cap evidence length at 2000 chars**

In the same `synthesize()` method, add a helper next to `getTaskId`:

```typescript
    const MAX_EVIDENCE_LENGTH = 2000;
    const capEvidence = (e: string): string =>
      e.length > MAX_EVIDENCE_LENGTH ? e.slice(0, MAX_EVIDENCE_LENGTH) : e;
```

Then wrap every `evidence: entry.evidence` in signal constructions with `capEvidence()`:
- `evidence: capEvidence(entry.evidence),` at each of the 9 signal emit sites
- Also the fabricated citation evidence at line ~384: `evidence: capEvidence(\`Confirmed finding cites non-existent code: "${entry.finding.slice(0, 200)}"\`),`

- [ ] **Step 7: Run existing consensus tests**

Run: `npx jest tests/orchestrator/consensus-e2e.test.ts --no-coverage`
Expected: PASS (existing tests use valid signals)

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/consensus-engine.ts tests/orchestrator/verify-citations.test.ts
git commit -m "fix: ConsensusEngine — non-empty taskId fallback, evidence cap, verifyCitations I/O safety"
```

---

### Task 3: Fix `gossip_record_signals` MCP tool — optional task_id, evidence validation, evidence cap

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts` (lines 1912-1968)

- [ ] **Step 1: Add `task_id` to Zod schema**

In `apps/cli/src/mcp-server-sdk.ts`, find the `gossip_record_signals` tool schema (around line 1916). Add `task_id` to the outer level (not inside the signals array):

```typescript
// BEFORE (line 1915):
  {
    signals: z.array(z.object({

// AFTER:
  {
    task_id: z.string().optional().describe('Real task ID to link manual signals to the triggering task. If omitted, a synthetic manual-* ID is generated.'),
    signals: z.array(z.object({
```

- [ ] **Step 2: Update handler to use `task_id` and validate evidence**

In the handler function (around line 1925), update the destructuring and formatting:

```typescript
// BEFORE (line 1925):
  async ({ signals }) => {

// AFTER:
  async ({ task_id, signals }) => {
```

Add evidence validation and cap before the formatting loop (after `const timestamp` line):

```typescript
    const MAX_EVIDENCE_LENGTH = 2000;
    const PUNITIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
    const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement']);

    // Validate: punitive signals require evidence
    for (const s of signals) {
      if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
        return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}` }] };
      }
      if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
        return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}` }] };
      }
    }
```

Update the formatting to use real `task_id` when provided, and cap evidence:

```typescript
// BEFORE (line 1937-1945):
      const formatted = signals.map((s, i) => ({
        type: 'consensus' as const,
        taskId: `manual-${timestamp.replace(/[:.]/g, '')}-${i}`,
        signal: s.signal,
        agentId: s.agent_id,
        counterpartId: s.counterpart_id,
        evidence: s.evidence || s.finding,
        timestamp,
      }));

// AFTER:
      const formatted = signals.map((s, i) => ({
        type: 'consensus' as const,
        taskId: task_id || `manual-${timestamp.replace(/[:.]/g, '')}-${i}`,
        signal: s.signal,
        agentId: s.agent_id,
        counterpartId: s.counterpart_id,
        evidence: ((s.evidence || s.finding) ?? '').slice(0, MAX_EVIDENCE_LENGTH),
        timestamp,
      }));
```

- [ ] **Step 3: Verify MCP server starts without error**

Run: `npx tsc --noEmit -p apps/cli/tsconfig.json` (or the relevant tsconfig)
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "feat: gossip_record_signals — optional task_id, evidence validation for punitive signals, evidence cap"
```

---

### Task 4: Fix `gossip_retract_signal` — remove `as any`, validate task_id

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts` (lines 1970-1997)

- [ ] **Step 1: Remove `as any` cast**

In `apps/cli/src/mcp-server-sdk.ts` around line 1987:

```typescript
// BEFORE:
        signal: 'signal_retracted' as any,

// AFTER:
        signal: 'signal_retracted',
```

- [ ] **Step 2: Add task_id validation**

In the handler (around line 1979), add validation before writing:

```typescript
// BEFORE (line 1980):
    try {

// AFTER:
    if (!task_id || task_id.trim().length === 0) {
      return { content: [{ type: 'text' as const, text: 'Error: task_id is required for retraction. Use the task ID from the original signal.' }] };
    }
    try {
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p apps/cli/tsconfig.json`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: gossip_retract_signal — remove as-any cast, validate task_id non-empty"
```

---

### Task 5: Migration — retract 46 empty-taskId signals

**Files:**
- Create: `scripts/migrate-empty-taskid-signals.ts`
- Test: `tests/orchestrator/signal-migration.test.ts`

- [ ] **Step 1: Write the migration test**

Create `tests/orchestrator/signal-migration.test.ts`:

```typescript
import { PerformanceWriter, PerformanceReader } from '@gossip/orchestrator';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Signal migration — empty-taskId retraction', () => {
  const testDir = join(tmpdir(), 'gossip-migration-' + Date.now());
  const filePath = join(testDir, '.gossip', 'agent-performance.jsonl');

  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  it('retracted empty-taskId signals are excluded from scoring', () => {
    // Write a signal with empty taskId (simulating the legacy bug)
    const badSignal = {
      type: 'consensus',
      taskId: '',
      signal: 'hallucination_caught',
      agentId: 'test-agent',
      evidence: 'fabricated finding',
      timestamp: '2026-03-25T10:00:00Z',
    };
    writeFileSync(filePath, JSON.stringify(badSignal) + '\n');

    // Write a retraction using the original's timestamp as taskId
    // (this is how the reader matches when taskId is empty)
    const retraction = {
      type: 'consensus',
      taskId: badSignal.timestamp, // KEY: use original's timestamp
      signal: 'signal_retracted',
      agentId: 'test-agent',
      evidence: 'Retracted: legacy empty-taskId signal',
      timestamp: new Date().toISOString(),
    };
    const writer = new PerformanceWriter(testDir);
    writer.appendSignal(retraction);

    // Verify the reader excludes the retracted signal
    const reader = new PerformanceReader(testDir);
    const scores = reader.getScores();
    const agentScore = scores.get('test-agent');
    // Agent should have no hallucinations counted (retracted)
    expect(agentScore?.hallucinations ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify the test setup works**

Run: `npx jest tests/orchestrator/signal-migration.test.ts --no-coverage`
Expected: PASS (the retraction mechanism already works when keys match)

- [ ] **Step 3: Write the migration script**

Create `scripts/migrate-empty-taskid-signals.ts`:

```typescript
#!/usr/bin/env ts-node
/**
 * One-time migration: retract all signals with empty taskId.
 *
 * These signals cannot be individually retracted via the normal tool because
 * the retraction key uses `agentId + ':' + (taskId || timestamp)`. For empty-taskId
 * signals, the reader keys by `agentId:timestamp`. So we write retraction entries
 * with `taskId = original.timestamp` to make the keys match.
 *
 * Usage: npx ts-node scripts/migrate-empty-taskid-signals.ts [project-root]
 */
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { PerformanceWriter } from '@gossip/orchestrator';

const projectRoot = resolve(process.argv[2] || process.cwd());
const filePath = join(projectRoot, '.gossip', 'agent-performance.jsonl');

if (!existsSync(filePath)) {
  console.log('No agent-performance.jsonl found. Nothing to migrate.');
  process.exit(0);
}

const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
const writer = new PerformanceWriter(projectRoot);

let retracted = 0;
const now = new Date().toISOString();

for (const line of lines) {
  try {
    const signal = JSON.parse(line);
    if (signal.type !== 'consensus') continue;
    if (signal.signal === 'signal_retracted') continue;
    if (typeof signal.taskId === 'string' && signal.taskId.length > 0) continue;

    // Empty taskId — write retraction with original's timestamp as taskId
    writer.appendSignal({
      type: 'consensus',
      taskId: signal.timestamp, // matches reader's fallback key
      signal: 'signal_retracted',
      agentId: signal.agentId,
      evidence: `Migration: retracted legacy signal with empty taskId (original timestamp: ${signal.timestamp})`,
      timestamp: now,
    });
    retracted++;
  } catch {
    // Skip malformed JSON lines
  }
}

console.log(`Migration complete: retracted ${retracted} empty-taskId signals.`);
```

- [ ] **Step 4: Run the migration**

Run: `npx ts-node scripts/migrate-empty-taskid-signals.ts`
Expected: `Migration complete: retracted 46 empty-taskId signals.`

- [ ] **Step 5: Verify scores improved**

Run: `npx ts-node -e "const { PerformanceReader } = require('@gossip/orchestrator'); const r = new PerformanceReader(process.cwd()); const s = r.getScores(); for (const [k,v] of s) console.log(k, v.accuracy.toFixed(2), v.hallucinations);"`
Expected: Hallucination counts should be lower for affected agents since bad signals are now retracted.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-empty-taskid-signals.ts tests/orchestrator/signal-migration.test.ts
git commit -m "feat: migration script to retract 46 empty-taskId signals + round-trip test"
```

---

### Task 6: Run full test suite + verify no regressions

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx jest --no-coverage`
Expected: All tests pass. If any fail due to the new validation catching previously-invalid test signals, fix them by providing valid `taskId`/`timestamp` values.

- [ ] **Step 2: Build check**

Run: `cd packages/orchestrator && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 3: Verify existing signal file is still readable**

Run: `npx ts-node -e "const { PerformanceReader } = require('@gossip/orchestrator'); const r = new PerformanceReader(process.cwd()); console.log('Scores:', r.getScores().size, 'agents');"`
Expected: Prints number of agents with scores (should be >= 4)

---

## Deferred Work (NOT in this plan)

- **Reader fallback removal** (`performance-reader.ts` lines 106, 117): Remove `|| s.timestamp` fallback. **Target: 2026-04-30** after legacy signals age out.
- **File rotation/eviction**: Separate concern for unbounded growth.
- **`consensusId` grouping in reader**: Wait until legacy signals expire.
