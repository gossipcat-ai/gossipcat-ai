import { AgentMemoryReader } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('AgentMemoryReader.prefetchConsensusFindingsText', () => {
  const testDir = join(tmpdir(), `gossip-prefetch-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const findingsPath = join(gossipDir, 'implementation-findings.jsonl');

  beforeEach(() => {
    mkdirSync(gossipDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array when implementation-findings.jsonl does not exist', () => {
    const reader = new AgentMemoryReader(testDir);
    expect(reader.prefetchConsensusFindingsText('some task')).toEqual([]);
  });

  it('returns empty array when findings file is empty', () => {
    writeFileSync(findingsPath, '');
    const reader = new AgentMemoryReader(testDir);
    expect(reader.prefetchConsensusFindingsText('some task')).toEqual([]);
  });

  it('returns matching findings for relevant task keywords', () => {
    const now = new Date().toISOString();
    const finding1 = JSON.stringify({ finding: 'Memory leak in dispatch pipeline cache eviction', timestamp: now, confirmedBy: ['gemini-tester'] });
    const finding2 = JSON.stringify({ finding: 'Unrelated database migration concern', timestamp: now, confirmedBy: ['sonnet-reviewer'] });
    writeFileSync(findingsPath, [finding1, finding2].join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('dispatch pipeline memory management');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toContain('dispatch pipeline');
  });

  it('does not return findings older than 30 days', () => {
    const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const recentDate = new Date().toISOString();
    const stale = JSON.stringify({ finding: 'relay server auth token validation bug', timestamp: oldDate, confirmedBy: ['sonnet-reviewer'] });
    const fresh = JSON.stringify({ finding: 'relay server auth token validation bug', timestamp: recentDate, confirmedBy: ['sonnet-reviewer'] });
    writeFileSync(findingsPath, [stale, fresh].join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('relay server auth token validation');

    // Only one result (fresh), not two
    expect(results).toHaveLength(1);
  });

  it('returns at most 3 findings', () => {
    const now = new Date().toISOString();
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ finding: `consensus finding number ${i} about dispatch pipeline`, timestamp: now, confirmedBy: ['gemini-tester'] })
    );
    writeFileSync(findingsPath, lines.join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('dispatch pipeline consensus findings');

    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('caps each finding snippet at 150 chars', () => {
    const now = new Date().toISOString();
    const longText = 'dispatch pipeline ' + 'x'.repeat(300);
    writeFileSync(findingsPath, JSON.stringify({ finding: longText, timestamp: now, confirmedBy: ['gemini-tester'] }) + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('dispatch pipeline');

    expect(results.length).toBe(1);
    expect(results[0].length).toBeLessThanOrEqual(150);
  });

  it('returns empty array when no findings match task keywords', () => {
    const now = new Date().toISOString();
    writeFileSync(findingsPath, JSON.stringify({ finding: 'completely unrelated database schema topic', timestamp: now, confirmedBy: ['gemini-tester'] }) + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('websocket relay server auth');

    expect(results).toEqual([]);
  });

  it('reads description field as fallback when finding field is absent', () => {
    const now = new Date().toISOString();
    writeFileSync(findingsPath, JSON.stringify({ description: 'relay server overflow during dispatch', timestamp: now, confirmedBy: ['sonnet-reviewer'] }) + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('relay server dispatch');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toContain('relay server overflow');
  });

  it('handles malformed JSON lines without throwing', () => {
    const now = new Date().toISOString();
    const good = JSON.stringify({ finding: 'relay server dispatch overflow', timestamp: now, confirmedBy: ['gemini-tester'] });
    writeFileSync(findingsPath, ['not valid json{{{', good].join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    expect(() => reader.prefetchConsensusFindingsText('relay server dispatch')).not.toThrow();
  });

  it('skips findings with no timestamp without crashing', () => {
    writeFileSync(findingsPath, JSON.stringify({ finding: 'relay server dispatch overflow', confirmedBy: ['gemini-tester'] }) + '\n');

    const reader = new AgentMemoryReader(testDir);
    // No timestamp means age filter is skipped; finding may still match
    expect(() => reader.prefetchConsensusFindingsText('relay server dispatch')).not.toThrow();
  });

  it('skips unconfirmed findings (empty confirmedBy)', () => {
    const now = new Date().toISOString();
    const unconfirmed = JSON.stringify({ finding: 'dispatch pipeline unconfirmed issue', timestamp: now, confirmedBy: [] });
    const confirmed = JSON.stringify({ finding: 'dispatch pipeline confirmed issue', timestamp: now, confirmedBy: ['gemini-tester'] });
    writeFileSync(findingsPath, [unconfirmed, confirmed].join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('dispatch pipeline issue');

    expect(results).toHaveLength(1);
    expect(results[0]).toContain('confirmed');
  });

  it('returns results ordered by relevance score (most relevant first)', () => {
    const now = new Date().toISOString();
    const highRelevance = JSON.stringify({ finding: 'dispatch pipeline consensus relay memory', timestamp: now, confirmedBy: ['gemini-tester'] });
    const lowRelevance = JSON.stringify({ finding: 'dispatch minor issue', timestamp: now, confirmedBy: ['sonnet-reviewer'] });
    writeFileSync(findingsPath, [lowRelevance, highRelevance].join('\n') + '\n');

    const reader = new AgentMemoryReader(testDir);
    const results = reader.prefetchConsensusFindingsText('dispatch pipeline consensus relay memory');

    expect(results[0]).toContain('dispatch pipeline consensus relay memory');
  });
});
