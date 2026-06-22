/**
 * Tests for scripts/rulebook-coverage-gate.mjs.
 *
 * Pure logic lives in scripts/rulebook-coverage-gate.lib.cjs (a CommonJS
 * module) so ts-jest can require it without flipping on Jest's experimental
 * ESM mode. The .mjs is a thin CLI wrapper around this same library.
 */
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(
  path.resolve(__dirname, '..', '..', 'scripts', 'rulebook-coverage-gate.lib.cjs'),
);

// ---------------------------------------------------------------------------
// findUndocumentedSignals
// ---------------------------------------------------------------------------

describe('findUndocumentedSignals', () => {
  it('(a) backtick-wrapped name is NOT returned', () => {
    const names = ['task_completed'];
    const docsText = 'The `task_completed` signal fires when a task finishes.';
    const exempt = new Set<string>();
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([]);
  });

  it('(a2) raw prose mention WITHOUT backticks IS returned (not documented)', () => {
    const names = ['task_completed'];
    const docsText = 'The task_completed signal fires when a task finishes.';
    const exempt = new Set<string>();
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([
      'task_completed',
    ]);
  });

  it('(b) undocumented non-exempt name IS returned', () => {
    const names = ['transport_failure'];
    const docsText = 'No signals mentioned here.';
    const exempt = new Set<string>();
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([
      'transport_failure',
    ]);
  });

  it('(c) exempt name is NOT returned even when absent from docs', () => {
    const names = ['worktree_isolation_failed'];
    const docsText = 'No signals mentioned here.';
    const exempt = new Set(['worktree_isolation_failed']);
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([]);
  });

  it('(d) backtick-wrapped name counts as documented', () => {
    // The signal name is a substring of `signal_name` in markdown
    const names = ['signal_retracted'];
    const docsText = 'Use `signal_retracted` to undo a signal.';
    const exempt = new Set<string>();
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([]);
  });

  it('handles empty inputs gracefully', () => {
    expect(mod.findUndocumentedSignals([], 'docs', new Set())).toEqual([]);
    expect(
      mod.findUndocumentedSignals(['foo'], '', new Set()),
    ).toEqual(['foo']);
  });

  it('returns only undocumented + non-exempt from a mixed list', () => {
    const names = ['documented_one', 'exempt_one', 'missing_one'];
    const docsText = 'Use `documented_one` here';
    const exempt = new Set(['exempt_one']);
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([
      'missing_one',
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractOperationalSignalNames
// ---------------------------------------------------------------------------

describe('extractOperationalSignalNames', () => {
  const FIXTURE_SOURCE = `
export const OPERATIONAL_SIGNAL_NAMES: ReadonlySet<string> = new Set([
  'task_completed',
  'task_tool_turns',
  /* Orchestrator signals */
  'dispatched_stale_base',
  // internal only
  'referenced_unreadable_path',
  "mid_flight_fixup",
]);
`;

  it('extracts all quoted names from a Set literal', () => {
    const names = mod.extractOperationalSignalNames(FIXTURE_SOURCE);
    expect(names).toContain('task_completed');
    expect(names).toContain('task_tool_turns');
    expect(names).toContain('dispatched_stale_base');
    expect(names).toContain('referenced_unreadable_path');
    expect(names).toContain('mid_flight_fixup');
    expect(names).toHaveLength(5);
  });

  it('ignores comment content (block and line)', () => {
    const src = `
export const OPERATIONAL_SIGNAL_NAMES = new Set([
  /* 'not_a_signal' */
  'real_signal', // 'also_not_a_signal'
]);
`;
    const names = mod.extractOperationalSignalNames(src);
    expect(names).toEqual(['real_signal']);
  });

  it('returns [] when OPERATIONAL_SIGNAL_NAMES is not present', () => {
    expect(mod.extractOperationalSignalNames('export const OTHER = 1;')).toEqual([]);
  });

  it('returns [] when new Set([ is not present after marker', () => {
    const src = 'const OPERATIONAL_SIGNAL_NAMES = someOtherThing;';
    expect(mod.extractOperationalSignalNames(src)).toEqual([]);
  });

  it('handles double-quoted strings', () => {
    const src = `
export const OPERATIONAL_SIGNAL_NAMES = new Set([
  "alpha",
  'beta',
]);
`;
    const names = mod.extractOperationalSignalNames(src);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Smoke test: run the REAL gate end-to-end against the live repo tree
// ---------------------------------------------------------------------------

describe('live gate smoke test', () => {
  it('exits 0 and reports OK on the current repo tree', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    let stdout: string;
    try {
      stdout = execFileSync('node', ['scripts/rulebook-coverage-gate.mjs'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch (err: any) {
      // execFileSync throws on non-zero exit; surface stderr for diagnostics
      throw new Error(
        `rulebook-coverage-gate exited non-zero.\nstdout: ${err.stdout ?? ''}\nstderr: ${err.stderr ?? ''}`,
      );
    }
    expect(stdout).toContain('OK —');
  });
});
