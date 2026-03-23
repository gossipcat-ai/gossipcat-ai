# Adaptive Team Intelligence (Tier 1+2 MVP) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When agents are co-dispatched with overlapping skills, automatically differentiate them with unique focus lenses so they produce complementary findings instead of duplicate ones.

**Architecture:** An `OverlapDetector` analyzes agent configs for shared skills by preset. A `LensGenerator` makes one cheap LLM call to create differentiated focus directives. Lenses flow through `DispatchOptions.lens` into the existing `assemblePrompt({ lens })` plumbing. No structural rewrites — just wiring new modules into existing hooks.

**Tech Stack:** TypeScript, existing `ILLMProvider` interface, Jest, existing `DispatchPipeline`/`assemblePrompt`

**Spec:** `docs/superpowers/specs/2026-03-23-adaptive-team-intelligence-v2.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/orchestrator/src/overlap-detector.ts` | Create | Preset-aware skill overlap analysis |
| `packages/orchestrator/src/lens-generator.ts` | Create | LLM-based lens generation for co-dispatched agents |
| `packages/orchestrator/src/types.ts` | Modify | Add `LensAssignment`, `OverlapResult` types; add `lens` to `DispatchOptions` |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Modify | Wire overlap detection + lens generation into `dispatchParallel`; pass `options.lens` to `assemblePrompt` in `dispatch` |
| `packages/orchestrator/src/index.ts` | Modify | Export new modules |
| `apps/cli/src/config.ts` | Modify | Add optional `utility_model` to `GossipConfig` |
| `apps/cli/src/mcp-server-sdk.ts` | Modify | Create utility LLM provider in `doBoot()`, pass to pipeline |
| `tests/orchestrator/overlap-detector.test.ts` | Create | Overlap classification tests |
| `tests/orchestrator/lens-generator.test.ts` | Create | Lens generation with mocked LLM |
| `tests/orchestrator/dispatch-pipeline-lens.test.ts` | Create | Integration: dispatch with lenses |

---

### Task 1: Types — `OverlapResult`, `LensAssignment`, `DispatchOptions.lens`

**Files:**
- Modify: `packages/orchestrator/src/types.ts`

- [ ] **Step 1: Add new types**

Add after the `DispatchOptions` interface in `packages/orchestrator/src/types.ts`:

```typescript
/** Result of analyzing skill overlap between co-dispatched agents */
export interface OverlapResult {
  hasOverlaps: boolean;
  agents: Array<{ id: string; preset: string; skills: string[] }>;
  sharedSkills: string[];
  pairs: Array<{ agentA: string; agentB: string; shared: string[]; type: 'redundant' | 'complementary' }>;
}

/** A focus lens assigned to an agent for a specific dispatch */
export interface LensAssignment {
  agentId: string;
  focus: string;
  avoidOverlap: string;
}
```

- [ ] **Step 2: Add `lens` to `DispatchOptions`**

Add to the `DispatchOptions` interface:

```typescript
export interface DispatchOptions {
  writeMode?: 'sequential' | 'scoped' | 'worktree';
  scope?: string;
  timeoutMs?: number;
  planId?: string;
  step?: number;
  lens?: string;  // NEW — focus lens from adaptive team intelligence
}
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: All tests pass (additive changes only)

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/types.ts
git commit -m "feat(types): add OverlapResult, LensAssignment, lens field on DispatchOptions"
```

---

### Task 2: Overlap Detector

**Files:**
- Create: `packages/orchestrator/src/overlap-detector.ts`
- Create: `tests/orchestrator/overlap-detector.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/overlap-detector.test.ts
import { OverlapDetector } from '../../packages/orchestrator/src/overlap-detector';
import type { AgentConfig } from '../../packages/orchestrator/src/types';

function agent(id: string, preset: string, skills: string[]): AgentConfig {
  return { id, provider: 'google', model: 'gemini-2.5-pro', preset, skills };
}

describe('OverlapDetector', () => {
  const detector = new OverlapDetector();

  it('detects redundant overlap (same preset, shared skills)', () => {
    const agents = [
      agent('gemini-rev', 'reviewer', ['code_review', 'security_audit']),
      agent('gpt-rev', 'reviewer', ['code_review', 'typescript']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.sharedSkills).toContain('code_review');
    expect(result.pairs[0].type).toBe('redundant');
  });

  it('detects complementary overlap (different presets, shared skills)', () => {
    const agents = [
      agent('rev', 'reviewer', ['code_review', 'security_audit']),
      agent('dbg', 'debugger', ['code_review', 'debugging']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs[0].type).toBe('complementary');
  });

  it('returns no overlaps when skills are disjoint', () => {
    const agents = [
      agent('rev', 'reviewer', ['code_review']),
      agent('impl', 'implementer', ['typescript']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(false);
    expect(result.pairs).toHaveLength(0);
  });

  it('returns no overlaps for a single agent', () => {
    const result = detector.detect([agent('rev', 'reviewer', ['code_review'])]);
    expect(result.hasOverlaps).toBe(false);
  });

  it('handles multiple pairs of overlaps', () => {
    const agents = [
      agent('a', 'reviewer', ['code_review', 'debugging']),
      agent('b', 'reviewer', ['code_review', 'typescript']),
      agent('c', 'tester', ['debugging', 'testing']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/overlap-detector.test.ts --no-coverage 2>&1 | head -10`
Expected: FAIL — module not found

- [ ] **Step 3: Implement OverlapDetector**

```typescript
// packages/orchestrator/src/overlap-detector.ts
import type { AgentConfig, OverlapResult } from './types';

export class OverlapDetector {
  detect(agents: AgentConfig[]): OverlapResult {
    const pairs: OverlapResult['pairs'] = [];
    const allShared = new Set<string>();

    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const shared = a.skills.filter(s => b.skills.includes(s));
        if (shared.length > 0) {
          const type = a.preset === b.preset ? 'redundant' : 'complementary';
          pairs.push({ agentA: a.id, agentB: b.id, shared, type });
          shared.forEach(s => allShared.add(s));
        }
      }
    }

    return {
      hasOverlaps: pairs.length > 0,
      agents: agents.map(a => ({ id: a.id, preset: a.preset || 'custom', skills: a.skills })),
      sharedSkills: Array.from(allShared),
      pairs,
    };
  }

  /** Format a one-line boot warning */
  formatWarning(result: OverlapResult): string | null {
    const redundant = result.pairs.filter(p => p.type === 'redundant');
    if (redundant.length === 0) return null;
    return redundant.map(p =>
      `${p.agentA} ∩ ${p.agentB} (same preset): ${p.shared.join(', ')}`
    ).join('\n  ');
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator/overlap-detector.test.ts --no-coverage 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/overlap-detector.ts tests/orchestrator/overlap-detector.test.ts
git commit -m "feat(overlap): add OverlapDetector with preset-aware skill analysis"
```

---

### Task 3: Lens Generator

**Files:**
- Create: `packages/orchestrator/src/lens-generator.ts`
- Create: `tests/orchestrator/lens-generator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/lens-generator.test.ts
import { LensGenerator } from '../../packages/orchestrator/src/lens-generator';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import type { LLMResponse } from '@gossip/types';

function mockLLM(response: string): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: response, toolCalls: [] } as LLMResponse),
  } as any;
}

describe('LensGenerator', () => {
  const agents = [
    { id: 'rev', preset: 'reviewer', skills: ['code_review', 'security_audit'] },
    { id: 'tst', preset: 'tester', skills: ['code_review', 'testing'] },
  ];
  const task = 'Review the authentication module';
  const sharedSkills = ['code_review'];

  it('generates valid lenses on happy path', async () => {
    const llm = mockLLM(JSON.stringify([
      { agentId: 'rev', focus: 'Focus on vulnerability identification', avoidOverlap: 'Do not check test coverage' },
      { agentId: 'tst', focus: 'Focus on testing gaps', avoidOverlap: 'Do not check for vulnerabilities' },
    ]));
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(2);
    expect(lenses[0].agentId).toBe('rev');
    expect(lenses[1].agentId).toBe('tst');
  });

  it('returns empty array on LLM failure', async () => {
    const llm = { generate: jest.fn().mockRejectedValue(new Error('Network error')) } as any;
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0);
  });

  it('returns empty array on malformed JSON', async () => {
    const llm = mockLLM('not valid json {{{');
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0);
  });

  it('includes agent presets and shared skills in the prompt', async () => {
    const llm = mockLLM('[]');
    const gen = new LensGenerator(llm);
    await gen.generateLenses(agents, task, sharedSkills);
    const prompt = (llm.generate as jest.Mock).mock.calls[0][0];
    const systemMsg = prompt.find((m: any) => m.role === 'system')?.content || '';
    expect(systemMsg).toContain('reviewer');
    expect(systemMsg).toContain('tester');
    expect(systemMsg).toContain('code_review');
  });

  it('detects semantically similar lenses and returns empty', async () => {
    const llm = mockLLM(JSON.stringify([
      { agentId: 'rev', focus: 'Focus on code quality and correctness', avoidOverlap: '' },
      { agentId: 'tst', focus: 'Focus on code correctness and quality', avoidOverlap: '' },
    ]));
    const gen = new LensGenerator(llm);
    const lenses = await gen.generateLenses(agents, task, sharedSkills);
    expect(lenses).toHaveLength(0); // rejected — too similar
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/lens-generator.test.ts --no-coverage 2>&1 | head -10`
Expected: FAIL — module not found

- [ ] **Step 3: Implement LensGenerator**

```typescript
// packages/orchestrator/src/lens-generator.ts
import type { ILLMProvider } from './llm-client';
import type { LLMMessage } from '@gossip/types';
import type { LensAssignment } from './types';

const STOP_WORDS = new Set(['the', 'a', 'an', 'on', 'in', 'for', 'and', 'or', 'to', 'of', 'is', 'do', 'not', 'focus']);

export class LensGenerator {
  constructor(private llm: ILLMProvider) {}

  async generateLenses(
    agents: Array<{ id: string; preset: string; skills: string[] }>,
    task: string,
    sharedSkills: string[],
  ): Promise<LensAssignment[]> {
    if (agents.length < 2 || sharedSkills.length === 0) return [];

    const agentList = agents.map(a => `- ${a.id} (${a.preset}): skills=[${a.skills.join(', ')}]`).join('\n');
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are assigning review focuses to ${agents.length} agents working on the same task.
Each agent should have a UNIQUE focus that avoids duplicating another's work.
Consider their presets and skills when assigning focus areas.

Agents:
${agentList}

Shared skills: ${sharedSkills.join(', ')}

Return a JSON array of { "agentId": string, "focus": string, "avoidOverlap": string } for each agent.
Return ONLY the JSON array, no other text.`,
      },
      { role: 'user', content: `Task: ${task}` },
    ];

    try {
      const response = await this.llm.generate(messages, { temperature: 0.3 });
      const text = (response.text || '').trim();
      // Extract JSON array from response (handle markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as LensAssignment[];
      if (!Array.isArray(parsed)) return [];
      // Validate shape
      const valid = parsed.filter(l => l.agentId && l.focus);
      if (valid.length !== agents.length) return [];
      // Quality check: reject if lenses are too similar
      if (!this.areDifferentiated(valid)) return [];
      return valid;
    } catch {
      return [];
    }
  }

  /** Check that lenses are meaningfully different (>50% shared significant words = too similar) */
  private areDifferentiated(lenses: LensAssignment[]): boolean {
    for (let i = 0; i < lenses.length; i++) {
      for (let j = i + 1; j < lenses.length; j++) {
        const wordsA = this.significantWords(lenses[i].focus);
        const wordsB = this.significantWords(lenses[j].focus);
        const intersection = wordsA.filter(w => wordsB.includes(w));
        const minLen = Math.min(wordsA.length, wordsB.length);
        if (minLen > 0 && intersection.length / minLen > 0.5) return false;
      }
    }
    return true;
  }

  private significantWords(text: string): string[] {
    return text.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator/lens-generator.test.ts --no-coverage 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/lens-generator.ts tests/orchestrator/lens-generator.test.ts
git commit -m "feat(lens): add LensGenerator with quality check and graceful degradation"
```

---

### Task 4: Wire Lenses into DispatchPipeline

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`
- Create: `tests/orchestrator/dispatch-pipeline-lens.test.ts`

- [ ] **Step 1: Write failing integration test**

```typescript
// tests/orchestrator/dispatch-pipeline-lens.test.ts
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';
import { TaskGraph } from '../../packages/orchestrator/src/task-graph';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function mockWorker(result = 'done') {
  return {
    executeTask: jest.fn().mockResolvedValue({ result, inputTokens: 0, outputTokens: 0 }),
    subscribeToBatch: jest.fn().mockResolvedValue(undefined),
    unsubscribeFromBatch: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DispatchPipeline lens integration', () => {
  let tmpDir: string;
  let workers: Map<string, any>;
  let pipeline: DispatchPipeline;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dp-lens-'));
    workers = new Map([
      ['rev', mockWorker('review done')],
      ['tst', mockWorker('test done')],
    ]);
    pipeline = new DispatchPipeline({
      projectRoot: tmpDir,
      workers,
      registryGet: (id) => ({
        id, provider: 'google' as const, model: 'gemini-2.5-pro',
        preset: id === 'rev' ? 'reviewer' : 'tester',
        skills: id === 'rev' ? ['code_review', 'security'] : ['code_review', 'testing'],
      }),
    });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('passes lens through to executeTask prompt when options.lens is set', () => {
    pipeline.dispatch('rev', 'review code', { lens: 'Focus on security vulnerabilities' });
    const prompt = workers.get('rev')!.executeTask.mock.calls[0][2];
    expect(prompt).toContain('LENS');
    expect(prompt).toContain('Focus on security vulnerabilities');
  });

  it('does not include lens when options.lens is undefined', () => {
    pipeline.dispatch('rev', 'review code');
    const prompt = workers.get('rev')!.executeTask.mock.calls[0][2];
    expect(prompt).not.toContain('LENS');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/dispatch-pipeline-lens.test.ts --no-coverage 2>&1 | head -15`
Expected: FAIL — lens not in prompt (assemblePrompt doesn't receive it yet)

- [ ] **Step 3: Wire `options.lens` into `dispatch()` method**

In `packages/orchestrator/src/dispatch-pipeline.ts`, find the `assemblePrompt` call in `dispatch()` (~line 145) and add `lens`:

Change:
```typescript
const promptContent = assemblePrompt({
  memory: memory || undefined,
  skills,
  sessionContext: sessionContext || undefined,
  chainContext: chainContext || undefined,
});
```

To:
```typescript
const promptContent = assemblePrompt({
  memory: memory || undefined,
  skills,
  lens: options?.lens,
  sessionContext: sessionContext || undefined,
  chainContext: chainContext || undefined,
});
```

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator/dispatch-pipeline-lens.test.ts --no-coverage 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts tests/orchestrator/dispatch-pipeline-lens.test.ts
git commit -m "feat(pipeline): wire DispatchOptions.lens through to assemblePrompt"
```

---

### Task 5: Wire Lens Generation into `dispatchParallel`

**Files:**
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`

- [ ] **Step 1: Add OverlapDetector and LensGenerator to DispatchPipelineConfig**

Add imports at the top of `dispatch-pipeline.ts`:

```typescript
import { OverlapDetector } from './overlap-detector';
import { LensGenerator } from './lens-generator';
```

Add optional fields to `DispatchPipelineConfig`:

```typescript
export interface DispatchPipelineConfig {
  projectRoot: string;
  workers: Map<string, WorkerLike>;
  registryGet: (agentId: string) => AgentConfig | undefined;
  gossipPublisher?: GossipPublisher | null;
  llm?: ILLMProvider;
  syncFactory?: () => TaskGraphSync | null;
  toolServer?: ToolServerCallbacks | null;
  overlapDetector?: OverlapDetector | null;   // NEW
  lensGenerator?: LensGenerator | null;        // NEW
}
```

Store them in the constructor:

```typescript
this.overlapDetector = config.overlapDetector ?? null;
this.lensGenerator = config.lensGenerator ?? null;
```

Add private fields:

```typescript
private readonly overlapDetector: OverlapDetector | null;
private readonly lensGenerator: LensGenerator | null;
```

- [ ] **Step 2: Add lens generation to `dispatchParallel`**

In the `dispatchParallel` method, after the write-mode pre-validation block and before the "Subscribe workers to batch channel" block (~line 500), add:

```typescript
    // Lens generation for overlapping agents
    let lensMap: Map<string, string> | null = null;
    if (this.overlapDetector && this.lensGenerator) {
      const agentConfigs = taskDefs
        .map(d => this.registryGet(d.agentId))
        .filter((c): c is AgentConfig => c !== undefined);
      const overlapResult = this.overlapDetector.detect(agentConfigs);
      if (overlapResult.hasOverlaps) {
        try {
          const lenses = await this.lensGenerator.generateLenses(
            overlapResult.agents, taskDefs[0]?.task || '', overlapResult.sharedSkills
          );
          if (lenses.length > 0) {
            lensMap = new Map(lenses.map(l => [l.agentId, l.focus]));
            log(`Applied lenses:\n${lenses.map(l => `  ${l.agentId} → ${l.focus.slice(0, 80)}`).join('\n')}`);
          }
        } catch (err) {
          log(`Lens generation failed: ${(err as Error).message}. Dispatching without lenses.`);
        }
      }
    }
```

Then in the dispatch loop (~line 510), pass the lens:

Change:
```typescript
const { taskId, promise } = this.dispatch(def.agentId, def.task, def.options);
```

To:
```typescript
const lens = lensMap?.get(def.agentId);
const { taskId, promise } = this.dispatch(def.agentId, def.task, {
  ...def.options,
  ...(lens ? { lens } : {}),
});
```

- [ ] **Step 3: Make `dispatchParallel` async**

The method signature needs to become `async` since `lensGenerator.generateLenses` is async. Change:

```typescript
dispatchParallel(taskDefs: ...): { taskIds: string[]; errors: string[] } {
```

To:

```typescript
async dispatchParallel(taskDefs: ...): Promise<{ taskIds: string[]; errors: string[] }> {
```

Then update ALL callers:

**`packages/orchestrator/src/main-agent.ts` (~line 126):**
```typescript
async dispatchParallel(tasks: Array<{ agentId: string; task: string; options?: DispatchOptions }>) {
  return this.pipeline.dispatchParallel(tasks);
}
```

**`apps/cli/src/mcp-server-sdk.ts` (~line 439):**
```typescript
const { taskIds, errors } = await mainAgent.dispatchParallel(
  taskDefs.map((d: any) => ({
    agentId: d.agent_id,
    task: d.task,
    options: d.write_mode ? { writeMode: d.write_mode, scope: d.scope } : undefined,
  }))
);
```
(Add `await` — without it, destructuring hits a Promise and `taskIds`/`errors` are `undefined`.)

**`tests/orchestrator/dispatch-pipeline.test.ts`:**
All `dispatchParallel` calls must be `await`ed. Find every occurrence (approximately lines 171, 180, 190, 198, 213) and add `await`. The test functions must also be `async`. Example:
```typescript
// Before:
const { taskIds, errors } = pipeline.dispatchParallel([...]);
// After:
const { taskIds, errors } = await pipeline.dispatchParallel([...]);
```

**`tests/orchestrator/dispatch-pipeline-gossip.test.ts`:**
Same — find all `dispatchParallel` calls and add `await`.

- [ ] **Step 4: Run full tests**

Run: `npx jest --no-coverage 2>&1 | tail -10`
Expected: All tests pass after adding `await` to all callers

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/dispatch-pipeline.ts packages/orchestrator/src/main-agent.ts apps/cli/src/mcp-server-sdk.ts
git commit -m "feat(pipeline): wire lens generation into dispatchParallel with overlap detection"
```

---

### Task 6: Export New Modules + Boot Warning

NOTE: This task comes before the boot wiring (Task 7) so exports are available when `doBoot()` imports them.

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts` (boot warning)

- [ ] **Step 1: Add exports to index.ts**

```typescript
export { OverlapDetector } from './overlap-detector';
export { LensGenerator } from './lens-generator';
```

- [ ] **Step 2: Add one-time boot overlap warning**

In `DispatchPipeline`, add a `bootWarningShown` flag and log overlap warnings on first `dispatchParallel` call:

```typescript
private bootWarningShown = false;

// At the start of dispatchParallel, before validation:
if (!this.bootWarningShown && this.overlapDetector) {
  const allAgents = taskDefs
    .map(d => this.registryGet(d.agentId))
    .filter((c): c is AgentConfig => c !== undefined);
  const result = this.overlapDetector.detect(allAgents);
  const warning = this.overlapDetector.formatWarning(result);
  if (warning) log(`Skill overlap detected:\n  ${warning}`);
  this.bootWarningShown = true;
}
```

- [ ] **Step 3: Run full tests**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/index.ts packages/orchestrator/src/dispatch-pipeline.ts
git commit -m "feat(overlap): export new modules, add one-time boot overlap warning"
```

---

### Task 7: Utility Model Config + Boot Wiring

**Files:**
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/cli/src/mcp-server-sdk.ts`
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts`

The key challenge: `MainAgent` constructs `DispatchPipeline` internally. We cannot pass `overlapDetector`/`lensGenerator` through `MainAgentConfig` without modifying both. Instead, use the existing `setGossipPublisher` pattern — add setter methods on `DispatchPipeline`.

- [ ] **Step 1: Add setter methods to DispatchPipeline**

In `packages/orchestrator/src/dispatch-pipeline.ts`, add after `setGossipPublisher`:

```typescript
setOverlapDetector(detector: OverlapDetector | null): void {
  this.overlapDetector = detector;
}

setLensGenerator(generator: LensGenerator | null): void {
  this.lensGenerator = generator;
}
```

Also add passthrough methods on `MainAgent` in `packages/orchestrator/src/main-agent.ts`:

```typescript
setOverlapDetector(detector: any): void { this.pipeline.setOverlapDetector(detector); }
setLensGenerator(generator: any): void { this.pipeline.setLensGenerator(generator); }
```

- [ ] **Step 2: Add `utility_model` to `GossipConfig`**

In `apps/cli/src/config.ts`, add to the `GossipConfig` interface:

```typescript
export interface GossipConfig {
  main_agent: {
    provider: string;
    model: string;
  };
  utility_model?: {
    provider: string;
    model: string;
  };
  agents?: Record<string, {
    provider: string;
    model: string;
    preset?: string;
    skills: string[];
  }>;
}
```

- [ ] **Step 3: Wire in `doBoot()`**

In `apps/cli/src/mcp-server-sdk.ts`, AFTER `mainAgent` is constructed in `doBoot()`, add:

```typescript
// Wire adaptive team intelligence
const { OverlapDetector, LensGenerator, createProvider: cp } = await import('@gossip/orchestrator');
const utilityLlm = config.utility_model
  ? cp(config.utility_model.provider as any, config.utility_model.model, await keychain.getKey(config.utility_model.provider))
  : mainLlm;  // mainLlm is whatever provider was created for main_agent
mainAgent.setOverlapDetector(new OverlapDetector());
mainAgent.setLensGenerator(new LensGenerator(utilityLlm));
```

NOTE: Read `doBoot()` to find `mainLlm` — it may be named differently. The key is to get the LLM provider that was created for `main_agent` and reuse it as fallback.

- [ ] **Step 4: Run full tests**

Run: `npx jest --no-coverage 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/config.ts apps/cli/src/mcp-server-sdk.ts packages/orchestrator/src/dispatch-pipeline.ts packages/orchestrator/src/main-agent.ts
git commit -m "feat(config): add utility_model support, wire OverlapDetector + LensGenerator via setters"
```

---

### Task 8: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npx jest --no-coverage 2>&1`
Expected: All tests pass

- [ ] **Step 2: TypeScript compilation check**

Run: `npx tsc --noEmit 2>&1 | tail -20`
Expected: No new type errors

- [ ] **Step 3: Verify lens plumbing works end-to-end**

Run: `npx tsx -e "
const { OverlapDetector } = require('./packages/orchestrator/src/overlap-detector');
const d = new OverlapDetector();
const r = d.detect([
  { id: 'rev', provider: 'google', model: 'x', preset: 'reviewer', skills: ['code_review', 'security'] },
  { id: 'tst', provider: 'google', model: 'x', preset: 'tester', skills: ['code_review', 'testing'] },
]);
console.log('hasOverlaps:', r.hasOverlaps);
console.log('sharedSkills:', r.sharedSkills);
console.log('pairs:', r.pairs);
"`
Expected: Shows complementary overlap on `code_review`

- [ ] **Step 4: Final commit if needed**

```bash
git add -A && git commit -m "fix: integration fixups for adaptive team intelligence"
```
