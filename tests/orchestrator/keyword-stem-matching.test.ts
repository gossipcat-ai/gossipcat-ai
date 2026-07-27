/**
 * Issue #681 — opt-in suffix-wildcard convention in the keyword tables.
 *
 * `getPattern()` compiles every keyword of every skill. Pre-#681 it emitted
 * `/\b<escaped>\b/i` unconditionally, so only base forms matched: 12 of 16
 * realistic `citation_grounding` phrasings fired NO keyword. Relaxing the
 * trailing `\b` globally was rejected in #676 (auth→author, log→login,
 * cast→broadcast, exec→execution).
 *
 * The landed design (option 2, operator-approved): a keyword ending in `*` opts
 * into stem matching — `\b<stem>[a-z]*`, leading anchor kept, trailing anchor
 * dropped. Bare keywords are untouched.
 *
 * This suite pins three things:
 *   1. the compiler contract, by PATTERN SOURCE, so a stem accidentally compiled
 *      with a trailing `\b` fails here and not just downstream;
 *   2. the 16 measured phrasings from the issue, asserting the RIGHT keyword
 *      fires — the pre-#681 pass rate flattered itself, because the 4 phrasings
 *      that did fire all fired via a keyword unrelated to the phrasing;
 *   3. the over-match control class, which must stay dead.
 */
import { DEFAULT_KEYWORDS, keywordStem, __lruInternals } from '../../packages/orchestrator/src/skill-loader';
import { CATEGORY_KEYWORDS } from '../../packages/orchestrator/src/skill-engine';

const { getPattern } = __lruInternals;

/** Which keywords of a category fire on `text` — not just whether any does. */
const firingKeywords = (category: string, text: string): string[] =>
  DEFAULT_KEYWORDS[category].filter(k => getPattern(k).test(text));

const categoryFires = (category: string, text: string): boolean =>
  firingKeywords(category, text).length > 0;

describe('#681 — getPattern compiler contract', () => {
  it('a BARE keyword compiles byte-identically to the pre-#681 pattern', () => {
    // The literal expected sources are spelled out rather than derived, so a
    // regression in the escape/anchor logic cannot be masked by a shared helper.
    expect(getPattern('auth').source).toBe('\\bauth\\b');
    expect(getPattern('cite').source).toBe('\\bcite\\b');
    expect(getPattern('line number').source).toBe('\\bline number\\b');
    expect(getPattern('n+1').source).toBe('\\bn\\+1\\b');
    expect(getPattern('auth').flags).toBe('i');
  });

  it('a TRAILING `*` compiles to a stem match with the leading anchor kept', () => {
    // If the trailing \b survives here, every inflection test below dies — that
    // is the mutation this assertion exists to catch.
    expect(getPattern('verif*').source).toBe('\\bverif[a-z]*');
    expect(getPattern('cite*').source).toBe('\\bcite[a-z]*');
    expect(getPattern('line number*').source).toBe('\\bline number[a-z]*');
    expect(getPattern('verif*').flags).toBe('i');
    expect(getPattern('verif*').source).not.toContain('\\b[a-z]');
    expect(getPattern('verif*').source.endsWith('\\b')).toBe(false);
  });

  it('case-insensitivity survives stem matching', () => {
    expect(getPattern('verif*').test('VERIFIED the claim')).toBe(true);
    expect(getPattern('verif*').test('Verification failed')).toBe(true);
    expect(getPattern('corrupt*').test('CORRUPTION detected')).toBe(true);
  });

  it('the leading \\b still holds — a stem cannot match mid-word', () => {
    // `\bcite[a-z]*` must not fire inside "excite"; dropping the LEADING anchor
    // as well would be a far worse regression than the one being fixed.
    expect(getPattern('cite*').test('excited about it')).toBe(false);
    expect(getPattern('serializ*').test('deserialization failed')).toBe(false);
    expect(getPattern('anchor*').test('unanchored')).toBe(false);
  });

  it('`*` is a wildcard ONLY as the trailing character', () => {
    // Mid-word and leading asterisks stay literal via the escape step, exactly
    // as before #681.
    expect(getPattern('a*b').source).toBe('\\ba\\*b\\b');
    expect(getPattern('a*b').test('a*b')).toBe(true);
    expect(getPattern('a*b').test('ab')).toBe(false);
    expect(getPattern('a*b').test('axb')).toBe(false);
    expect(getPattern('*cite').source).toBe('\\b\\*cite\\b');
    expect(getPattern('*cite').test('cited')).toBe(false);
  });

  it('an all-asterisk keyword fails CLOSED, not open', () => {
    // `\b[a-z]*` would match every task string and activate every skill. The
    // stem is empty, so the compiler must fall back to the exact-match branch.
    expect(getPattern('*').source).toBe('\\b\\*\\b');
    expect(getPattern('*').test('an ordinary task description')).toBe(false);
    expect(getPattern('***').source).toBe('\\b\\*\\*\\*\\b');
    expect(getPattern('***').test('an ordinary task description')).toBe(false);
  });

  it('repeated trailing asterisks collapse to one stem marker', () => {
    expect(getPattern('verif**').source).toBe('\\bverif[a-z]*');
    expect(getPattern('verif**').test('verified')).toBe(true);
  });

  it('keywordStem strips the marker for literal-substring consumers', () => {
    // The signal category-inference paths in mcp-server-sdk.ts match with
    // text.includes(); a raw `cite*` is a substring of nothing.
    expect(keywordStem('cite*')).toBe('cite');
    expect(keywordStem('verif**')).toBe('verif');
    expect(keywordStem('cite')).toBe('cite');
    expect(keywordStem('line number*')).toBe('line number');
    // Empty stem → return the original, so includes() cannot match everything.
    expect(keywordStem('*')).toBe('*');
    expect(keywordStem('**')).toBe('**');
  });

  it('no keyword in any table is dead — every one matches its own stem', () => {
    // The #676 failure class, restated for the wildcard era: a keyword that
    // cannot match the text it is made of can never fire.
    for (const [category, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
      for (const k of keywords) {
        expect(`${category}:${k}:${getPattern(k).test(keywordStem(k))}`).toBe(`${category}:${k}:true`);
      }
    }
  });
});

/**
 * The 16 phrasings measured in issue #681, verbatim. `expected` names the
 * keyword that SHOULD carry each phrasing — asserting only "something fired"
 * would have passed pre-#681 for four of these via unrelated keywords.
 */
const ISSUE_681_PHRASINGS: ReadonlyArray<{ text: string; expected: string; wasDead: boolean }> = [
  { text: 'cites the wrong line', expected: 'cite*', wasDead: true },
  { text: 'cited the file', expected: 'cite*', wasDead: true },
  { text: 'citing a stale anchor', expected: 'citing', wasDead: false },
  { text: 'three citations', expected: 'citation*', wasDead: true },
  { text: 'the line numbers are wrong', expected: 'line number*', wasDead: true },
  { text: 'two anchors', expected: 'anchor*', wasDead: true },
  { text: 'anchored to master', expected: 'anchor*', wasDead: true },
  { text: 'several file paths', expected: 'file path*', wasDead: true },
  { text: 'references are stale', expected: 'referenc*', wasDead: true },
  { text: 'referenced the wrong file', expected: 'referenc*', wasDead: true },
  { text: 'referencing a dead line', expected: 'referenc*', wasDead: true },
  { text: 'verifies the claim', expected: 'verif*', wasDead: true },
  { text: 'I verified the citation', expected: 'verif*', wasDead: false },
  { text: 'verifying the anchor', expected: 'verif*', wasDead: false },
  { text: 'citation verification failed', expected: 'citation*', wasDead: false },
  { text: "doesn't exist", expected: "doesn't exist", wasDead: true },
];

describe('#681 — the 16 measured phrasings', () => {
  it('the fixture matches the issue: 12 were DEAD, 4 fired', () => {
    // Guards the guard — if someone trims the table, the reason is unambiguous.
    expect(ISSUE_681_PHRASINGS).toHaveLength(16);
    expect(ISSUE_681_PHRASINGS.filter(p => p.wasDead)).toHaveLength(12);
  });

  it.each(ISSUE_681_PHRASINGS.map(p => [p.text, p.expected] as const))(
    'fires via the RIGHT keyword: "%s" → %s',
    (text, expected) => {
      expect(firingKeywords('citation_grounding', text)).toContain(expected);
    },
  );

  it('all 16 fire the category (0 dead, was 12)', () => {
    const dead = ISSUE_681_PHRASINGS.filter(p => !categoryFires('citation_grounding', p.text));
    expect(dead.map(p => p.text)).toEqual([]);
  });
});

/**
 * Over-match control class. Every stem introduced by #681 was picked over a
 * shorter one precisely because the shorter one collided with these words. If a
 * future edit shortens a stem, this suite is what fails.
 */
describe('#681 — over-match control class stays dead', () => {
  it.each([
    // [category, text, why]
    ['trust_boundaries', 'the author of the commit', 'auth must not reach author (#676)'],
    ['observability', 'the login screen', 'log must not reach login'],
    ['observability', 'business logic bug', 'log must not reach logic'],
    ['type_safety', 'a broadcast listener', 'cast must not reach broadcast'],
    ['type_safety', 'the castle metaphor', 'cast stays bare — cast* would reach castle'],
    ['injection_vectors', 'the executive summary', 'exec stays bare — exec* would reach executive'],
    ['citation_grounding', 'the city of Ankara', 'cite* must not reach city (cit* was rejected)'],
    ['citation_grounding', 'a citizen report', 'cite* must not reach citizen'],
    ['citation_grounding', 'a referral to another team', 'referenc* must not reach referral'],
    ['citation_grounding', 'very fabric-like texture', 'fabricate entries must not reach fabric'],
    ['error_handling', 'retrieve the record', 'retry* must not reach retrieve'],
    ['error_handling', 'a hasty retreat', 'retry* must not reach retreat'],
    ['data_integrity', 'a corral for the horses', 'corrupt* must not reach unrelated cor- words'],
  ])('%s does not fire on "%s" (%s)', (category, text) => {
    expect(firingKeywords(category as string, text as string)).toEqual([]);
  });

  it('serializ* and deserializ* do not cross-match', () => {
    // The leading \b is what separates them; both entries are therefore needed.
    expect(getPattern('serializ*').test('deserialize the payload')).toBe(false);
    expect(getPattern('deserializ*').test('serialize the payload')).toBe(false);
    expect(getPattern('serializ*').test('serialization is lossy')).toBe(true);
    expect(getPattern('deserializ*').test('deserialization is lossy')).toBe(true);
  });

  it('the widened categories still fire on their own inflections', () => {
    expect(categoryFires('data_integrity', 'the record was corrupted')).toBe(true);
    expect(categoryFires('data_integrity', 'silent corruption on write')).toBe(true);
    expect(categoryFires('injection_vectors', 'the value is sanitized twice')).toBe(true);
    expect(categoryFires('injection_vectors', 'sanitization is the sole defense')).toBe(true);
    expect(categoryFires('input_validation', 'sanitizing user input')).toBe(true);
    expect(categoryFires('error_handling', 'retrying the request')).toBe(true);
    expect(categoryFires('error_handling', 'three retries then give up')).toBe(true);
    expect(categoryFires('error_handling', 'it retried and failed')).toBe(true);
  });
});

describe('#681 — the two keyword tables agree', () => {
  const shared = Object.keys(DEFAULT_KEYWORDS).filter(c => c in CATEGORY_KEYWORDS);

  it('there are shared categories to compare (guards a vacuous pass)', () => {
    expect(shared.length).toBeGreaterThanOrEqual(9);
  });

  it.each(shared)('DEFAULT_KEYWORDS.%s === CATEGORY_KEYWORDS equivalent', category => {
    // #675 noted drift between these two tables. They feed different pipelines
    // (contextual activation vs. generated-skill frontmatter), so drift means a
    // generated skill inherits keywords the loader never intended.
    expect(CATEGORY_KEYWORDS[category]).toEqual(DEFAULT_KEYWORDS[category]);
  });

  it('the categories that legitimately differ are only these', () => {
    // skill-engine seeds generated skills and carries severity_calibration, a
    // category with no loader-side default. skill-loader carries the Phase 1
    // dev-quality categories, which are never auto-generated. Documented, not
    // accidental — a NEW asymmetry should fail this test.
    const engineOnly = Object.keys(CATEGORY_KEYWORDS).filter(c => !(c in DEFAULT_KEYWORDS));
    const loaderOnly = Object.keys(DEFAULT_KEYWORDS).filter(c => !(c in CATEGORY_KEYWORDS));
    expect(engineOnly.sort()).toEqual(['severity_calibration']);
    expect(loaderOnly.sort()).toEqual(['cli_ergonomics', 'observability', 'performance', 'testing']);
  });
});
