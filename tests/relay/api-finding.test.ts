import { findingHandler } from '../../packages/relay/src/dashboard/api-finding';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('findingHandler', () => {
  it('returns finding + signals + citation snippets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-finding-'));
    mkdirSync(join(root, '.gossip', 'consensus-reports'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'foo.ts'), 'line1\nline2\nline3\nline4\nline5\n');

    writeFileSync(join(root, '.gossip', 'consensus-reports', 'abc-def.json'), JSON.stringify({
      id: 'abc-def',
      timestamp: '2026-04-17T10:00:00Z',
      confirmed: [{
        id: 'abc-def:f1',
        authorFindingId: 'sonnet-reviewer:f1',
        originalAgentId: 'sonnet-reviewer',
        finding: 'Bug in <cite tag="file">src/foo.ts:3</cite>',
        findingType: 'finding',
        severity: 'high',
        tag: 'confirmed',
        confirmedBy: ['gemini-reviewer'],
        disputedBy: [],
        confidence: 5,
      }],
      disputed: [], unverified: [], unique: [], insights: [], newFindings: [],
    }));

    writeFileSync(join(root, '.gossip', 'agent-performance.jsonl'),
      JSON.stringify({ type: 'consensus', signal: 'agreement', agentId: 'gemini-reviewer',
        findingId: 'abc-def:f1', timestamp: '2026-04-17T10:01:00Z' }) + '\n');

    const res = await findingHandler(root, 'abc-def', 'abc-def:f1');
    expect(res.finding.id).toBe('abc-def:f1');
    expect(res.finding.severity).toBe('high');
    expect(res.finding.tag).toBe('confirmed');
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].agentId).toBe('gemini-reviewer');
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0].file).toBe('src/foo.ts');
    expect(res.citations[0].line).toBe(3);
    expect(res.citations[0].snippet).toContain('line3');
  });

  it('404s on unknown consensusId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-finding-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
    await expect(findingHandler(root, 'missing', 'missing:f1')).rejects.toThrow(/not found/i);
  });

  it('404s on unknown findingId within a valid consensus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-finding-'));
    mkdirSync(join(root, '.gossip', 'consensus-reports'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'consensus-reports', 'abc-def.json'), JSON.stringify({
      id: 'abc-def', confirmed: [], disputed: [], unverified: [], unique: [], insights: [], newFindings: [],
    }));
    await expect(findingHandler(root, 'abc-def', 'abc-def:f99')).rejects.toThrow(/not found/i);
  });

  it('rejects path-traversal citations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossip-test-finding-'));
    mkdirSync(join(root, '.gossip', 'consensus-reports'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'consensus-reports', 'c1-c2.json'), JSON.stringify({
      id: 'c1-c2',
      confirmed: [{
        id: 'c1-c2:f1', originalAgentId: 'x', findingType: 'finding', tag: 'confirmed',
        finding: 'evil <cite tag="file">../../etc/passwd:1</cite>',
        confirmedBy: [], disputedBy: [], confidence: 1,
      }],
      disputed: [], unverified: [], unique: [], insights: [], newFindings: [],
    }));
    const res = await findingHandler(root, 'c1-c2', 'c1-c2:f1');
    expect(res.citations).toHaveLength(0);
  });
});
