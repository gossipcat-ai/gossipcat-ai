/**
 * Tests for the malformed-settings data-loss guard in installWorktreeSandboxHook.
 *
 * When .claude/settings.json exists but is unparseable or is not a plain JSON
 * object, the installer must:
 *   1. Return { installed: false } without throwing to the caller.
 *   2. Leave the file byte-identical to its original content (zero data loss).
 *   3. NOT copy the hook script to disk (issue #500 — ordering fix).
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { installWorktreeSandboxHook } from '../../packages/orchestrator/src/hook-installer';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-hook-malformed-'));
}

describe('installWorktreeSandboxHook — malformed settings.json guard', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('does not throw and skips write when settings.json contains malformed JSON', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const malformed = '{not valid json';
    writeFileSync(join(root, '.claude', 'settings.json'), malformed);

    // Must not throw — best-effort install, callers expect HookInstallResult.
    let result: ReturnType<typeof installWorktreeSandboxHook>;
    expect(() => {
      result = installWorktreeSandboxHook(root);
    }).not.toThrow();

    expect(result!.installed).toBe(false);
    expect(typeof result!.reason).toBe('string');

    // File must be byte-identical to malformed input.
    const after = readFileSync(join(root, '.claude', 'settings.json'), 'utf-8');
    expect(after).toBe(malformed);
  });

  it('does not throw and skips write when settings.json is a JSON array (not an object)', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const arrayJson = '[]';
    writeFileSync(join(root, '.claude', 'settings.json'), arrayJson);

    let result: ReturnType<typeof installWorktreeSandboxHook>;
    expect(() => {
      result = installWorktreeSandboxHook(root);
    }).not.toThrow();

    expect(result!.installed).toBe(false);
    expect(typeof result!.reason).toBe('string');

    // File must be byte-identical to the original non-object JSON.
    const after = readFileSync(join(root, '.claude', 'settings.json'), 'utf-8');
    expect(after).toBe(arrayJson);
  });

  it('does NOT copy the hook script when settings.json is malformed (#500 ordering fix)', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const malformed = '{not valid json';
    writeFileSync(join(root, '.claude', 'settings.json'), malformed);

    let result: ReturnType<typeof installWorktreeSandboxHook>;
    expect(() => {
      result = installWorktreeSandboxHook(root);
    }).not.toThrow();

    expect(result!.installed).toBe(false);

    // The hook script must NOT be on disk — settings were malformed so we
    // must bail before any filesystem side-effects on the hook target.
    const hookPath = join(root, '.claude', 'hooks', 'worktree-sandbox.sh');
    expect(existsSync(hookPath)).toBe(false);
  });

  it('does not throw and skips write when settings.json is a JSON string (not an object)', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const stringJson = '"just a string"';
    writeFileSync(join(root, '.claude', 'settings.json'), stringJson);

    let result: ReturnType<typeof installWorktreeSandboxHook>;
    expect(() => {
      result = installWorktreeSandboxHook(root);
    }).not.toThrow();

    expect(result!.installed).toBe(false);
    expect(typeof result!.reason).toBe('string');

    const after = readFileSync(join(root, '.claude', 'settings.json'), 'utf-8');
    expect(after).toBe(stringJson);
  });
});
