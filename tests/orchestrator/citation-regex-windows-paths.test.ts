// tests/orchestrator/citation-regex-windows-paths.test.ts
//
// Regression tests for issue #413 — Windows drive-letter citation regex.
// Ensures that paths like `c:/Users/Daniele/repo/src/foo.ts:42` are matched
// starting at the drive letter, not at position 2 (which would strip the drive
// letter from the anchor key and break cross-review resolution on Windows repos).
//
// Coverage across three distinct regex patterns:
//   1. parse-findings ANCHOR_PATTERN (via parseAgentFindingsStrict hasAnchor)
//   2. dedupe-key ANCHOR_PATTERN (via DEDUPE_KEY_INTERNALS)
//   3. consensus-engine citationPattern (re-declared inline — not exported)

import { parseAgentFindingsStrict } from '@gossip/orchestrator';
import { DEDUPE_KEY_INTERNALS } from '@gossip/orchestrator';

// Re-declare the Shape-B citationPattern from consensus-engine.ts:1464 so we
// can unit-test it without pulling the full engine into scope.
const CONSENSUS_CITATION_PATTERN =
  /((?:[a-zA-Z]:\/)?(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6})):(\d+)/g;

// Helper: reset lastIndex and collect all matches from a global regex.
function allMatches(re: RegExp, input: string): RegExpExecArray[] {
  re.lastIndex = 0;
  const results: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) results.push(m);
  return results;
}

// ---------------------------------------------------------------------------
// 1. Unix path — still works (regression guard)
// ---------------------------------------------------------------------------
describe('ANCHOR_PATTERN — unix path', () => {
  it('matches auth.ts:38 with full path captured (parse-findings hasAnchor)', () => {
    const body = `<agent_finding type="finding" severity="high" category="input_validation">
Missing bounds check at auth.ts:38 causes overflow.
</agent_finding>`;
    const result = parseAgentFindingsStrict(body);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].hasAnchor).toBe(true);
  });

  it('matches unix path via dedupe-key ANCHOR_PATTERN', () => {
    const { ANCHOR_PATTERN } = DEDUPE_KEY_INTERNALS;
    const m = 'src/auth.ts:38'.match(ANCHOR_PATTERN);
    expect(m).not.toBeNull();
    expect(m![0]).toBe('src/auth.ts:38');
  });
});

// ---------------------------------------------------------------------------
// 2. Windows drive letter (lowercase) — core regression
// ---------------------------------------------------------------------------
describe('ANCHOR_PATTERN — Windows lowercase drive letter', () => {
  it('matches c:/Users/Daniele/repo/src/foo.ts:42 starting at c: (dedupe-key)', () => {
    const { ANCHOR_PATTERN } = DEDUPE_KEY_INTERNALS;
    const input = 'Bug at c:/Users/Daniele/repo/src/foo.ts:42 in loop';
    const m = input.match(ANCHOR_PATTERN);
    expect(m).not.toBeNull();
    // Full match must start with the drive letter, not strip it
    expect(m![0]).toContain('c:/');
    expect(m![0]).toMatch(/^c:\//);
  });

  it('preserves drive letter in hasAnchor detection (parse-findings)', () => {
    const body = `<agent_finding type="finding" severity="medium" category="error_handling">
Unhandled null at c:/Users/Daniele/repo/src/foo.ts:42 inside loop.
</agent_finding>`;
    const result = parseAgentFindingsStrict(body);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].hasAnchor).toBe(true);
  });

  it('consensus citationPattern captures full path including drive letter', () => {
    const input = 'See c:/Users/Daniele/repo/src/foo.ts:42 for details';
    const matches = allMatches(CONSENSUS_CITATION_PATTERN, input);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const fullRef = matches[0][1];
    expect(fullRef).toMatch(/^c:\//);
    expect(fullRef).toContain('foo.ts');
  });
});

// ---------------------------------------------------------------------------
// 3. Windows drive letter (uppercase)
// ---------------------------------------------------------------------------
describe('ANCHOR_PATTERN — Windows uppercase drive letter', () => {
  it('matches C:/Users/foo.ts:1 starting at C: (dedupe-key)', () => {
    const { ANCHOR_PATTERN } = DEDUPE_KEY_INTERNALS;
    const input = 'C:/Users/foo.ts:1';
    const m = input.match(ANCHOR_PATTERN);
    expect(m).not.toBeNull();
    expect(m![0]).toMatch(/^C:\//);
  });

  it('consensus citationPattern captures full path with uppercase drive', () => {
    const input = 'Error at C:/Users/foo.ts:1 is critical';
    const matches = allMatches(CONSENSUS_CITATION_PATTERN, input);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const fullRef = matches[0][1];
    expect(fullRef).toMatch(/^C:\//);
  });
});

// ---------------------------------------------------------------------------
// 4. cite tag context — full path preserved through extraction
// ---------------------------------------------------------------------------
describe('cite tag Windows path', () => {
  it('consensus citationPattern finds the path inside a cite tag attribute value', () => {
    // Simulate the inner value extracted from <cite tag="file">c:/Users/foo.ts:42</cite>
    const tagValue = 'c:/Users/foo.ts:42';
    const matches = allMatches(CONSENSUS_CITATION_PATTERN, tagValue);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const fullRef = matches[0][1];
    expect(fullRef).toMatch(/^c:\//);
    expect(fullRef).toContain('foo.ts');
    expect(matches[0][3]).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// 5. URL-shaped string — still extracts a citation (didn't break URL strings)
// ---------------------------------------------------------------------------
describe('URL-shaped strings — still matches embedded file citation', () => {
  it('consensus citationPattern still extracts foo.ts:42 from URL-like context', () => {
    // The URL prefix is not a drive-letter, so the pattern will still find
    // the embedded .ts:N citation anchored at the filename portion.
    const input = 'http://example.com/foo.ts:42';
    const matches = allMatches(CONSENSUS_CITATION_PATTERN, input);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const fileCapture = matches[matches.length - 1][2];
    expect(fileCapture).toBe('foo.ts');
  });
});
