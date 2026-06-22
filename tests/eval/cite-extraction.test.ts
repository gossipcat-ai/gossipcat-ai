/**
 * tests/eval/cite-extraction.test.ts — extractCiteAnchor unit coverage.
 *
 * The eval scoring rubric (eval/match.ts) returns 0 when finding.file is
 * undefined. parseAgentFindingsStrict gives us only the prose `content`;
 * extractCiteAnchor pulls the file:line anchor from the FIRST
 * `<cite tag="file">…</cite>` so live-dispatched findings can score above
 * the file-mismatch floor.
 */

import { extractCiteAnchor } from '../../eval/harness';

describe('extractCiteAnchor', () => {
  it('extracts file and line from a single cite', () => {
    const out = extractCiteAnchor(
      'The bug lives in <cite tag="file">packages/dashboard/Foo.tsx:42</cite> as a missing guard.',
    );
    expect(out).toEqual({ file: 'packages/dashboard/Foo.tsx', line: 42 });
  });

  it('prefers the first cite when multiple are present', () => {
    const out = extractCiteAnchor(
      'See <cite tag="file">a/first.ts:10</cite> then <cite tag="file">b/second.ts:20</cite>.',
    );
    expect(out).toEqual({ file: 'a/first.ts', line: 10 });
  });

  it('reduces a line range to its lower bound', () => {
    const out = extractCiteAnchor(
      'Span <cite tag="file">eval/match.ts:11-15</cite> handles the rubric.',
    );
    expect(out).toEqual({ file: 'eval/match.ts', line: 11 });
  });

  it('returns undefined fields when no cite is present', () => {
    const out = extractCiteAnchor('Plain prose with no anchor at all.');
    expect(out).toEqual({});
  });

  it('returns undefined fields on a malformed cite (missing line)', () => {
    const out = extractCiteAnchor(
      'Broken <cite tag="file">eval/match.ts</cite> no colon line.',
    );
    expect(out).toEqual({});
  });

  it('accepts single-quoted tag attribute', () => {
    const out = extractCiteAnchor(
      "Mixed quotes <cite tag='file'>x/y.ts:7</cite> still work.",
    );
    expect(out).toEqual({ file: 'x/y.ts', line: 7 });
  });
});
