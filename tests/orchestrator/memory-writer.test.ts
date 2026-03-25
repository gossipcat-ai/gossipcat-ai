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

  it('derives importance from scores via writeTaskEntry', async () => {
    const writer = new MemoryWriter(testDir);
    await writer.writeTaskEntry('test-agent', {
      taskId: 'imp-test', task: 'test importance', skills: ['testing'],
      scores: { relevance: 5, accuracy: 5, uniqueness: 5 },
    });
    const tasksPath = join(testDir, '.gossip', 'agents', 'test-agent', 'memory', 'tasks.jsonl');
    const entry = JSON.parse(readFileSync(tasksPath, 'utf-8').trim());
    expect(entry.importance).toBe(1.0); // (5+5+5)/15 = 1.0
  });
});
