import { parseClaimBlock } from '../../packages/orchestrator/src/claim-types';

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
});
