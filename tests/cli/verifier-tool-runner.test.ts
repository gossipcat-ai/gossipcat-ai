/**
 * Issue #710 — Phase-2 cross-review verifier tools must read the review
 * worktree when `resolutionRoots` are declared, not the repo root.
 *
 * Fixture shape: a fake project root and a fake review worktree that both
 * contain `src/target.ts` with DIVERGENT content. A cross-reviewer citing that
 * path must see the worktree copy; a path that only exists at the project root
 * must still resolve.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileTools, GitTools, Sandbox } from '@gossip/tools';
import type { MemorySearcher } from '@gossip/orchestrator';
import {
  buildVerifierFileAccess,
  buildVerifierToolRunner,
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
