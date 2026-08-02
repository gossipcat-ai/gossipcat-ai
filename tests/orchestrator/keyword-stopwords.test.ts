/**
 * Issue #700 — ambient-repo-noun stopwording for skill keyword lists.
 *
 * Contextual activation counts keyword hits against the dispatch brief, so a
 * keyword that names this repo's own machinery measures vocabulary overlap
 * rather than task relevance. That made hit rate ANTI-correlated with measured
 * effectiveness: `trust_boundaries` fired on 59.4% of briefs at -0.19, while
 * `concurrency` fired on 15.7% at +0.58 — the worst skill always fired, the best
 * almost never did.
 *
 * This suite pins four things:
 *   1. the filter's normalization contract, including the #681 `*` interaction;
 *   2. the phrase carve-out, which is what keeps #681's `file path*` /
 *      `line number*` alive under a stopworded `path` / `line`;
 *   3. the fail-safe on an all-ambient list;
 *   4. TABLE HYGIENE — no ambient noun survives in either shipped keyword
 *      table. This is the regression gate: the tables are edited by hand, and
 *      re-adding `path` to trust_boundaries must fail here.
 */
import {
  AMBIENT_STOPWORDS,
  isAmbientStopword,
  stripAmbientStopwords,
  normalizeKeywordForStopwordLookup,
} from '../../packages/orchestrator/src/keyword-stopwords';
import { DEFAULT_KEYWORDS, __lruInternals } from '../../packages/orchestrator/src/skill-loader';
import { CATEGORY_KEYWORDS } from '../../packages/orchestrator/src/skill-engine';

const { getPattern } = __lruInternals;

describe('#700 — normalization contract', () => {
  it('lowercases and trims before lookup', () => {
    expect(isAmbientStopword('PATH')).toBe(true);
    expect(isAmbientStopword('  Session  ')).toBe(true);
    expect(isAmbientStopword('ToKeN')).toBe(true);
  });

  it('strips the #681 `*` stem marker before lookup', () => {
    // A stopword smuggled in as a stem would otherwise match MORE than the bare
    // form (`token*` reaches tokens/tokenize) while evading the filter.
    expect(isAmbientStopword('token*')).toBe(true);
    expect(isAmbientStopword('path*')).toBe(true);
    expect(normalizeKeywordForStopwordLookup('token*')).toBe('token');
    expect(normalizeKeywordForStopwordLookup('verif*')).toBe('verif');
  });

  it('strips ALL trailing stem markers, matching keywordStem (consensus b416f60f:f4)', () => {
    // `keywordStem` in skill-loader.ts strips /\*+$/, so `token**` compiles to
    // the same wildcard pattern as `token*`. A single-star strip here let the
    // doubled marker evade the filter while still matching every brief.
    expect(normalizeKeywordForStopwordLookup('token**')).toBe('token');
    expect(isAmbientStopword('token**')).toBe(true);
    expect(isAmbientStopword('path***')).toBe(true);
    expect(stripAmbientStopwords(['token**', 'auth'])).toEqual(['auth']);
  });

  it('leaves non-ambient keywords alone', () => {
    for (const keyword of ['auth', 'traversal', 'sandbox', 'toctou', 'deadlock', 'sanitiz*', 'zod']) {
      expect(isAmbientStopword(keyword)).toBe(false);
    }
  });

  it('an empty or whitespace-only keyword is not a stopword', () => {
    expect(isAmbientStopword('')).toBe(false);
    expect(isAmbientStopword('   ')).toBe(false);
  });
});

describe('#700 — multi-word phrases are never stopwords', () => {
  // The carve-out that keeps #681 intact. `path`, `line`, `test`, `prompt` and
  // `injection` are all ambient alone; every phrase below contains one and must
  // still survive, because the qualifier restores the sense the bare noun lost.
  it.each([
    ['file path*', 'citation_grounding, added by #681'],
    ['line number*', 'citation_grounding, added by #681'],
    ['path traversal', 'trust_boundaries'],
    ['hot path', 'performance'],
    ['unit test', 'testing'],
    ['test suite', 'testing'],
    ['integration test', 'testing'],
    ['prompt injection', 'injection_vectors'],
    ['command injection', 'injection_vectors'],
    ['trust boundary', 'trust_boundaries'],
  ])('%s survives (%s)', phrase => {
    expect(isAmbientStopword(phrase)).toBe(false);
    expect(stripAmbientStopwords([phrase])).toEqual([phrase]);
  });

  it('#681 stem phrases still compile and match after surviving the filter', () => {
    // Guards the interaction rather than the filter alone: a phrase that
    // survives but no longer stem-matches would be a silent #681 regression.
    const kept = stripAmbientStopwords(['file path*', 'line number*']);
    expect(kept).toEqual(['file path*', 'line number*']);
    expect(getPattern(kept[0]).test('the file paths are wrong')).toBe(true);
    expect(getPattern(kept[1]).test('bogus line numbers')).toBe(true);
  });
});

describe('#700 — stripAmbientStopwords', () => {
  it('removes ambient nouns and preserves order and spelling of survivors', () => {
    const input = ['auth', 'session', 'traversal', 'path', 'sandbox', 'injection', 'bypass*'];
    expect(stripAmbientStopwords(input)).toEqual(['auth', 'traversal', 'sandbox', 'bypass*']);
  });

  it('defuses the real shipped skill that motivated this issue', () => {
    // Verbatim `keywords:` from the opus-implementer trust-boundaries skill.
    // Seven ambient nouns made it fire on 5/5 briefs at -0.19 effectiveness.
    const shipped = ['auth', 'session', 'token', 'path', 'traversal', 'injection', 'sandbox',
      'prompt-injection', 'mcp', 'relay', 'resolutionroots', 'projectroot', 'gossip', 'untrusted', 'validate'];
    expect(stripAmbientStopwords(shipped)).toEqual([
      'auth', 'traversal', 'sandbox', 'prompt-injection', 'resolutionroots', 'projectroot', 'untrusted', 'validate',
    ]);
  });

  it('FAIL-SAFE: an all-ambient list is returned intact, never emptied', () => {
    // An empty list sends getKeywords() to the filename fallback, which fires on
    // a single tenuous word — strictly worse than the ambient list it replaced.
    const allAmbient = ['path', 'session', 'token'];
    expect(stripAmbientStopwords(allAmbient)).toEqual(allAmbient);
    expect(stripAmbientStopwords(allAmbient).length).toBeGreaterThan(0);
  });

  it('is idempotent and does not mutate its input', () => {
    const input = ['auth', 'path', 'sandbox'];
    const once = stripAmbientStopwords(input);
    expect(stripAmbientStopwords(once)).toEqual(once);
    expect(input).toEqual(['auth', 'path', 'sandbox']);
  });

  it('an empty input yields an empty output', () => {
    expect(stripAmbientStopwords([])).toEqual([]);
  });
});

describe('#700 — TABLE HYGIENE: no ambient noun ships in either keyword table', () => {
  const tables: ReadonlyArray<[string, Record<string, string[]>]> = [
    ['DEFAULT_KEYWORDS (skill-loader)', DEFAULT_KEYWORDS],
    ['CATEGORY_KEYWORDS (skill-engine)', CATEGORY_KEYWORDS],
  ];

  it('the tables are non-empty (guards a vacuous pass)', () => {
    for (const [, table] of tables) {
      expect(Object.keys(table).length).toBeGreaterThanOrEqual(9);
      for (const keywords of Object.values(table)) expect(keywords.length).toBeGreaterThan(0);
    }
  });

  it.each(tables)('%s contains no ambient repo noun', (_label, table) => {
    const offenders: string[] = [];
    for (const [category, keywords] of Object.entries(table)) {
      for (const keyword of keywords) {
        if (isAmbientStopword(keyword)) offenders.push(`${category}: ${keyword}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the specific nouns named in #700 are gone from the categories they polluted', () => {
    // Spelled out rather than derived, so a future edit to AMBIENT_STOPWORDS
    // cannot make this assertion vacuous.
    expect(DEFAULT_KEYWORDS.trust_boundaries).not.toContain('path');
    expect(DEFAULT_KEYWORDS.trust_boundaries).not.toContain('session');
    expect(DEFAULT_KEYWORDS.trust_boundaries).not.toContain('token');
    expect(DEFAULT_KEYWORDS.trust_boundaries).not.toContain('injection');
    expect(DEFAULT_KEYWORDS.injection_vectors).not.toContain('injection');
    expect(DEFAULT_KEYWORDS.resource_exhaustion).not.toContain('memory');
    expect(DEFAULT_KEYWORDS.observability).not.toContain('log');
    expect(DEFAULT_KEYWORDS.observability).not.toContain('dashboard');
    expect(DEFAULT_KEYWORDS.testing).not.toContain('test');
    expect(DEFAULT_KEYWORDS.testing).not.toContain('tests');
    expect(CATEGORY_KEYWORDS.severity_calibration).not.toContain('high');
    expect(CATEGORY_KEYWORDS.severity_calibration).not.toContain('medium');
    expect(CATEGORY_KEYWORDS.severity_calibration).not.toContain('low');
  });

  it('DF-clearing terms that are their category subject are deliberately KEPT', () => {
    // The admission test has two parts; these prove the second is load-bearing
    // and not decoration. `cli` (22.9%) and `verif*` (34.8%) both clear the DF
    // bar. Stripping `verif*` would directly regress #681, which added it.
    expect(DEFAULT_KEYWORDS.cli_ergonomics).toContain('cli');
    expect(DEFAULT_KEYWORDS.citation_grounding).toContain('verif*');
    expect(DEFAULT_KEYWORDS.testing).toContain('testing');
    expect(AMBIENT_STOPWORDS.has('cli')).toBe(false);
    expect(AMBIENT_STOPWORDS.has('verif')).toBe(false);
    expect(AMBIENT_STOPWORDS.has('logging')).toBe(false);
  });
});

describe('#700 — regenerated categories fire on the right vocabulary', () => {
  const fires = (category: string, text: string): boolean =>
    DEFAULT_KEYWORDS[category].some(k => getPattern(k).test(text));

  it('trust_boundaries no longer fires on ambient brief vocabulary', () => {
    // Every string below is realistic gossipcat brief prose with NO trust
    // boundary concern. Each fired the old table via path/session/token.
    expect(fires('trust_boundaries', 'update the memory file path in the session log')).toBe(false);
    expect(fires('trust_boundaries', 'the relay drops resolutionRoots on consensus')).toBe(false);
    expect(fires('trust_boundaries', 'trim the context token budget for the dashboard')).toBe(false);
    expect(fires('trust_boundaries', 'skill injection happens after the cache warms')).toBe(false);
  });

  it('trust_boundaries still fires on real trust-boundary briefs', () => {
    expect(fires('trust_boundaries', 'the agent escaped the worktree sandbox')).toBe(true);
    expect(fires('trust_boundaries', 'absolute paths bypass the scoped write contract')).toBe(true);
    expect(fires('trust_boundaries', 'validate against path traversal')).toBe(true);
    expect(fires('trust_boundaries', 'untrusted agent output is parsed directly')).toBe(true);
    expect(fires('trust_boundaries', 'the allowlist check is missing')).toBe(true);
    expect(fires('trust_boundaries', 'this lets a caller escalate privileges')).toBe(true);
  });

  it('concurrency now fires on this repo\'s actual concurrency vocabulary', () => {
    // The old table was textbook jargon absent from real briefs: `race
    // condition` matched 0.8% of the corpus where bare `race` matched 5.7%.
    expect(fires('concurrency', 'there is a race between the two writers')).toBe(true);
    expect(fires('concurrency', 'a TOCTOU window in the path policy')).toBe(true);
    expect(fires('concurrency', 'concurrent dispatches interleave their writes')).toBe(true);
    expect(fires('concurrency', 'the mid-flight fixup landed in-flight')).toBe(true);
    expect(fires('concurrency', 'concurrency bug in the counter')).toBe(true);
  });

  it('injection_vectors keeps the security sense and drops the skill-injection sense', () => {
    // 60 of 62 corpus occurrences of bare `injection` are skill/lesson/context
    // injection — the sense inversion that made this category misfire.
    expect(fires('injection_vectors', 'lesson injection poisons the skill cache')).toBe(false);
    expect(fires('injection_vectors', 'the phase-2 skills injection site')).toBe(false);
    expect(fires('injection_vectors', 'a prompt injection in the relay payload')).toBe(true);
    expect(fires('injection_vectors', 'classic argument injection into the shell')).toBe(true);
    expect(fires('injection_vectors', 'the value is sanitized twice')).toBe(true);
  });

  it('testing keeps its phrases while dropping boilerplate "tests pass"', () => {
    expect(fires('testing', 'all tests pass and the build is green')).toBe(false);
    expect(fires('testing', 'add a unit test for the invalid input')).toBe(true);
    expect(fires('testing', 'the fixture is missing coverage')).toBe(true);
  });
});
