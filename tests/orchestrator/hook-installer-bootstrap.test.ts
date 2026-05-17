/**
 * Tests for `installBootstrapHook` — the UserPromptSubmit hook upgrader from
 * docs/specs/2026-05-07-bootstrap-hook-trim.md.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installBootstrapHook, BOOTSTRAP_HOOK_COMMAND } from '../../packages/orchestrator/src/hook-installer';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-bootstrap-hook-'));
}

describe('installBootstrapHook', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('creates settings.local.json with the new hook when no settings exist', () => {
    const root = makeTmpProject();
    created.push(root);

    const r = installBootstrapHook(root);
    expect(r.action).toBe('installed');

    const settingsPath = join(root, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(Array.isArray(settings.hooks?.UserPromptSubmit)).toBe(true);
    const cmds = settings.hooks.UserPromptSubmit.flatMap((e: any) =>
      (e.hooks ?? []).map((h: any) => h.command),
    );
    expect(cmds).toContain(BOOTSTRAP_HOOK_COMMAND);
  });

  it('upgrades a legacy `cat .gossip/bootstrap.md` hook command in place', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    const settingsPath = join(root, '.claude', 'settings.local.json');
    const legacy = {
      permissions: { allow: ['Edit'] },
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: "cat .gossip/bootstrap.md 2>/dev/null || echo '[gossipcat] No bootstrap yet...'" },
            ],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(legacy));

    const r = installBootstrapHook(root);
    expect(r.action).toBe('upgraded');

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Other settings preserved.
    expect(after.permissions).toEqual(legacy.permissions);
    // Command rewritten.
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(BOOTSTRAP_HOOK_COMMAND);
  });

  it('preserves a user-custom UserPromptSubmit command and warns to stderr', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    const settingsPath = join(root, '.claude', 'settings.local.json');
    const custom = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: 'echo custom-thing' }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(custom));

    // Capture stderr.
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };

    let r: ReturnType<typeof installBootstrapHook>;
    try {
      r = installBootstrapHook(root);
    } finally {
      (process.stderr as any).write = orig;
    }

    expect(r!.action).toBe('skipped-user-custom');
    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo custom-thing');
    expect(writes.join('')).toMatch(/custom command/i);
  });

  it('is idempotent — second call reports already-current and does not change content', () => {
    const root = makeTmpProject();
    created.push(root);

    installBootstrapHook(root);
    const settingsPath = join(root, '.claude', 'settings.local.json');
    const before = readFileSync(settingsPath, 'utf-8');

    const r2 = installBootstrapHook(root);
    expect(r2.action).toBe('already-current');
    const after = readFileSync(settingsPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('preserves unrelated settings keys and existing non-UserPromptSubmit hooks', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    const settingsPath = join(root, '.claude', 'settings.local.json');
    const initial = {
      permissions: { allow: ['Edit', 'Write'], deny: ['Bash'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pretool' }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    installBootstrapHook(root);

    const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(after.permissions).toEqual(initial.permissions);
    expect(after.hooks.PreToolUse).toEqual(initial.hooks.PreToolUse);
    expect(after.hooks.UserPromptSubmit[0].hooks[0].command).toBe(BOOTSTRAP_HOOK_COMMAND);
  });

  it('does not throw and reports skipped-malformed on bad JSON; file is byte-preserved', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    const settingsPath = join(root, '.claude', 'settings.local.json');
    const malformed = '{not valid';
    writeFileSync(settingsPath, malformed);

    let r: ReturnType<typeof installBootstrapHook>;
    expect(() => { r = installBootstrapHook(root); }).not.toThrow();
    expect(r!.action).toBe('skipped-malformed');
    expect(readFileSync(settingsPath, 'utf-8')).toBe(malformed);
  });
});
