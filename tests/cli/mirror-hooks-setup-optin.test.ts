/**
 * gossip_setup handler — activity-mirror hooks are OPT-IN (default OFF).
 *
 * The activity-mirror hooks (UserPromptSubmit/Stop/PostToolUse) mirror the live
 * CC session's tool I/O into the dashboard. They are NEVER auto-enabled:
 * installMirrorHooks runs only when the caller passes `mirror_hooks: true`.
 *
 * Like mcp-server-setup-dashboard.test.ts, we test the gating logic layer
 * (mirroring the block in mcp-server-sdk.ts) rather than the full HTTP handler,
 * which requires a live relay + agent config. The source-text assertions below
 * lock the structural invariants of the real handler so the simulation cannot
 * silently diverge.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

interface MirrorHookInstallResult {
  installed: string[];
  skipped: string[];
  reason?: string;
}

/**
 * Mirrors the mirror-hooks gating block from the gossip_setup handler:
 * installMirrorHooks(root) runs ONLY when mirror_hooks === true; otherwise the
 * settings file is never touched and an opt-in advisory line is appended.
 */
function buildMirrorSummary(opts: {
  mirror_hooks: boolean | undefined;
  install: () => MirrorHookInstallResult;
}): string {
  let mirrorSummary = '';
  if (opts.mirror_hooks === true) {
    try {
      const mirrorResult = opts.install();
      if (mirrorResult.reason) {
        mirrorSummary = `Mirror hooks: skipped (${mirrorResult.reason})`;
      } else if (mirrorResult.installed.length > 0) {
        mirrorSummary = `Mirror hooks: installed [${mirrorResult.installed.join(', ')}]`;
        if (mirrorResult.skipped.length > 0) {
          mirrorSummary += `, already present [${mirrorResult.skipped.join(', ')}]`;
        }
      } else {
        mirrorSummary = 'Mirror hooks: already present (no changes)';
      }
    } catch (e) {
      mirrorSummary = `Mirror hooks: skipped (${(e as Error).message})`;
    }
  } else {
    mirrorSummary = 'Mirror hooks: not enabled (opt-in — pass mirror_hooks:true to install)';
  }
  return mirrorSummary;
}

describe('gossip_setup — mirror hooks opt-in gating', () => {
  it('mirror_hooks:true → installMirrorHooks IS invoked', () => {
    let called = 0;
    const summary = buildMirrorSummary({
      mirror_hooks: true,
      install: () => {
        called += 1;
        return { installed: ['mirror-prompt', 'mirror-stop', 'mirror-tool'], skipped: [] };
      },
    });
    expect(called).toBe(1);
    expect(summary).toContain('Mirror hooks: installed [mirror-prompt, mirror-stop, mirror-tool]');
  });

  it('mirror_hooks:false → installMirrorHooks NOT invoked, no settings mutation', () => {
    let called = 0;
    const summary = buildMirrorSummary({
      mirror_hooks: false,
      install: () => {
        called += 1;
        return { installed: [], skipped: [] };
      },
    });
    expect(called).toBe(0);
    expect(summary).toContain('not enabled (opt-in');
  });

  it('mirror_hooks absent (undefined) → installMirrorHooks NOT invoked (default OFF)', () => {
    let called = 0;
    const summary = buildMirrorSummary({
      mirror_hooks: undefined,
      install: () => {
        called += 1;
        return { installed: [], skipped: [] };
      },
    });
    expect(called).toBe(0);
    expect(summary).toContain('not enabled (opt-in');
  });

  it('mirror_hooks:true with all already present → "already present (no changes)"', () => {
    const summary = buildMirrorSummary({
      mirror_hooks: true,
      install: () => ({ installed: [], skipped: ['mirror-prompt', 'mirror-stop', 'mirror-tool'] }),
    });
    expect(summary).toBe('Mirror hooks: already present (no changes)');
  });

  it('mirror_hooks:true with a malformed-settings reason → skipped (reason)', () => {
    const summary = buildMirrorSummary({
      mirror_hooks: true,
      install: () => ({ installed: [], skipped: [], reason: 'settings.local.json is malformed' }),
    });
    expect(summary).toBe('Mirror hooks: skipped (settings.local.json is malformed)');
  });

  it('mirror_hooks:true install throw → fail-soft skipped summary (no propagation)', () => {
    const summary = buildMirrorSummary({
      mirror_hooks: true,
      install: () => { throw new Error('boom'); },
    });
    expect(summary).toBe('Mirror hooks: skipped (boom)');
  });
});

// ── Source-text assertions — lock the real handler's gating invariants ───────
describe('gossip_setup source — mirror_hooks opt-in invariants', () => {
  const SRC: string = readFileSync(
    resolve(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
    'utf-8',
  );

  it('declares a mirror_hooks boolean flag defaulting to false', () => {
    expect(SRC).toMatch(/mirror_hooks:\s*z\.boolean\(\)\.default\(false\)/);
  });

  it('destructures mirror_hooks in the handler args', () => {
    expect(SRC).toMatch(/instruction_mode,\s*mirror_hooks\s*\}/);
  });

  it('installMirrorHooks is gated behind mirror_hooks === true', () => {
    // The install call must sit inside the `mirror_hooks === true` branch.
    expect(SRC).toMatch(/if \(mirror_hooks === true\)[\s\S]*?installMirrorHooks\(root\)/);
  });

  it('the else branch never installs (opt-in advisory only)', () => {
    expect(SRC).toMatch(/not enabled \(opt-in/);
  });
});
