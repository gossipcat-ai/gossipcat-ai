import { violationsHandler, ViolationEntry } from '../../packages/relay/src/dashboard/api-violations';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-violations-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  return root;
}

function makeEntry(overrides: Partial<ViolationEntry> = {}): ViolationEntry {
  return {
    taskId: 'task-abc',
    agentId: 'sonnet-implementer',
    preSha: 'aaa1111',
    postSha: 'bbb2222',
    detectedAt: new Date().toISOString(),
    commits: ['bbb2222 feat: direct push'],
    ...overrides,
  };
}

describe('violationsHandler', () => {
  it('returns empty response when file does not exist', () => {
    const root = setupRoot();
    const result = violationsHandler(root);
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('returns empty response when file is empty', () => {
    const root = setupRoot();
    writeFileSync(join(root, '.gossip', 'process-violations.jsonl'), '');
    const result = violationsHandler(root);
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('returns one entry when file has one valid line', () => {
    const root = setupRoot();
    const entry = makeEntry({ taskId: 'task-1' });
    writeFileSync(join(root, '.gossip', 'process-violations.jsonl'), JSON.stringify(entry) + '\n');
    const result = violationsHandler(root);
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].taskId).toBe('task-1');
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
  });

  it('filters by agentId when query param is set', () => {
    const root = setupRoot();
    const e1 = makeEntry({ taskId: 'task-1', agentId: 'agent-a' });
    const e2 = makeEntry({ taskId: 'task-2', agentId: 'agent-b' });
    writeFileSync(
      join(root, '.gossip', 'process-violations.jsonl'),
      JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n',
    );
    const query = new URLSearchParams({ agentId: 'agent-a' });
    const result = violationsHandler(root, query);
    expect(result.total).toBe(1);
    expect(result.items[0].agentId).toBe('agent-a');
  });

  it('paginates correctly', () => {
    const root = setupRoot();
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(makeEntry({ taskId: `task-${i}`, detectedAt: new Date(Date.now() - i * 1000).toISOString() }))
    ).join('\n') + '\n';
    writeFileSync(join(root, '.gossip', 'process-violations.jsonl'), lines);

    const query = new URLSearchParams({ page: '2', pageSize: '2' });
    const result = violationsHandler(root, query);
    expect(result.total).toBe(5);
    expect(result.items).toHaveLength(2);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(2);
  });

  it('skips malformed lines without throwing', () => {
    const root = setupRoot();
    const e1 = makeEntry({ taskId: 'task-ok' });
    writeFileSync(
      join(root, '.gossip', 'process-violations.jsonl'),
      'not-json\n' + JSON.stringify(e1) + '\n',
    );
    const result = violationsHandler(root);
    expect(result.total).toBe(1);
    expect(result.items[0].taskId).toBe('task-ok');
  });

  it('sorts entries newest-first by detectedAt', () => {
    const root = setupRoot();
    const older = makeEntry({ taskId: 'old', detectedAt: '2026-04-28T10:00:00.000Z' });
    const newer = makeEntry({ taskId: 'new', detectedAt: '2026-04-29T10:00:00.000Z' });
    writeFileSync(
      join(root, '.gossip', 'process-violations.jsonl'),
      JSON.stringify(older) + '\n' + JSON.stringify(newer) + '\n',
    );
    const result = violationsHandler(root);
    expect(result.items[0].taskId).toBe('new');
    expect(result.items[1].taskId).toBe('old');
  });

  it('clamps pageSize to max 100', () => {
    const root = setupRoot();
    const query = new URLSearchParams({ pageSize: '999' });
    const result = violationsHandler(root, query);
    expect(result.pageSize).toBe(100);
  });
});
