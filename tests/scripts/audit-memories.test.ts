/**
 * Tests for scripts/audit-memories.mjs.
 *
 * Pure logic lives in scripts/audit-memories.lib.cjs (a CommonJS module)
 * so ts-jest can require it without flipping on Jest's experimental ESM
 * mode. The .mjs is a thin CLI wrapper around this same library.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(path.resolve(__dirname, '..', '..', 'scripts', 'audit-memories.lib.cjs'));
const SCRIPT_MJS = path.resolve(__dirname, '..', '..', 'scripts', 'audit-memories.mjs');

describe('scoreRubric', () => {
  it('all-3-signals fixture scores 3', () => {
    const body = [
      'session 2026-04-01 and follow-up on 2026-04-15.',
      'You MUST always record signals.',
      'Without it, signals are silently lost.',
    ].join('\n');
    expect(mod.scoreRubric(body)).toBe(3);
  });

  it('empty body scores 0', () => {
    expect(mod.scoreRubric('')).toBe(0);
  });

  it('originSessionId alone counts for criterion 1', () => {
    const body = 'no dates here, but originSessionId is present.';
    // No MUST/etc, no consequence keyword -> only criterion 1 fires
    expect(mod.scoreRubric(body)).toBe(1);
    const body2 = body + ' MUST proceed.';
    expect(mod.scoreRubric(body2)).toBe(2);
  });

  it('case-sensitive on STOP/MUST/ALWAYS/NEVER', () => {
    expect(mod.scoreRubric('must do it')).toBe(0);
    expect(mod.scoreRubric('MUST do it')).toBe(1);
  });
});

describe('classify', () => {
  it('gemini-hallucinat fixture is MODEL_INTRINSIC', () => {
    const body = 'gemini-reviewer hallucinates spec fields consistently.';
    expect(mod.classify(body)).toBe('MODEL_INTRINSIC');
  });

  it('gossip_remember fixture is PROTOCOL_BOUND', () => {
    const body = 'Always call gossip_remember before coding.';
    expect(mod.classify(body)).toBe('PROTOCOL_BOUND');
  });

  it('UX-preference fixture is USER_SPECIFIC', () => {
    const body = 'I prefer concise output and dark themes.';
    expect(mod.classify(body)).toBe('USER_SPECIFIC');
  });

  it('packages/ project path triggers PROTOCOL_BOUND', () => {
    const body = 'See packages/orchestrator/src/foo.ts for details.';
    expect(mod.classify(body)).toBe('PROTOCOL_BOUND');
  });

  it('backticked identifier near "must" triggers PROTOCOL_BOUND', () => {
    const body = 'The `finding_id` field must be present in every signal.';
    expect(mod.classify(body)).toBe('PROTOCOL_BOUND');
  });

  it('MODEL_INTRINSIC wins over PROTOCOL_BOUND when both apply', () => {
    const body = 'gemini-reviewer hallucinates findings in packages/foo/.';
    expect(mod.classify(body)).toBe('MODEL_INTRINSIC');
  });
});

describe('provenanceHits', () => {
  it('PR #123 at commit abc1234 → hits ≥ 2 and strip_needed', () => {
    const body = 'Shipped in PR #123 at commit abc1234.';
    const hits = mod.provenanceHits(body);
    expect(hits).toBeGreaterThanOrEqual(2);
    const row = mod.auditBody('x.md', body);
    expect(row.strip_needed).toBe(true);
  });

  it('does not double-count PR digits as commit hashes', () => {
    // "#1234567" is a PR mention; the digit run is also 7 chars long
    // so a naive commit-hash regex would re-match it. Make sure we don't.
    const body = 'See PR #1234567 for context.';
    const hits = mod.provenanceHits(body);
    expect(hits).toBe(1);
  });

  it('counts codenames including extras passed via --codenames', () => {
    const body = 'Initial work in crab-language; superseded by gossip-v2 and project-zeta.';
    const hits = mod.provenanceHits(body, ['project-zeta']);
    expect(hits).toBe(3);
  });

  it('zero provenance → strip_needed false', () => {
    const row = mod.auditBody('x.md', 'plain text with no markers');
    expect(row.strip_needed).toBe(false);
  });
});

describe('proposeTarget', () => {
  it('rubric=3 + PROTOCOL_BOUND → HANDBOOK', () => {
    expect(mod.proposeTarget(3, 'PROTOCOL_BOUND')).toBe('HANDBOOK');
  });
  it('rubric=2 + PROTOCOL_BOUND → DROP', () => {
    expect(mod.proposeTarget(2, 'PROTOCOL_BOUND')).toBe('DROP');
  });
  it('rubric=3 + MODEL_INTRINSIC → model-skill', () => {
    expect(mod.proposeTarget(3, 'MODEL_INTRINSIC')).toBe('model-skill');
  });
  it('rubric=3 + USER_SPECIFIC → DROP', () => {
    expect(mod.proposeTarget(3, 'USER_SPECIFIC')).toBe('DROP');
  });
});

describe('defaultMemoryDir', () => {
  it('encodes cwd by replacing slashes and dropping leading dash', () => {
    const dir = mod.defaultMemoryDir('/Users/alice/code/proj', '/home/alice');
    expect(dir).toBe('/home/alice/.claude/projects/Users-alice-code-proj/memory');
  });
});

describe('resolveProjectRoot', () => {
  it('uses git-common-dir parent when superproject is empty', () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes('--show-superproject-working-tree')) return '';
      if (cmd.includes('--git-common-dir')) return '/Users/alice/code/proj/.git';
      throw new Error('unexpected');
    };
    const root = mod.resolveProjectRoot('/Users/alice/code/proj/.claude/worktrees/agent-XXXX', fakeExec);
    // parent of /Users/alice/code/proj/.git is /Users/alice/code/proj
    expect(root).toBe('/Users/alice/code/proj');
  });

  it('uses git-common-dir when superproject throws', () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes('--show-superproject-working-tree')) throw new Error('not a superproject');
      if (cmd.includes('--git-common-dir')) return '/Users/alice/code/proj/.git';
      throw new Error('unexpected');
    };
    const root = mod.resolveProjectRoot('/Users/alice/code/proj/.claude/worktrees/agent-XXXX', fakeExec);
    expect(root).toBe('/Users/alice/code/proj');
  });

  it('defaultMemoryDir uses git-common-dir root, not cwd', () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes('--show-superproject-working-tree')) return '';
      if (cmd.includes('--git-common-dir')) return '/Users/alice/code/proj/.git';
      throw new Error('unexpected');
    };
    const dir = mod.defaultMemoryDir('/Users/alice/code/proj/.claude/worktrees/agent-XXXX', '/home/alice', fakeExec);
    expect(dir).toBe('/home/alice/.claude/projects/Users-alice-code-proj/memory');
  });

  it('falls back to cwd when all git commands fail', () => {
    const fakeExec = () => { throw new Error('not a git repo'); };
    const root = mod.resolveProjectRoot('/some/non-git/dir', fakeExec);
    expect(root).toBe('/some/non-git/dir');
  });

  it('--dir flag overrides derivation (parseArgs test)', () => {
    const args = mod.parseArgs(['--dir', '/custom/memory/path']);
    expect(args.dir).toBe('/custom/memory/path');
  });
});

describe('parseArgs', () => {
  it('parses flags and values', () => {
    const a = mod.parseArgs(['--json', '--dir', '/tmp/x', '--candidates-only', '--codenames', 'a,b']);
    expect(a.json).toBe(true);
    expect(a.dir).toBe('/tmp/x');
    expect(a.candidatesOnly).toBe(true);
    expect(a.codenames).toEqual(['a', 'b']);
  });
  it('--help sets help flag', () => {
    expect(mod.parseArgs(['--help']).help).toBe(true);
  });
});

describe('auditDir end-to-end', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mem-'));
    fs.writeFileSync(
      path.join(tmp, 'a.md'),
      [
        'gemini-reviewer hallucinates findings consistently.',
        'You MUST verify and the consequence is silently dropped signals.',
        '2026-04-01 and 2026-04-10 sessions confirm.',
        'PR #42 at commit deadbee.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmp, 'b.md'),
      'Just a UX note. Nothing remarkable.',
    );
    fs.writeFileSync(path.join(tmp, 'MEMORY.md'), '# index, should be skipped');
    fs.writeFileSync(path.join(tmp, 'not-md.txt'), 'ignored');
  });

  it('returns sorted rows and skips MEMORY.md / non-md', () => {
    const { rows } = mod.auditDir(tmp);
    expect(rows.map((r: { file: string }) => r.file).sort()).toEqual(['a.md', 'b.md']);
    const a = rows.find((r: { file: string }) => r.file === 'a.md');
    expect(a.proposed_target).toBe('model-skill');
    expect(a.bucket).toBe('MODEL_INTRINSIC');
    expect(a.rubric_score).toBe(3);
    expect(a.strip_needed).toBe(true);
    const b = rows.find((r: { file: string }) => r.file === 'b.md');
    expect(b.proposed_target).toBe('DROP');
  });

  it('sort order: HANDBOOK > model-skill > DROP', () => {
    const { rows } = mod.auditDir(tmp);
    const targets = rows.map((r: { proposed_target: string }) => r.proposed_target);
    expect(targets).toEqual(['model-skill', 'DROP']);
  });

  it('missing dir throws with resolved path in message', () => {
    expect(() => mod.auditDir('/no/such/dir/exists/here')).toThrow(/no\/such\/dir/);
  });
});

describe('CLI smoke', () => {
  it('--help prints usage and exits 0', () => {
    const out = execFileSync('node', [SCRIPT_MJS, '--help'], { encoding: 'utf8' });
    expect(out).toMatch(/audit-memories/);
    expect(out).toMatch(/--candidates-only/);
  });
});
