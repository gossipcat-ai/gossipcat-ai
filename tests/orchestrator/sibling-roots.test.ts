import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { validateResolutionRoot } from '../../packages/orchestrator/src/validate-resolution-root';

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
