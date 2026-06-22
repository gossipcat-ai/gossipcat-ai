import { TaskGraph } from '../../packages/orchestrator/src/task-graph';
import { TaskGraphSync } from '../../packages/orchestrator/src/task-graph-sync';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
global.fetch = jest.fn(async (url: string | URL, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(init.body as string) : null;
  const method = init?.method || 'GET';
  fetchCalls.push({ url: url.toString(), method, body });
  return new Response(JSON.stringify(body ? [body] : []), {
    status: method === 'PATCH' ? 200 : 201,
    headers: { 'content-type': 'application/json' },
  });
}) as any;

describe('TaskGraphSync', () => {
  let tmpDir: string;
  let graph: TaskGraph;
  let sync: TaskGraphSync;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tg-sync-'));
    graph = new TaskGraph(tmpDir);
    sync = new TaskGraphSync(graph, 'https://test.supabase.co', 'test-key', 'user-hash', 'project-hash', tmpDir);
    fetchCalls.length = 0;
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('syncs created and completed events to Supabase', async () => {
    graph.recordCreated('t1', 'gemini-reviewer', 'Review relay', ['code_review']);
    graph.recordCompleted('t1', 'Found 2 bugs', 15000);
    const result = await sync.sync();
    expect(result.events).toBeGreaterThanOrEqual(2);
    const insert = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/rest/v1/tasks'));
    expect(insert).toBeDefined();
    expect(insert!.body.id).toBe('t1');
    expect(insert!.body.agent_id).toBe('gemini-reviewer');
    expect(insert!.body.status).toBe('created');
    // completed → PATCH (partial update, preserves existing fields)
    const completed = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('id=eq.t1'));
    expect(completed).toBeDefined();
    expect(completed!.body.status).toBe('completed');
    expect(completed!.body.result).toBe('Found 2 bugs');
  });

  it('updates sync meta after successful sync', async () => {
    graph.recordCreated('t1', 'gemini-reviewer', 'Review relay', ['code_review']);
    await sync.sync();
    const meta = graph.getSyncMeta();
    expect(meta.lastSync).toBeTruthy();
    expect(meta.lastSyncEventCount).toBe(1);
  });

  it('only syncs events after last sync timestamp', async () => {
    graph.recordCreated('t1', 'agent-a', 'Old task', []);
    await sync.sync();
    fetchCalls.length = 0;
    // Ensure distinct timestamp (ISO string comparison requires >)
    await new Promise(r => setTimeout(r, 2));
    graph.recordCreated('t2', 'agent-b', 'New task', []);
    const result = await sync.sync();
    expect(result.events).toBe(1);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.id).toBe('t2');
  });

  it('syncs decomposed events', async () => {
    graph.recordCreated('p1', 'orchestrator', 'Parent task', []);
    graph.recordDecomposed('p1', 'parallel', ['s1', 's2']);
    await sync.sync();
    const decomp = fetchCalls.find(c => c.url.includes('/rest/v1/task_decompositions'));
    expect(decomp).toBeDefined();
    expect(decomp!.body.parent_id).toBe('p1');
    expect(decomp!.body.sub_task_ids).toEqual(['s1', 's2']);
  });

  it('syncs reference events', async () => {
    graph.recordCreated('t1', 'agent-a', 'Found bug', []);
    graph.recordCreated('fix1', 'agent-b', 'Fix bug', []);
    graph.recordReference('fix1', 't1', 'fixes', 'commit abc123');
    await sync.sync();
    const ref = fetchCalls.find(c => c.url.includes('/rest/v1/task_references'));
    expect(ref).toBeDefined();
    expect(ref!.body.from_task_id).toBe('fix1');
    expect(ref!.body.relationship).toBe('fixes');
  });

  it('syncs failed events as PATCH', async () => {
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    graph.recordFailed('t1', 'Timeout error', 30000);
    await sync.sync();
    const failed = fetchCalls.find(c => c.method === 'PATCH' && c.body?.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.body.error).toBe('Timeout error');
  });

  it('handles fetch errors gracefully without throwing', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    const result = await sync.sync();
    expect(result.events).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('Network error');
  });

  it('syncs cancelled events', async () => {
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    graph.recordCancelled('t1', 'collect timeout', 120000);
    await sync.sync();
    const cancelled = fetchCalls.find(c => c.method === 'PATCH' && c.body?.status === 'cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.body.error).toBe('collect timeout');
  });

  it('handles 409 conflict gracefully on re-sync', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response('{"message":"duplicate key"}', { status: 409 })
    );
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    const result = await sync.sync();
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('409');
  });

  it('reports isConfigured correctly', () => {
    expect(sync.isConfigured()).toBe(true);
    const unconfigured = new TaskGraphSync(graph, '', '', 'u', 'p', tmpDir);
    expect(unconfigured.isConfigured()).toBe(false);
  });

  it('includes display_name in created event when provided', async () => {
    const syncWithName = new TaskGraphSync(
      graph, 'https://test.supabase.co', 'test-key',
      'user-hash', 'project-hash', tmpDir, 'alice@co.com'
    );
    graph.recordCreated('t1', 'agent-a', 'Review code', ['code_review']);
    await syncWithName.sync();
    const insert = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/rest/v1/tasks'));
    expect(insert!.body.display_name).toBe('alice@co.com');
  });

  it('sends null display_name when not provided (solo mode)', async () => {
    graph.recordCreated('t1', 'agent-a', 'Review code', ['code_review']);
    await sync.sync();
    const insert = fetchCalls.find(c => c.method === 'POST' && c.url.includes('/rest/v1/tasks'));
    expect(insert!.body.display_name).toBeNull();
  });

  it('includes token fields in completed sync', async () => {
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    graph.recordCompleted('t1', 'Done', 5000, 1200, 350);
    await sync.sync();
    const completed = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('id=eq.t1'));
    expect(completed!.body.input_tokens).toBe(1200);
    expect(completed!.body.output_tokens).toBe(350);
  });

  it('sends null tokens when not provided', async () => {
    graph.recordCreated('t1', 'agent-a', 'Task', []);
    graph.recordCompleted('t1', 'Done', 5000);
    await sync.sync();
    const completed = fetchCalls.find(c => c.method === 'PATCH' && c.url.includes('id=eq.t1'));
    expect(completed!.body.input_tokens).toBeNull();
    expect(completed!.body.output_tokens).toBeNull();
  });

  describe('migration', () => {
    it('migrates projectId when oldProjectId provided', async () => {
      const syncWithMigration = new TaskGraphSync(
        graph, 'https://test.supabase.co', 'test-key',
        'user-hash', 'new-project-hash', tmpDir, null,
        { oldProjectId: 'old-project-hash' }
      );
      graph.recordCreated('t1', 'agent-a', 'Task', []);
      await syncWithMigration.sync();

      const migration = fetchCalls.find(c =>
        c.method === 'PATCH' && c.body?.project_id === 'new-project-hash' &&
        c.url.includes('project_id=eq.old-project-hash')
      );
      expect(migration).toBeDefined();
    });

    it('skips migration when no oldProjectId provided', async () => {
      graph.recordCreated('t1', 'agent-a', 'Task', []);
      await sync.sync();
      const migration = fetchCalls.find(c =>
        c.method === 'PATCH' && c.url.includes('project_id=eq.')
      );
      expect(migration).toBeUndefined();
    });
  });
});
