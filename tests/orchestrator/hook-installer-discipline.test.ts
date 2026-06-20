/**
 * Tests for installDisciplineHooks — the v1 orchestrator-discipline hook bundle.
 *
 * Mirrors the patterns in hook-installer.test.ts and
 * hook-installer-malformed-settings.test.ts (PR #362 guard).
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installDisciplineHooks } from '../../packages/orchestrator/src/hook-installer';

const DISCIPLINE_COMMANDS = [
  '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/session-start-bootstrap.sh',
  '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/pretool-signals-validate.sh',
  '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/posttool-collect-reminder.sh',
] as const;

const DISCIPLINE_HOOK_NAMES = [
  'session-start-bootstrap',
  'pretool-signals-validate',
  'posttool-collect-reminder',
] as const;

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-discipline-hook-'));
}

describe('installDisciplineHooks', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('installs all 3 hooks and creates settings.local.json on a fresh project', () => {
    const root = makeTmpProject();
    created.push(root);

    const result = installDisciplineHooks(root);

    // All 3 hook script files must exist and be executable
    const scriptDir = join(root, '.claude', 'hooks', 'discipline');
    expect(existsSync(join(scriptDir, 'session-start-bootstrap.sh'))).toBe(true);
    expect(existsSync(join(scriptDir, 'pretool-signals-validate.sh'))).toBe(true);
    expect(existsSync(join(scriptDir, 'posttool-collect-reminder.sh'))).toBe(true);

    // settings.local.json must exist
    const settingsPath = join(root, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    // SessionStart hook registered
    expect(Array.isArray(settings.hooks?.SessionStart)).toBe(true);
    const sessionStartEntry = settings.hooks.SessionStart.find((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[0]),
    );
    expect(sessionStartEntry).toBeDefined();

    // PreToolUse hook registered with correct matcher
    expect(Array.isArray(settings.hooks?.PreToolUse)).toBe(true);
    const preToolEntry = settings.hooks.PreToolUse.find((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[1]),
    );
    expect(preToolEntry).toBeDefined();
    expect(preToolEntry.matcher).toBe('mcp__gossipcat__gossip_signals');

    // PostToolUse hook registered with correct matcher
    expect(Array.isArray(settings.hooks?.PostToolUse)).toBe(true);
    const postToolEntry = settings.hooks.PostToolUse.find((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[2]),
    );
    expect(postToolEntry).toBeDefined();
    expect(postToolEntry.matcher).toBe('mcp__gossipcat__gossip_collect');

    // All 3 reported as installed
    expect(result.installed).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.reason).toBeUndefined();
  });

  it('is idempotent — second call does not duplicate any entries', () => {
    const root = makeTmpProject();
    created.push(root);

    installDisciplineHooks(root);
    const result2 = installDisciplineHooks(root);
    const result3 = installDisciplineHooks(root);

    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf-8'));

    // Each hook event should have exactly 1 discipline entry
    const sessionStartMatches = (settings.hooks?.SessionStart ?? []).filter((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[0]),
    );
    expect(sessionStartMatches).toHaveLength(1);

    const preToolMatches = (settings.hooks?.PreToolUse ?? []).filter((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[1]),
    );
    expect(preToolMatches).toHaveLength(1);

    const postToolMatches = (settings.hooks?.PostToolUse ?? []).filter((e: any) =>
      e.hooks?.some((h: any) => h.command === DISCIPLINE_COMMANDS[2]),
    );
    expect(postToolMatches).toHaveLength(1);

    // Second/third calls should skip (already present)
    expect(result2.installed).toHaveLength(0);
    expect(result2.skipped.length).toBeGreaterThanOrEqual(3);
    expect(result3.installed).toHaveLength(0);
  });

  it('merges into existing settings.local.json without overwriting unrelated keys', () => {
    const root = makeTmpProject();
    created.push(root);

    const settingsPath = join(root, '.claude', 'settings.local.json');
    mkdirSync(join(root, '.claude'), { recursive: true });
    const initial = {
      permissions: { allow: ['Edit', 'Write'] },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    installDisciplineHooks(root);

    const updated = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Unrelated keys preserved
    expect(updated.permissions).toEqual(initial.permissions);
    // Existing PreToolUse entry preserved alongside new discipline entry
    expect(updated.hooks.PreToolUse).toHaveLength(2);
    expect(updated.hooks.PreToolUse[0].hooks[0].command).toBe('echo existing');
  });

  it('does not throw and skips write when settings.local.json is malformed JSON', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const malformed = '{not valid json';
    const settingsPath = join(root, '.claude', 'settings.local.json');
    writeFileSync(settingsPath, malformed);

    let result: ReturnType<typeof installDisciplineHooks>;
    expect(() => {
      result = installDisciplineHooks(root);
    }).not.toThrow();

    expect(result!.reason).toBeDefined();
    expect(typeof result!.reason).toBe('string');

    // File must be byte-identical — zero data loss
    const after = readFileSync(settingsPath, 'utf-8');
    expect(after).toBe(malformed);
  });

  it('does not throw and skips write when settings.local.json is a JSON array', () => {
    const root = makeTmpProject();
    created.push(root);

    mkdirSync(join(root, '.claude'), { recursive: true });
    const arrayJson = '[]';
    const settingsPath = join(root, '.claude', 'settings.local.json');
    writeFileSync(settingsPath, arrayJson);

    let result: ReturnType<typeof installDisciplineHooks>;
    expect(() => {
      result = installDisciplineHooks(root);
    }).not.toThrow();

    expect(result!.reason).toBeDefined();
    const after = readFileSync(settingsPath, 'utf-8');
    expect(after).toBe(arrayJson);
  });

  it('does NOT copy discipline hook scripts when settings.local.json is malformed', () => {
    const root = makeTmpProject();
    created.push(root);

    // Write a malformed settings.local.json before calling installDisciplineHooks.
    mkdirSync(join(root, '.claude'), { recursive: true });
    const malformed = '{not valid json';
    const settingsPath = join(root, '.claude', 'settings.local.json');
    writeFileSync(settingsPath, malformed);

    let result: ReturnType<typeof installDisciplineHooks>;
    expect(() => {
      result = installDisciplineHooks(root);
    }).not.toThrow();

    // Must return a reason matching /malformed/i from the JSON parse error.
    expect(result!.reason).toMatch(/malformed|Unexpected token|JSON/i);

    // The discipline hook script files must NOT have been copied to disk —
    // the load-before-copy ordering fix ensures no files land when settings
    // validation fails.
    const disciplineDir = join(root, '.claude', 'hooks', 'discipline');
    const filenames = [
      'session-start-bootstrap.sh',
      'pretool-signals-validate.sh',
      'posttool-collect-reminder.sh',
    ];
    for (const filename of filenames) {
      expect(existsSync(join(disciplineDir, filename))).toBe(false);
    }

    // The discipline directory itself must not have been created either.
    expect(existsSync(disciplineDir)).toBe(false);

    // The malformed file must be byte-identical — zero data loss.
    const after = readFileSync(settingsPath, 'utf-8');
    expect(after).toBe(malformed);
  });

  it('referenced discipline script files exist on disk as bundled assets', () => {
    // Sanity check — the hook-finder must locate all 3 scripts from the
    // current working environment (mirrors findBundledHook sanity test).
    const root = makeTmpProject();
    created.push(root);

    const result = installDisciplineHooks(root);

    // If the assets are found, installed will have entries. If not found,
    // skipped will have them. We assert they are NOT skipped due to missing
    // asset (they may be skipped due to idempotency, but not on fresh root).
    // Fresh project → all 3 must install successfully.
    expect(result.reason).toBeUndefined();
    expect(result.installed).toHaveLength(3);
    for (const name of DISCIPLINE_HOOK_NAMES) {
      expect(result.installed).toContain(name);
    }
  });
});
