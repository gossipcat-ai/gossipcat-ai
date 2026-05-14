/**
 * Tests for next-session ledger auto-verify guardrail (Option B).
 * Spec: docs/specs/2026-05-14-next-session-ledger-autoverify.md
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseNextSessionBullets,
  readLedgerIndex,
  writeLedgerIndex,
  runLedgerVerification,
  annotateLedgerText,
  annotationPrefix,
  hashContent,
  ledgerIndexPath,
  defaultVerifierFactory,
  type LedgerIndexEntry,
  type LedgerVerdict,
  type ParsedBullet,
  type BulletVerifier,
} from '@gossip/orchestrator';

const mkTmp = (suffix: string) => {
  const dir = join(tmpdir(), `gossip-ledger-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(dir, '.gossip'), { recursive: true });
  return dir;
};

describe('parseNextSessionBullets', () => {
  it('classifies memory-linked bullets via [label](path.md)', () => {
    const md = `# Next Session

## Open for next session

- [Backlog item A](memory/feedback_x.md) — description here
- [Backlog item B](docs/specs/y.md): more text
`;
    const out = parseNextSessionBullets(md);
    expect(out).toHaveLength(2);
    expect(out[0].backingFile).toBe('memory/feedback_x.md');
    expect(out[0].proseOnly).toBe(false);
    expect(out[1].backingFile).toBe('docs/specs/y.md');
  });

  it('classifies free-form prose bullets', () => {
    const md = `## Open for next session

- Continue work on the dashboard refactor
- Investigate flaky test in foo.test.ts
`;
    const out = parseNextSessionBullets(md);
    expect(out).toHaveLength(2);
    expect(out[0].backingFile).toBeUndefined();
    expect(out[0].proseOnly).toBe(true);
    expect(out[1].proseOnly).toBe(true);
  });

  it('extracts numeric worktree claims', () => {
    const md = `## Open for next session

- Clean up "4 merged-but-locked worktree branches"
- Audit 7 worktrees for stale base
`;
    const out = parseNextSessionBullets(md);
    expect(out).toHaveLength(2);
    expect(out[0].numericClaim).toEqual({ n: 4, noun: 'worktree' });
    expect(out[0].proseOnly).toBe(false);
    expect(out[1].numericClaim).toEqual({ n: 7, noun: 'worktree' });
  });

  it('returns [] for empty / missing content', () => {
    expect(parseNextSessionBullets('')).toEqual([]);
    expect(parseNextSessionBullets('no bullets here, just prose')).toEqual([]);
  });

  it('produces stable hashes across runs', () => {
    const md = `## Open for next session\n\n- Same bullet text\n`;
    const a = parseNextSessionBullets(md);
    const b = parseNextSessionBullets(md);
    expect(a[0].hash).toBe(b[0].hash);
    expect(a[0].hash).toBe(hashContent(a[0].text));
  });
});

describe('readLedgerIndex — cache validation', () => {
  let dir: string;
  beforeEach(() => { dir = mkTmp('cache'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const ledger = '## Open for next session\n\n- [A](a.md) — x\n';
  const writeLedger = () => {
    const p = join(dir, '.gossip', 'next-session.md');
    writeFileSync(p, ledger);
    return p;
  };

  it('returns null when sidecar is missing', () => {
    writeLedger();
    expect(readLedgerIndex(dir, ledger, 1)).toBeNull();
  });

  it('returns null when ledgerMtime mismatches', () => {
    writeLedgerIndex(dir, {
      ledgerMtime: 100,
      ledgerContentHash: hashContent(ledger),
      entries: [],
    });
    expect(readLedgerIndex(dir, ledger, 999)).toBeNull();
  });

  it('returns null when content hash mismatches (even if mtime matches)', () => {
    writeLedgerIndex(dir, {
      ledgerMtime: 100,
      ledgerContentHash: 'wronghash',
      entries: [],
    });
    expect(readLedgerIndex(dir, ledger, 100)).toBeNull();
  });

  it('returns parsed index when BOTH mtime and content hash match', () => {
    const entries: LedgerIndexEntry[] = [
      { bulletHash: 'abc', verdict: 'FRESH', details: 'ok', checkedAt: '2026-05-14T00:00:00Z' },
    ];
    writeLedgerIndex(dir, {
      ledgerMtime: 100,
      ledgerContentHash: hashContent(ledger),
      entries,
    });
    const out = readLedgerIndex(dir, ledger, 100);
    expect(out).not.toBeNull();
    expect(out!.entries).toEqual(entries);
  });

  it('returns null when sidecar is malformed JSON', () => {
    const p = ledgerIndexPath(dir);
    writeFileSync(p, '{not valid json');
    expect(readLedgerIndex(dir, ledger, 100)).toBeNull();
  });
});

describe('annotateLedgerText / annotationPrefix — rendering', () => {
  const ledger = `## Open for next session

- [Item A](a.md) — first
- Continue free-form work
- Clean up 4 merged-but-locked worktree branches
`;
  const bullets = parseNextSessionBullets(ledger);

  it('produces "" for FRESH (no marker)', () => {
    expect(annotationPrefix('FRESH')).toBe('');
  });

  it('STALE includes inline details (user decision #1)', () => {
    expect(annotationPrefix('STALE', 'shipped PR #X')).toContain('[STALE — shipped PR #X]');
  });

  it('PROSE-ONLY / UNVERIFIABLE / UNVERIFIED prefixes', () => {
    expect(annotationPrefix('PROSE-ONLY')).toBe('[PROSE-ONLY] ');
    expect(annotationPrefix('UNVERIFIABLE')).toBe('[UNVERIFIABLE] ');
    expect(annotationPrefix('INCONCLUSIVE')).toBe('[UNVERIFIED] ');
  });

  it('keeps STALE bullets in place (does not strip)', () => {
    const byHash = new Map<string, LedgerIndexEntry>();
    byHash.set(bullets[0].hash, {
      bulletHash: bullets[0].hash, verdict: 'STALE',
      details: 'shipped PR #X', checkedAt: 'now',
    });
    const out = annotateLedgerText(ledger, bullets, byHash);
    expect(out).toContain('[STALE — shipped PR #X]');
    expect(out).toContain('[Item A](a.md) — first');
  });

  it('cold cache annotates everything as [UNVERIFIED]', () => {
    const out = annotateLedgerText(ledger, bullets, new Map());
    expect(out).toContain('[UNVERIFIED] [Item A](a.md) — first');
    expect(out).toContain('[UNVERIFIED] Continue free-form work');
    expect(out).toContain('[UNVERIFIED] Clean up 4 merged-but-locked');
  });

  it('FRESH bullets are NOT prefixed', () => {
    const byHash = new Map<string, LedgerIndexEntry>();
    for (const b of bullets) {
      byHash.set(b.hash, { bulletHash: b.hash, verdict: 'FRESH', details: '', checkedAt: 'now' });
    }
    const out = annotateLedgerText(ledger, bullets, byHash);
    expect(out).not.toContain('[UNVERIFIED]');
    expect(out).not.toContain('[STALE');
    expect(out).not.toContain('[PROSE-ONLY]');
  });

  it('PROSE-ONLY marker renders for prose bullets', () => {
    const byHash = new Map<string, LedgerIndexEntry>();
    byHash.set(bullets[1].hash, {
      bulletHash: bullets[1].hash, verdict: 'PROSE-ONLY', details: '', checkedAt: 'now',
    });
    const out = annotateLedgerText(ledger, bullets, byHash);
    expect(out).toContain('[PROSE-ONLY] Continue free-form work');
  });

  it('UNVERIFIABLE marker renders for numeric bullets without live counter', () => {
    const byHash = new Map<string, LedgerIndexEntry>();
    byHash.set(bullets[2].hash, {
      bulletHash: bullets[2].hash, verdict: 'UNVERIFIABLE', details: '', checkedAt: 'now',
    });
    const out = annotateLedgerText(ledger, bullets, byHash);
    expect(out).toContain('[UNVERIFIABLE] Clean up 4 merged-but-locked');
  });
});

describe('runLedgerVerification — concurrency cap', () => {
  const makeBullets = (n: number): ParsedBullet[] =>
    Array.from({ length: n }, (_, i) => ({
      text: `bullet ${i}`, index: i, hash: `h${i}`, proseOnly: true,
    }));

  it('runs all bullets and preserves order', async () => {
    const verifier: BulletVerifier = async (b) => ({
      bulletHash: b.hash, verdict: 'PROSE-ONLY', details: '', checkedAt: 'now',
    });
    const out = await runLedgerVerification(makeBullets(5), verifier, 3);
    expect(out).toHaveLength(5);
    out.forEach((e, i) => expect(e.bulletHash).toBe(`h${i}`));
  });

  it('honors concurrency cap of 3 — never more than 3 in-flight at once', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const verifier: BulletVerifier = async (b) => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise(r => setTimeout(r, 20));
      inFlight--;
      return { bulletHash: b.hash, verdict: 'INCONCLUSIVE', details: '', checkedAt: 'now' };
    };
    await runLedgerVerification(makeBullets(10), verifier, 3);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(0);
  });

  it('catches verifier exceptions as INCONCLUSIVE — does NOT crash the batch', async () => {
    const verifier: BulletVerifier = async (b) => {
      if (b.index === 1) throw new Error('boom');
      return { bulletHash: b.hash, verdict: 'FRESH', details: 'ok', checkedAt: 'now' };
    };
    const out = await runLedgerVerification(makeBullets(3), verifier, 3);
    expect(out).toHaveLength(3);
    expect(out[0].verdict).toBe('FRESH');
    expect(out[1].verdict).toBe('INCONCLUSIVE');
    expect(out[1].details).toContain('verifier threw');
    expect(out[2].verdict).toBe('FRESH');
  });
});

describe('defaultVerifierFactory', () => {
  const mk = (overrides: Partial<ParsedBullet>): ParsedBullet => ({
    text: 't', index: 0, hash: 'h', proseOnly: false, ...overrides,
  });

  it('returns PROSE-ONLY for free-form bullets', async () => {
    const v = defaultVerifierFactory();
    const r = await v(mk({ proseOnly: true }));
    expect(r.verdict).toBe('PROSE-ONLY');
  });

  it('returns FRESH when live worktree count matches the claim', async () => {
    const v = defaultVerifierFactory({ worktree: () => 4 });
    const r = await v(mk({ numericClaim: { n: 4, noun: 'worktree' } }));
    expect(r.verdict).toBe('FRESH');
    expect(r.details).toContain('live worktree count: 4');
  });

  it('returns STALE when live worktree count differs from the claim', async () => {
    const v = defaultVerifierFactory({ worktree: () => 21 });
    const r = await v(mk({ numericClaim: { n: 4, noun: 'worktree' } }));
    expect(r.verdict).toBe('STALE');
    expect(r.details).toContain('live worktree count: 21 (claim: 4)');
  });

  it('returns UNVERIFIABLE for numeric claims with no live counter', async () => {
    const v = defaultVerifierFactory();
    const r = await v(mk({ numericClaim: { n: 4, noun: 'worktree' } }));
    expect(r.verdict).toBe('UNVERIFIABLE');
  });

  it('returns INCONCLUSIVE for memory-linked bullets (orchestrator-side dispatch)', async () => {
    const v = defaultVerifierFactory();
    const r = await v(mk({ backingFile: 'memory/foo.md' }));
    expect(r.verdict).toBe('INCONCLUSIVE');
    expect(r.details).toContain('gossip_verify_memory');
  });
});

describe('writeLedgerIndex / sidecar round-trip', () => {
  let dir: string;
  beforeEach(() => { dir = mkTmp('rt'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes sidecar JSON that readLedgerIndex parses back', () => {
    const ledger = 'content';
    const mtime = 12345;
    const entries: LedgerIndexEntry[] = [
      { bulletHash: 'x', verdict: 'FRESH' as LedgerVerdict, details: 'ok', checkedAt: '2026-05-14T00:00:00Z' },
    ];
    writeLedgerIndex(dir, {
      ledgerMtime: mtime, ledgerContentHash: hashContent(ledger), entries,
    });
    expect(existsSync(ledgerIndexPath(dir))).toBe(true);
    const out = readLedgerIndex(dir, ledger, mtime);
    expect(out).not.toBeNull();
    expect(out!.entries).toEqual(entries);
  });
});
