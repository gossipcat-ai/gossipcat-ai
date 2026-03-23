import { TaskGraph } from '@gossip/orchestrator';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('TaskGraph', () => {
  const testDir = join(tmpdir(), `gossip-taskgraph-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const graphPath = join(gossipDir, 'task-graph.jsonl');

  beforeEach(() => {
    mkdirSync(gossipDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('write events', () => {
    it('creates JSONL file on first event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'gemini-reviewer', 'review code', ['code_review']);
      expect(existsSync(graphPath)).toBe(true);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0]);
      expect(event.type).toBe('task.created');
      expect(event.taskId).toBe('t1');
      expect(event.agentId).toBe('gemini-reviewer');
      expect(event.timestamp).toBeDefined();
    });

    it('appends multiple events', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'task 1', ['skill1']);
      graph.recordCompleted('t1', 'done', 5000);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe('task.created');
      expect(JSON.parse(lines[1]).type).toBe('task.completed');
    });

    it('records decomposition event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordDecomposed('parent-1', 'parallel', ['sub-1', 'sub-2']);
      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.decomposed');
      expect(event.parentId).toBe('parent-1');
      expect(event.subTaskIds).toEqual(['sub-1', 'sub-2']);
    });

    it('records reference event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordReference('fix-1', 'review-1', 'fixes', 'commit abc');
      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.reference');
      expect(event.relationship).toBe('fixes');
      expect(event.evidence).toBe('commit abc');
    });

    it('records cancelled event', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCancelled('t1', 'collect timeout', 120000);
      const event = JSON.parse(readFileSync(graphPath, 'utf-8').trim());
      expect(event.type).toBe('task.cancelled');
      expect(event.reason).toBe('collect timeout');
    });

    it('creates .gossip directory if missing', () => {
      rmSync(gossipDir, { recursive: true, force: true });
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent', 'task', []);
      expect(existsSync(graphPath)).toBe(true);
    });

    it('records token counts in completed events', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-a', 'task', []);
      graph.recordCompleted('t1', 'done', 5000, 1200, 350);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      const completed = JSON.parse(lines[1]);
      expect(completed.inputTokens).toBe(1200);
      expect(completed.outputTokens).toBe(350);
    });

    it('records token counts in failed events', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-a', 'task', []);
      graph.recordFailed('t1', 'timeout', 5000, 800, 100);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      const failed = JSON.parse(lines[1]);
      expect(failed.inputTokens).toBe(800);
      expect(failed.outputTokens).toBe(100);
    });

    it('omits token fields when not provided (backwards compat)', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-a', 'task', []);
      graph.recordCompleted('t1', 'done', 5000);
      const lines = readFileSync(graphPath, 'utf-8').trim().split('\n');
      const completed = JSON.parse(lines[1]);
      expect(completed.inputTokens).toBeUndefined();
      expect(completed.outputTokens).toBeUndefined();
    });
  });

  describe('read and reconstruct', () => {
    it('reconstructs a completed task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'review code', ['code_review']);
      graph.recordCompleted('t1', 'found 3 bugs', 15000);
      const task = graph.getTask('t1');
      expect(task).not.toBeNull();
      expect(task!.taskId).toBe('t1');
      expect(task!.agentId).toBe('agent-1');
      expect(task!.status).toBe('completed');
      expect(task!.result).toBe('found 3 bugs');
      expect(task!.duration).toBe(15000);
    });

    it('returns null for unknown task', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getTask('nonexistent')).toBeNull();
    });

    it('returns recent tasks in reverse order', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'a1', 'first', []);
      graph.recordCreated('t2', 'a2', 'second', []);
      graph.recordCreated('t3', 'a3', 'third', []);
      graph.recordCompleted('t1', 'done', 100);
      graph.recordCompleted('t2', 'done', 200);
      const recent = graph.getRecentTasks(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].taskId).toBe('t3');
    });

    it('filters tasks by agent', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent-1', 'task 1', []);
      graph.recordCreated('t2', 'agent-2', 'task 2', []);
      graph.recordCreated('t3', 'agent-1', 'task 3', []);
      const tasks = graph.getTasksByAgent('agent-1');
      expect(tasks).toHaveLength(2);
      expect(tasks.every(t => t.agentId === 'agent-1')).toBe(true);
    });

    it('returns children of a parent task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('parent', 'orchestrator', 'big task', []);
      graph.recordDecomposed('parent', 'parallel', ['sub-1', 'sub-2']);
      graph.recordCreated('sub-1', 'agent-1', 'sub task 1', [], 'parent');
      graph.recordCreated('sub-2', 'agent-2', 'sub task 2', [], 'parent');
      const children = graph.getChildren('parent');
      expect(children).toHaveLength(2);
      expect(children.map(c => c.taskId).sort()).toEqual(['sub-1', 'sub-2']);
    });

    it('returns references for a task', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('review-1', 'agent', 'review', []);
      graph.recordCreated('fix-1', 'agent', 'fix', []);
      graph.recordReference('fix-1', 'review-1', 'fixes', 'commit abc');
      const refs = graph.getReferences('review-1');
      expect(refs).toHaveLength(1);
      expect(refs[0].fromTaskId).toBe('fix-1');
      expect(refs[0].relationship).toBe('fixes');
    });

    it('counts events via getEventCount', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getEventCount()).toBe(0);
      graph.recordCreated('t1', 'agent', 'task', []);
      graph.recordCompleted('t1', 'done', 100);
      expect(graph.getEventCount()).toBe(2);
    });

    it('handles empty graph gracefully', () => {
      const graph = new TaskGraph(testDir);
      expect(graph.getRecentTasks()).toEqual([]);
      expect(graph.getTasksByAgent('any')).toEqual([]);
      expect(graph.getEventCount()).toBe(0);
    });

    it('manages sync meta', () => {
      const graph = new TaskGraph(testDir);
      const meta = graph.getSyncMeta();
      expect(meta.lastSync).toBe('');
      expect(meta.lastSyncEventCount).toBe(0);
      graph.updateSyncMeta({ lastSync: '2026-03-21T00:00:00Z', lastSyncEventCount: 5 });
      const updated = graph.getSyncMeta();
      expect(updated.lastSync).toBe('2026-03-21T00:00:00Z');
      expect(updated.lastSyncEventCount).toBe(5);
    });

    it('truncates result to 4000 chars', () => {
      const graph = new TaskGraph(testDir);
      const longResult = 'x'.repeat(5000);
      graph.recordCreated('t1', 'agent', 'task', []);
      graph.recordCompleted('t1', longResult, 100);
      const task = graph.getTask('t1');
      expect(task!.result!.length).toBe(4000);
    });

    it('redacts secret patterns from results', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'agent', 'task', []);
      graph.recordCompleted('t1', 'Found key: sk-ant-abc123def456ghi789jkl012mno345 in config', 100);
      const task = graph.getTask('t1');
      expect(task!.result).toContain('[REDACTED_ANTHROPIC_KEY]');
      expect(task!.result).not.toContain('sk-ant-abc123');
    });

    it('redacts GitHub tokens from results', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t2', 'agent', 'task', []);
      graph.recordCompleted('t2', 'Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij in env', 100);
      const task = graph.getTask('t2');
      expect(task!.result).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(task!.result).not.toContain('ghp_');
    });

    it('redacts secrets from error messages too', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t3', 'agent', 'task', []);
      graph.recordFailed('t3', 'API error with key sk-abcdefghijklmnopqrstuvwxyz0123456789abcdef', 100);
      const task = graph.getTask('t3');
      expect(task!.error).toContain('[REDACTED_API_KEY]');
    });

    it('persists index and loads on new instance', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('idx-1', 'agent', 'indexed task', ['test']);
      graph.recordCompleted('idx-1', 'done', 500);

      // New instance loads the persisted index
      const graph2 = new TaskGraph(testDir);
      const task = graph2.getTask('idx-1');
      expect(task).not.toBeNull();
      expect(task!.taskId).toBe('idx-1');
      expect(task!.status).toBe('completed');
    });

    it('getEventCount uses cached count', () => {
      const graph = new TaskGraph(testDir);
      graph.recordCreated('t1', 'a', 'task', []);
      graph.recordCompleted('t1', 'done', 100);

      // New instance should have the correct count from disk
      const graph2 = new TaskGraph(testDir);
      expect(graph2.getEventCount()).toBe(2);
    });
  });
});
