/**
 * Regression tests for GH #136 — session-save auto-resolve never fires.
 *
 * Root cause: the auto-resolve blocks in mcp-server-sdk.ts read `f.file`, but
 * producers at handlers/collect.ts never populate that field. The file path
 * is embedded in finding text as `<cite tag="file">path/to/foo.ts[:NN[-MM]]</cite>`.
 *
 * Fix: extract file path via regex from the cite tag (see auto-resolve-finding.ts).
 */
import {
  extractCitedFile,
  tryAutoResolveFinding,
} from '../../apps/cli/src/auto-resolve-finding';

describe('extractCitedFile', () => {
  it('extracts path from basic cite tag with line number', () => {
    expect(
      extractCitedFile('See <cite tag="file">packages/orchestrator/src/foo.ts:42</cite> for bug.')
    ).toBe('packages/orchestrator/src/foo.ts');
  });

  it('extracts path from cite tag with line range', () => {
    expect(
      extractCitedFile('<cite tag="file">path/bar.ts:42-55</cite>')
    ).toBe('path/bar.ts');
  });

  it('extracts path from cite tag without line number', () => {
    expect(
      extractCitedFile('<cite tag="file">apps/cli/src/index.ts</cite>')
    ).toBe('apps/cli/src/index.ts');
  });

  it('returns empty string when no cite tag present', () => {
    expect(extractCitedFile('Just a plain finding with no tag.')).toBe('');
  });

  it('returns empty string for null/undefined input', () => {
    expect(extractCitedFile(null)).toBe('');
    expect(extractCitedFile(undefined)).toBe('');
    expect(extractCitedFile('')).toBe('');
  });

  it('handles whitespace in the tag', () => {
    expect(
      extractCitedFile('<cite  tag="file">packages/foo.ts:10</cite>')
    ).toBe('packages/foo.ts');
  });
});

describe('tryAutoResolveFinding', () => {
  const frozenNow = () => '2026-04-20T00:00:00.000Z';

  it('resolves finding with cite tag + gitLog containing filename + matching word', () => {
    const f = {
      status: 'open',
      finding:
        'Null dereference in <cite tag="file">packages/orchestrator/src/foo.ts:42</cite> when handler misbehaves.',
    };
    const gitLog = 'abc1234 fix(orchestrator): handler null check in foo.ts path\n';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(true);
    expect(r.finding.status).toBe('resolved');
    expect(r.finding.resolvedAt).toBe('2026-04-20T00:00:00.000Z');
    // Input not mutated
    expect(f.status).toBe('open');
  });

  it('leaves finding open when no cite tag', () => {
    const f = { status: 'open', finding: 'Some generic finding mentioning foo.ts and handler.' };
    const gitLog = 'abc1234 fix(foo): handler something';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(false);
    expect(r.finding.status).toBe('open');
  });

  it('leaves finding open when gitLog does not contain filename', () => {
    const f = {
      status: 'open',
      finding: 'Bug in <cite tag="file">packages/orchestrator/src/foo.ts:42</cite> dereferences handler.',
    };
    const gitLog = 'abc1234 docs: update README';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(false);
    expect(r.finding.status).toBe('open');
  });

  it('extracts line-range cite correctly and resolves', () => {
    const f = {
      status: 'open',
      finding:
        'Race condition in <cite tag="file">path/bar.ts:42-55</cite> during concurrent dispatch.',
    };
    const gitLog = 'def5678 fix(dispatch): bar.ts concurrent race condition';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(true);
    expect(r.finding.status).toBe('resolved');
  });

  it('leaves already-resolved finding untouched', () => {
    const f = {
      status: 'resolved',
      finding: '<cite tag="file">foo.ts:1</cite> dereferences handler',
    };
    const gitLog = 'abc foo.ts handler dereferences';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(false);
  });

  it('requires content word match (not just filename)', () => {
    const f = {
      status: 'open',
      finding: 'Bug at <cite tag="file">index.ts:1</cite>.',
    };
    // Filename matches but no content word of length > 5 that also appears
    const gitLog = 'abc1234 chore: bump deps in index.ts';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(false);
  });

  it('falls back to legacy f.file when no cite tag present', () => {
    // Backward compat path — if a future producer ever writes f.file, it still works.
    const f = {
      status: 'open',
      finding: 'A dereference issue involving the handler code path.',
      file: 'packages/orchestrator/src/foo.ts',
    };
    const gitLog = 'abc fix(orch): dereference handler guard in foo.ts';
    const r = tryAutoResolveFinding(f, gitLog, frozenNow);
    expect(r.changed).toBe(true);
    expect(r.finding.status).toBe('resolved');
  });
});
