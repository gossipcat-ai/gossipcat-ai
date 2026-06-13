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
  computeStaleAnchorUnresolveRate,
  appendChainedEntry,
  verifyChain,
  FINDING_RESOLVER_INTERNALS,
  type AuditEntry,
} from '@gossip/orchestrator';

const { MIN_BRAKE_SAMPLE, BRAKE_THRESHOLD } = FINDING_RESOLVER_INTERNALS;

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
    // Diagnostic counter: the finding was held open purely by the disabled
    // line-anchored gate, so skipReasons.lineAnchoredOff must record it. This
    // is the headline explanation for a resolved:0 run.
    expect(result.skipReasons?.lineAnchoredOff).toBeGreaterThanOrEqual(1);
  });

  // ── Case 9: deleted-file cite (ENOENT) → commit:<sha>, flag-independent ─
  test('case 9: cited file no longer exists on disk → resolves as commit:<sha>', async () => {
    const root = makeTempProject();
    initGit(root);
    const abs = path.join(root, 'src/gone.ts');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'export const removeMe = () => 1;\n');
    commit(root, 'init');
    // Delete the file and commit the removal.
    fs.rmSync(abs);
    fs.writeFileSync(path.join(root, '.gossip', '_marker'), Date.now().toString());
    const headSha = commit(root, 'delete gone.ts');

    writeFinding(root, {
      taskId: 'case9:f1',
      finding: 'Issue in `removeMe` <cite tag="file">src/gone.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    // lineAnchored NOT passed — deleted-file resolution is flag-independent.
    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(1);
    const findings = readFindings(root);
    expect(findings[0].status).toBe('resolved');
    expect(findings[0].resolvedBy).toBe(`commit:${headSha}`);
    // Audit entry records the absent fastpath, not stale_anchor.
    const audit = readAuditEntries(root);
    const resolveEntry = audit.find(e => e.action === 'resolve' && e.finding_id === 'case9:f1');
    expect(resolveEntry).toBeDefined();
    expect(resolveEntry.after_check).toBe('absent');
  });

  // ── Case 10: NEVER-tracked cite path (ENOENT but not a deletion) → NOT
  //    resolved. Guards the full-mode false-resolve (consensus da8f1aa1 f2):
  //    in full mode the touched-set gate is bypassed, so a typo'd/fabricated
  //    citation path reaches readFileSync → ENOENT. It must NOT be treated as
  //    a deletion because git never tracked it.
  test('case 10: never-tracked cite path is NOT resolved (full mode)', async () => {
    const root = makeTempProject();
    initGit(root);
    // Commit a real file so HEAD exists, but the cited path was NEVER tracked.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/real.ts'), 'export const real = 1;\n');
    commit(root, 'init');

    writeFinding(root, {
      taskId: 'case10:f1',
      finding: 'Issue in `neverWas` <cite tag="file">src/never-existed.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
    // The never-tracked ENOENT routes through the auditable read-error skip.
    expect((result.skipReasons?.readError ?? 0)).toBeGreaterThanOrEqual(1);
    const audit = readAuditEntries(root);
    const skip = audit.find(e => e.action === 'skipped' && e.finding_id === 'case10:f1');
    expect(skip).toBeDefined();
    expect(skip.after_check).toBe('read_error');
  });

  // ── Case 11: multi-cite deleted-file (ENOENT→absent) + present sibling →
  //    strict-AND blocks resolution (the most important safety property).
  test('case 11: deleted cite + present sibling cite → NOT resolved', async () => {
    const root = makeTempProject();
    initGit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // A tracked file that we will delete.
    fs.writeFileSync(path.join(root, 'src/gone.ts'), 'export const removeMe = () => 1;\n');
    // A present file whose symbol sits AT the cited line (present_at_anchor).
    fs.writeFileSync(path.join(root, 'src/alive.ts'), buildFileWithSymbolAt(20, 'stillHere', [10]));
    commit(root, 'init');
    fs.rmSync(path.join(root, 'src/gone.ts'));
    commit(root, 'delete gone.ts');

    // Lead identifier is `stillHere` (the symbol checked against ALL cited
    // files): present_at_anchor in alive.ts:10, and absent from the deleted
    // gone.ts (which is ENOENT→absent regardless of symbol). The present
    // sibling must block the deleted cite's absence under strict-AND.
    writeFinding(root, {
      taskId: 'case11:f1',
      finding:
        'Cross-file issue with `stillHere` <cite tag="file">src/alive.ts:10</cite> <cite tag="file">src/gone.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true });
    if (!result.ok) throw new Error('lock contended');
    // Deleted cite sets sawAbsentEverywhere, but the present sibling sets
    // sawPresentAtAnchor → allAbsentEverywhere is false → finding stays OPEN.
    expect(result.resolved).toBe(0);
    expect(readFindings(root)[0].status).toBe('open');
    expect((result.skipReasons?.absentBlockedBySibling ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

// ─── computeStaleAnchorUnresolveRate — pure helper (5% safety brake) ───────

describe('computeStaleAnchorUnresolveRate — 5% safety brake', () => {
  const NOW = Date.parse('2026-06-13T00:00:00.000Z');
  const DAY = 86_400_000;

  // Minimal AuditEntry factory (hashes are irrelevant to the stats reader).
  function entry(partial: Partial<AuditEntry>): AuditEntry {
    return {
      prev_hash: '0'.repeat(64),
      entry_hash: '0'.repeat(64),
      finding_id: 'x',
      ts: new Date(NOW).toISOString(),
      action: 'resolve',
      ...partial,
    } as AuditEntry;
  }

  function staleResolve(id: string, offsetDays: number): AuditEntry {
    return entry({
      finding_id: id,
      action: 'resolve',
      resolved_by: 'stale_anchor',
      ts: new Date(NOW - offsetDays * DAY).toISOString(),
    });
  }
  function unresolve(id: string, offsetDays: number): AuditEntry {
    return entry({
      finding_id: id,
      action: 'unresolve',
      ts: new Date(NOW - offsetDays * DAY).toISOString(),
    });
  }

  test('engaged=false when staleAnchorResolves < MIN_BRAKE_SAMPLE even at 100% rate', () => {
    // 1 resolve + 1 unresolve of the same id → 100% rate, but denominator is
    // 1 < 20 floor → brake PAUSED.
    const entries = [staleResolve('f1', 1), unresolve('f1', 0)];
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(1);
    expect(r.unresolves).toBe(1);
    expect(r.rate).toBe(1);
    expect(r.engaged).toBe(false);
  });

  test('exactly 5% (1/20) → engaged=false (strict >)', () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) entries.push(staleResolve(`f${i}`, 1));
    entries.push(unresolve('f0', 0)); // 1 unresolve of a stale_anchor id
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(MIN_BRAKE_SAMPLE);
    expect(r.unresolves).toBe(1);
    expect(r.rate).toBeCloseTo(0.05, 10);
    expect(r.rate).toBe(BRAKE_THRESHOLD); // exactly 5.0%, not > 5%
    expect(r.engaged).toBe(false);
  });

  test('>5% with denominator >= 20 (2/20=10%) → engaged=true', () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) entries.push(staleResolve(`f${i}`, 1));
    entries.push(unresolve('f0', 0));
    entries.push(unresolve('f1', 0));
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(MIN_BRAKE_SAMPLE);
    expect(r.unresolves).toBe(2);
    expect(r.rate).toBeCloseTo(0.1, 10);
    expect(r.engaged).toBe(true);
  });

  test('unresolves of commit:<sha> findings (id not in stale_anchor set) excluded from numerator', () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) entries.push(staleResolve(`f${i}`, 1));
    // A commit:<sha> resolve + its unresolve — id NEVER appears as a
    // stale_anchor resolve, so it must NOT count toward the numerator.
    entries.push(entry({ finding_id: 'commitId', action: 'resolve', resolved_by: 'commit:abc', ts: new Date(NOW - DAY).toISOString() }));
    entries.push(unresolve('commitId', 0));
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(MIN_BRAKE_SAMPLE);
    expect(r.unresolves).toBe(0); // commitId excluded
    expect(r.engaged).toBe(false);
  });

  test('out-of-window resolves excluded from denominator; NaN/absent ts skipped', () => {
    const entries: AuditEntry[] = [];
    // 20 in-window stale_anchor resolves.
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) entries.push(staleResolve(`f${i}`, 1));
    // An old (40d) stale_anchor resolve — outside the 30d window → not counted
    // in the denominator (but its id IS in the all-time set).
    entries.push(staleResolve('old', 40));
    // 2 unresolves in-window → with denom 20, rate=10% > 5%.
    entries.push(unresolve('f0', 0));
    entries.push(unresolve('f1', 0));
    // Malformed ts entries — must be skipped, not throw.
    entries.push(entry({ finding_id: 'f2', action: 'unresolve', ts: 'not-a-date' }));
    entries.push(entry({ finding_id: 'f3', action: 'resolve', resolved_by: 'stale_anchor', ts: undefined as unknown as string }));
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(MIN_BRAKE_SAMPLE); // old (40d) + NaN-ts excluded
    expect(r.unresolves).toBe(2);
    expect(r.engaged).toBe(true);
  });

  test('unresolve of an all-time (out-of-window) stale_anchor resolve still counts', () => {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) entries.push(staleResolve(`f${i}`, 1));
    // The resolve for `old` is 40d out (not in denominator), but its in-window
    // unresolve must still count in the numerator (all-time id set).
    entries.push(staleResolve('old', 40));
    entries.push(unresolve('old', 0));
    entries.push(unresolve('f0', 0));
    const r = computeStaleAnchorUnresolveRate(entries, NOW);
    expect(r.staleAnchorResolves).toBe(MIN_BRAKE_SAMPLE);
    expect(r.unresolves).toBe(2); // old + f0
    expect(r.engaged).toBe(true);
  });

  test('zero denominator → rate 0, not NaN, not engaged', () => {
    const r = computeStaleAnchorUnresolveRate([], NOW);
    expect(r.staleAnchorResolves).toBe(0);
    expect(r.rate).toBe(0);
    expect(r.engaged).toBe(false);
  });
});

// ─── 5% safety brake integration (resolveFindings) ─────────────────────────

describe('finding-resolver — 5% safety brake integration', () => {
  // Pre-seed the audit log with >5% manual-unresolve history on stale_anchor
  // resolutions so the brake is engaged when resolveFindings runs.
  function seedBrakeEngagedHistory(root: string): void {
    for (let i = 0; i < MIN_BRAKE_SAMPLE; i++) {
      appendChainedEntry(root, {
        ts: new Date().toISOString(),
        finding_id: `seed${i}`,
        action: 'resolve',
        resolved_by: 'stale_anchor',
        after_check: 'present_elsewhere_only',
        operator: 'auto',
        cited_line: 1,
        window: 5,
      });
    }
    // 2 unresolves / 20 = 10% > 5% → engaged.
    for (const id of ['seed0', 'seed1']) {
      appendChainedEntry(root, {
        ts: new Date().toISOString(),
        finding_id: id,
        action: 'unresolve',
        operator: 'manual',
      });
    }
  }

  function setupRepoWithFixture(
    relPath: string,
    initialContent: string,
    fixedContent: string,
  ): { root: string } {
    const root = makeTempProject();
    initGit(root);
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, initialContent);
    commit(root, 'init');
    fs.writeFileSync(abs, fixedContent);
    fs.writeFileSync(path.join(root, '.gossip', '_marker'), Date.now().toString());
    commit(root, 'refactor');
    return { root };
  }

  // ── brake engaged → stale_anchor finding flagged, stays open ──────────────
  test('brake engaged: present_elsewhere finding stays open + flag_for_review audit entry', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);
    seedBrakeEngagedHistory(root);

    writeFinding(root, {
      taskId: 'brake1:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(0);
    expect(result.flaggedForReview).toBe(1);
    expect(result.skipReasons?.brakeEngaged).toBe(1);
    // Finding stays open.
    expect(readFindings(root)[0].status).toBe('open');
    // A flag_for_review audit entry with the stale_anchor payload was appended.
    const flag = readAuditEntries(root).find(
      e => e.action === 'flag_for_review' && e.finding_id === 'brake1:f1',
    );
    expect(flag).toBeDefined();
    expect(flag.resolved_by).toBe('stale_anchor');
    expect(flag.after_check).toBe('present_elsewhere_only');
    expect(flag.cited_line).toBe(120);
    expect(flag.window).toBe(5);
    expect(flag.operator).toBe('auto');
    expect(typeof flag.reason).toBe('string');
    // No resolve entry for this finding.
    expect(
      readAuditEntries(root).find(e => e.action === 'resolve' && e.finding_id === 'brake1:f1'),
    ).toBeUndefined();
  });

  // ── brake does NOT gate the absent_everywhere commit:<sha> fastpath ───────
  test('brake engaged: absent_everywhere finding still resolves as commit:<sha>', async () => {
    const root = makeTempProject();
    initGit(root);
    const abs = path.join(root, 'src/gone.ts');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'export const removeMe = () => 1;\n');
    commit(root, 'init');
    fs.rmSync(abs);
    fs.writeFileSync(path.join(root, '.gossip', '_marker'), Date.now().toString());
    commit(root, 'delete gone.ts');
    seedBrakeEngagedHistory(root);

    writeFinding(root, {
      taskId: 'brake2:f1',
      finding: 'Issue in `removeMe` <cite tag="file">src/gone.ts:1</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    // lineAnchored ON — brake is engaged — but the absent_everywhere path is
    // explicitly NOT gated (spec §Risks §A).
    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.resolved).toBe(1);
    expect(result.flaggedForReview).toBe(0);
    expect(readFindings(root)[0].status).toBe('resolved');
    expect(String(readFindings(root)[0].resolvedBy).startsWith('commit:')).toBe(true);
  });

  // ── chain stays intact after a flag_for_review append ─────────────────────
  test('verifyChain returns null (intact) after a flag_for_review append', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);
    seedBrakeEngagedHistory(root);

    writeFinding(root, {
      taskId: 'brake3:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const result = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!result.ok) throw new Error('lock contended');
    expect(result.flaggedForReview).toBe(1);
    expect(verifyChain(root)).toBeNull();
  });

  // ── audit-log dedup: a persistently-flagged finding is flagged once across
  //    runs (no duplicate flag_for_review per run), but stays open + counted ──
  function countFlags(root: string, findingId: string): number {
    return readAuditEntries(root).filter(
      e => e.action === 'flag_for_review' && e.finding_id === findingId,
    ).length;
  }

  test('brake engaged: second run does NOT append a duplicate flag_for_review (dedup across runs)', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);
    seedBrakeEngagedHistory(root);

    writeFinding(root, {
      taskId: 'dedup1:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const r1 = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!r1.ok) throw new Error('lock contended');
    expect(r1.flaggedForReview).toBe(1);
    expect(countFlags(root, 'dedup1:f1')).toBe(1);

    const r2 = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!r2.ok) throw new Error('lock contended');
    // Still held open + counted this run...
    expect(r2.flaggedForReview).toBe(1);
    expect(r2.skipReasons?.brakeEngaged).toBe(1);
    expect(readFindings(root)[0].status).toBe('open');
    // ...but NO second audit WRITE for the same finding.
    expect(countFlags(root, 'dedup1:f1')).toBe(1);
  });

  test('brake engaged: an unresolve between runs re-arms the flag (re-flag after unresolve)', async () => {
    const initial = buildFileWithSymbolAt(200, 'Math.min', [110, 120, 130]);
    const fixed = buildFileWithSymbolAt(200, 'Math.min', [110, 130]);
    const { root } = setupRepoWithFixture('src/foo.ts', initial, fixed);
    seedBrakeEngagedHistory(root);

    writeFinding(root, {
      taskId: 'dedup2:f1',
      finding: '`Math.min` <cite tag="file">src/foo.ts:120</cite>',
      tag: 'finding',
      type: 'finding',
      status: 'open',
    });

    const r1 = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!r1.ok) throw new Error('lock contended');
    expect(countFlags(root, 'dedup2:f1')).toBe(1);

    // Operator unresolves the flagged finding — most-recent action is now
    // `unresolve`, not `flag_for_review`, so the next run must re-flag.
    appendChainedEntry(root, {
      ts: new Date().toISOString(),
      finding_id: 'dedup2:f1',
      action: 'unresolve',
      operator: 'manual',
    });

    const r2 = await resolveFindings(root, { full: true, lineAnchored: true });
    if (!r2.ok) throw new Error('lock contended');
    expect(r2.flaggedForReview).toBe(1);
    expect(countFlags(root, 'dedup2:f1')).toBe(2);
  });
});
