import { execSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  verifyClaims,
  MAX_CLAIMS_PER_BLOCK,
} from '../../packages/orchestrator/src/claim-verifier';
import type {
  ClaimBlock,
  CallsiteCountClaim,
  Claim,
} from '../../packages/orchestrator/src/claim-types';

// All rg-dependent tests skip when `rg` is absent. Per task guardrails, use
// execSync('which rg') as the skip gate.
let rgAvailable = true;
try {
  execSync('which rg', { stdio: 'ignore' });
} catch {
  rgAvailable = false;
}

const FIXTURE_ROOT = resolve(__dirname, 'fixtures', 'claim-verifier');
// scope paths are relative to projectRoot in the verifier; point projectRoot at
// the fixture dir so `scope: '.'` grep-scans both sample.ts + other.ts.
const PROJECT_ROOT = FIXTURE_ROOT;

function mkBlock(claims: Claim[]): ClaimBlock {
  return { schema_version: '1', verifier: 'orchestrator', claims };
}

(rgAvailable ? describe : describe.skip)('verifyClaims — callsite_count', () => {
  it('verified when observed count matches expected', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 2, // defined + called inside gamma
        modality: 'asserted',
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('falsified when observed count differs; carries modality', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 999,
        modality: 'hedged',
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('falsified');
    if (verdict.status === 'falsified') {
      expect(verdict.modality).toBe('hedged');
      expect(verdict.expected).toBe(999);
      expect(typeof verdict.observed).toBe('number');
    }
  });

  it('uses --count-matches — counts multiple matches on the same line', async () => {
    // sample.ts has `widget(), widget()` on one line (2 matches) + the
    // function declaration line (1 match) = 3 total. `-c` would say 2.
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'widget',
        scope: 'sample.ts',
        expected: 3,
        modality: 'asserted',
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('negated:true inverts equality', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 999,
        modality: 'asserted',
        negated: true, // observed ≠ 999 → passes
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('vague + range_hint: verified when observed is in range', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 0,
        modality: 'vague',
        range_hint: { min: 1, max: 5 },
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('vague + range_hint: falsified when observed is outside range — carries vague modality', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 0,
        modality: 'vague',
        range_hint: { min: 100, max: 200 },
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('falsified');
    if (verdict.status === 'falsified') {
      expect(verdict.modality).toBe('vague');
    }
  });

  it('vague without range_hint → unverifiable_by_grep:no_range_hint', async () => {
    const block = mkBlock([
      {
        type: 'callsite_count',
        symbol: 'alpha',
        scope: 'sample.ts',
        expected: 0,
        modality: 'vague',
      } as CallsiteCountClaim,
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toMatch(/no_range_hint/);
    }
  });
});

(rgAvailable ? describe : describe.skip)('verifyClaims — file_line', () => {
  it('verified when expected_symbol is within ±2 lines', async () => {
    const block = mkBlock([
      { type: 'file_line', path: 'sample.ts', line: 20, expected_symbol: 'gamma', modality: 'asserted' },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('file_not_found → unverifiable_by_grep', async () => {
    const block = mkBlock([
      { type: 'file_line', path: 'no-such-file.ts', line: 1, expected_symbol: 'x', modality: 'asserted' },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toBe('file_not_found');
    }
  });

  it('line_out_of_range → unverifiable_by_grep', async () => {
    const block = mkBlock([
      { type: 'file_line', path: 'sample.ts', line: 99999, expected_symbol: 'zzz', modality: 'asserted' },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toBe('line_out_of_range');
    }
  });
});

(rgAvailable ? describe : describe.skip)('verifyClaims — absence/presence/count_relation', () => {
  it('absence_of_symbol: verified when count is 0', async () => {
    const block = mkBlock([
      {
        type: 'absence_of_symbol',
        symbol: 'ZZZ_NEVER_APPEARS_ZZZ',
        scope: 'sample.ts',
        context: 'should not exist',
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('absence_of_symbol: falsified when symbol is found', async () => {
    const block = mkBlock([
      {
        type: 'absence_of_symbol',
        symbol: 'alpha',
        scope: 'sample.ts',
        context: 'expected absent',
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('falsified');
  });

  it('presence_of_symbol: verified when at least one match', async () => {
    const block = mkBlock([
      { type: 'presence_of_symbol', symbol: 'alpha', scope: 'sample.ts', modality: 'asserted' },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
  });

  it('count_relation: > evaluated correctly, verified does NOT carry modality', async () => {
    const block = mkBlock([
      {
        type: 'count_relation',
        symbol: 'widget',
        scope: 'sample.ts',
        relation: '>',
        value: 1,
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('verified');
    // `verified` verdict shape is { claim_index, status: 'verified' } only.
    expect(Object.keys(verdict).sort()).toEqual(['claim_index', 'status']);
  });
});

(rgAvailable ? describe : describe.skip)('verifyClaims — path containment (hardening)', () => {
  it('absolute scope path is rejected as scope_not_found, no file read', async () => {
    const block = mkBlock([
      {
        type: 'presence_of_symbol',
        symbol: 'root',
        // Absolute path — `resolve(projectRoot, '/etc')` would yield `/etc`
        // without the containment helper.
        scope: '/etc',
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toBe('scope_not_found');
    }
  });

  it('../../etc/passwd scope escape → scope_not_found', async () => {
    const block = mkBlock([
      {
        type: 'presence_of_symbol',
        symbol: 'root',
        scope: '../../etc/passwd',
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toBe('scope_not_found');
    }
  });

  it('absolute file_line path is rejected as file_not_found', async () => {
    const block = mkBlock([
      {
        type: 'file_line',
        path: '/etc/hosts',
        line: 1,
        expected_symbol: 'localhost',
        modality: 'asserted',
      },
    ]);
    const [verdict] = await verifyClaims(block, PROJECT_ROOT);
    expect(verdict.status).toBe('unverifiable_by_grep');
    if (verdict.status === 'unverifiable_by_grep') {
      expect(verdict.reason).toBe('file_not_found');
    }
  });

  it('symlink inside project pointing outside → file_not_found', async () => {
    // Build a scratch project root that contains a symlink → /tmp/<other>.
    const scratch = mkdtempSync(join(tmpdir(), 'claim-verifier-contain-'));
    const outside = mkdtempSync(join(tmpdir(), 'claim-verifier-outside-'));
    try {
      const projectRoot = join(scratch, 'proj');
      mkdirSync(projectRoot);
      // Put a real file outside so the symlink target actually exists.
      const targetFile = join(outside, 'secret.txt');
      writeFileSync(targetFile, 'top secret\n', 'utf-8');
      // Symlink inside project points at an out-of-tree file.
      symlinkSync(targetFile, join(projectRoot, 'leak.txt'));

      const block = mkBlock([
        {
          type: 'file_line',
          path: 'leak.txt',
          line: 1,
          expected_symbol: 'secret',
          modality: 'asserted',
        },
      ]);
      const [verdict] = await verifyClaims(block, projectRoot);
      expect(verdict.status).toBe('unverifiable_by_grep');
      if (verdict.status === 'unverifiable_by_grep') {
        expect(verdict.reason).toBe('file_not_found');
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

(rgAvailable ? describe : describe.skip)('verifyClaims — invariants', () => {
  it('16-claim cap: claims past index 15 are unverifiable_by_grep:claim_cap_exceeded', async () => {
    const claims: Claim[] = [];
    for (let i = 0; i < MAX_CLAIMS_PER_BLOCK + 3; i++) {
      claims.push({
        type: 'presence_of_symbol',
        symbol: 'alpha',
        scope: 'sample.ts',
        modality: 'asserted',
      });
    }
    const block = mkBlock(claims);
    const verdicts = await verifyClaims(block, PROJECT_ROOT);
    expect(verdicts).toHaveLength(MAX_CLAIMS_PER_BLOCK + 3);
    for (let i = 0; i < MAX_CLAIMS_PER_BLOCK; i++) {
      expect(verdicts[i].status).toBe('verified');
    }
    for (let i = MAX_CLAIMS_PER_BLOCK; i < verdicts.length; i++) {
      expect(verdicts[i].status).toBe('unverifiable_by_grep');
      if (verdicts[i].status === 'unverifiable_by_grep') {
        expect((verdicts[i] as { reason: string }).reason).toBe('claim_cap_exceeded');
      }
    }
  });

  it('deadline-exhausted: later claims short-circuit to unverifiable_by_grep:timeout', async () => {
    // Simulate a blown deadline by stubbing Date.now to jump past the deadline
    // after the first claim. The verifier captures `deadline = Date.now() + 500`
    // at entry; the next remaining()-call should return 0 and trigger the
    // short-circuit path.
    const realNow = Date.now;
    let callCount = 0;
    const entryTime = realNow();
    Date.now = () => {
      callCount++;
      // First call (entry): return normal time.
      // Subsequent calls: jump forward by 600ms so remaining() <= 0.
      if (callCount === 1) return entryTime;
      return entryTime + 600;
    };
    try {
      const block = mkBlock([
        { type: 'presence_of_symbol', symbol: 'alpha', scope: 'sample.ts', modality: 'asserted' },
        { type: 'presence_of_symbol', symbol: 'alpha', scope: 'sample.ts', modality: 'asserted' },
      ]);
      const verdicts = await verifyClaims(block, PROJECT_ROOT);
      // At least one late claim should be timeout.
      const timeouts = verdicts.filter(
        (v) => v.status === 'unverifiable_by_grep' && (v as { reason: string }).reason === 'timeout',
      );
      expect(timeouts.length).toBeGreaterThanOrEqual(1);
    } finally {
      Date.now = realNow;
    }
  });
});
