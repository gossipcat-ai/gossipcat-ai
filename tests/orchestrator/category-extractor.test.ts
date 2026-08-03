import { extractCategories, isValidCategory, PerformanceWriter } from '@gossip/orchestrator';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

describe('extractCategories', () => {
  test('extracts injection_vectors from injection-related finding', () => {
    expect(extractCategories('Prompt injection via unsanitized input')).toContain('injection_vectors');
  });

  test('extracts concurrency from race condition finding', () => {
    expect(extractCategories('Race condition in scope validation')).toContain('concurrency');
  });

  test('extracts multiple categories from compound finding', () => {
    // #706: bare "injection" no longer fires injection_vectors (89 corpus
    // occurrences, ~94% skill/lesson/dependency injection chatter) — the
    // finding must name the genuine sense concretely, as a real report would
    // ("LLM response" without a type guard is a prompt-injection vector).
    const cats = extractCategories('Missing type guard on LLM response allows prompt injection');
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

  test('extracts trust_boundaries from web-auth vocabulary (CSRF, sec-fetch, samesite, origin, CORS)', () => {
    expect(extractCategories('Missing CSRF token validation on POST handler')).toContain('trust_boundaries');
    expect(extractCategories('Sec-Fetch-Site header not validated before mutation')).toContain('trust_boundaries');
    expect(extractCategories('Cookie missing SameSite=Strict')).toContain('trust_boundaries');
    expect(extractCategories('Origin header trusted without allowlist check')).toContain('trust_boundaries');
    expect(extractCategories('Permissive CORS policy on /api/admin')).toContain('trust_boundaries');
    expect(extractCategories('JWT signature not verified before token use')).toContain('trust_boundaries');
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

  // #706: ambient-noun stopword pass on CATEGORY_PATTERNS, mirroring #700/PR#704
  // on the skill-keyword tables. Bare /inject/i, /dashboard/i, /\bprompt\b/i and
  // /\btest(s|ing)?\b/i measured as majority repo-machinery chatter over a
  // 400-commit corpus (see category-extractor.ts inline comments for the
  // per-pattern fire-rate breakdown) and were replaced with discriminative
  // multi-word forms or dropped outright.
  test('injection_vectors: repo-machinery injection (skill/lesson/dependency) does not fire', () => {
    expect(extractCategories('Skill injection point injects the lesson card into the prompt')).not.toContain('injection_vectors');
    expect(extractCategories('dependency-injected module orchestrator-preconditions.ts')).not.toContain('injection_vectors');
    expect(extractCategories('lesson auto-injection (#669), cross-review memory directive')).not.toContain('injection_vectors');
  });

  test('injection_vectors: genuine multi-word injection senses still fire', () => {
    expect(extractCategories('Header injection via unvalidated redirect target')).toContain('injection_vectors');
    expect(extractCategories('Argument injection in the shell-out helper')).toContain('injection_vectors');
    expect(extractCategories('git-flag-injection via unescaped ref name')).toContain('injection_vectors');
    expect(extractCategories('jsx HTML injection in the rendered markdown')).toContain('injection_vectors');
    expect(extractCategories('Command injection via a crafted filename argument')).toContain('injection_vectors');
  });

  // Phase 1 dev-quality extensions
  test('extracts observability from telemetry/metric findings', () => {
    expect(extractCategories('telemetry gap: drop-gate bug hid for weeks')).toContain('observability');
    expect(extractCategories('No observability into latency metrics on the hot path')).toContain('observability');
    expect(extractCategories('Structured logging omits the request id')).toContain('observability');
  });

  test('observability \\blog\\b avoids backlog/catalog/dialog', () => {
    expect(extractCategories('backlog item stale')).not.toContain('observability');
    expect(extractCategories('catalog.json is out of date')).not.toContain('observability');
    expect(extractCategories('dialog box close handler')).not.toContain('observability');
  });

  // #706: bare /dashboard/i dropped — in this repo "dashboard" means
  // gossipcat's own dashboard product, never a generic observability surface.
  test('observability: repo-machinery dashboard rendering does not fire', () => {
    expect(extractCategories('feat(dashboard): redesign chat page — full-viewport fit')).not.toContain('observability');
    expect(extractCategories('Dashboard WebSocket broadcasts only log_lines')).not.toContain('observability');
    expect(extractCategories('mcp.log spam from getKeywords warnings')).not.toContain('observability');
    expect(extractCategories('git log <sha>..HEAD walk for rotated files')).not.toContain('observability');
  });

  test('extracts cli_ergonomics from UX findings', () => {
    expect(extractCategories('Banner alignment is off; spinner invisible during dispatch')).toContain('cli_ergonomics');
  });

  // #706: bare /\bprompt\b/i dropped — in this repo "prompt" means LLM-prompt
  // assembly machinery, never CLI-facing prompt UX.
  test('cli_ergonomics: repo-machinery prompt assembly does not fire', () => {
    expect(extractCategories('assembled prompt cache warms the system prompt for native dispatch')).not.toContain('cli_ergonomics');
    expect(extractCategories('prompt-assembler.ts wraps the skills block')).not.toContain('cli_ergonomics');
  });

  test('cli_ergonomics: genuine CLI prompt UX still fires', () => {
    expect(extractCategories('Confirmation prompt missing before a destructive rm -rf')).toContain('cli_ergonomics');
    expect(extractCategories('Interactive prompt hangs when stdin is not a TTY')).toContain('cli_ergonomics');
  });

  test('extracts performance from non-DoS perf findings', () => {
    expect(extractCategories('readFileSync loads entire jsonl into memory')).toContain('performance');
    expect(extractCategories('latency in hot path due to uncached lookup')).toContain('performance');
  });

  test('extracts testing from coverage findings', () => {
    expect(extractCategories('Native-agent format compliance has zero test coverage')).toContain('testing');
    expect(extractCategories('test suite missing e2e case for cross-review')).toContain('testing');
  });

  test('testing \\btest\\b avoids contest/protest/latest', () => {
    expect(extractCategories('the latest consensus round')).not.toContain('testing');
    expect(extractCategories('protest against unbounded growth')).not.toContain('testing');
  });

  // #706: bare /\btest(s|ing)?\b/i and the seemingly-qualified /test suite/i
  // both measured majority repo-machinery ("Full suite green, 351 suites,
  // 4774 tests"; "17-case test suite with injected git/fs stubs") rather than
  // findings about test coverage, so both were dropped from the table.
  test('testing: repo-machinery test-suite chatter does not fire', () => {
    expect(extractCategories('Full test suite green (351 suites, 4774 tests); npm run build clean')).not.toContain('testing');
    expect(extractCategories('17-case test suite with injected git/fs/emit stubs')).not.toContain('testing');
    expect(extractCategories('all tests pass, 1270 total')).not.toContain('testing');
  });

  test('testing: genuine coverage-gap phrasing still fires', () => {
    expect(extractCategories('Unit-test coverage gap on the retry path')).toContain('testing');
    expect(extractCategories('This branch is completely untested')).toContain('testing');
  });

  // Regression guard: pins the #706 fix so re-adding a bare ambient pattern
  // (/inject/i, /dashboard/i, /\bprompt\b/i, /\btest(s|ing)?\b/i) to
  // CATEGORY_PATTERNS makes this test fail.
  test('#706 regression guard: bare ambient patterns stay removed', () => {
    const machinery = 'Skill injection point injects the lesson card into the assembled prompt for the feat(dashboard) redesign; full test suite green (353 suites, 4774 tests)';
    const cats = extractCategories(machinery);
    expect(cats).not.toContain('injection_vectors');
    expect(cats).not.toContain('observability');
    expect(cats).not.toContain('cli_ergonomics');
    expect(cats).not.toContain('testing');
  });
});

describe('isValidCategory', () => {
  test('accepts canonical lowercase category names', () => {
    expect(isValidCategory('concurrency')).toBe(true);
    expect(isValidCategory('injection_vectors')).toBe(true);
  });

  test('is case-sensitive — rejects valid names with wrong casing', () => {
    // Agent-supplied categories must match the canonical (lowercase) keys
    // exactly; "Concurrency" would otherwise poison categoryStrengths with a
    // duplicate bucket (spec 2026-05-20-category-resolution-fix.md PART F).
    expect(isValidCategory('Concurrency')).toBe(false);
    expect(isValidCategory('INJECTION_VECTORS')).toBe(false);
  });

  test('rejects unknown categories and undefined', () => {
    expect(isValidCategory('not_a_category')).toBe(false);
    expect(isValidCategory(undefined)).toBe(false);
  });
});

describe('Post-consensus category extraction integration', () => {
  const testDir = join(tmpdir(), 'gossip-cat-hook-' + Date.now());

  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('extractCategories + PerformanceWriter produces category_confirmed signals', () => {
    const writer = new PerformanceWriter(testDir);
    const confirmedFindings = [
      { originalAgentId: 'agent-a', finding: 'Prompt injection via unsanitized input' },
      { originalAgentId: 'agent-b', finding: 'Race condition in scope validation' },
    ];

    for (const f of confirmedFindings) {
      const categories = extractCategories(f.finding);
      for (const category of categories) {
        writer[WRITER_INTERNAL].appendSignal({
          type: 'consensus',
          signal: 'category_confirmed',
          agentId: f.originalAgentId,
          taskId: 'test-task',
          category,
          evidence: f.finding,
          timestamp: new Date().toISOString(),
        } as any);
      }
    }

    const lines = readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8').trim().split('\n');
    const signals = lines.map(l => JSON.parse(l));
    const catSignals = signals.filter((s: any) => s.signal === 'category_confirmed');
    expect(catSignals.length).toBeGreaterThanOrEqual(2);
    expect(catSignals.some((s: any) => s.category === 'injection_vectors')).toBe(true);
    expect(catSignals.some((s: any) => s.category === 'concurrency')).toBe(true);
  });
});
