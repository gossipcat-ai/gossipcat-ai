import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  mergeNextSessionLedger,
  extractLedgerBullets,
  bulletsMatch,
  isShippedPerGitLog,
  NEXT_SESSION_MAX_BULLETS,
} from '../../packages/orchestrator/src/next-session-merge';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';

const ledger = (...bullets: string[]) =>
  `# Next Session\n\n## Open for next session\n${bullets.map(b => `- ${b}`).join('\n')}\n`;

describe('mergeNextSessionLedger — carry-forward (issue #684)', () => {
  it('returns new content unchanged when there is no existing ledger', () => {
    const next = ledger('Ship the parser rewrite');
    expect(mergeNextSessionLedger('', next, '')).toBe(next);
    expect(mergeNextSessionLedger('   \n', next, '')).toBe(next);
  });

  it('carries forward prior bullets the new summary did not mention', () => {
    const existing = ledger(
      'Follow up on #666 msg-redaction characterization test',
      'Deferred: dashboard gravity easter egg',
      'Residual: audit memory hygiene backfill',
    );
    const next = ledger('Land the warm-cache suffix fix');

    const merged = mergeNextSessionLedger(existing, next, '');

    expect(merged).toContain('Land the warm-cache suffix fix');
    expect(merged).toContain('#666 msg-redaction');
    expect(merged).toContain('dashboard gravity easter egg');
    expect(merged).toContain('audit memory hygiene backfill');
    // New bullet stays first.
    expect(merged.indexOf('warm-cache')).toBeLessThan(merged.indexOf('#666'));
  });

  it('keeps only the new bullets when nothing carries over', () => {
    const next = ledger('Only item');
    expect(mergeNextSessionLedger('# Next Session\n\n## What shipped\n- done\n', next, '')).toBe(next);
  });

  it('de-duplicates by issue reference even when the wording differs', () => {
    const existing = ledger('Characterization test for message redaction gap (#666)');
    const next = ledger('Close #666 — redaction gap now covered by a real assertion');

    const merged = mergeNextSessionLedger(existing, next, '');

    expect(merged).toContain('Close #666');
    expect(merged).not.toContain('Characterization test for message redaction');
    expect(extractLedgerBullets(merged)).toHaveLength(1);
  });

  it('de-duplicates by text similarity when no issue ref is present', () => {
    const existing = ledger('Wire the dashboard consensus presentation panel');
    const next = ledger('Wire the dashboard consensus presentation panel to live data');

    const merged = mergeNextSessionLedger(existing, next, '');

    expect(extractLedgerBullets(merged)).toHaveLength(1);
    expect(merged).toContain('to live data');
  });

  it('does not treat unrelated bullets as duplicates', () => {
    const existing = ledger('Investigate the re2 lastIndex heap overflow PoC');
    const next = ledger('Rebuild the MCP bundle after the zod bump');

    expect(extractLedgerBullets(mergeNextSessionLedger(existing, next, ''))).toHaveLength(2);
  });

  it('drops a carried bullet whose issue ref appears in the git log', () => {
    const existing = ledger('Fix the warm prompt cache split (#672)', 'Deferred: fault_search backlog');
    const next = ledger('Review the release notes');
    const gitLog = 'aeb657b fix(cache): split the warm prompt cache on an exact caller-supplied tail (#672)';

    const merged = mergeNextSessionLedger(existing, next, gitLog);

    expect(merged).not.toContain('#672');
    expect(merged).toContain('fault_search backlog');
  });

  it('carries a multi-ref bullet forward unless every ref shipped', () => {
    const existing = ledger('Close out #672 and #684 together');
    const next = ledger('Unrelated work');

    expect(mergeNextSessionLedger(existing, next, 'abc123 fix (#672)')).toContain('#684');
    expect(mergeNextSessionLedger(existing, next, 'abc123 fix (#672)\ndef456 fix (#684)')).not.toContain('#684');
  });

  it('never auto-drops a bullet that names no issue ref, even with a rich git log', () => {
    const existing = ledger('Deferred: rewrite the skill taxonomy doc');
    const next = ledger('Something else');
    const gitLog = 'abc123 docs: rewrite the skill taxonomy doc (#999)';

    expect(mergeNextSessionLedger(existing, next, gitLog)).toContain('rewrite the skill taxonomy doc');
  });

  it('fails open on a malformed existing file', () => {
    const next = ledger('New item');
    for (const malformed of ['not markdown at all', '```\nunclosed fence', '# Next Session\n\nprose only, no heading\n']) {
      expect(mergeNextSessionLedger(malformed, next, '')).toBe(next);
    }
  });

  it('ignores the appended Open Findings table and stops at the next heading', () => {
    const existing =
      '# Next Session\n\n## Open for next session\n- Carry me forward\n\n' +
      '## Open Findings\n\n| Finding | Agent | Confidence | Status |\n|---|---|---|---|\n' +
      '| do not carry this row | reviewer | 0.8 | open |\n';
    const next = ledger('Fresh item');

    const merged = mergeNextSessionLedger(existing, next, '');

    expect(merged).toContain('Carry me forward');
    expect(merged).not.toContain('do not carry this row');
    expect(extractLedgerBullets(merged)).toHaveLength(2);
  });

  it('truncates at the cap with a visible marker, eldest last', () => {
    const existing = ledger(...Array.from({ length: 8 }, (_, i) => `Old item ${i + 1}`));
    const next = ledger('New A', 'New B');

    const merged = mergeNextSessionLedger(existing, next, '', 5);

    expect(extractLedgerBullets(merged)).toHaveLength(5);
    expect(merged).toContain('Old item 3');
    expect(merged).not.toContain('Old item 4');
    expect(merged).toContain('_(+5 older items truncated)_');
  });

  it('defaults the cap to NEXT_SESSION_MAX_BULLETS', () => {
    const existing = ledger(...Array.from({ length: NEXT_SESSION_MAX_BULLETS + 4 }, (_, i) => `Old item ${i + 1}`));
    const merged = mergeNextSessionLedger(existing, ledger('New one'), '');

    expect(extractLedgerBullets(merged)).toHaveLength(NEXT_SESSION_MAX_BULLETS);
    expect(merged).toContain('_(+5 older items truncated)_');
  });

  it('appends a ledger section when the new content has none (LLM fallback shape)', () => {
    const existing = ledger('Keep this backlog item');
    const next = '# Next Session\n\n> LLM summary failed — raw data below.\n';

    const merged = mergeNextSessionLedger(existing, next, '');

    expect(merged).toContain('raw data below');
    expect(merged).toContain('## Open for next session');
    expect(merged).toContain('Keep this backlog item');
  });

  it('keeps multi-line bullets intact', () => {
    const existing = '# Next Session\n\n## Open for next session\n- Parent item\n  - nested detail\n  continued prose\n';
    const merged = mergeNextSessionLedger(existing, ledger('Fresh'), '');

    expect(merged).toContain('  - nested detail');
    expect(merged).toContain('  continued prose');
    expect(extractLedgerBullets(merged)).toHaveLength(2);
  });

  it('collapses duplicates among the carried bullets themselves', () => {
    const existing = ledger('Audit the memory hygiene backfill', 'Audit the memory hygiene backfill pass');
    expect(extractLedgerBullets(mergeNextSessionLedger(existing, ledger('New'), ''))).toHaveLength(2);
  });
});

describe('bulletsMatch / isShippedPerGitLog', () => {
  it('matches on a shared issue ref', () => {
    expect(bulletsMatch('- fix #684 merge', '- #684 still open')).toBe(true);
  });

  it('does not match on a different issue ref', () => {
    expect(bulletsMatch('- fix #684 merge', '- fix #685 merge please now')).toBe(false);
  });

  it('does not confuse #66 with #666', () => {
    expect(isShippedPerGitLog('- item #66', 'abc123 fix (#666)')).toBe(false);
    expect(isShippedPerGitLog('- item #666', 'abc123 fix (#666)')).toBe(true);
  });

  it('returns false with an empty git log', () => {
    expect(isShippedPerGitLog('- item #666', '')).toBe(false);
  });
});

describe('session-save artifact preparation merges the existing ledger', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'next-session-merge-'));
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('carries prior open bullets into nextSessionContent and writes them', async () => {
    const nextSessionPath = join(testDir, '.gossip', 'next-session.md');
    writeFileSync(nextSessionPath, ledger('Prior backlog: fault_search deferred', 'Prior backlog: re2 PoC (#680)'));

    const writer = new MemoryWriter(testDir);
    const artifacts = await writer.prepareSessionArtifactsFromRaw({
      gossip: 'g', consensus: 'c', performance: 'p',
      gitLog: 'abc123 chore: unrelated commit',
      raw: 'SUMMARY: Merge work\n\n## Open for next session\n- Verify the carry-forward merge\n\n## What shipped\n- The merge helper\n',
    });

    expect(artifacts.nextSessionContent).toContain('Verify the carry-forward merge');
    expect(artifacts.nextSessionContent).toContain('fault_search deferred');
    expect(artifacts.nextSessionContent).toContain('re2 PoC (#680)');

    writer.writeSessionArtifacts(artifacts);
    expect(existsSync(nextSessionPath)).toBe(true);
    expect(readFileSync(nextSessionPath, 'utf-8')).toContain('fault_search deferred');
  });

  it('drops a prior bullet whose issue landed in the git log', async () => {
    writeFileSync(join(testDir, '.gossip', 'next-session.md'), ledger('Prior backlog: re2 PoC (#680)'));

    const writer = new MemoryWriter(testDir);
    const artifacts = await writer.prepareSessionArtifactsFromRaw({
      gossip: 'g', consensus: 'c', performance: 'p',
      gitLog: 'abc123 fix(re2): land the PoC guard (#680)',
      raw: 'SUMMARY: Merge work\n\n## Open for next session\n- Verify the carry-forward merge\n',
    });

    expect(artifacts.nextSessionContent).toContain('Verify the carry-forward merge');
    expect(artifacts.nextSessionContent).not.toContain('#680');
  });

  it('writes generated content unchanged when no prior file exists', async () => {
    const writer = new MemoryWriter(testDir);
    const artifacts = await writer.prepareSessionArtifactsFromRaw({
      gossip: 'g', consensus: 'c', performance: 'p', gitLog: '',
      raw: 'SUMMARY: First save\n\n## Open for next session\n- Only this item\n',
    });

    expect(artifacts.nextSessionContent).toContain('Only this item');
    expect(extractLedgerBullets(artifacts.nextSessionContent)).toHaveLength(1);
  });
});
