// tests/orchestrator/dedupe-key.test.ts
import { computeDedupeKey, DEDUPE_KEY_INTERNALS } from '@gossip/orchestrator';

describe('computeDedupeKey', () => {
  it('produces stable hash for identical inputs', () => {
    const input = {
      agentId: 'sonnet-reviewer',
      content:
        'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow when size > MAX',
      category: 'input_validation',
    };
    expect(computeDedupeKey(input)).toEqual(computeDedupeKey(input));
  });

  it('produces different hashes for distinct content on same file+agent+category', () => {
    const base = {
      agentId: 'sonnet-reviewer',
      category: 'input_validation',
    };
    const a = computeDedupeKey({
      ...base,
      content: 'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow',
    });
    const b = computeDedupeKey({
      ...base,
      content:
        'Null pointer dereference at packages/orchestrator/src/foo.ts:55 when user-input is empty string here',
    });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toEqual(b);
  });

  it('returns null when normalized content is shorter than 32 chars', () => {
    // 31 chars after normalization, but includes a citation so citation passes.
    const input = {
      agentId: 'sonnet-reviewer',
      content: 'short foo.ts:1',
      category: 'input_validation',
    };
    expect(computeDedupeKey(input)).toBeNull();
  });

  it('returns null when no file citation is present', () => {
    const input = {
      agentId: 'sonnet-reviewer',
      content: 'This is a long description of a bug with no file citation anywhere in the body.',
      category: 'input_validation',
    };
    expect(computeDedupeKey(input)).toBeNull();
  });

  it('returns null when agentId is missing', () => {
    expect(
      computeDedupeKey({
        agentId: '',
        content: 'Missing bounds check at packages/orchestrator/src/foo.ts:42 overflow risk',
        category: 'input_validation',
      }),
    ).toBeNull();
  });

  it('normalizes absolute vs relative paths to the same key when content prefix matches', () => {
    // Keep the citation *after* the first 32 chars of content so path-
    // normalization (which operates only on the extracted citation) is
    // what drives convergence, not the 32-char content window.
    const prefix =
      'Missing bounds check causes integer overflow when input exceeds MAX. Location: ';
    const relative = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: `${prefix}packages/orchestrator/src/foo.ts:42`,
      category: 'input_validation',
    });
    const absolute = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: `${prefix}/Users/x/repo/packages/orchestrator/src/foo.ts:42`,
      category: 'input_validation',
    });
    expect(relative).not.toBeNull();
    expect(relative).toEqual(absolute);
  });

  it('empty category is treated like missing category (legacy signals)', () => {
    const base = {
      agentId: 'sonnet-reviewer',
      content: 'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes overflow risk here',
    };
    const withEmpty = computeDedupeKey({ ...base, category: '' });
    const withoutCategory = computeDedupeKey(base);
    expect(withEmpty).toEqual(withoutCategory);
  });

  it('different agents produce different keys (no cross-agent dedup)', () => {
    const content =
      'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow on large inputs';
    const a = computeDedupeKey({ agentId: 'sonnet-reviewer', content, category: 'input_validation' });
    const b = computeDedupeKey({ agentId: 'gemini-reviewer', content, category: 'input_validation' });
    expect(a).not.toEqual(b);
  });

  it('different categories produce different keys (same content)', () => {
    const content =
      'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow on large inputs';
    const a = computeDedupeKey({ agentId: 'sonnet-reviewer', content, category: 'input_validation' });
    const b = computeDedupeKey({ agentId: 'sonnet-reviewer', content, category: 'concurrency' });
    expect(a).not.toEqual(b);
  });

  it('line drift does not change the key (line number stripped)', () => {
    const a = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: 'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes integer overflow',
      category: 'input_validation',
    });
    const b = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: 'Missing bounds check at packages/orchestrator/src/foo.ts:99 causes integer overflow',
      category: 'input_validation',
    });
    expect(a).toEqual(b);
  });

  it('whitespace variants normalize to the same key', () => {
    const a = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: 'Missing bounds check at packages/orchestrator/src/foo.ts:42 causes overflow risk',
      category: 'input_validation',
    });
    const b = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content:
        'Missing   bounds\tcheck   at\n\npackages/orchestrator/src/foo.ts:42   causes  overflow   risk',
      category: 'input_validation',
    });
    expect(a).toEqual(b);
  });

  it('extracts citation from evidence when content has none', () => {
    const key = computeDedupeKey({
      agentId: 'sonnet-reviewer',
      content: 'General description of the bug spanning more than thirty two characters total',
      evidence: 'See packages/orchestrator/src/foo.ts:42 for the specific line',
      category: 'input_validation',
    });
    expect(key).not.toBeNull();
  });

  it('exposes MIN_NORMALIZED_CONTENT_LENGTH = 32 for test calibration', () => {
    expect(DEDUPE_KEY_INTERNALS.MIN_NORMALIZED_CONTENT_LENGTH).toBe(32);
  });
});
