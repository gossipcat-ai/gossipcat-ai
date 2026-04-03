import { MemoryWriter } from '@gossip/orchestrator';
import { readFileSync, existsSync, rmSync, readdirSync } from 'fs';
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
    expect(entry.importance).toBeCloseTo(0.8, 1);
    expect(entry.warmth).toBe(1.0);
  });

  it('caps importance at 0.85 even with perfect scores', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry(agentId, {
      taskId: 'perfect',
      task: 'perfect scoring task',
      skills: ['test'],
      scores: { relevance: 5, accuracy: 5, uniqueness: 5 },
    });

    const content = readFileSync(join(memDir, 'tasks.jsonl'), 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.importance).toBeLessThanOrEqual(0.85);
    expect(entry.importance).toBeCloseTo(0.85, 2);
  });

  it('rebuilds MEMORY.md index with recent tasks', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry(agentId, {
      taskId: 'a1', task: 'first task', skills: ['code_review'],
      scores: { relevance: 4, accuracy: 4, uniqueness: 4 },
    });
    await writer.writeTaskEntry(agentId, {
      taskId: 'a2', task: 'second task', skills: ['testing'],
      scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
    });

    writer.rebuildIndex(agentId);

    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    expect(index).toContain(`# Agent Memory — ${agentId}`);
    expect(index).toContain('second task');
    expect(index).toContain('first task');
  });

  it('writes knowledge entry from task result with file names', () => {
    const writer = new MemoryWriter(testDir);
    writer.writeKnowledgeFromResult(agentId, {
      taskId: 'k1',
      task: 'Build the login form',
      result: 'I created `src/login.tsx` and modified `src/app.tsx` to add the route. Used React with TypeScript for the form validation.',
    });

    // Filename is now timestamp-prefixed: YYYY-MM-DDTHH-MM-SS-k1.md
    const knowledgeDir = join(memDir, 'knowledge');
    const files = readdirSync(knowledgeDir).filter(f => f.includes('k1'));
    expect(files.length).toBe(1);

    const content = readFileSync(join(knowledgeDir, files[0]), 'utf-8');
    expect(content).toContain('name:');
    expect(content).toContain('description:');
    expect(content).toContain('importance:');
    expect(content).toContain('src/login.tsx');
    expect(content).toContain('react');
    expect(content).toContain('typescript');
  });

  it('writes knowledge with technology detection', () => {
    const writer = new MemoryWriter(testDir);
    writer.writeKnowledgeFromResult(agentId, {
      taskId: 'k2',
      task: 'Set up the audio engine',
      result: 'Created AudioEngine.js using the Web Audio API. I chose ES modules for the module system and Canvas for rendering.',
    });

    const k2Files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('k2'));
    const content = readFileSync(join(memDir, 'knowledge', k2Files[0]), 'utf-8');
    expect(content).toContain('web audio');
    expect(content).toContain('canvas');
    expect(content).toContain('es modules');
  });

  it('skips knowledge write when result has no extractable facts', () => {
    const writer = new MemoryWriter(testDir);
    writer.writeKnowledgeFromResult(agentId, {
      taskId: 'k3',
      task: 'Review code',
      result: 'OK',
    });

    const knowledgePath = join(memDir, 'knowledge', 'task-k3.md');
    expect(existsSync(knowledgePath)).toBe(false);
  });

  it('knowledge entry is loadable by AgentMemoryReader', () => {
    const writer = new MemoryWriter(testDir);
    writer.writeKnowledgeFromResult(agentId, {
      taskId: 'k4',
      task: 'Build the game grid',
      result: 'Created src/grid.js with a 16x8 grid using Canvas API. I chose vanilla JavaScript with ES modules.',
    });
    writer.rebuildIndex(agentId);

    // Verify the reader can find and load it
    const { AgentMemoryReader } = require('@gossip/orchestrator');
    const reader = new AgentMemoryReader(testDir);
    const memory = reader.loadMemory(agentId, 'build the grid component');
    expect(memory).not.toBeNull();
    expect(memory).toContain('grid.js');
  });

  describe('file extraction (Tier 3)', () => {
    it('rejects code identifiers: this.data, JSON.parse, Object.proto', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f1', task: 'review code',
        result: 'Found issues with this.data and JSON.parse usage. The Object.proto was polluted. Also this.save and console.log were problematic. Check src/main.ts for details.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f1'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      // The Files: line should have src/main.ts but NOT code identifiers
      const filesLine = content.split('\n').find(l => l.startsWith('Files:')) || '';
      expect(filesLine).toContain('src/main.ts');
      expect(filesLine).not.toContain('this.data');
      expect(filesLine).not.toContain('JSON.parse');
      expect(filesLine).not.toContain('Object.proto');
      expect(filesLine).not.toContain('this.save');
      expect(filesLine).not.toContain('console.log');
    });

    it('accepts source files with paths', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f2', task: 'review code',
        result: 'Found bug in packages/orchestrator/src/skill-index.ts at line 42.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f2'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('packages/orchestrator/src/skill-index.ts');
    });

    it('rejects bare config files without paths', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f3', task: 'review config',
        result: 'The skill-index.json file was corrupted. Also package.json needs updating.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f3'));
      if (files.length > 0) {
        const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
        expect(content).not.toMatch(/Files:.*skill-index\.json/);
        expect(content).not.toMatch(/Files:.*package\.json/);
      }
    });

    it('accepts config files with full paths', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f4', task: 'review config',
        result: 'Updated packages/foo/tsconfig.json with strict mode.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f4'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('packages/foo/tsconfig.json');
    });

    it('rejects .env paths as sensitive', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f5', task: 'review security',
        result: 'The config/.env.local file contains API keys that should not be committed.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f5'));
      if (files.length > 0) {
        const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
        expect(content).not.toMatch(/Files:.*\.env/);
      }
    });

    it('accepts bare source files with recognized extensions', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'f6', task: 'review code',
        result: 'The main issue is in app.tsx where the state is not initialized properly.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('f6'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('app.tsx');
    });
  });

  describe('decision extraction (Tier 3)', () => {
    it('matches third-person decisions', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'd1', task: 'architecture review',
        result: 'The team decided to use TypeScript for type safety. We chose React because of the ecosystem.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('d1'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('Decisions:');
    });

    it('does not match passive voice', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'd2', task: 'review code',
        result: 'The variable was decided by the runtime. Using a shared lock for thread safety is common.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('d2'));
      if (files.length > 0) {
        const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
        expect(content).not.toContain('Decisions:');
      }
    });

    it('matches migration decisions', () => {
      const writer = new MemoryWriter(testDir);
      writer.writeKnowledgeFromResult(agentId, {
        taskId: 'd3', task: 'migration review',
        result: 'We migrated to Vitest instead of keeping Jest. The project adopted event sourcing due to audit needs.',
      });
      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('d3'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('Decisions:');
    });
  });

  describe('cognitive summary (LLM)', () => {
    it('uses LLM summary when summaryLlm is set', async () => {
      const writer = new MemoryWriter(testDir);
      writer.setSummaryLlm({
        generate: jest.fn().mockResolvedValue({ text: 'You reviewed skill-index.ts and found a prototype pollution vulnerability via unsanitized agentId. The key lesson: always validate object keys from external input.' }),
      } as any);

      await writer.writeKnowledgeFromResult(agentId, {
        taskId: 'cog1', task: 'review skill-index.ts',
        result: 'Found prototype pollution via __proto__ in skill-index.ts:44. The agentId parameter is used directly as an object key.',
      });

      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('cog1'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      // Should contain LLM summary, not regex fragments
      expect(content).toContain('prototype pollution vulnerability');
      expect(content).toContain('always validate object keys');
      // Should still have metadata
      expect(content).toContain('Files:');
    });

    it('falls back to regex extraction when LLM fails', async () => {
      const writer = new MemoryWriter(testDir);
      writer.setSummaryLlm({
        generate: jest.fn().mockRejectedValue(new Error('API error')),
      } as any);

      await writer.writeKnowledgeFromResult(agentId, {
        taskId: 'cog2', task: 'review code',
        result: 'Found bug in src/auth.ts where input is not validated. I chose to add Zod for schema validation.',
      });

      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('cog2'));
      expect(files.length).toBe(1);
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      // Should fall back to regex — has Decisions and Summary
      expect(content).toContain('src/auth.ts');
    });

    it('produces no LLM call when summaryLlm not set', async () => {
      const writer = new MemoryWriter(testDir);
      // No setSummaryLlm call

      await writer.writeKnowledgeFromResult(agentId, {
        taskId: 'cog3', task: 'review code',
        result: 'Found issues in src/main.ts with error handling.',
      });

      const files = readdirSync(join(memDir, 'knowledge')).filter(f => f.includes('cog3'));
      expect(files.length).toBe(1);
      // Should still work with regex fallback
      const content = readFileSync(join(memDir, 'knowledge', files[0]), 'utf-8');
      expect(content).toContain('src/main.ts');
    });
  });

  it('derives importance from scores via writeTaskEntry', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry('test-agent', {
      taskId: 'imp-test', task: 'test importance', skills: ['testing'],
      scores: { relevance: 5, accuracy: 5, uniqueness: 5 },
    });
    const tasksPath = join(testDir, '.gossip', 'agents', 'test-agent', 'memory', 'tasks.jsonl');
    const entry = JSON.parse(readFileSync(tasksPath, 'utf-8').trim());
    expect(entry.importance).toBe(0.85); // (5+5+5)/15 = 1.0, capped at 0.85
  });

  it('writes session summary entries with low importance', async () => {
    const writer = new MemoryWriter(testDir);
    const projectMemDir = join(testDir, '.gossip', 'agents', '_project', 'memory');

    await writer.writeSessionSummary({
      gossip: 'test gossip',
      consensus: 'test consensus',
      performance: 'test performance',
      gitLog: 'test git log',
    });

    const tasksPath = join(projectMemDir, 'tasks.jsonl');
    expect(existsSync(tasksPath)).toBe(true);
    const content = readFileSync(tasksPath, 'utf-8').trim();
    const entry = JSON.parse(content.split('\n').pop()!);
    expect(entry.importance).toBeCloseTo(0.4, 2);
  });

  it('does not count -session.md files against knowledge cap', async () => {
    const writer = new MemoryWriter(testDir);
    const knowledgeDir = join(memDir, 'knowledge');
    const { mkdirSync: md, writeFileSync: wf } = require('fs');
    md(knowledgeDir, { recursive: true });

    // Write 8 session files + 3 knowledge files = 11 total, but only 3 count
    for (let i = 0; i < 8; i++) {
      wf(join(knowledgeDir, `2026-01-0${i + 1}T00-00-00-session.md`),
        `---\nname: Session ${i}\ndescription: test\nimportance: 0.7\nlastAccessed: 2026-01-0${i + 1}\naccessCount: 0\n---\nSession content`);
    }
    for (let i = 0; i < 3; i++) {
      wf(join(knowledgeDir, `2026-02-0${i + 1}T00-00-00-knowledge.md`),
        `---\nname: Knowledge ${i}\ndescription: test\nimportance: 0.8\nlastAccessed: 2026-02-0${i + 1}\naccessCount: 0\n---\nKnowledge content`);
    }

    // Prune with cap of 5 — should NOT evict knowledge files (only 3 count)
    (writer as any).pruneKnowledgeDir(knowledgeDir, 5);

    const remaining = readdirSync(knowledgeDir).filter(f => f.endsWith('.md') && !f.endsWith('-session.md'));
    expect(remaining).toHaveLength(3);
  });

  it('caps -session.md files at 5, evicting oldest', async () => {
    const writer = new MemoryWriter(testDir);
    const knowledgeDir = join(memDir, 'knowledge');
    const { mkdirSync: md, writeFileSync: wf } = require('fs');
    md(knowledgeDir, { recursive: true });

    for (let i = 0; i < 8; i++) {
      wf(join(knowledgeDir, `2026-01-0${i + 1}T00-00-00-session.md`),
        `---\nname: Session ${i}\ndescription: test\nimportance: 0.7\nlastAccessed: 2026-01-0${i + 1}\naccessCount: 0\n---\nSession`);
    }

    (writer as any).pruneKnowledgeDir(knowledgeDir, 25);

    const sessionFiles = readdirSync(knowledgeDir).filter(f => f.endsWith('-session.md'));
    expect(sessionFiles).toHaveLength(5);
    // Oldest 3 should be gone (files sort lexicographically, oldest = smallest date prefix)
    expect(sessionFiles).not.toContain('2026-01-01T00-00-00-session.md');
    expect(sessionFiles).not.toContain('2026-01-02T00-00-00-session.md');
    expect(sessionFiles).not.toContain('2026-01-03T00-00-00-session.md');
  });

  it('migrates old high-importance _project entries on session save', async () => {
    const writer = new MemoryWriter(testDir);
    const projectMemDir = join(testDir, '.gossip', 'agents', '_project', 'memory');
    const { mkdirSync, writeFileSync: wfs } = require('fs');
    mkdirSync(projectMemDir, { recursive: true });
    const tasksPath = join(projectMemDir, 'tasks.jsonl');

    // Write old entries with importance=1.0 (legacy)
    const oldEntries = [
      JSON.stringify({ taskId: 'old-1', task: 'Session old', importance: 1.0, warmth: 1.0, timestamp: new Date().toISOString(), version: 1, skills: [], scores: { relevance: 5, accuracy: 5, uniqueness: 5 }, findings: 0, hallucinated: 0 }),
      JSON.stringify({ taskId: 'old-2', task: 'Session old 2', importance: 0.9, warmth: 1.0, timestamp: new Date().toISOString(), version: 1, skills: [], scores: { relevance: 5, accuracy: 5, uniqueness: 5 }, findings: 0, hallucinated: 0 }),
    ].join('\n') + '\n';
    wfs(tasksPath, oldEntries);

    await writer.writeSessionSummary({
      gossip: 'test', consensus: 'test', performance: 'test', gitLog: 'test',
    });

    const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry.importance).toBeLessThanOrEqual(0.5);
    }
  });
});
