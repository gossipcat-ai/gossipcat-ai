import {
  MAX_CLAIM_STRING_CHARS,
  MAX_PATH_CHARS,
  parseClaimBlock,
} from '../../packages/orchestrator/src/claim-types';

describe('parseClaimBlock — fail-soft parser', () => {
  it('accepts a valid block with all five claim types', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'callsite_count', symbol: 'foo', scope: 'src', expected: 3, modality: 'asserted' },
        { type: 'file_line', path: 'src/a.ts', line: 10, expected_symbol: 'bar', modality: 'asserted' },
        { type: 'absence_of_symbol', symbol: 'baz', scope: 'src', context: 'no baz anywhere', modality: 'asserted' },
        { type: 'presence_of_symbol', symbol: 'qux', scope: 'src', modality: 'asserted' },
        { type: 'count_relation', symbol: 'qq', scope: 'src', relation: '>', value: 2, modality: 'asserted' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block).not.toBeNull();
    expect(block!.claims).toHaveLength(5);
    expect(errors).toHaveLength(0);
  });

  it('returns null block + invalid_json error on malformed JSON', () => {
    const { block, errors } = parseClaimBlock('{not-json');
    expect(block).toBeNull();
    expect(errors).toEqual([{ claim_index: null, message: 'invalid_json' }]);
  });

  it('records missing_modality lint and defaults to asserted', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'callsite_count', symbol: 'foo', scope: 'src', expected: 3 },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block).not.toBeNull();
    expect(block!.claims).toHaveLength(1);
    expect(block!.claims[0].modality).toBe('asserted');
    expect(errors.some((e) => e.message === 'missing_modality' && e.claim_index === 0)).toBe(true);
  });

  it('rejects absence_of_symbol + negated:true', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        {
          type: 'absence_of_symbol',
          symbol: 'x',
          scope: 'src',
          context: 'ctx',
          modality: 'asserted',
          negated: true,
        },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block).not.toBeNull();
    expect(block!.claims).toHaveLength(0);
    expect(errors.some((e) => /illegal/.test(e.message))).toBe(true);
  });

  it('rejects absence_of_symbol with context > 120 chars', () => {
    const ctx = 'a'.repeat(121);
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        {
          type: 'absence_of_symbol',
          symbol: 'x',
          scope: 'src',
          context: ctx,
          modality: 'asserted',
        },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(0);
    expect(errors.some((e) => /120 chars/.test(e.message))).toBe(true);
  });

  it('ACCEPTS vague claim without range_hint (no lint — spec §Modality)', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'callsite_count', symbol: 'foo', scope: 'src', expected: 0, modality: 'vague' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(1);
    expect(block!.claims[0].modality).toBe('vague');
    expect(errors).toHaveLength(0); // no lint for missing range_hint
  });

  it('keeps valid claims alongside invalid ones', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'callsite_count', symbol: 'foo', scope: 'src', expected: 1, modality: 'asserted' },
        { type: 'callsite_count', symbol: '', scope: 'src', expected: 1, modality: 'asserted' }, // invalid
        { type: 'presence_of_symbol', symbol: 'bar', scope: 'src', modality: 'asserted' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(2);
    expect(errors.some((e) => e.claim_index === 1)).toBe(true);
  });

  it('rejects symbol longer than MAX_CLAIM_STRING_CHARS (256) — schema-lint, skipped', () => {
    const longSymbol = 'a'.repeat(MAX_CLAIM_STRING_CHARS + 1);
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'presence_of_symbol', symbol: longSymbol, scope: 'src', modality: 'asserted' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(0);
    expect(errors.some((e) => /symbol_too_long/.test(e.message))).toBe(true);
  });

  it('rejects file_line path longer than MAX_PATH_CHARS (1024) — schema-lint, skipped', () => {
    const longPath = 'a/'.repeat(MAX_PATH_CHARS); // length ≫ 1024
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'file_line', path: longPath, line: 1, expected_symbol: 'x', modality: 'asserted' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(0);
    expect(errors.some((e) => /path_too_long/.test(e.message))).toBe(true);
  });

  it('rejects over-long scope across all grep-using claim types', () => {
    const longScope = 's'.repeat(MAX_CLAIM_STRING_CHARS + 1);
    for (const type of ['callsite_count', 'absence_of_symbol', 'presence_of_symbol', 'count_relation']) {
      const claim: Record<string, unknown> = { type, symbol: 'foo', scope: longScope, modality: 'asserted' };
      if (type === 'callsite_count') claim.expected = 1;
      if (type === 'count_relation') { claim.relation = '>'; claim.value = 0; }
      if (type === 'absence_of_symbol') claim.context = 'ctx';
      const raw = JSON.stringify({ schema_version: '1', verifier: 'orchestrator', claims: [claim] });
      const { block, errors } = parseClaimBlock(raw);
      expect(block!.claims).toHaveLength(0);
      expect(errors.some((e) => /scope_too_long/.test(e.message))).toBe(true);
    }
  });

  it('rejects over-long file_line expected_symbol', () => {
    const longSym = 'x'.repeat(MAX_CLAIM_STRING_CHARS + 1);
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [
        { type: 'file_line', path: 'src/a.ts', line: 1, expected_symbol: longSym, modality: 'asserted' },
      ],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block!.claims).toHaveLength(0);
    expect(errors.some((e) => /expected_symbol_too_long/.test(e.message))).toBe(true);
  });

  it('accepts an empty claims array', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [],
    });
    const { block, errors } = parseClaimBlock(raw);
    expect(block).not.toBeNull();
    expect(block!.claims).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('truncates unknown_type message when agent-supplied type is very long', () => {
    const longType = 'a'.repeat(5000);
    const raw = JSON.stringify({
      schema_version: '1',
      verifier: 'orchestrator',
      claims: [{ type: longType, symbol: 'x', scope: 'src', modality: 'asserted' }],
    });
    const { errors } = parseClaimBlock(raw);
    const unknownErr = errors.find(e => e.message.startsWith('unknown_type:'));
    expect(unknownErr).toBeDefined();
    // 'unknown_type: ' prefix (15 chars) + up to 200 sanitized chars + '…' = at most 216 chars
    expect(unknownErr!.message.length).toBeLessThanOrEqual(216);
    expect(unknownErr!.message).toContain('…');
  });
});
