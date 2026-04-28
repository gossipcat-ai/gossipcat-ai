/**
 * Tests for open-findings auto-resolver — Phase 1.
 * Spec: docs/specs/2026-04-27-open-findings-auto-resolve.md (rev2,
 * consensus b3f57cc6-22c24114).
 *
 * Covers Test Plan items 1–9 (unit) plus a focused replay (15) and
 * conservatism (16). Integration tests 10–14 require larger fixtures
 * (full git fixtures for shallow-clone, multi-process orchestration);
 * these are kept smaller in scope and rely on `execFileSync` against
 * temp git repos that we initialize from scratch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import {
  resolveFindings,
  parseCites,
  validatePath,
  isAutoMemoryPath,
  inferLeadIdentifier,
  stripJsTsComments,
  containsToken,
  appendChainedEntry,
  verifyChain,
  ZERO_HASH,
  withResolverLock,
} from '@gossip/orchestrator';

function makeTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-resolver-'));
  fs.mkdirSync(path.join(root, '.gossip'));
  return root;
}

function initGit(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

function commit(root: string, msg: string): string {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', msg, '--no-gpg-sign'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function writeFinding(root: string, entry: any): void {
  const p = path.join(root, '.gossip', 'implementation-findings.jsonl');
  const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  fs.writeFileSync(p, prev + JSON.stringify(entry) + '\n');
}

function readFindings(root: string): any[] {
  const p = path.join(root, '.gossip', 'implementation-findings.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('finding-resolver — pure helpers', () => {
  test('parseCites extracts file + line + fn cites', () => {
    const text = 'Bug at <cite tag="file">src/foo.ts:42</cite> via <cite tag="fn">badFn</cite>.';
    const out = parseCites(text);
    expect(out.fileCites).toEqual([{ path: 'src/foo.ts', line: 42 }]);
    expect(out.fnCites).toEqual(['badFn']);
  });

  test('parseCites handles file-only (no line)', () => {
    const out = parseCites('See <cite tag="file">README.md</cite>.');
    expect(out.fileCites).toEqual([{ path: 'README.md' }]);
  });

  test('parseCites picks up plain-prose path:line citations (PR-299 Bug B)', () => {
    const out = parseCites('writeFileSync at hook-installer.ts:107 is not atomic');
    expect(out.fileCites).toContainEqual({ path: 'hook-installer.ts', line: 107 });
  });

  test('parseCites does not double-count when both structured and plain forms appear', () => {
    const text = 'Bug at <cite tag="file">src/foo.ts:42</cite> and elsewhere src/foo.ts:42 again.';
    const out = parseCites(text);
    // structured cite consumed; plain-prose pass dedupes the same path:line
    expect(out.fileCites).toEqual([{ path: 'src/foo.ts', line: 42 }]);
  });

  test('parseCites plain-prose ignores version-like tokens without a known extension', () => {
    const out = parseCites('Released v1.2:3 yesterday');
    expect(out.fileCites).toEqual([]);
  });

  test('parseCites plain-prose handles cross-reviewer-selection.ts:105,110', () => {
    const out = parseCites('see cross-reviewer-selection.ts:105,110 for details');
    expect(out.fileCites.length).toBeGreaterThanOrEqual(1);
    expect(out.fileCites[0]).toEqual({ path: 'cross-reviewer-selection.ts', line: 105 });
  });

  test('inferLeadIdentifier picks first backtick-wrapped identifier', () => {
    expect(inferLeadIdentifier('Use `Math.min` here, then `bar`.')).toBe('Math.min');
    expect(inferLeadIdentifier('no backticks here')).toBeNull();
  });

  test('stripJsTsComments removes both // and /* */ comments', () => {
    const src = `let x = 1; // was: badFn(...)\n/* multi\nline\n */ const y = 2;`;
    const stripped = stripJsTsComments(src);
    expect(stripped).not.toContain('badFn');
    expect(stripped).not.toContain('multi');
    expect(stripped).toContain('let x = 1');
    expect(stripped).toContain('const y = 2');
  });

  test('containsToken respects identifier boundaries', () => {
    expect(containsToken('foo Math.min(a)', 'Math.min')).toBe(true);
    expect(containsToken('foo Math.minutes', 'Math.min')).toBe(false);
    expect(containsToken('findFiles()', 'findFile')).toBe(false);
    expect(containsToken('findFile()', 'findFile')).toBe(true);
  });
});

describe('finding-resolver — path validation (test #3)', () => {
  test('rejects ..', () => {
    const root = makeTempProject();
    const r = validatePath(root, '../etc/passwd');
    expect(r.ok).toBe(false);
  });
  test('rejects NUL', () => {
    const root = makeTempProject();
    const r = validatePath(root, 'foo\0bar.ts');
    expect(r.ok).toBe(false);
  });
  test('rejects leading slash', () => {
    const root = makeTempProject();
    expect(validatePath(root, '/etc/passwd').ok).toBe(false);
  });
  test('rejects leading tilde', () => {
    const root = makeTempProject();
    expect(validatePath(root, '~/foo.ts').ok).toBe(false);
  });
  test('rejects URL scheme', () => {
    const root = makeTempProject();
    expect(validatePath(root, 'https://evil.com/x').ok).toBe(false);
  });
  test('accepts plain relative path', () => {
    const root = makeTempProject();
    const r = validatePath(root, 'src/foo.ts');
    expect(r.ok).toBe(true);
  });
  test('rejects symlink that escapes root', () => {
    const root = makeTempProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    const r = validatePath(root, 'leak.txt');
    expect(r.ok).toBe(false);
  });

  // Bucket A — absolute path inside projectRoot should be accepted
  test('accepts absolute path that resolves inside projectRoot', () => {
    const root = makeTempProject();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'foo.ts'), 'export const x = 1;\n');
    const absPath = path.join(root, 'src', 'foo.ts');
    const r = validatePath(root, absPath);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    // absPath should be the realpathed form of the file
    expect(r.absPath).toBeTruthy();
    expect(r.absPath).toContain('foo.ts');
  });

  // Bucket A — absolute path OUTSIDE projectRoot should reject with ESCAPE, not ABSOLUTE
  test('rejects absolute path outside projectRoot with reason ESCAPE', () => {
    const root = makeTempProject();
    const r = validatePath(root, '/etc/passwd');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toContain('escapes project root');
  });
});

describe('isAutoMemoryPath', () => {
  test('matches ~/.claude/projects/<encoded>/memory/foo.md', () => {
    // Construct the encoded project root path as Claude Code does it
    const projectRoot = '/Users/test/myproject';
    const encoded = projectRoot.replace(/\//g, '-'); // -Users-test-myproject
    const memPath = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory', 'MEMORY.md');
    expect(isAutoMemoryPath(projectRoot, memPath)).toBe(true);
  });

  test('matches nested memory file', () => {
    const projectRoot = '/Users/test/myproject';
    const encoded = projectRoot.replace(/\//g, '-');
    const memPath = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory', 'project_foo.md');
    expect(isAutoMemoryPath(projectRoot, memPath)).toBe(true);
  });

  test('does not match a non-memory path', () => {
    const projectRoot = '/Users/test/myproject';
    expect(isAutoMemoryPath(projectRoot, '/Users/test/myproject/src/foo.ts')).toBe(false);
  });

  test('does not match a different project encoded path', () => {
    const projectRoot = '/Users/test/myproject';
    const otherEncoded = '-Users-other-project';
    const memPath = path.join(os.homedir(), '.claude', 'projects', otherEncoded, 'memory', 'foo.md');
    expect(isAutoMemoryPath(projectRoot, memPath)).toBe(false);
  });

  test('does not match a relative path', () => {
    const projectRoot = '/Users/test/myproject';
    expect(isAutoMemoryPath(projectRoot, 'memory/foo.md')).toBe(false);
  });
});

describe('audit-log-chain (test #9)', () => {
  test('first entry uses ZERO_HASH and chains forward', () => {
    const root = makeTempProject();
    const e1 = appendChainedEntry(root, { ts: '2026-01-01T00:00:00Z', finding_id: 'a:1', action: 'resolve', operator: 'auto' });
    expect(e1.prev_hash).toBe(ZERO_HASH);
    const e2 = appendChainedEntry(root, { ts: '2026-01-02T00:00:00Z', finding_id: 'a:2', action: 'resolve', operator: 'auto' });
    expect(e2.prev_hash).toBe(e1.entry_hash);
    expect(verifyChain(root)).toBeNull();
  });
  test('tampering with entry breaks the chain', () => {
    const root = makeTempProject();
    appendChainedEntry(root, { ts: 'a', finding_id: 'a:1', action: 'resolve', operator: 'auto' });
    appendChainedEntry(root, { ts: 'b', finding_id: 'a:2', action: 'resolve', operator: 'auto' });
    appendChainedEntry(root, { ts: 'c', finding_id: 'a:3', action: 'resolve', operator: 'auto' });
    const p = path.join(root, '.gossip', 'finding-resolutions.jsonl');
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.reason = 'evil';
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    const v = verifyChain(root);
    expect(v).not.toBeNull();
    expect(v!.brokenAtIndex).toBe(1);
  });
});

describe('finding-resolver — file lock', () => {
  test('two concurrent locks: one wins, second times out', async () => {
    const root = makeTempProject();
    const order: string[] = [];
    const a = withResolverLock(root, async () => {
      order.push('a-start');
      await new Promise(r => setTimeout(r, 200));
      order.push('a-end');
      return 'A';
    }, { waitMs: 50 });
    // Give A time to acquire
    await new Promise(r => setTimeout(r, 30));
    const b = await withResolverLock(root, async () => {
      order.push('b-start');
      return 'B';
    }, { waitMs: 50 });
    const aResult = await a;
    expect(aResult).toBe('A');
    expect(b).toBeNull(); // contended
    expect(order).toEqual(['a-start', 'a-end']);
  });
});

describe('finding-resolver — resolveFindings', () => {
  function setupGitFixture(): { root: string; touchedSha: string } {
    const root = makeTempProject();
    initGit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // initial: contains `Math.min(...arr)`
    fs.writeFileSync(
      path.join(root, 'src/foo.ts'),
      `export function smallest(arr: number[]) { return Math.min(...arr); }\n`,
    );
    commit(root, 'init');
    // fix: replace with reduce
    fs.writeFileSync(
      path.join(root, 'src/foo.ts'),
      `export function smallest(arr: number[]) { return arr.reduce((a, b) => a < b ? a : b); }\n`,
    );
    const touchedSha = commit(root, 'fix Math.min spread');
    return { root, touchedSha };
  }

  test('test #1 + #15: resolves a finding when cited symbol is gone', async () => {
    const { root } = setupGitFixture();
    writeFinding(root, {
      timestamp: '2026-04-12T00:00:00Z',
      taskId: 'abc-1:f1',
      originalAgentId: 'gemini-reviewer',
      finding: 'Stack overflow with `Math.min` spread on large arrays. <cite tag="file">src/foo.ts:1</cite>',
      tag: 'unverified',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(1);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('resolved');
    expect(findings[0].resolvedBy).toMatch(/^commit:[0-9a-f]{40}$/);
  });

  test('test #2: insight-tag findings are never resolved', async () => {
    const { root } = setupGitFixture();
    writeFinding(root, {
      timestamp: '2026-04-12T00:00:00Z',
      taskId: 'abc-2:f1',
      type: 'insight',
      finding: '`Math.min` is no longer used. <cite tag="file">src/foo.ts:1</cite>',
      tag: 'confirmed',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('open');
  });

  test('test #4: idempotent — resolved finding stays resolved without duplicate audit entry', async () => {
    const { root } = setupGitFixture();
    writeFinding(root, {
      taskId: 'abc-4:f1',
      finding: 'Bad `Math.min` <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    await resolveFindings(root, { full: true });
    const auditPath = path.join(root, '.gossip', 'finding-resolutions.jsonl');
    const before = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
    await resolveFindings(root, { full: true });
    const after = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
    expect(after).toBe(before);
  });

  test('test #5: multi-cite AND — partial fix does not resolve', async () => {
    const { root } = setupGitFixture();
    fs.writeFileSync(path.join(root, 'src/bar.ts'), `export const bug = Math.min(1, 2);\n`);
    commit(root, 'add bar');
    writeFinding(root, {
      taskId: 'abc-5:f1',
      finding: 'Bug touches both `Math.min` <cite tag="file">src/foo.ts:1</cite> and <cite tag="file">src/bar.ts:1</cite>.',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(0);
  });

  test('test #6: comment-stripped grep — // was: Math.min(...) does not block resolution', async () => {
    const root = makeTempProject();
    initGit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/foo.ts'),
      `export function smallest(arr: number[]) {\n  // was: Math.min(...arr)\n  return arr.reduce((a, b) => a < b ? a : b);\n}\n`,
    );
    commit(root, 'init');
    writeFinding(root, {
      taskId: 'abc-6:f1',
      finding: 'Bad `Math.min` spread <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(1);
  });

  test('test #16: conservatism — rename keeps spread => stays open', async () => {
    const root = makeTempProject();
    initGit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/foo.ts'),
      `export function smallest(arr: number[]) { return findMin(...arr); }\nfunction findMin(...nums: number[]) { return Math.min(...nums); }\n`,
    );
    commit(root, 'init');
    writeFinding(root, {
      taskId: 'abc-16:f1',
      finding: 'Bad `Math.min` spread on large arrays <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('open');
  });

  test('test #3 (audit-log entry on path rejection)', async () => {
    const root = makeTempProject();
    initGit(root);
    fs.writeFileSync(path.join(root, 'README.md'), '# noop\n');
    commit(root, 'init');
    writeFinding(root, {
      taskId: 'abc-pv:f1',
      finding: 'Bad path <cite tag="file">../escape.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.pathRejections).toBe(1);
    const auditPath = path.join(root, '.gossip', 'finding-resolutions.jsonl');
    const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.action).toBe('path_validation_rejected');
    expect(entry.after_check).toBe('rejected_path');
  });

  test('test #7: corrupt watermark falls back to cold-start window', async () => {
    const { root } = setupGitFixture();
    fs.writeFileSync(path.join(root, '.gossip', 'last-resolve-scan.sha'), 'NOT_A_SHA\n');
    writeFinding(root, {
      taskId: 'abc-7:f1',
      finding: 'Bad `Math.min` <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    // Without `full`, the resolver should still discover the touched file
    // via cold-start window (--since=90.days)
    const result = await resolveFindings(root);
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(1);
  });

  test('PR-299 Bug A: row without `type` falls back to consensus report (finding → resolves)', async () => {
    const { root } = setupGitFixture();
    fs.mkdirSync(path.join(root, '.gossip', 'consensus-reports'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.gossip', 'consensus-reports', 'abcd1234-ef567890.json'),
      JSON.stringify({
        id: 'abcd1234-ef567890',
        confirmed: [{ id: 'abcd1234-ef567890:f1', findingType: 'finding', finding: 'x' }],
      }),
    );
    writeFinding(root, {
      taskId: 'abcd1234-ef567890:f1',
      finding: 'Bad `Math.min` <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      // no `type` field — must backfill from consensus report
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(1);
  });

  test('PR-299 Bug A: row without `type`, consensus report shows insight → skip', async () => {
    const { root } = setupGitFixture();
    fs.mkdirSync(path.join(root, '.gossip', 'consensus-reports'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.gossip', 'consensus-reports', 'aaaa1111-bbbb2222.json'),
      JSON.stringify({
        id: 'aaaa1111-bbbb2222',
        insights: [{ id: 'aaaa1111-bbbb2222:f1', findingType: 'insight', finding: 'x' }],
      }),
    );
    writeFinding(root, {
      taskId: 'aaaa1111-bbbb2222:f1',
      finding: 'Note: `Math.min` no longer used <cite tag="file">src/foo.ts:1</cite>',
      tag: 'unique',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('open');
  });

  test('PR-299 Bug A: row without `type`, no consensus report → conservative skip', async () => {
    const { root } = setupGitFixture();
    writeFinding(root, {
      taskId: 'cccc3333-dddd4444:f1',
      finding: 'Bad `Math.min` <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('open');
  });

  test('test #8: config.json override is respected', async () => {
    const { root } = setupGitFixture();
    fs.writeFileSync(
      path.join(root, '.gossip', 'config.json'),
      JSON.stringify({ resolver: { coldStartWindow: '7.days' } }),
    );
    writeFinding(root, {
      taskId: 'abc-8:f1',
      finding: 'Bad `Math.min` <cite tag="file">src/foo.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root);
    if (!result.ok) throw new Error();
    expect(result.resolved).toBe(1);
  });

  // Bucket A integration: finding citing absolute in-project path resolves cleanly
  test('Bucket A: finding with absolute in-project citation resolves when symbol is absent', async () => {
    const { root } = setupGitFixture();
    // cite the file using an absolute path — same file as src/foo.ts but absolute
    const absFilePath = path.join(root, 'src', 'foo.ts');
    writeFinding(root, {
      taskId: 'abs-path-test:f1',
      finding: `Bad \`Math.min\` spread <cite tag="file">${absFilePath}:1</cite>`,
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    // should resolve (not reject) because Math.min is gone from src/foo.ts
    expect(result.resolved).toBe(1);
    expect(result.pathRejections).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('resolved');
  });

  // Bucket B integration: finding citing auto-memory path produces 'skipped' audit entry
  test('Bucket B: finding citing auto-memory path produces skipped/not_source audit entry', async () => {
    const { root } = setupGitFixture();
    // Simulate an auto-memory path for this project root
    const encoded = root.replace(/\//g, '-');
    const memPath = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory', 'MEMORY.md');
    writeFinding(root, {
      taskId: 'memory-cite-test:f1',
      finding: `Note: see \`Math.min\` docs at <cite tag="file">${memPath}:1</cite>`,
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error();
    // should NOT count as a pathRejection
    expect(result.pathRejections).toBe(0);
    // should NOT resolve (it's skipped, not resolved)
    expect(result.resolved).toBe(0);
    // audit log should contain a 'skipped'/'not_source' entry
    const auditPath = path.join(root, '.gossip', 'finding-resolutions.jsonl');
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.action).toBe('skipped');
    expect(entry.after_check).toBe('not_source');
  });
});
