/**
 * Unit tests for the gossip_ask_back introspection ledger.
 * Spec: orchestrator signal pipeline Unit 4.
 *
 * Covers:
 *  - buildIntrospectionPrompt: contains claim, groundTruth, mechanism ask
 *  - appendIntrospection: round-trip JSONL via fs spy, trailing newline, best-effort on throw
 *  - readIntrospections: multi-line parse, skips torn line, filters by agentId, [] on missing file
 *  - required-field guard on appendIntrospection
 *
 * All tests use an injected fs dependency — real .gossip is never touched.
 */

import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildIntrospectionPrompt,
  appendIntrospection,
  readIntrospections,
  type IntrospectionRecord,
} from '../../apps/cli/src/handlers/ask-back';

// ---------------------------------------------------------------------------
// buildIntrospectionPrompt
// ---------------------------------------------------------------------------

describe('buildIntrospectionPrompt', () => {
  it('contains the claim verbatim', () => {
    const prompt = buildIntrospectionPrompt('Agent cited line 42 but it does not exist', 'grep shows no such line');
    expect(prompt).toContain('Agent cited line 42 but it does not exist');
  });

  it('contains the ground truth verbatim', () => {
    const prompt = buildIntrospectionPrompt('some claim', 'grep shows no such line in auth.ts');
    expect(prompt).toContain('grep shows no such line in auth.ts');
  });

  it('asks for a specific failure mechanism (not an apology)', () => {
    const prompt = buildIntrospectionPrompt('claim', 'truth');
    // Must request a mechanism explanation
    const lower = prompt.toLowerCase();
    expect(
      lower.includes('mechanism') ||
      lower.includes('process') ||
      lower.includes('how') ||
      lower.includes('why') ||
      lower.includes('specific')
    ).toBe(true);
  });

  it('is non-empty and reasonably sized', () => {
    const prompt = buildIntrospectionPrompt('a', 'b');
    expect(prompt.length).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------------------
// appendIntrospection helpers
// ---------------------------------------------------------------------------

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-ask-back-test-'));
}

function makeFsSpyCapturing(): { written: { path: string; data: string }[]; fsDep: Parameters<typeof appendIntrospection>[2] } {
  const written: { path: string; data: string }[] = [];
  const fsDep = {
    mkdirSync: (_path: string, _opts?: unknown) => { /* no-op */ },
    appendFileSync: (path: string, data: string) => {
      written.push({ path, data });
    },
  } as Parameters<typeof appendIntrospection>[2];
  return { written, fsDep };
}

// ---------------------------------------------------------------------------
// appendIntrospection
// ---------------------------------------------------------------------------

describe('appendIntrospection', () => {
  it('writes a JSONL line with trailing newline', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record: IntrospectionRecord = {
      agentId: 'sonnet-reviewer',
      claim: 'claimed line 42',
      groundTruth: 'no such line',
      status: 'asked',
      askedAt: new Date().toISOString(),
    };
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(1);
    expect(written[0].data.endsWith('\n')).toBe(true);
  });

  it('written line round-trips back to the original record fields', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record: IntrospectionRecord = {
      agentId: 'haiku-researcher',
      findingId: 'abc123:haiku-researcher:f2',
      claim: 'claimed X',
      groundTruth: 'actually Y',
      status: 'asked',
      askedAt: '2026-06-22T10:00:00.000Z',
    };
    appendIntrospection('/fake/root', record, fsDep);
    const line = written[0].data.trim();
    const parsed = JSON.parse(line) as IntrospectionRecord;
    expect(parsed.agentId).toBe('haiku-researcher');
    expect(parsed.findingId).toBe('abc123:haiku-researcher:f2');
    expect(parsed.claim).toBe('claimed X');
    expect(parsed.groundTruth).toBe('actually Y');
    expect(parsed.status).toBe('asked');
    expect(parsed.askedAt).toBe('2026-06-22T10:00:00.000Z');
  });

  it('does not serialize undefined fields (omits optional absent keys)', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record: IntrospectionRecord = {
      agentId: 'gemini-reviewer',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: '2026-06-22T10:00:00.000Z',
    };
    appendIntrospection('/fake/root', record, fsDep);
    const parsed = JSON.parse(written[0].data.trim());
    expect('answer' in parsed).toBe(false);
    expect('findingId' in parsed).toBe(false);
    expect('answeredAt' in parsed).toBe(false);
  });

  it('is best-effort: does not throw when fs.appendFileSync throws', () => {
    const throwingFs = {
      mkdirSync: () => { /* no-op */ },
      appendFileSync: () => { throw new Error('disk full'); },
    } as Parameters<typeof appendIntrospection>[2];
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: new Date().toISOString(),
    };
    expect(() => appendIntrospection('/fake/root', record, throwingFs)).not.toThrow();
  });

  it('is best-effort: does not throw when mkdirSync throws', () => {
    const throwingFs = {
      mkdirSync: () => { throw new Error('permission denied'); },
      appendFileSync: () => { /* no-op */ },
    } as Parameters<typeof appendIntrospection>[2];
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: new Date().toISOString(),
    };
    expect(() => appendIntrospection('/fake/root', record, throwingFs)).not.toThrow();
  });

  it('does not write when required fields are missing', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    // Missing agentId — cast to bypass TS for the runtime guard test
    const badRecord = { claim: 'c', groundTruth: 'g', status: 'asked', askedAt: 'now' } as unknown as IntrospectionRecord;
    appendIntrospection('/fake/root', badRecord, fsDep);
    expect(written).toHaveLength(0);
  });

  it('does not write when status is missing', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const badRecord = { agentId: 'x', claim: 'c', groundTruth: 'g', askedAt: 'now' } as unknown as IntrospectionRecord;
    appendIntrospection('/fake/root', badRecord, fsDep);
    expect(written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readIntrospections
// ---------------------------------------------------------------------------

describe('readIntrospections', () => {
  it('returns [] when file does not exist', () => {
    const root = makeRoot(); // empty temp dir
    const fsDep = {
      readFileSync: (_path: string): string => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections(root, undefined, fsDep);
    expect(result).toEqual([]);
  });

  it('parses multiple JSONL lines', () => {
    const r1: IntrospectionRecord = { agentId: 'a1', claim: 'c1', groundTruth: 'g1', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const r2: IntrospectionRecord = { agentId: 'a2', claim: 'c2', groundTruth: 'g2', status: 'answered', askedAt: '2026-01-02T00:00:00.000Z', answeredAt: '2026-01-02T01:00:00.000Z', answer: 'pattern matched' };
    const jsonl = JSON.stringify(r1) + '\n' + JSON.stringify(r2) + '\n';
    const fsDep = {
      readFileSync: (_path: string): string => jsonl,
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(2);
    expect(result[0].agentId).toBe('a1');
    expect(result[1].agentId).toBe('a2');
    expect(result[1].answer).toBe('pattern matched');
  });

  it('skips torn (invalid JSON) lines leniently', () => {
    const r1: IntrospectionRecord = { agentId: 'good', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const jsonl = JSON.stringify(r1) + '\n' + 'TORN_LINE{{{invalid\n' + JSON.stringify(r1) + '\n';
    const fsDep = {
      readFileSync: (_path: string): string => jsonl,
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(2);
  });

  it('filters by agentId when provided', () => {
    const r1: IntrospectionRecord = { agentId: 'target', claim: 'c1', groundTruth: 'g1', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const r2: IntrospectionRecord = { agentId: 'other', claim: 'c2', groundTruth: 'g2', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const r3: IntrospectionRecord = { agentId: 'target', claim: 'c3', groundTruth: 'g3', status: 'answered', askedAt: '2026-01-01T00:00:00.000Z', answer: 'x' };
    const jsonl = [r1, r2, r3].map(r => JSON.stringify(r)).join('\n') + '\n';
    const fsDep = {
      readFileSync: (_path: string): string => jsonl,
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', 'target', fsDep);
    expect(result).toHaveLength(2);
    expect(result.every(r => r.agentId === 'target')).toBe(true);
  });

  it('returns all records when agentId filter is undefined', () => {
    const records: IntrospectionRecord[] = [
      { agentId: 'a', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' },
      { agentId: 'b', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const jsonl = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    const fsDep = {
      readFileSync: (_path: string): string => jsonl,
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(2);
  });

  it('ignores blank lines', () => {
    const r: IntrospectionRecord = { agentId: 'a', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const jsonl = '\n' + JSON.stringify(r) + '\n\n';
    const fsDep = {
      readFileSync: (_path: string): string => jsonl,
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(1);
  });
});
