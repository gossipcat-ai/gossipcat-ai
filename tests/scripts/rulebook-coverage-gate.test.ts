/**
 * Tests for scripts/rulebook-coverage-gate.mjs.
 *
 * Pure logic lives in scripts/rulebook-coverage-gate.lib.cjs (a CommonJS
 * module) so ts-jest can require it without flipping on Jest's experimental
 * ESM mode. The .mjs is a thin CLI wrapper around this same library.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require(
  path.resolve(__dirname, '..', '..', 'scripts', 'rulebook-coverage-gate.lib.cjs'),
);

// ---------------------------------------------------------------------------
// findUndocumentedSignals
// ---------------------------------------------------------------------------

describe('findUndocumentedSignals', () => {
  it('(a) documented name is NOT returned', () => {
    const names = ['task_completed'];
    const docsText = 'The task_completed signal fires when a task finishes.';
    const exempt = new Set<string>();
    expect(mod.findUndocumentedSignals(names, docsText, exempt)).toEqual([]);
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
    const docsText = 'documented_one appears here';
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
// Smoke test: gate is GREEN on the real repo tree
// ---------------------------------------------------------------------------

describe('live gate smoke test', () => {
  it('finds zero undocumented signals on the current repo tree', () => {
    const ROOT = path.resolve(__dirname, '..', '..');

    // Read the real signal source
    const signalSource = fs.readFileSync(
      path.join(ROOT, 'packages', 'orchestrator', 'src', 'consensus-types.ts'),
      'utf8',
    );
    const signalNames: string[] = mod.extractOperationalSignalNames(signalSource);
    expect(signalNames.length).toBeGreaterThan(0);

    // Read the real docs
    const docPaths = [
      path.join(ROOT, 'docs', 'HANDBOOK.md'),
      path.join(ROOT, '.claude', 'rules', 'gossipcat.md'),
      path.join(ROOT, 'CLAUDE.md'),
    ];
    const docsText = docPaths
      .map((p) => {
        try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
      })
      .join('\n');

    // Use the real DOCS_EXEMPT from the production gate via execFileSync —
    // but we want pure-function coverage, so we replicate the exempt set here.
    // This set MUST stay in sync with scripts/rulebook-coverage-gate.mjs.
    const DOCS_EXEMPT = new Set([
      'task_completed',
      'task_tool_turns',
      'signal_retracted',
      'task_timeout',
      'task_empty',
      'citation_fabricated',
      'consensus_round_retracted',
      'transport_failure',
      'worktree_isolation_failed',
      'auto_verify_attempted',
      'auto_verify_skipped_misconfigured',
    ]);

    const missing: string[] = mod.findUndocumentedSignals(signalNames, docsText, DOCS_EXEMPT);
    expect(missing).toEqual([]);
  });
});
