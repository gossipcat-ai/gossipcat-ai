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
  MAX_INTROSPECTION_BYTES,
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
    // Path-aware: .1 not present; only live file has content
    const fsDep = {
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return jsonl;
      },
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
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return jsonl;
      },
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
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return jsonl;
      },
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
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return jsonl;
      },
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(2);
  });

  it('ignores blank lines', () => {
    const r: IntrospectionRecord = { agentId: 'a', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const jsonl = '\n' + JSON.stringify(r) + '\n\n';
    const fsDep = {
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return jsonl;
      },
    } as Parameters<typeof readIntrospections>[2];
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// FIX 3: Guard — empty claim/groundTruth on 'asked' rejected; 'answered' allowed
// ---------------------------------------------------------------------------

describe('appendIntrospection — FIX 3 guard (empty claim/groundTruth)', () => {
  it('does not write when claim is empty string and status is asked', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record = {
      agentId: 'agent',
      claim: '',
      groundTruth: 'valid truth',
      status: 'asked' as const,
    } as IntrospectionRecord;
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(0);
  });

  it('does not write when claim is whitespace-only and status is asked', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record = {
      agentId: 'agent',
      claim: '   ',
      groundTruth: 'valid truth',
      status: 'asked' as const,
    } as IntrospectionRecord;
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(0);
  });

  it('does not write when groundTruth is empty string and status is asked', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record = {
      agentId: 'agent',
      claim: 'valid claim',
      groundTruth: '',
      status: 'asked' as const,
    } as IntrospectionRecord;
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(0);
  });

  it('writes when status is answered and claim/groundTruth are empty (from mcp record action)', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    // This mirrors what mcp-server-sdk.ts action:'record' sends:
    // claim: claim ?? '', groundTruth: ground_truth ?? '' (may be empty)
    const record = {
      agentId: 'agent',
      claim: '',
      groundTruth: '',
      answer: 'I pattern-matched the task framing',
      status: 'answered' as const,
      answeredAt: '2026-06-22T10:00:00.000Z',
    } as IntrospectionRecord;
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0].data.trim());
    expect(parsed.status).toBe('answered');
    expect(parsed.answer).toBe('I pattern-matched the task framing');
  });
});

// ---------------------------------------------------------------------------
// FIX 4: 'answered' records omit askedAt
// ---------------------------------------------------------------------------

describe('appendIntrospection — FIX 4 askedAt optional on answered', () => {
  it('writes answered record without askedAt when omitted', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'claimed X',
      groundTruth: 'actually Y',
      answer: 'I assumed without checking',
      status: 'answered',
      answeredAt: '2026-06-22T10:00:00.000Z',
      // askedAt intentionally absent
    };
    appendIntrospection('/fake/root', record, fsDep);
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0].data.trim());
    expect('askedAt' in parsed).toBe(false);
    expect(parsed.answeredAt).toBe('2026-06-22T10:00:00.000Z');
  });

  it('includes askedAt when explicitly provided on answered record', () => {
    const { written, fsDep } = makeFsSpyCapturing();
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      answer: 'a',
      status: 'answered',
      askedAt: '2026-06-22T09:00:00.000Z',
      answeredAt: '2026-06-22T10:00:00.000Z',
    };
    appendIntrospection('/fake/root', record, fsDep);
    const parsed = JSON.parse(written[0].data.trim());
    expect(parsed.askedAt).toBe('2026-06-22T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// FIX 5: Rotation — renames at threshold; readIntrospections reads rotated + live
// ---------------------------------------------------------------------------

function makeRotationFsDep(fileSize: number): {
  renamed: { src: string; dest: string }[];
  written: { path: string; data: string }[];
  fsDep: Parameters<typeof appendIntrospection>[2];
} {
  const renamed: { src: string; dest: string }[] = [];
  const written: { path: string; data: string }[] = [];
  const fsDep: Parameters<typeof appendIntrospection>[2] = {
    mkdirSync: () => { /* no-op */ },
    appendFileSync: (path: string, data: string) => { written.push({ path, data }); },
    statSync: (_path: string) => ({ size: fileSize }),
    renameSync: (src: string, dest: string) => { renamed.push({ src, dest }); },
  };
  return { renamed, written, fsDep };
}

describe('appendIntrospection — FIX 5 rotation', () => {
  it('renames ledger to .1 when size >= MAX_INTROSPECTION_BYTES', () => {
    const { renamed, written, fsDep } = makeRotationFsDep(MAX_INTROSPECTION_BYTES);
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: '2026-01-01T00:00:00.000Z',
    };
    appendIntrospection('/fake/root', record, fsDep);
    expect(renamed).toHaveLength(1);
    expect(renamed[0].dest.endsWith('.1')).toBe(true);
    // append still happens after rename
    expect(written).toHaveLength(1);
  });

  it('does NOT rename when size < MAX_INTROSPECTION_BYTES', () => {
    const { renamed, written, fsDep } = makeRotationFsDep(MAX_INTROSPECTION_BYTES - 1);
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: '2026-01-01T00:00:00.000Z',
    };
    appendIntrospection('/fake/root', record, fsDep);
    expect(renamed).toHaveLength(0);
    expect(written).toHaveLength(1);
  });

  it('is best-effort: continues to append when statSync throws (file missing)', () => {
    const written: { path: string; data: string }[] = [];
    const fsDep: Parameters<typeof appendIntrospection>[2] = {
      mkdirSync: () => { /* no-op */ },
      appendFileSync: (path: string, data: string) => { written.push({ path, data }); },
      statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      renameSync: () => { /* no-op */ },
    };
    const record: IntrospectionRecord = {
      agentId: 'agent',
      claim: 'c',
      groundTruth: 'g',
      status: 'asked',
      askedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() => appendIntrospection('/fake/root', record, fsDep)).not.toThrow();
    // Append still happens after stat failure
    expect(written).toHaveLength(1);
  });
});

describe('readIntrospections — FIX 5 reads rotated .1 + live', () => {
  it('returns records from both .1 and live file', () => {
    const r1: IntrospectionRecord = { agentId: 'a1', claim: 'c1', groundTruth: 'g1', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const r2: IntrospectionRecord = { agentId: 'a2', claim: 'c2', groundTruth: 'g2', status: 'asked', askedAt: '2026-01-02T00:00:00.000Z' };
    const rotatedContent = JSON.stringify(r1) + '\n'; // older records in .1
    const liveContent = JSON.stringify(r2) + '\n';    // newer records in live

    const fsDep: Parameters<typeof readIntrospections>[2] = {
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) return rotatedContent;
        return liveContent;
      },
    };
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(2);
    // .1 is read first (older), then live
    expect(result[0].agentId).toBe('a1');
    expect(result[1].agentId).toBe('a2');
  });

  it('returns records from live file when .1 is missing', () => {
    const r: IntrospectionRecord = { agentId: 'live-only', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const fsDep: Parameters<typeof readIntrospections>[2] = {
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return JSON.stringify(r) + '\n';
      },
    };
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('live-only');
  });

  it('returns records from .1 file when live is missing', () => {
    const r: IntrospectionRecord = { agentId: 'rotated-only', claim: 'c', groundTruth: 'g', status: 'asked', askedAt: '2026-01-01T00:00:00.000Z' };
    const fsDep: Parameters<typeof readIntrospections>[2] = {
      readFileSync: (path: string): string => {
        if (path.endsWith('.1')) return JSON.stringify(r) + '\n';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    };
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('rotated-only');
  });

  it('returns [] when both .1 and live are missing', () => {
    const fsDep: Parameters<typeof readIntrospections>[2] = {
      readFileSync: (_path: string): string => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    };
    const result = readIntrospections('/fake/root', undefined, fsDep);
    expect(result).toEqual([]);
  });
});
