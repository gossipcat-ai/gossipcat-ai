import { extractCategories } from '@gossip/orchestrator';

describe('extractCategories', () => {
  test('extracts injection_vectors from injection-related finding', () => {
    expect(extractCategories('Prompt injection via unsanitized input')).toContain('injection_vectors');
  });

  test('extracts concurrency from race condition finding', () => {
    expect(extractCategories('Race condition in scope validation')).toContain('concurrency');
  });

  test('extracts multiple categories from compound finding', () => {
    const cats = extractCategories('Missing type guard on LLM response allows injection');
    expect(cats).toContain('type_safety');
    expect(cats).toContain('injection_vectors');
  });

  test('returns empty array for unrecognized finding', () => {
    expect(extractCategories('The button color is wrong')).toEqual([]);
  });

  test('is case insensitive', () => {
    expect(extractCategories('DOS attack via unbounded allocation')).toContain('resource_exhaustion');
    expect(extractCategories('dos attack via unbounded allocation')).toContain('resource_exhaustion');
  });

  test('extracts trust_boundaries from auth finding', () => {
    expect(extractCategories('No authentication on relay connection')).toContain('trust_boundaries');
  });

  test('extracts error_handling from exception finding', () => {
    expect(extractCategories('Unhandled exception in fallback path')).toContain('error_handling');
  });

  test('extracts data_integrity from corruption finding', () => {
    expect(extractCategories('Data corruption from non-atomic write')).toContain('data_integrity');
  });

  test('returns deduplicated categories', () => {
    const cats = extractCategories('SQL injection with unsanitized input injection');
    const unique = new Set(cats);
    expect(cats.length).toBe(unique.size);
  });
});
