# Agent Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give worker agents persistent memory — knowledge files, task outcome tracking, warmth-based compaction, and orchestrator-written memories injected at dispatch time.

**Architecture:** Memory reader loads index + relevant knowledge at dispatch, orchestrator writes task outcomes and extracts knowledge after each task. Prompt assembler combines memory + skills into final prompt. No scoring/calibration yet — that comes with Adaptive Team Intelligence.

**Tech Stack:** TypeScript, JSONL for task entries, Markdown with frontmatter for knowledge files, Jest for testing.

**Spec:** `docs/superpowers/specs/2026-03-21-agent-memory-design.md`
**Integration:** `docs/superpowers/specs/2026-03-21-phase3-integration-addendum.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/orchestrator/src/prompt-assembler.ts` | **NEW** — Assemble memory + lens + skills + context into final prompt string (from integration addendum) |
| `packages/orchestrator/src/agent-memory.ts` | **NEW** — Memory reader: load MEMORY.md, select knowledge files by warmth × relevance, format for injection |
| `packages/orchestrator/src/memory-writer.ts` | **NEW** — Write task entries to JSONL, extract knowledge via LLM, update MEMORY.md index |
| `packages/orchestrator/src/memory-compactor.ts` | **NEW** — Warmth calculation, archive cold entries, trigger knowledge distillation |
| `packages/orchestrator/src/types.ts` | **EDIT** — Add TaskMemoryEntry, MemoryFrontmatter types |
| `packages/orchestrator/src/index.ts` | **EDIT** — Export new modules |
| `apps/cli/src/mcp-server-sdk.ts` | **EDIT** — Load memory at dispatch, write memory at collect, use prompt assembler |
| `tests/orchestrator/prompt-assembler.test.ts` | **NEW** — Prompt assembly tests |
| `tests/orchestrator/agent-memory.test.ts` | **NEW** — Memory loading, knowledge selection tests |
| `tests/orchestrator/memory-writer.test.ts` | **NEW** — Task entry writing, index rebuild tests |
| `tests/orchestrator/memory-compactor.test.ts` | **NEW** — Warmth calculation, archival threshold tests |

## Scope Note

**Included:** Memory reading, writing, knowledge extraction, warmth scoring, compaction, prompt assembly, MCP integration.

**Deferred:** Calibration/accuracy tracking (requires Adaptive Team Intelligence scoring), token budget calibration from API usage (requires tracking across multiple dispatches — implement the budget structure now, calibrate later).

---

### Task 1: Types — TaskMemoryEntry + MemoryFrontmatter

**Files:**
- Modify: `packages/orchestrator/src/types.ts`

- [ ] **Step 1: Add memory types to types.ts**

Append to `packages/orchestrator/src/types.ts`:

```typescript
/** Frontmatter for knowledge files — warmth metadata */
export interface MemoryFrontmatter {
  name: string;
  description: string;
  importance: number;        // 0-1
  lastAccessed: string;      // ISO date
  accessCount: number;
  version?: number;
}

/** A single task outcome stored in tasks.jsonl */
export interface TaskMemoryEntry {
  version: number;            // schema version (currently 1)
  taskId: string;
  task: string;               // truncated to 200 chars
  skills: string[];
  lens?: string;
  findings: number;
  hallucinated: number;
  scores: {                   // plural — matches integration addendum normalization
    relevance: number;        // 1-5
    accuracy: number;
    uniqueness: number;
  };
  warmth: number;
  importance: number;         // 0-1, derived from scores
  timestamp: string;
}

/** An archived task entry in archive.jsonl */
export interface ArchivedTaskEntry {
  archivedAt: string;
  reason: string;
  warmth: number;
  entry: TaskMemoryEntry;
}
```

- [ ] **Step 2: Run tests**

Run: `npx jest --no-coverage`
Expected: All tests pass (additive types only)

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/types.ts
git commit -m "feat(orchestrator): add TaskMemoryEntry and MemoryFrontmatter types"
```

---

### Task 2: Prompt Assembler (from Integration Addendum)

**Files:**
- Create: `packages/orchestrator/src/prompt-assembler.ts`
- Create: `tests/orchestrator/prompt-assembler.test.ts`
- Modify: `packages/orchestrator/src/index.ts` — export assemblePrompt

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/prompt-assembler.test.ts
import { assemblePrompt } from '@gossip/orchestrator';

describe('assemblePrompt', () => {
  it('assembles memory + skills', () => {
    const result = assemblePrompt({
      memory: 'memory content here',
      skills: 'skill content here',
    });
    expect(result).toContain('--- MEMORY ---');
    expect(result).toContain('memory content here');
    expect(result).toContain('--- END MEMORY ---');
    expect(result).toContain('--- SKILLS ---');
    expect(result).toContain('skill content here');
    expect(result).toContain('--- END SKILLS ---');
  });

  it('omits memory block when no memory', () => {
    const result = assemblePrompt({ skills: 'skills' });
    expect(result).not.toContain('--- MEMORY ---');
    expect(result).toContain('--- SKILLS ---');
  });

  it('omits lens block when no lens', () => {
    const result = assemblePrompt({ skills: 'skills', memory: 'mem' });
    expect(result).not.toContain('--- LENS ---');
  });

  it('includes lens block between memory and skills', () => {
    const result = assemblePrompt({
      memory: 'mem',
      lens: 'focus on DoS',
      skills: 'skills',
    });
    const memIdx = result.indexOf('--- END MEMORY ---');
    const lensIdx = result.indexOf('--- LENS ---');
    const skillsIdx = result.indexOf('--- SKILLS ---');
    expect(memIdx).toBeLessThan(lensIdx);
    expect(lensIdx).toBeLessThan(skillsIdx);
  });

  it('includes context after skills', () => {
    const result = assemblePrompt({ skills: 'skills', context: 'ctx' });
    expect(result).toContain('\n\nContext:\nctx');
  });

  it('handles all empty — returns empty string', () => {
    expect(assemblePrompt({})).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/prompt-assembler.test.ts --no-coverage`

- [ ] **Step 3: Implement prompt-assembler.ts**

```typescript
// packages/orchestrator/src/prompt-assembler.ts

/**
 * Assemble memory, lens, skills, and context into a single prompt string.
 * Order: MEMORY → LENS → SKILLS → context
 * Each block is only included if content is provided.
 */
export function assemblePrompt(parts: {
  memory?: string;
  lens?: string;
  skills?: string;
  context?: string;
}): string {
  const blocks: string[] = [];

  if (parts.memory) {
    blocks.push(`\n\n--- MEMORY ---\n${parts.memory}\n--- END MEMORY ---`);
  }

  if (parts.lens) {
    blocks.push(`\n\n--- LENS ---\n${parts.lens}\n--- END LENS ---`);
  }

  if (parts.skills) {
    blocks.push(`\n\n--- SKILLS ---\n${parts.skills}\n--- END SKILLS ---`);
  }

  if (parts.context) {
    blocks.push(`\n\nContext:\n${parts.context}`);
  }

  return blocks.join('');
}
```

- [ ] **Step 4: Export from index**

Add to `packages/orchestrator/src/index.ts`:
```typescript
export { assemblePrompt } from './prompt-assembler';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/prompt-assembler.test.ts --no-coverage`
Expected: All 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/prompt-assembler.ts packages/orchestrator/src/index.ts tests/orchestrator/prompt-assembler.test.ts
git commit -m "feat(orchestrator): add prompt assembler for memory + lens + skills injection"
```

---

### Task 3: Memory Reader — Load + Select + Format

**Files:**
- Create: `packages/orchestrator/src/agent-memory.ts`
- Create: `tests/orchestrator/agent-memory.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/agent-memory.test.ts
import { AgentMemoryReader } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AgentMemoryReader', () => {
  const testDir = join(tmpdir(), `gossip-memory-test-${Date.now()}`);
  const agentId = 'test-agent';
  const memDir = join(testDir, '.gossip', 'agents', agentId, 'memory');
  const knowledgeDir = join(memDir, 'knowledge');

  beforeEach(() => {
    mkdirSync(knowledgeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when MEMORY.md does not exist', () => {
    const reader = new AgentMemoryReader(testDir);
    expect(reader.loadMemory(agentId, 'some task')).toBeNull();
  });

  it('loads MEMORY.md content', () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '# Agent Memory\n\n## Knowledge\n- test knowledge');
    const reader = new AgentMemoryReader(testDir);
    const result = reader.loadMemory(agentId, 'some task');
    expect(result).toContain('# Agent Memory');
    expect(result).toContain('test knowledge');
  });

  it('loads relevant knowledge files by keyword match', () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '# Memory\n## Knowledge\n- [relay](knowledge/relay.md) — relay server');
    writeFileSync(join(knowledgeDir, 'relay.md'), '---\nname: relay\ndescription: relay server internals\nimportance: 0.9\nlastAccessed: 2026-03-21\naccessCount: 5\n---\n\n- Auth via JSON frame\n- maxPayload 1MB');
    writeFileSync(join(knowledgeDir, 'unrelated.md'), '---\nname: unrelated\ndescription: database migrations\nimportance: 0.5\nlastAccessed: 2026-03-01\naccessCount: 1\n---\n\n- Use migrations');

    const reader = new AgentMemoryReader(testDir);
    const result = reader.loadMemory(agentId, 'review the relay server');
    expect(result).toContain('Auth via JSON frame');
    expect(result).not.toContain('database migrations');
  });

  it('calculates warmth correctly', () => {
    const reader = new AgentMemoryReader(testDir);
    // importance 0.9, accessed today
    expect(reader.calculateWarmth(0.9, new Date().toISOString())).toBeCloseTo(0.9, 1);
    // importance 0.5, accessed 30 days ago
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    expect(reader.calculateWarmth(0.5, thirtyDaysAgo)).toBeCloseTo(0.25, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/agent-memory.test.ts --no-coverage`

- [ ] **Step 3: Implement agent-memory.ts**

```typescript
// packages/orchestrator/src/agent-memory.ts
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

export class AgentMemoryReader {
  constructor(private projectRoot: string) {}

  /**
   * Load agent memory for injection into prompt.
   * Returns formatted memory string, or null if no memory exists.
   */
  loadMemory(agentId: string, taskText: string): string | null {
    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    const indexPath = join(memDir, 'MEMORY.md');

    if (!existsSync(indexPath)) return null;

    const parts: string[] = [];

    // 1. Always load MEMORY.md index
    parts.push(readFileSync(indexPath, 'utf-8'));

    // 2. Load relevant knowledge files
    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = this.selectKnowledgeFiles(knowledgeDir, taskText);
      for (const file of files) {
        const content = readFileSync(file.path, 'utf-8');
        parts.push(content);
        // Update lastAccessed and accessCount
        this.touchKnowledgeFile(file.path, content);
      }
    }

    // 3. Load calibration if exists
    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      parts.push(readFileSync(calPath, 'utf-8'));
    }

    return parts.join('\n\n');
  }

  /** Select knowledge files ranked by warmth × relevance */
  private selectKnowledgeFiles(knowledgeDir: string, taskText: string): Array<{ path: string; score: number }> {
    const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
    const scored: Array<{ path: string; score: number }> = [];
    const lower = taskText.toLowerCase();

    for (const file of files) {
      const filePath = join(knowledgeDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = this.parseFrontmatter(content);
      if (!frontmatter) continue;

      const warmth = this.calculateWarmth(frontmatter.importance, frontmatter.lastAccessed);
      const relevance = this.calculateRelevance(frontmatter.description, lower);

      if (relevance > 0) {
        scored.push({ path: filePath, score: warmth * relevance });
      }
    }

    // Sort by score descending, take top files (budget: ~5 files max)
    return scored.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /** Calculate warmth: importance × (1 / (1 + daysSinceAccess / 30)) */
  calculateWarmth(importance: number, lastAccessed: string): number {
    const days = (Date.now() - new Date(lastAccessed).getTime()) / 86400000;
    return importance * (1 / (1 + days / 30));
  }

  /** Keyword overlap relevance (0-1) */
  private calculateRelevance(description: string, taskLower: string): number {
    const words = description.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3);
    if (words.length === 0) return 0;
    const matches = words.filter(w => taskLower.includes(w)).length;
    return matches / words.length;
  }

  /** Parse YAML-like frontmatter from markdown */
  private parseFrontmatter(content: string): { name: string; description: string; importance: number; lastAccessed: string; accessCount: number } | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const lines = match[1].split('\n');
    const obj: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length) obj[key.trim()] = rest.join(':').trim();
    }
    return {
      name: obj.name || '',
      description: obj.description || '',
      importance: parseFloat(obj.importance) || 0.5,
      lastAccessed: obj.lastAccessed || new Date().toISOString(),
      accessCount: parseInt(obj.accessCount) || 0,
    };
  }

  /** Update lastAccessed and accessCount in a knowledge file */
  private touchKnowledgeFile(filePath: string, content: string): void {
    const today = new Date().toISOString().split('T')[0];
    let updated = content.replace(/lastAccessed:.*/, `lastAccessed: ${today}`);
    const countMatch = updated.match(/accessCount:\s*(\d+)/);
    if (countMatch) {
      const newCount = parseInt(countMatch[1]) + 1;
      updated = updated.replace(/accessCount:\s*\d+/, `accessCount: ${newCount}`);
    }
    writeFileSync(filePath, updated);
  }
}
```

- [ ] **Step 4: Export from index**

```typescript
export { AgentMemoryReader } from './agent-memory';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/agent-memory.test.ts --no-coverage`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/agent-memory.ts packages/orchestrator/src/index.ts tests/orchestrator/agent-memory.test.ts
git commit -m "feat(orchestrator): add AgentMemoryReader with warmth-based knowledge selection"
```

---

### Task 4: Memory Writer — Task Entries + Knowledge Extraction + Index

**Files:**
- Create: `packages/orchestrator/src/memory-writer.ts`
- Create: `tests/orchestrator/memory-writer.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/memory-writer.test.ts
import { MemoryWriter } from '@gossip/orchestrator';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MemoryWriter', () => {
  const testDir = join(tmpdir(), `gossip-memwriter-test-${Date.now()}`);
  const agentId = 'test-agent';
  const memDir = join(testDir, '.gossip', 'agents', agentId, 'memory');

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates directory structure on first write', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry(agentId, {
      taskId: 'abc',
      task: 'review code',
      skills: ['code_review'],
      scores: { relevance: 4, accuracy: 3, uniqueness: 5 },
    });

    expect(existsSync(join(memDir, 'tasks.jsonl'))).toBe(true);
    expect(existsSync(join(memDir, 'knowledge'))).toBe(true);
    expect(existsSync(join(memDir, 'calibration'))).toBe(true);
  });

  it('appends task entry to tasks.jsonl', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry(agentId, {
      taskId: 'abc',
      task: 'review relay/server.ts for security issues',
      skills: ['security_audit'],
      scores: { relevance: 4, accuracy: 3, uniqueness: 5 },
    });

    const content = readFileSync(join(memDir, 'tasks.jsonl'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.version).toBe(1);
    expect(entry.taskId).toBe('abc');
    expect(entry.task).toBe('review relay/server.ts for security issues');
    expect(entry.scores.relevance).toBe(4);
    expect(entry.importance).toBeCloseTo(0.8, 1); // (4+3+5)/15
    expect(entry.warmth).toBe(1.0);
  });

  it('rebuilds MEMORY.md index with recent tasks', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry(agentId, {
      taskId: 'a1',
      task: 'first task',
      skills: ['code_review'],
      scores: { relevance: 4, accuracy: 4, uniqueness: 4 },
    });
    await writer.writeTaskEntry(agentId, {
      taskId: 'a2',
      task: 'second task',
      skills: ['testing'],
      scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
    });

    writer.rebuildIndex(agentId);

    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    expect(index).toContain(`# Agent Memory — ${agentId}`);
    expect(index).toContain('second task');
    expect(index).toContain('first task');
  });

  it('derives importance from scores correctly', () => {
    const writer = new MemoryWriter(testDir);
    expect(writer.deriveImportance({ relevance: 5, accuracy: 5, uniqueness: 5 })).toBe(1.0);
    expect(writer.deriveImportance({ relevance: 1, accuracy: 1, uniqueness: 1 })).toBeCloseTo(0.2, 1);
    expect(writer.deriveImportance({ relevance: 3, accuracy: 3, uniqueness: 3 })).toBeCloseTo(0.6, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement memory-writer.ts**

```typescript
// packages/orchestrator/src/memory-writer.ts
import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry } from './types';

const memoryLocks = new Map<string, Promise<void>>();

async function withMemoryLock(agentId: string, fn: () => Promise<void>): Promise<void> {
  const prev = memoryLocks.get(agentId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  memoryLocks.set(agentId, next);
  await next;
}

export class MemoryWriter {
  constructor(private projectRoot: string) {}

  private getMemDir(agentId: string): string {
    return join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
  }

  private ensureDirs(agentId: string): string {
    const memDir = this.getMemDir(agentId);
    mkdirSync(join(memDir, 'knowledge'), { recursive: true });
    mkdirSync(join(memDir, 'calibration'), { recursive: true });
    return memDir;
  }

  /** Write a task outcome to tasks.jsonl */
  async writeTaskEntry(agentId: string, data: {
    taskId: string;
    task: string;
    skills: string[];
    scores: { relevance: number; accuracy: number; uniqueness: number };
    lens?: string;
    findings?: number;
  }): Promise<void> {
    const memDir = this.ensureDirs(agentId);
    const entry: TaskMemoryEntry = {
      version: 1,
      taskId: data.taskId,
      task: data.task.slice(0, 200),
      skills: data.skills,
      lens: data.lens,
      findings: data.findings ?? 0,
      hallucinated: 0,
      scores: data.scores,
      warmth: 1.0,
      importance: this.deriveImportance(data.scores),
      timestamp: new Date().toISOString(),
    };
    appendFileSync(join(memDir, 'tasks.jsonl'), JSON.stringify(entry) + '\n');
  }

  /** Derive importance from scores (0-1) */
  deriveImportance(scores: { relevance: number; accuracy: number; uniqueness: number }): number {
    return (scores.relevance + scores.accuracy + scores.uniqueness) / 15;
  }

  /** Rebuild MEMORY.md index from current state */
  rebuildIndex(agentId: string): void {
    const memDir = this.getMemDir(agentId);
    const parts: string[] = [`# Agent Memory — ${agentId}\n`];

    // Knowledge section
    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        parts.push('## Knowledge');
        for (const file of files) {
          const content = readFileSync(join(knowledgeDir, file), 'utf-8');
          const descMatch = content.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : file.replace('.md', '');
          parts.push(`- [${file.replace('.md', '')}](knowledge/${file}) — ${desc}`);
        }
        parts.push('');
      }
    }

    // Calibration section
    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      const content = readFileSync(calPath, 'utf-8');
      const descMatch = content.match(/description:\s*(.+)/);
      parts.push('## Calibration');
      parts.push(`- [accuracy](calibration/accuracy.md) — ${descMatch ? descMatch[1].trim() : 'accuracy data'}`);
      parts.push('');
    }

    // Recent tasks section (last 5)
    const tasksPath = join(memDir, 'tasks.jsonl');
    if (existsSync(tasksPath)) {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5).reverse();
      if (recent.length > 0) {
        parts.push('## Recent Tasks');
        for (const line of recent) {
          try {
            const entry = JSON.parse(line) as TaskMemoryEntry;
            const date = entry.timestamp.split('T')[0];
            parts.push(`- ${date}: ${entry.task}`);
          } catch { /* skip malformed */ }
        }
        parts.push('');
      }
    }

    writeFileSync(join(memDir, 'MEMORY.md'), parts.join('\n'));
  }

  /** Write knowledge file (with locking for concurrent safety) */
  async writeKnowledge(agentId: string, filename: string, content: string): Promise<void> {
    await withMemoryLock(agentId, async () => {
      const memDir = this.ensureDirs(agentId);
      const filePath = join(memDir, 'knowledge', filename);
      writeFileSync(filePath, content);
      this.rebuildIndex(agentId);
    });
  }
}
```

- [ ] **Step 4: Export from index**

```typescript
export { MemoryWriter } from './memory-writer';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/memory-writer.test.ts --no-coverage`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/memory-writer.ts packages/orchestrator/src/index.ts tests/orchestrator/memory-writer.test.ts
git commit -m "feat(orchestrator): add MemoryWriter for task entries and index management"
```

---

### Task 5: Memory Compactor — Warmth + Archival

**Files:**
- Create: `packages/orchestrator/src/memory-compactor.ts`
- Create: `tests/orchestrator/memory-compactor.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/memory-compactor.test.ts
import { MemoryCompactor } from '@gossip/orchestrator';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MemoryCompactor', () => {
  const testDir = join(tmpdir(), `gossip-compactor-test-${Date.now()}`);
  const agentId = 'test-agent';
  const memDir = join(testDir, '.gossip', 'agents', agentId, 'memory');
  const tasksPath = join(memDir, 'tasks.jsonl');
  const archivePath = join(memDir, 'archive.jsonl');

  beforeEach(() => {
    mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeEntries(entries: Array<{ importance: number; daysAgo: number; task: string }>) {
    const lines = entries.map(e => JSON.stringify({
      version: 1,
      taskId: `t-${Math.random().toString(36).slice(2, 6)}`,
      task: e.task,
      skills: ['test'],
      findings: 1,
      hallucinated: 0,
      scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
      warmth: 0, // will be recalculated
      importance: e.importance,
      timestamp: new Date(Date.now() - e.daysAgo * 86400000).toISOString(),
    })).join('\n') + '\n';
    writeFileSync(tasksPath, lines);
  }

  it('does not compact when under threshold', () => {
    writeEntries([
      { importance: 0.9, daysAgo: 0, task: 'recent task' },
    ]);
    const compactor = new MemoryCompactor(testDir);
    const result = compactor.compactIfNeeded(agentId, 10); // threshold 10 entries
    expect(result.archived).toBe(0);
  });

  it('archives coldest entries when over threshold', () => {
    writeEntries([
      { importance: 0.9, daysAgo: 0, task: 'hot task' },
      { importance: 0.1, daysAgo: 60, task: 'cold task 1' },
      { importance: 0.2, daysAgo: 45, task: 'cold task 2' },
      { importance: 0.8, daysAgo: 1, task: 'warm task' },
    ]);
    const compactor = new MemoryCompactor(testDir);
    const result = compactor.compactIfNeeded(agentId, 2); // keep max 2

    expect(result.archived).toBe(2);
    expect(existsSync(archivePath)).toBe(true);

    // Remaining entries should be the warmest
    const remaining = readFileSync(tasksPath, 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(2);

    // Archived entries should be the coldest
    const archived = readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(archived).toHaveLength(2);
    const firstArchived = JSON.parse(archived[0]);
    expect(firstArchived.reason).toBe('warmth_below_threshold');
    expect(firstArchived.entry.task).toContain('cold task');
  });

  it('calculates warmth for entries', () => {
    const compactor = new MemoryCompactor(testDir);
    const w = compactor.calculateWarmth(0.9, new Date().toISOString());
    expect(w).toBeCloseTo(0.9, 1);

    const old = compactor.calculateWarmth(0.5, new Date(Date.now() - 30 * 86400000).toISOString());
    expect(old).toBeCloseTo(0.25, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement memory-compactor.ts**

```typescript
// packages/orchestrator/src/memory-compactor.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry, ArchivedTaskEntry } from './types';

export class MemoryCompactor {
  constructor(private projectRoot: string) {}

  /** Calculate warmth: importance × (1 / (1 + daysSinceAccess / 30)) */
  calculateWarmth(importance: number, timestamp: string): number {
    const days = (Date.now() - new Date(timestamp).getTime()) / 86400000;
    return importance * (1 / (1 + days / 30));
  }

  /**
   * Compact tasks.jsonl if over threshold.
   * Archives coldest entries. Returns count of archived entries.
   */
  compactIfNeeded(agentId: string, maxEntries: number = 20): { archived: number; message?: string } {
    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    const tasksPath = join(memDir, 'tasks.jsonl');

    if (!existsSync(tasksPath)) return { archived: 0 };

    const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
    if (lines.length <= maxEntries) return { archived: 0 };

    // Parse and calculate warmth
    const entries: Array<{ entry: TaskMemoryEntry; warmth: number; line: string }> = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as TaskMemoryEntry;
        const warmth = this.calculateWarmth(entry.importance, entry.timestamp);
        entries.push({ entry, warmth, line });
      } catch { /* skip malformed */ }
    }

    // Sort by warmth ascending (coldest first)
    entries.sort((a, b) => a.warmth - b.warmth);

    // Archive coldest until we're at maxEntries
    const toArchive = entries.slice(0, entries.length - maxEntries);
    const toKeep = entries.slice(entries.length - maxEntries);

    // Write archive
    const archivePath = join(memDir, 'archive.jsonl');
    for (const item of toArchive) {
      const archived: ArchivedTaskEntry = {
        archivedAt: new Date().toISOString(),
        reason: 'warmth_below_threshold',
        warmth: item.warmth,
        entry: item.entry,
      };
      appendFileSync(archivePath, JSON.stringify(archived) + '\n');
    }

    // Rewrite tasks.jsonl with remaining entries
    writeFileSync(tasksPath, toKeep.map(e => e.line).join('\n') + '\n');

    const message = `Compacted ${toArchive.length} memories for ${agentId}`;
    return { archived: toArchive.length, message };
  }
}
```

- [ ] **Step 4: Export from index**

```typescript
export { MemoryCompactor } from './memory-compactor';
```

- [ ] **Step 5: Run tests**

Run: `npx jest tests/orchestrator/memory-compactor.test.ts --no-coverage`
Expected: All 3 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/memory-compactor.ts packages/orchestrator/src/index.ts tests/orchestrator/memory-compactor.test.ts
git commit -m "feat(orchestrator): add MemoryCompactor with warmth-based archival"
```

---

### Task 6: MCP Server Integration — Memory at Dispatch + Write at Collect

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts`

- [ ] **Step 1: Read current dispatch and collect handlers**

Read `apps/cli/src/mcp-server-sdk.ts` to understand the current structure.

- [ ] **Step 2: Add memory loading to gossip_dispatch handler**

After `loadSkills` (line 160) and before `worker.executeTask` (line 171), add memory loading and use prompt assembler:

```typescript
// Load agent memory
const { AgentMemoryReader, assemblePrompt } = await import('@gossip/orchestrator');
const memoryReader = new AgentMemoryReader(process.cwd());
const memoryContent = memoryReader.loadMemory(agent_id, task);

// Assemble prompt: memory + skills
const promptContent = assemblePrompt({
  memory: memoryContent || undefined,
  skills: skillsContent,
});
```

Then change `worker.executeTask(task, undefined, skillsContent)` to:
```typescript
worker.executeTask(task, undefined, promptContent)
```

- [ ] **Step 3: Do the same in gossip_dispatch_parallel handler**

Same pattern — load memory per agent, assemble prompt, pass to executeTask.

- [ ] **Step 4: Add memory writing to gossip_collect handler**

After the existing post-collect processing (skill gap tracker), add memory writing:

```typescript
// Write agent memories (async, non-blocking)
try {
  const { MemoryWriter } = await import('@gossip/orchestrator');
  const memWriter = new MemoryWriter(process.cwd());
  for (const t of targets) {
    if (t.status === 'completed') {
      await memWriter.writeTaskEntry(t.agentId, {
        taskId: t.id,
        task: t.task,
        skills: [], // TODO: pass skills from dispatch entry
        scores: { relevance: 3, accuracy: 3, uniqueness: 3 }, // TODO: real scoring from Adaptive Team
      });
      memWriter.rebuildIndex(t.agentId);
    }
  }
  // Check compaction
  const { MemoryCompactor } = await import('@gossip/orchestrator');
  const compactor = new MemoryCompactor(process.cwd());
  for (const t of targets) {
    if (t.status === 'completed') {
      const result = compactor.compactIfNeeded(t.agentId);
      if (result.message) {
        process.stderr.write(`[gossipcat] ${result.message}\n`);
      }
    }
  }
} catch { /* memory write failure is non-blocking */ }
```

Note: Scores are hardcoded to 3/3/3 for now — real scoring comes with Adaptive Team Intelligence. The important thing is the pipeline is in place.

- [ ] **Step 5: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass

- [ ] **Step 6: Build MCP**

Run: `npm run build:mcp`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "feat(mcp): integrate agent memory — load at dispatch, write at collect"
```

---

### Task 7: Final Integration Test

- [ ] **Step 1: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass

- [ ] **Step 2: Build MCP**

Run: `npm run build:mcp`

- [ ] **Step 3: Verify no loose changes**

```bash
git status
```

---

## Execution Order

Task 1 first (types used by everything). Tasks 2-5 are independent of each other. Task 6 depends on 2-5. Task 7 runs last.

```
Task 1 (Types) ──→ Task 2 (Prompt Assembler) ──┐
                   Task 3 (Memory Reader) ──────┤
                   Task 4 (Memory Writer) ──────┼──→ Task 6 (MCP Integration) ──→ Task 7
                   Task 5 (Compactor) ──────────┘
```
