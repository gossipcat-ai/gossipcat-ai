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
      warmth: 0,
      importance: e.importance,
      timestamp: new Date(Date.now() - e.daysAgo * 86400000).toISOString(),
    })).join('\n') + '\n';
    writeFileSync(tasksPath, lines);
  }

  it('does not compact when under threshold', () => {
    writeEntries([{ importance: 0.9, daysAgo: 0, task: 'recent task' }]);
    const compactor = new MemoryCompactor(testDir);
    const result = compactor.compactIfNeeded(agentId, 10);
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
    const result = compactor.compactIfNeeded(agentId, 2);

    expect(result.archived).toBe(2);
    expect(existsSync(archivePath)).toBe(true);

    const remaining = readFileSync(tasksPath, 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(2);

    const archived = readFileSync(archivePath, 'utf-8').trim().split('\n');
    expect(archived).toHaveLength(2);
    const firstArchived = JSON.parse(archived[0]);
    expect(firstArchived.reason).toBe('warmth_below_threshold');
  });

  it('compacts _project entries to cap of 15', () => {
    const projectMemDir = join(testDir, '.gossip', 'agents', '_project', 'memory');
    mkdirSync(projectMemDir, { recursive: true });
    const projectTasksPath = join(projectMemDir, 'tasks.jsonl');

    // Write 20 entries — should compact to 15
    const entries = Array.from({ length: 20 }, (_, i) => JSON.stringify({
      version: 1,
      taskId: `session-${i}`,
      task: `Session ${i}`,
      skills: [],
      findings: 0,
      hallucinated: 0,
      scores: { relevance: 2, accuracy: 2, uniqueness: 2 },
      warmth: 0,
      importance: 0.4,
      timestamp: new Date(Date.now() - (20 - i) * 86400000).toISOString(),
    })).join('\n') + '\n';
    writeFileSync(projectTasksPath, entries);

    const compactor = new MemoryCompactor(testDir);
    const result = compactor.compactIfNeeded('_project', 15);

    expect(result.archived).toBe(5);
    const remaining = readFileSync(projectTasksPath, 'utf-8').trim().split('\n');
    expect(remaining).toHaveLength(15);
  });

  it('calculates warmth for entries', () => {
    const compactor = new MemoryCompactor(testDir);
    expect(compactor.calculateWarmth(0.9, new Date().toISOString())).toBeCloseTo(0.9, 1);
    const old = compactor.calculateWarmth(0.5, new Date(Date.now() - 30 * 86400000).toISOString());
    expect(old).toBeCloseTo(0.25, 1);
  });
});
