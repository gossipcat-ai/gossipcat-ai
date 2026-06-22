/**
 * Unit tests for installMirrorHooks (packages/orchestrator/src/hook-installer.ts).
 * Spec §Component 1 settings wiring. NOT auto-enabled — this exercises the
 * explicit installer fn that a follow-up activation step would call.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installMirrorHooks } from '../../packages/orchestrator/src/hook-installer';

function freshProject(): string {
  return mkdtempSync(join(tmpdir(), 'mirror-installer-'));
}

function readSettings(dir: string): any {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf-8'));
}

describe('installMirrorHooks', () => {
  let dir: string;
  beforeEach(() => { dir = freshProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('registers all three mirror hooks on a fresh project', () => {
    const r = installMirrorHooks(dir);
    expect(r.installed.sort()).toEqual(['mirror-prompt', 'mirror-stop', 'mirror-tool']);
    expect(r.skipped).toEqual([]);
    const s = readSettings(dir);
    expect(s.hooks.UserPromptSubmit.some((e: any) =>
      e.hooks.some((h: any) => h.command === 'gossipcat hook mirror-prompt'))).toBe(true);
    expect(s.hooks.Stop.some((e: any) =>
      e.hooks.some((h: any) => h.command === 'gossipcat hook mirror-stop'))).toBe(true);
    expect(s.hooks.PostToolUse.some((e: any) =>
      e.hooks.some((h: any) => h.command === 'gossipcat hook mirror-tool'))).toBe(true);
  });

  it('scopes the PostToolUse matcher to the curated allowlist', () => {
    installMirrorHooks(dir);
    const s = readSettings(dir);
    const entry = s.hooks.PostToolUse.find((e: any) =>
      e.hooks.some((h: any) => h.command === 'gossipcat hook mirror-tool'));
    expect(entry.matcher).toContain('Bash');
    expect(entry.matcher).toContain('mcp__gossipcat__gossip_dispatch');
    expect(entry.matcher).not.toContain('Read');
  });

  it('is idempotent — a second call skips all three', () => {
    installMirrorHooks(dir);
    const r2 = installMirrorHooks(dir);
    expect(r2.installed).toEqual([]);
    expect(r2.skipped.sort()).toEqual(['mirror-prompt', 'mirror-stop', 'mirror-tool']);
  });

  it('preserves pre-existing unrelated settings', () => {
    const dotClaude = join(dir, '.claude');
    require('fs').mkdirSync(dotClaude, { recursive: true });
    writeFileSync(join(dotClaude, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Edit'] } }, null, 2));
    installMirrorHooks(dir);
    const s = readSettings(dir);
    expect(s.permissions.allow).toEqual(['Edit']);
    expect(s.hooks.UserPromptSubmit).toBeDefined();
  });

  it('does NOT clobber a malformed settings.local.json', () => {
    const dotClaude = join(dir, '.claude');
    require('fs').mkdirSync(dotClaude, { recursive: true });
    const p = join(dotClaude, 'settings.local.json');
    writeFileSync(p, '{ not json');
    const r = installMirrorHooks(dir);
    expect(r.reason).toMatch(/malformed/i);
    // File left untouched.
    expect(readFileSync(p, 'utf-8')).toBe('{ not json');
  });

  it('never throws (returns a result even on a bad path)', () => {
    // A path whose .claude cannot be created (file in the way) still returns.
    const filePath = join(dir, 'afile');
    writeFileSync(filePath, 'x');
    const r = installMirrorHooks(filePath);
    expect(r).toHaveProperty('installed');
    expect(r).toHaveProperty('skipped');
  });

  it('leaves no .tmp file behind after a successful write', () => {
    installMirrorHooks(dir);
    const dotClaude = join(dir, '.claude');
    const leftover = require('fs').readdirSync(dotClaude).filter((f: string) => f.includes('.tmp'));
    expect(leftover).toEqual([]);
    expect(existsSync(join(dotClaude, 'settings.local.json'))).toBe(true);
  });
});
