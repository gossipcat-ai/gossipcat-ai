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
    writeFileSync(join(memDir, 'MEMORY.md'), '# Memory');
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
