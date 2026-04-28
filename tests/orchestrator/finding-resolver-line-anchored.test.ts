/**
 * Tests for the line-anchored staleness heuristic.
 * Spec: docs/specs/2026-04-28-resolver-line-anchored-staleness.md (v3,
 * post 2-round consensus). Cases 1–8 per §Tests.
 *
 * Premise: the resolver classifies each (cite, symbol) pair as one of
 *   - absent_everywhere   → existing commit:<sha> path
 *   - present_at_anchor   → leave open
 *   - present_elsewhere   → new stale_anchor path (when flag is on)
 * with strict-AND aggregation across all cites.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';

import {
  resolveFindings,
  classifyPresence,
} from '@gossip/orchestrator';

function makeTempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-resolver-line-anchored-'));
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

function readAuditEntries(root: string): any[] {
  const p = path.join(root, '.gossip', 'finding-resolutions.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/**
 * Build a file with `symbol` placed at specific 1-indexed lines, padded
 * with neutral filler. Total line count = `totalLines`. Allows constructing
 * synthetic identifier-reuse fixtures with deterministic anchor windows.
 */
function buildFileWithSymbolAt(
  totalLines: number,
  symbol: string,
  atLines: number[],
): string {
  const lines: string[] = [];
  const set = new Set(atLines);
  for (let i = 1; i <= totalLines; i++) {
    if (set.has(i)) {
      // Ensure the symbol is the only identifier on the line (no comments,
      // no string literals — stripJsTsComments would no-op anyway).
      lines.push(`const _l${i} = ${symbol}(0);`);
    } else {
      lines.push(`const _filler${i} = ${i};`);
    }
  }
  return lines.join('\n') + '\n';
}

// ─── classifyPresence pure helper sanity ────────────────────────────────

describe('classifyPresence — pure helper', () => {
  test('absent_everywhere when symbol missing from file', () => {
    const body = 'const a = 1;\nconst b = 2;\n';
    expect(classifyPresence(body, body, 'Math.min', 5, 5)).toEqual({
      kind: 'absent_everywhere',
    });
  });

  test('present_at_anchor when symbol within window', () => {
    const body = buildFileWithSymbolAt(20, 'Math.min', [10]);
    // citedLine=12, window=5 → window covers lines 7..17, line 10 is in.
    expect(classifyPresence(body, body, 'Math.min', 12, 5)).toEqual({
      kind: 'present_at_anchor',
    });
  });

  test('present_elsewhere when symbol outside window', () => {
    const body = buildFileWithSymbolAt(40, 'Math.min', [30]);
    // citedLine=10, window=5 → window covers 5..15; line 30 is far out.
    expect(classifyPresence(body, body, 'Math.min', 10, 5)).toEqual({
      kind: 'present_elsewhere',
    });
  });

  test('present_elsewhere when citedLine is undefined (no anchor) and symbol present', () => {
    const body = 'const x = Math.min(1, 2);\n';
    expect(classifyPresence(body, body, 'Math.min', undefined, 5)).toEqual({
      kind: 'present_elsewhere',
    });
  });

  test('inclusive end-index: line at hi is in the window', () => {
    // citedLine=10, window=5 → window covers 5..15 INCLUSIVE.
    const body = buildFileWithSymbolAt(30, 'Math.min', [15]);
    expect(classifyPresence(body, body, 'Math.min', 10, 5)).toEqual({
      kind: 'present_at_anchor',
    });
  });
});

// ─── resolveFindings integration ────────────────────────────────────────

describe('finding-resolver — line-anchored staleness (resolveFindings)', () => {
  function setupRepoWithFixture(
    relPath: string,
    initialContent: string,
    fixedContent: string,
  ): { root: string; headSha: string } {
    const root = makeTempProject();
    initGit(root);
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, initialContent);
    commit(root, 'init');
    fs.writeFileSync(abs, fixedContent);
    // Touch a sibling file so the "fixed" commit has at least one diff
    // even when initialContent === fixedContent (cases 2 + 5 — anchor
    // still true / cite without line — both intentionally leave the
    // cited file unchanged but still need a non-empty HEAD commit so
    // resolveFindings sees a watermark).
    fs.writeFileSync(path.join(root, '.gossip', '_marker'), Date.now().toString());
    const headSha = commit(root, 'refactor');
    return { root, headSha };
  }

  // ── Case 1: identifier-reuse refactor → stale_anchor ───────────────────
  test('case 1: identifier-reuse refactor resolves as stale_anchor when flag on', async () => {
    // Initial: Math.min at :120 (cited line). Fixed: Math.min still at
    // :119 + :126 (unrelated callsites) but :120 is gone — outside ±5
    // is :126; :119 is INSIDE the window. Need it strictly outside.
    // Use lines :110 + :130 to be unambiguously outside ±5 of :120.
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case1:f1',
      finding: 'Stack overflow with `Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(1);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('resolved');
    expect(findings[0].resolvedBy).toBe('stale_anchor');
  });

  // ── Case 2: anchor-still-true → leave open ─────────────────────────────
  test('case 2: anchor still has the cited symbol → leave open', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [120]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [120]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case2:f1',
      finding: '`Math.min` issue <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
  });

  // ── Case 3: edge of window (within ±5) → leave open ────────────────────
  test('case 3: identifier within window (±5) → leave open', async () => {
    // Cite at :120. Identifier present only at :115 (within ±5). Must
    // classify as present_at_anchor → leave open.
    const initial = buildFileWithSymbolAt(200, 'Math.min', [115, 120]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [115]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case3:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
  });

  // ── Case 4: outside window → stale_anchor ──────────────────────────────
  test('case 4: identifier only at :200 (cite :120) → stale_anchor', async () => {
    const initial = buildFileWithSymbolAt(250, 'Math.min', [120, 200]);
    const fixed = buildFileWithSymbolAt(250, 'Math.min', [200]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case4:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(1);
    expect(readFindings(root)[0].resolvedBy).toBe('stale_anchor');
  });

  // ── Case 5: cite without line → leave open (preserve fallback) ─────────
  test('case 5: cite without line and symbol present → leave open', async () => {
    // <cite tag="file">foo.ts</cite> (no :line); identifier exists in file.
    const initial = `const a = Math.min(1, 2);\n`;
    const fixed = `const a = Math.min(1, 2);\n`;
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case5:f1',
      finding: '`Math.min` somewhere <cite tag="file">src/foo.ts</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
  });

  // ── Case 6: multi-cite AND, mixed-state → leave open ───────────────────
  test('case 6: multi-cite mixed (one stale_anchor + one still-true) → leave open', async () => {
    const fileA_initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fileA_fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]); // anchor :120 stale
    const fileB_initial = buildFileWithSymbolAt(200, 'Math.min', [50]);
    const fileB_fixed = buildFileWithSymbolAt(200, 'Math.min', [50]); // anchor :50 still true
    const root = makeTempProject();
    initGit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), fileA_initial);
    fs.writeFileSync(path.join(root, 'src/b.ts'), fileB_initial);
    commit(root, 'init');
    fs.writeFileSync(path.join(root, 'src/a.ts'), fileA_fixed);
    fs.writeFileSync(path.join(root, 'src/b.ts'), fileB_fixed);
    commit(root, 'partial fix');

    writeFinding(root, {
      taskId: 'case6:f1',
      finding: '`Math.min` at <cite tag="file">src/a.ts:120</cite> and <cite tag="file">src/b.ts:50</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
  });

  // ── Case 7: audit-log shape verification ───────────────────────────────
  test('case 7: stale_anchor audit entry has present_elsewhere_only + cited_line + window', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case7:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    await resolveFindings(root, { full: true, lineAnchored: true });
    const audit = readAuditEntries(root);
    const resolveEntry = audit.find(e => e.action === 'resolve' && e.finding_id === 'case7:f1');
    expect(resolveEntry).toBeDefined();
    expect(resolveEntry.resolved_by).toBe('stale_anchor');
    expect(resolveEntry.after_check).toBe('present_elsewhere_only');
    expect(resolveEntry.cited_line).toBe(120);
    expect(resolveEntry.window).toBe(5);
    expect(resolveEntry.operator).toBe('auto');
  });

  // ── Case 8: config flag default off → no stale_anchor ─────────────────
  test('case 8: lineAnchored flag default off → identifier-reuse refactor stays open', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);

    writeFinding(root, {
      taskId: 'case8:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    // No lineAnchored: behavior must match pre-PR — leave open since
    // Math.min still appears in the file.
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('open');
    // No stale_anchor audit entries either.
    const audit = readAuditEntries(root);
    expect(audit.find(e => e.resolved_by === 'stale_anchor')).toBeUndefined();
  });
});
