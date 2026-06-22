import {
  assemblePrompt,
  extractSpecReferences,
  buildSpecReviewEnrichment,
} from '@gossip/orchestrator';

describe('extractSpecReferences', () => {
  it('detects spec file references in task text', () => {
    const task = 'Review `docs/api-spec.md` and implement the changes';
    const refs = extractSpecReferences(task);
    expect(refs).toContain('docs/api-spec.md');
  });

  it('detects design doc references in task text', () => {
    const task = 'Follow the plan in `docs/auth-design.md` for this feature';
    const refs = extractSpecReferences(task);
    expect(refs).toContain('docs/auth-design.md');
  });

  it('detects specs/ paths in task text', () => {
    const task = 'See `specs/routing.md` for details';
    const refs = extractSpecReferences(task);
    expect(refs).toContain('specs/routing.md');
  });

  it('extracts implementation file paths from spec content (backtick paths)', () => {
    const specContent = 'The handler is in `src/handlers/auth.ts` and uses `lib/crypto.js`';
    const refs = extractSpecReferences('some task', specContent);
    expect(refs).toContain('src/handlers/auth.ts');
    expect(refs).toContain('lib/crypto.js');
  });

  it('extracts file paths from markdown tables in spec content', () => {
    const specContent = `
| File | Purpose |
|------|---------|
| src/router.ts | Main router |
| src/middleware.ts:42 | Auth middleware |
`;
    const refs = extractSpecReferences('some task', specContent);
    expect(refs).toContain('src/router.ts');
    expect(refs).toContain('src/middleware.ts');
  });

  it('returns empty array for tasks with no spec references', () => {
    const refs = extractSpecReferences('Fix the login button color');
    expect(refs).toEqual([]);
  });

  it('rejects paths with .. segments', () => {
    const task = 'Check `docs/../../../etc/passwd`';
    const refs = extractSpecReferences(task);
    expect(refs).toEqual([]);
  });

  it('rejects paths with .. segments in spec content', () => {
    const specContent = 'See `../../../etc/shadow` for secrets';
    const refs = extractSpecReferences('task', specContent);
    expect(refs).toEqual([]);
  });

  it('only accepts known doc extensions for spec detection in task text', () => {
    const task = 'Review `docs/image.png` and `docs/api-spec.md`';
    const refs = extractSpecReferences(task);
    expect(refs).not.toContain('docs/image.png');
    expect(refs).toContain('docs/api-spec.md');
  });

  it('accepts .txt and .rst doc extensions', () => {
    const task = 'Read `docs/notes.txt` and `specs/plan.rst`';
    const refs = extractSpecReferences(task);
    expect(refs).toContain('docs/notes.txt');
    expect(refs).toContain('specs/plan.rst');
  });

  it('deduplicates references', () => {
    const task = 'See `docs/api-spec.md` and also `docs/api-spec.md`';
    const refs = extractSpecReferences(task);
    const count = refs.filter((r) => r === 'docs/api-spec.md').length;
    expect(count).toBe(1);
  });
});

describe('buildSpecReviewEnrichment', () => {
  it('returns null if no files', () => {
    expect(buildSpecReviewEnrichment([])).toBeNull();
  });

  it('builds enrichment block with cross-reference instructions', () => {
    const result = buildSpecReviewEnrichment(['src/auth.ts', 'src/router.ts']);
    expect(result).not.toBeNull();
    expect(result).toContain('IMPORTANT: This task references a spec document');
    expect(result).toContain('Verify described flows');
    expect(result).toContain('backwards-compatibility');
    expect(result).toContain('functions/methods exist');
    expect(result).toContain('- src/auth.ts');
    expect(result).toContain('- src/router.ts');
  });

  it('lists a single file correctly', () => {
    const result = buildSpecReviewEnrichment(['lib/utils.ts']);
    expect(result).toContain('- lib/utils.ts');
  });
});

describe('assemblePrompt with specReviewContext', () => {
  it('includes specReviewContext when provided', () => {
    const result = assemblePrompt({
      context: 'some context',
      specReviewContext: 'cross-reference block here',
    });
    expect(result).toContain('--- SPEC REVIEW ---');
    expect(result).toContain('cross-reference block here');
    expect(result).toContain('--- END SPEC REVIEW ---');
  });

  it('places specReviewContext before context', () => {
    const result = assemblePrompt({
      context: 'ctx',
      specReviewContext: 'spec review',
    });
    const ctxIdx = result.indexOf('Context:\nctx');
    const specIdx = result.indexOf('--- SPEC REVIEW ---');
    expect(specIdx).toBeLessThan(ctxIdx);
  });

  it('omits spec review block when not provided', () => {
    const result = assemblePrompt({ context: 'ctx' });
    expect(result).not.toContain('--- SPEC REVIEW ---');
  });
});
