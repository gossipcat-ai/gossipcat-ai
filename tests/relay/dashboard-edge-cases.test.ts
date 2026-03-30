import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';
import { skillsGetHandler, skillsBindHandler } from '@gossip/relay/dashboard/api-skills';
import { memoryHandler } from '@gossip/relay/dashboard/api-memory';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillIndex } from '@gossip/orchestrator/skill-index';

describe('Dashboard API: Edge Cases', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-edge-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('api-overview', () => {
    it('should count consensus runs from agent-performance signals', async () => {
      const signals = [
        JSON.stringify({ type: 'consensus', taskId: 'task-1', signal: 'agreement', agentId: 'a', timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'consensus', taskId: 'task-1', signal: 'unique_confirmed', agentId: 'b', timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'consensus', taskId: 'task-2', signal: 'disagreement', agentId: 'a', timestamp: new Date().toISOString() }),
      ].join('\n');
      writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), signals);
      const data = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
      expect(data.consensusRuns).toBe(2); // 2 unique taskIds
      expect(data.totalSignals).toBe(3);
      expect(data.confirmedFindings).toBe(2); // agreement + unique_confirmed
      expect(data.totalFindings).toBe(3);
    });

    it('should not throw on malformed agent-performance.jsonl', async () => {
      writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), '{"foo":\nnot json\n{"bar": 1}');
      const data = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
      // Resilient: skips invalid lines, counts valid ones ({"bar": 1} parses OK)
      expect(data.totalSignals).toBe(1);
    });

    it('should handle very large agent-performance file without crashing', async () => {
      // NOTE: This is synchronous and will block. A better implementation would stream.
      const largeFileContent = Array.from({ length: 10000 }, (_, i) => JSON.stringify({ i })).join('\n');
      writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), largeFileContent);
      const data = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
      expect(data.totalSignals).toBe(10000);
    });
  });

  describe('api-agents', () => {
    it('should handle a corrupt agent-performance.jsonl file gracefully', async () => {
      // PerformanceReader currently throws on corrupt file, this test expects agentsHandler to catch it.
      // As of 2026-03, agentsHandler does NOT catch it, so this test would fail.
      // This highlights a needed fix in the source.
      writeFileSync(join(projectRoot, '.gossip', 'agent-performance.jsonl'), 'corrupt data');
      const configs = [{ id: 'a', provider: 'p', model: 'm', skills: [] }];
      // We expect it to return default scores instead of throwing.
      const result = await agentsHandler(projectRoot, configs as any);
      expect(result).toHaveLength(1);
      expect(result[0].scores.accuracy).toBe(0.5); // Default score
    });
  });

  describe('api-skills', () => {
    it('should not throw on corrupt skill-index.json for GET', async () => {
      writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), '{"foo":');
      // This would throw before. The handler should catch it.
      const result = await skillsGetHandler(projectRoot);
      expect(result.index).toEqual({});
    });

    it('should not throw on corrupt skill-index.json for POST', async () => {
      writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), '{"foo":');
      const result = await skillsBindHandler(projectRoot, { agent_id: 'a', skill: 's', enabled: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not parse');
    });

    it('should demonstrate "last write wins" race condition', async () => {
      const index = new SkillIndex(projectRoot);
      index.bind('agent-a', 'skill-1', { enabled: true, source: 'manual' }); // Initial state

      // Simulate two requests trying to modify the same agent at the same time
      const p1 = skillsBindHandler(projectRoot, { agent_id: 'agent-a', skill: 'skill-1', enabled: false });
      const p2 = skillsBindHandler(projectRoot, { agent_id: 'agent-a', skill: 'skill-2', enabled: true });

      await Promise.all([p1, p2]);

      const finalState = new SkillIndex(projectRoot).getIndex();
      // Depending on execution order, one of these changes might be lost.
      // A robust system would use file locking or a transactional update.
      // We assert that both changes are present, but this is not guaranteed.
      expect(finalState['agent-a']['skill-1'].enabled).toBe(false);
      expect(finalState['agent-a']['skill-2'].enabled).toBe(true);
    });
  });

  describe('api-memory', () => {
    beforeEach(() => {
      mkdirSync(join(projectRoot, '.gossip', 'agents', 'agent-x', 'memory'), { recursive: true });
    });

    it('should handle non-existent agent gracefully', async () => {
        const result = await memoryHandler(projectRoot, 'non-existent-agent');
        expect(result.knowledge).toEqual([]);
        expect(result.tasks).toEqual([]);
    });

    it('should not crash with binary files in memory dir', async () => {
      const memDir = join(projectRoot, '.gossip', 'agents', 'agent-x', 'memory');
      writeFileSync(join(memDir, 'binary-file.md'), Buffer.from([0, 1, 2, 3, 4, 5]));
      const result = await memoryHandler(projectRoot, 'agent-x');
      expect(result.knowledge).toHaveLength(1);
      // The content will be garbage, but it shouldn't crash the server
      expect(result.knowledge[0].content).toBeDefined();
    });

    it('should handle malformed frontmatter', async () => {
      const memDir = join(projectRoot, '.gossip', 'agents', 'agent-x', 'memory');
      writeFileSync(join(memDir, 'bad-fm.md'), '---\nfoo: bar\n---\ncontent');
      const result = await memoryHandler(projectRoot, 'agent-x');
      expect(result.knowledge).toHaveLength(1);
      expect(result.knowledge[0].frontmatter.foo).toBe('bar');
    });

    it('should handle a large number of knowledge files', async () => {
      // NOTE: This is synchronous and will block. A better implementation would stream.
      const memDir = join(projectRoot, '.gossip', 'agents', 'agent-x', 'memory');
      for (let i = 0; i < 500; i++) {
        writeFileSync(join(memDir, `file-${i}.md`), `content ${i}`);
      }
      const result = await memoryHandler(projectRoot, 'agent-x');
      expect(result.knowledge).toHaveLength(500);
    });
  });
});
