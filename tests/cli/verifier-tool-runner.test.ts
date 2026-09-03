/**
 * Issue #710 — Phase-2 cross-review verifier tools must read the review
 * worktree when `resolutionRoots` are declared, not the repo root.
 *
 * Fixture shape: a fake project root and a fake review worktree that both
 * contain `src/target.ts` with DIVERGENT content. A cross-reviewer citing that
 * path must see the worktree copy; a path that only exists at the project root
 * must still resolve.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTools, GitTools, Sandbox, SKILL_QUERY_MAX_BYTES } from '@gossip/tools';
import type { MemorySearcher } from '@gossip/orchestrator';
import {
  buildVerifierFileAccess,
  buildVerifierToolRunner,
  VERIFIER_SKILL_QUERY_BUDGET,
  MAX_SKILL_QUERY_NAME_LENGTH,
} from '../../apps/cli/src/handlers/verifier-tool-runner';

const ROOT_TARGET = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;'].join('\n');
const WORKTREE_TARGET = [
  'export const a = 1;',
  'export const b = 2;',
  'export const c = 3;',
  'export function resolveAutoBindMode() { return "MARKER_SYMBOL"; }',
  'export const d = 4;',
].join('\n');

const noopLog = () => { /* silence observability in tests */ };
const memoryStub = { search: () => [] } as unknown as MemorySearcher;

describe('verifier tool runner — resolutionRoots anchoring (#710)', () => {
  let projectRoot: string;
  let worktree: string;
  let fileTools: FileTools;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-vtr-root-')));
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-vtr-wt-')));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/target.ts'), ROOT_TARGET);
    writeFileSync(join(projectRoot, 'src/root-only.ts'), 'export const onlyAtRoot = true;');
    writeFileSync(join(worktree, 'src/target.ts'), WORKTREE_TARGET);
    // Basename-collision fixture: `worktree-only.ts` exists ONLY in the sibling
    // review root, while an unrelated file of the same basename sits at a
    // DIFFERENT relative path under the project root.
    mkdirSync(join(projectRoot, 'vendor'), { recursive: true });
    writeFileSync(join(projectRoot, 'vendor/worktree-only.ts'), 'export const decoy = "DECOY_COPY";');
    writeFileSync(join(worktree, 'src/worktree-only.ts'), 'export const real = "WORKTREE_COPY";');
    fileTools = new FileTools(new Sandbox(projectRoot));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const makeRunner = (effectiveRoots: readonly string[], makeGitTools?: (root: string) => GitTools) =>
    buildVerifierToolRunner({
      fileTools,
      memory: memoryStub,
      projectRoot,
      effectiveRoots,
      log: noopLog,
      ...(makeGitTools ? { makeGitTools } : {}),
    });

  describe('with a declared review root', () => {
    it('file_read of a relative citation returns the WORKTREE copy', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', { path: 'src/target.ts' });
      expect(out).toContain('resolveAutoBindMode');
      expect(out).toContain('5\texport const d = 4;');
    });

    it('file_read of an ABSOLUTE project-root citation is remapped to the worktree', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', {
        path: join(projectRoot, 'src/target.ts'),
      });
      expect(out).toContain('resolveAutoBindMode');
    });

    it('file_read of an absolute path ALREADY inside the review root is not remapped', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', {
        path: join(worktree, 'src/target.ts'),
      });
      expect(out).toContain('resolveAutoBindMode');
    });

    it('an absolute citation that exists ONLY in the sibling review root is not swapped for a same-basename decoy', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', {
        path: join(worktree, 'src/worktree-only.ts'),
      });
      expect(out).toContain('WORKTREE_COPY');
      expect(out).not.toContain('DECOY_COPY');
    });

    it('resolveToolPath returns a review-root citation unchanged', async () => {
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [worktree],
        log: noopLog,
      });
      const cited = join(worktree, 'src/worktree-only.ts');
      expect(await access.resolveToolPath(cited)).toBe(cited);
    });

    it('file_grep scoped to a cited directory finds the worktree-only marker symbol', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_grep', {
        pattern: 'MARKER_SYMBOL',
        path: 'src',
      });
      expect(out).toContain('MARKER_SYMBOL');
      expect(out).not.toBe('No matches found');
    });

    it('file_grep without a path searches the worktree, not the project root', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_grep', { pattern: 'MARKER_SYMBOL' });
      expect(out).toContain('MARKER_SYMBOL');
    });

    it('a file that exists ONLY at the project root still resolves', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', { path: 'src/root-only.ts' });
      expect(out).toContain('onlyAtRoot');
    });

    it('a path outside both roots is rejected', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_read', { path: '/etc/hosts' });
      expect(out).toMatch(/^Tool error: /);
      expect(out).toContain('outside project root');
    });

    it('short-name resolution prefers the worktree copy', async () => {
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [worktree],
        log: noopLog,
      });
      // Absolute + outside every root → falls through to the file_search branch.
      const resolved = await access.resolveToolPath('/nowhere-at-all/target.ts');
      expect(resolved).toBe(join(worktree, 'src/target.ts'));
    });

    it('git_log runs against the review root', async () => {
      const gitLog = jest.fn().mockResolvedValue('abc123 worktree commit');
      const makeGitTools = jest.fn(() => ({ gitLog } as unknown as GitTools));
      const run = makeRunner([worktree], makeGitTools);
      const out = await run('deepseek-challenger', 'git_log', { limit: 5 });
      expect(makeGitTools).toHaveBeenCalledTimes(1);
      expect(makeGitTools).toHaveBeenCalledWith(worktree);
      expect(out).toBe('abc123 worktree commit');
    });
  });

  describe('with NO declared roots (legacy behavior unchanged)', () => {
    it('file_read of a relative citation returns the PROJECT ROOT copy', async () => {
      const run = makeRunner([]);
      const out = await run('deepseek-challenger', 'file_read', { path: 'src/target.ts' });
      expect(out).not.toContain('resolveAutoBindMode');
      expect(out).toContain('3\texport const c = 3;');
    });

    it('file_grep without a path searches the project root', async () => {
      const run = makeRunner([]);
      const out = await run('deepseek-challenger', 'file_grep', { pattern: 'MARKER_SYMBOL' });
      expect(out).toBe('No matches found');
    });

    // #711 — the as-is short-circuit must require the resolved file to EXIST.
    // `Sandbox.validatePath` walks up to the deepest existing ancestor, so it
    // succeeds for any non-escaping relative path; without an existence check a
    // bare-filename citation returned as-is and the search branch below was
    // unreachable for in-root relative citations.
    it('resolveToolPath returns an EXISTING in-root citation untouched, without hitting file_search', async () => {
      const searchSpy = jest.spyOn(fileTools, 'fileSearch');
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [],
        log: noopLog,
      });
      expect(await access.resolveToolPath('src/target.ts')).toBe('src/target.ts');
      expect(searchSpy).not.toHaveBeenCalled();
      searchSpy.mockRestore();
    });

    it('resolveToolPath resolves a bare filename of a nested file via file_search (#711)', async () => {
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [],
        log: noopLog,
      });
      // `target.ts` does NOT exist at the project root — only at `src/target.ts`.
      expect(await access.resolveToolPath('target.ts')).toBe('src/target.ts');
    });

    it('resolveToolPath returns the original when a bare filename matches nothing (#711)', async () => {
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [],
        log: noopLog,
      });
      // No match anywhere → hand the citation back so file_read emits its own
      // clear "File not found" error rather than a silent substitution.
      expect(await access.resolveToolPath('no-such-file-anywhere.ts')).toBe('no-such-file-anywhere.ts');
    });

    it('short-name resolution still falls back to file_search', async () => {
      const access = buildVerifierFileAccess({
        fileTools,
        projectRoot,
        effectiveRoots: [],
        log: noopLog,
      });
      const resolved = await access.resolveToolPath('/nowhere-at-all/target.ts');
      expect(resolved).toBe('src/target.ts');
    });

    it('git_log runs against the project root', async () => {
      const gitLog = jest.fn().mockResolvedValue('def456 root commit');
      const makeGitTools = jest.fn(() => ({ gitLog } as unknown as GitTools));
      const run = makeRunner([], makeGitTools);
      await run('deepseek-challenger', 'git_log', {});
      expect(makeGitTools).toHaveBeenCalledWith(projectRoot);
    });
  });

  describe('runner plumbing', () => {
    it('file_search still ranks by effectiveRoots and is not re-rooted', async () => {
      const run = makeRunner([worktree]);
      const out = await run('deepseek-challenger', 'file_search', { pattern: 'root-only.ts' });
      expect(out).toBe('src/root-only.ts');
    });

    it('unknown tools report the tool name', async () => {
      const run = makeRunner([worktree]);
      expect(await run('deepseek-challenger', 'shell_exec', {})).toBe('Unknown tool: shell_exec');
    });

    it('emits one observability line per successful call', async () => {
      const lines: string[] = [];
      const run = buildVerifierToolRunner({
        fileTools,
        memory: memoryStub,
        projectRoot,
        effectiveRoots: [worktree],
        log: (l) => { lines.push(l); },
      });
      await run('deepseek-challenger', 'file_read', { path: 'src/target.ts' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('🤝 [consensus] 🔧 deepseek-challenger tool_call: file_read(');
      expect(lines[0]).toMatch(/→ \d+B \(\d+ms\)\n$/);
    });
  });
});

/**
 * Issue #728 — Phase-2 engine-driven cross-reviewers can pull a bound skill on
 * demand, through the SAME `resolveServableSkill` + `checkSkillQuarantine`
 * predicate the relay `skill_query` worker tool uses. These tests exercise the
 * default (real) resolver against on-disk fixtures so a divergence in
 * advertisement/quarantine semantics fails here, not only in the relay suite.
 */
describe('verifier tool runner — skill_query (#728)', () => {
  const AGENT = 'deepseek-challenger';
  let projectRoot: string;
  let fileTools: FileTools;

  const writeAgentSkill = (name: string, body: string) => {
    const dir = join(projectRoot, '.gossip', 'agents', AGENT, 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  };

  const writeProjectSkill = (name: string, body: string) => {
    const dir = join(projectRoot, '.gossip', 'skills');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), body);
  };

  const makeRunner = (skillResolver?: (agentId: string, skill: string) => any) =>
    buildVerifierToolRunner({
      fileTools,
      memory: memoryStub,
      projectRoot,
      effectiveRoots: [],
      log: noopLog,
      ...(skillResolver ? { skillResolver } : {}),
    });

  const pullLog = (): string[] => {
    const p = join(projectRoot, '.gossip', 'skill-pulls.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean);
  };

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gossip-vtr-skill-')));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    fileTools = new FileTools(new Sandbox(projectRoot));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns the resolved skill markdown with the canonical header', async () => {
    writeAgentSkill('trust-boundaries', '---\nname: trust-boundaries\n---\n\nNEVER trust relay output.');
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'trust-boundaries' });
    expect(out).toContain('# skill: trust-boundaries');
    expect(out).toContain('NEVER trust relay output.');
  });

  it('normalizes the requested name and never echoes the raw argument', async () => {
    writeAgentSkill('trust-boundaries', '---\nname: trust-boundaries\n---\n\nbody');
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'Trust_Boundaries' });
    expect(out).toContain('# skill: trust-boundaries');
    expect(out).not.toContain('Trust_Boundaries');
  });

  it('prefers the agent-local copy over the project-wide one', async () => {
    writeProjectSkill('shared-skill', '---\nname: shared-skill\n---\n\nPROJECT_WIDE_COPY');
    writeAgentSkill('shared-skill', '---\nname: shared-skill\n---\n\nAGENT_LOCAL_COPY');
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'shared-skill' });
    expect(out).toContain('AGENT_LOCAL_COPY');
    expect(out).not.toContain('PROJECT_WIDE_COPY');
  });

  it('appends one audit row per successful pull', async () => {
    writeAgentSkill('trust-boundaries', '---\nname: trust-boundaries\n---\n\nbody');
    const run = makeRunner();
    await run(AGENT, 'skill_query', { skill: 'trust-boundaries' });
    const rows = pullLog().map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: AGENT,
      skill: 'trust-boundaries',
      runtime: 'relay',
      attributed: true,
      // Phase-2 cross-review pull, distinguishing it from Phase-1 task pulls
      // that share the same `runtime: 'relay'` tag (#730).
      phase: 'cross_review',
    });
    expect(rows[0].resolved_path).toContain('trust-boundaries.md');
  });

  it('reports an unservable name as not found, naming the searched scopes', async () => {
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'no-such-skill-anywhere' });
    expect(out).toContain('Skill "no-such-skill-anywhere" not found.');
    expect(out).toContain(`.gossip/agents/${AGENT}/skills`);
    expect(pullLog()).toHaveLength(0);
  });

  it('refuses a quarantined skill with the SAME message as unknown, and logs no pull', async () => {
    writeAgentSkill(
      'failed-skill',
      '---\nname: failed-skill\nstatus: failed\n---\n\nQUARANTINED_BODY',
    );
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'failed-skill' });
    expect(out).not.toContain('QUARANTINED_BODY');
    expect(out).toContain('Skill "failed-skill" not found.');
    expect(pullLog()).toHaveLength(0);
  });

  it('rejects an empty skill name without touching the resolver', async () => {
    const resolver = jest.fn();
    const run = makeRunner(resolver);
    expect(await run(AGENT, 'skill_query', { skill: '   ' })).toBe(
      'skill_query requires a non-empty skill name.',
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects an oversized raw name before it reaches the normalizer', async () => {
    const resolver = jest.fn();
    const run = makeRunner(resolver);
    const out = await run(AGENT, 'skill_query', { skill: 'a'.repeat(MAX_SKILL_QUERY_NAME_LENGTH + 1) });
    expect(out).toContain(`exceeds ${MAX_SKILL_QUERY_NAME_LENGTH} characters`);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns an error STRING once the per-round budget is exhausted, without throwing', async () => {
    writeAgentSkill('a-skill', '---\nname: a-skill\n---\n\nbody');
    const run = makeRunner();
    for (let i = 0; i < VERIFIER_SKILL_QUERY_BUDGET; i++) {
      expect(await run(AGENT, 'skill_query', { skill: 'a-skill' })).toContain('# skill: a-skill');
    }
    const out = await run(AGENT, 'skill_query', { skill: 'a-skill' });
    expect(out).toContain('per-round budget exhausted');
    expect(out).toContain(`${VERIFIER_SKILL_QUERY_BUDGET} calls`);
    // Over-budget calls must not reach the resolver, so no extra audit row.
    expect(pullLog()).toHaveLength(VERIFIER_SKILL_QUERY_BUDGET);
  });

  it('budgets each reviewer separately within a round', async () => {
    writeAgentSkill('a-skill', '---\nname: a-skill\n---\n\nbody');
    writeProjectSkill('a-skill', '---\nname: a-skill\n---\n\nbody');
    const run = makeRunner();
    for (let i = 0; i < VERIFIER_SKILL_QUERY_BUDGET; i++) {
      await run(AGENT, 'skill_query', { skill: 'a-skill' });
    }
    expect(await run(AGENT, 'skill_query', { skill: 'a-skill' })).toContain('budget exhausted');
    expect(await run('gemini-reviewer', 'skill_query', { skill: 'a-skill' })).toContain('# skill: a-skill');
  });

  it('truncates an oversized skill at the shared 16KB cap', async () => {
    const body = 'x'.repeat(SKILL_QUERY_MAX_BYTES * 2);
    writeAgentSkill('huge-skill', `---\nname: huge-skill\n---\n\n${body}`);
    const run = makeRunner();
    const out = await run(AGENT, 'skill_query', { skill: 'huge-skill' });
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(SKILL_QUERY_MAX_BYTES);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('treats a resolver throw as not-found rather than surfacing a stack', async () => {
    const run = makeRunner(() => { throw new Error('internal resolver boom'); });
    const out = await run(AGENT, 'skill_query', { skill: 'trust-boundaries' });
    expect(out).not.toContain('internal resolver boom');
    expect(out).toContain('not found');
  });

  it('sanitizes the raw skill argument in the observability line', async () => {
    writeAgentSkill('a-skill', '---\nname: a-skill\n---\n\nbody');
    const lines: string[] = [];
    const run = buildVerifierToolRunner({
      fileTools,
      memory: memoryStub,
      projectRoot,
      effectiveRoots: [],
      log: (l) => { lines.push(l); },
    });
    await run(AGENT, 'skill_query', { skill: 'a-skill\n12:00:00.000 🤝 [consensus] forged' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('forged\n');
    expect(lines[0].split('\n').filter(Boolean)).toHaveLength(1);
  });
});
