import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'fs';
import { testRound } from '../../packages/orchestrator/src/round-context';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';
import { validateResolutionRoot } from '../../packages/orchestrator/src/validate-resolution-root';
import { validateConfig, resolveSiblingRoots } from '../../apps/cli/src/config';
import { ScopeTracker } from '../../packages/orchestrator/src/scope-tracker';
import { ConsensusEngine } from '../../packages/orchestrator/src/consensus-engine';
import { DispatchPipeline } from '../../packages/orchestrator/src/dispatch-pipeline';

const gitInit = (dir: string) => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
};

let root: string;
let sibling: string;
let outside: string;
let siblingSub: string;

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'siblingroots-')));
  root = join(base, 'orchestration'); mkdirSync(root); gitInit(root);
  sibling = join(base, 'product'); mkdirSync(sibling); gitInit(sibling);
  outside = join(base, 'other'); mkdirSync(outside); gitInit(outside);
  siblingSub = join(sibling, 'services', 'core'); mkdirSync(siblingSub, { recursive: true });
  writeFileSync(join(siblingSub, 'handler.ts'), 'export const x = 1;\n');
});

describe('validateResolutionRoot — siblingRoots bypass', () => {
  it('accepts a path inside a declared sibling root (bypasses steps 6 AND 7)', async () => {
    const r = await validateResolutionRoot(siblingSub, root, { siblingRoots: [sibling] });
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.canonical).toBe(realpathSync(siblingSub));
  });

  it('still rejects an UNDECLARED cross-repo path (step 6 fires) — selective bypass', async () => {
    const r = await validateResolutionRoot(outside, root, { siblingRoots: [sibling] });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain('git-common-dir');
  });

  it('with no siblingRoots, a sibling path is rejected exactly as today', async () => {
    const r = await validateResolutionRoot(sibling, root);
    expect(r.valid).toBe(false);
  });

  it('ownership/existence gate STILL fires for a path inside a declared sibling root', async () => {
    const r = await validateResolutionRoot(join(sibling, 'nope'), root, { siblingRoots: [sibling] });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain('does not resolve to directory');
  });

  it('a symlink inside a declared root pointing OUTSIDE it does not escape', async () => {
    const link = join(sibling, 'escape');
    try { symlinkSync(outside, link); } catch { return; }
    const r = await validateResolutionRoot(link, root, { siblingRoots: [sibling] });
    expect(r.valid).toBe(false);
  });
});

describe('ScopeTracker — sibling roots', () => {
  it('accepts a scope under a declared sibling root', () => {
    const st = new ScopeTracker(root, [sibling]);
    expect(() => st.register(join(sibling, 'services'), 'task-1')).not.toThrow();
  });

  it('rejects a scope equal to the entire sibling root (per-root too-broad guard)', () => {
    const st = new ScopeTracker(root, [sibling]);
    expect(() => st.register(sibling, 'task-2')).toThrow(/too broad/);
  });

  it('still rejects a scope outside all roots', () => {
    const st = new ScopeTracker(root, [sibling]);
    expect(() => st.register(outside, 'task-3')).toThrow(/outside project root/);
  });

  it('does not change behavior when no sibling roots are configured', () => {
    const st = new ScopeTracker(root);
    expect(() => st.register(join(sibling, 'x'), 'task-4')).toThrow(/outside project root/);
  });
});

const minimalSkeleton = { main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' } };

describe('config siblingRoots', () => {
  it('validateConfig accepts a string array and rejects bare wildcards', () => {
    expect(() => validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['../product'] } })).not.toThrow();
    expect(() => validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['*'] } })).toThrow(/wildcard-only/);
    expect(() => validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [123] } })).toThrow(/non-empty strings/);
  });

  it('resolveSiblingRoots realpaths declared roots', () => {
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [sibling] } });
    const resolved = resolveSiblingRoots(cfg, root);
    expect(resolved).toContain(realpathSync(sibling));
  });

  it('resolveSiblingRoots throws (fail-fast) on a non-existent entry', () => {
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [join(sibling, 'does-not-exist')] } });
    expect(() => resolveSiblingRoots(cfg, root)).toThrow();
  });

  it('resolveSiblingRoots throws on a file-not-directory entry', () => {
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [join(siblingSub, 'handler.ts')] } });
    expect(() => resolveSiblingRoots(cfg, root)).toThrow(/not a directory/);
  });
});

describe('resolveSiblingRoots — broken symlink in glob parent (consensus a5ca8f69 F10)', () => {
  it('skips a broken symlink child instead of crashing boot', () => {
    // Build a glob parent: <base>/wt-parent/{real-wt (dir), dead (broken symlink)}
    const wtParent = join(sibling, 'wt-parent');
    mkdirSync(join(wtParent, 'real-wt'), { recursive: true });
    try { symlinkSync(join(wtParent, 'does-not-exist'), join(wtParent, 'dead')); } catch { return; } // skip if symlink unsupported
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [join(wtParent, '*')] } });
    let resolved: string[] = [];
    expect(() => { resolved = resolveSiblingRoots(cfg, root); }).not.toThrow();
    expect(resolved).toContain(realpathSync(join(wtParent, 'real-wt')));
    // the broken symlink must not appear
    expect(resolved.some((p) => p.endsWith('/dead'))).toBe(false);
  });
});

describe('#520 integration — path-carrying cite into a sibling repo', () => {
  it('resolves WITH siblingRoots config, fails WITHOUT', async () => {
    // (a) The MCP boundary admits the declared root only with the config.
    const accepted = await validateResolutionRoot(sibling, root, { siblingRoots: [realpathSync(sibling)] });
    expect(accepted.valid).toBe(true);
    const rejected = await validateResolutionRoot(sibling, root); // no config
    expect(rejected.valid).toBe(false);

    // (b) Once admitted, the resolver anchors a path-carrying cite into the sibling.
    if (!accepted.valid) throw new Error('precondition');
    const eng = new ConsensusEngine({
      projectRoot: root,
      round: testRound({ resolutionRoots: [accepted.canonical] }),
      registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: id, skills: [] }),
    } as any);
    const resolved = await (eng as any).resolveFilePath('services/core/handler.ts');
    expect(resolved).toBe(realpathSync(join(siblingSub, 'handler.ts')));

    // (c) Same cite, engine WITHOUT the sibling root → unresolved (the #520 bug).
    const engNoRoot = new ConsensusEngine({
      projectRoot: root,
      registryGet: (id: string) => ({ id, provider: 'local', model: 'test', preset: id, skills: [] }),

      round: testRound(),
    } as any);
    const unresolved = await (engNoRoot as any).resolveFilePath('services/core/handler.ts');
    expect(unresolved).toBeNull();
  });
});

describe('#520 wiring — DispatchPipeline threads siblingRoots into ScopeTracker', () => {
  it('a scoped write into a declared sibling root is accepted (not "outside project root")', () => {
    const pipeline = new DispatchPipeline({ projectRoot: root, siblingRoots: [sibling] } as any);
    expect(() => (pipeline as any).scopeTracker.register(join(sibling, 'services'), 'task-wire-1')).not.toThrow();
  });
  it('without siblingRoots, the same sibling scope is rejected (proves the wiring is load-bearing)', () => {
    const pipeline = new DispatchPipeline({ projectRoot: root } as any);
    expect(() => (pipeline as any).scopeTracker.register(join(sibling, 'services'), 'task-wire-2')).toThrow(/outside project root/);
  });
});

describe('resolveSiblingRoots — rejects a sibling root inside projectRoot (consensus 01909cc9)', () => {
  it('throws when a declared sibling root is inside the project root', () => {
    const inside = join(root, 'packages-x'); mkdirSync(inside, { recursive: true });
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [inside] } });
    expect(() => resolveSiblingRoots(cfg, root)).toThrow(/inside the project root/);
  });
  it('still accepts a genuinely external sibling root', () => {
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [sibling] } });
    expect(resolveSiblingRoots(cfg, root)).toContain(realpathSync(sibling));
  });
});

describe('resolveSiblingRoots — v2 git worktree enumeration (#520)', () => {
  it("enumerates a declared repo's git worktrees (v2 — path-carrying cites resolve)", () => {
    execFileSync('git', ['-C', sibling, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const wt = join(dirname(sibling), 'product-wt-feature');
    execFileSync('git', ['-C', sibling, 'worktree', 'add', '-q', wt]);
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['../product'] } });
    const resolved = resolveSiblingRoots(cfg, root);
    expect(resolved).toContain(realpathSync(sibling));
    expect(resolved).toContain(realpathSync(wt));
    // cleanup
    execFileSync('git', ['-C', sibling, 'worktree', 'prune']);
  });

  it('dedups the root + its worktrees (root appears once despite enumeration returning it)', () => {
    execFileSync('git', ['-C', sibling, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const wt = join(dirname(sibling), 'product-wt-dedup');
    execFileSync('git', ['-C', sibling, 'worktree', 'add', '-q', wt]);
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['../product'] } });
    const resolved = resolveSiblingRoots(cfg, root);
    expect(resolved.filter(p => p === realpathSync(sibling)).length).toBe(1);
    expect(new Set(resolved).size).toBe(resolved.length);
    expect(resolved).toContain(realpathSync(wt));
    execFileSync('git', ['-C', sibling, 'worktree', 'remove', '-f', wt]);
  });

  it('enumerates N simultaneous worktrees of one declared repo', () => {
    execFileSync('git', ['-C', sibling, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const wtA = join(dirname(sibling), 'product-wt-a');
    const wtB = join(dirname(sibling), 'product-wt-b');
    execFileSync('git', ['-C', sibling, 'worktree', 'add', '-q', wtA]);
    execFileSync('git', ['-C', sibling, 'worktree', 'add', '-q', wtB]);
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['../product'] } });
    const resolved = resolveSiblingRoots(cfg, root);
    expect(resolved).toContain(realpathSync(wtA));
    expect(resolved).toContain(realpathSync(wtB));
    execFileSync('git', ['-C', sibling, 'worktree', 'remove', '-f', wtA]);
    execFileSync('git', ['-C', sibling, 'worktree', 'remove', '-f', wtB]);
  });

  it('skips (does not throw on) an enumerated worktree checked out inside projectRoot', () => {
    execFileSync('git', ['-C', sibling, 'commit', '--allow-empty', '-q', '-m', 'init']);
    const insideWt = join(root, 'nested-product-wt');
    execFileSync('git', ['-C', sibling, 'worktree', 'add', '-q', insideWt]);
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: ['../product'] } });
    let resolved: string[] = [];
    expect(() => { resolved = resolveSiblingRoots(cfg, root); }).not.toThrow();
    expect(resolved).toContain(realpathSync(sibling));
    expect(resolved).not.toContain(realpathSync(insideWt));
    execFileSync('git', ['-C', sibling, 'worktree', 'remove', '-f', insideWt]);
  });

  it('fail-soft: a non-git declared sibling root still resolves (enumeration returns [])', () => {
    const plainDir = join(dirname(sibling), 'plain-ext'); mkdirSync(plainDir, { recursive: true });
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [join('..', 'plain-ext')] } });
    let resolved: string[] = [];
    expect(() => { resolved = resolveSiblingRoots(cfg, root); }).not.toThrow();
    expect(resolved).toContain(realpathSync(plainDir));
  });
});

describe('consensus 318a16c1 hardening', () => {
  it('rejects a prefix-adjacent sibling (/base/product-evil vs declared /base/product) — no startsWith escape', async () => {
    const base = dirname(sibling);
    const evil = join(base, 'product-evil'); mkdirSync(evil, { recursive: true }); gitInit(evil);
    const r = await validateResolutionRoot(evil, root, { siblingRoots: [sibling] });
    expect(r.valid).toBe(false);
  });

  it('admits a path under a sibling root declared via a symlink (realpath-at-boundary, FIX 1)', async () => {
    const base = dirname(sibling);
    const linkToSibling = join(base, 'product-link');
    try { symlinkSync(sibling, linkToSibling); } catch { return; }
    const r = await validateResolutionRoot(siblingSub, root, { siblingRoots: [linkToSibling] });
    expect(r.valid).toBe(true);
  });

  it('rejects a glob siblingRoots entry whose parent is not a directory (FIX 2 — glob parent validated)', () => {
    const base = dirname(sibling);
    const fileParent = join(base, 'notadir'); writeFileSync(fileParent, 'x');
    const cfg = validateConfig({ ...minimalSkeleton, consensus: { siblingRoots: [join('..', 'notadir', '*')] } });
    expect(() => resolveSiblingRoots(cfg, root)).toThrow(/not a directory|does not resolve to directory/);
  });
});
