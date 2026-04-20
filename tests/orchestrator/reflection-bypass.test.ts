/**
 * reflection-bypass.test.ts — Stream C defense-in-depth for the signal-pipeline
 * boundary. Complements Stream A's AST walker
 * (tests/orchestrator/completion-signals-parity.test.ts) with:
 *
 *  1. A dumb literal-string scan for `Object.getOwnPropertySymbols` across
 *     packages/orchestrator/src/** and apps/cli/src/**. Redundant with the AST
 *     walker but fails faster and is trivial to audit.
 *
 *  2. A runtime witness: synthesise a symbol-reflection bypass against a real
 *     PerformanceWriter in a tmpdir and assert the L3 PipelineDriftDetector's
 *     `bypassCount` goes up.
 *
 *  3. A negative control: the same writer instance invoked via the sanctioned
 *     `emitConsensusSignals` helper must NOT raise the bypass count. Proves
 *     the detector actually distinguishes reflection writes from helper-routed
 *     writes.
 *
 * Addresses gemini-reviewer f1 HIGH from consensus fb3ea8fc-6e674462 — without
 * this test the WRITER_INTERNAL Symbol gate is a purely static boundary that
 * any call site can circumvent via `Object.getOwnPropertySymbols(writer)[0]`.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve, basename } from 'path';
import { PerformanceWriter } from '../../packages/orchestrator/src/performance-writer';
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';
import { emitConsensusSignals } from '../../packages/orchestrator/src/signal-helpers';
import { PipelineDriftDetector } from '../../packages/orchestrator/src/pipeline-drift-detector';
import type { PerformanceSignal } from '../../packages/orchestrator/src/consensus-types';

const REPO_ROOT = resolve(__dirname, '../..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'packages/orchestrator/src'),
  join(REPO_ROOT, 'apps/cli/src'),
];

/**
 * Files that are permitted to mention `Object.getOwnPropertySymbols` because
 * they are part of the sanctioned boundary itself, documentation, or this
 * very test. Any NEW occurrence outside this list is a bypass and fails.
 */
const EXEMPT_BASENAMES = new Set<string>([
  'signal-helpers.ts',
  '_writer-internal.ts',
  'completion-signals.ts',
]);

function walkTs(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Skip build output and node_modules defensively.
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
      walkTs(full, acc);
    } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('reflection-bypass defense-in-depth', () => {
  describe('source-scan (Layer 1 sibling)', () => {
    it('no source file outside the sanctioned boundary references Object.getOwnPropertySymbols', () => {
      const offenders: Array<{ file: string; line: number; text: string }> = [];
      const files: string[] = [];
      for (const root of SCAN_ROOTS) walkTs(root, files);

      for (const file of files) {
        const base = basename(file);
        if (EXEMPT_BASENAMES.has(base)) continue;
        const src = readFileSync(file, 'utf8');
        if (!src.includes('Object.getOwnPropertySymbols')) continue;
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('Object.getOwnPropertySymbols')) {
            offenders.push({
              file: relative(REPO_ROOT, file),
              line: i + 1,
              text: lines[i].trim(),
            });
          }
        }
      }

      if (offenders.length > 0) {
        const pretty = offenders
          .map(o => `  ${o.file}:${o.line}: ${o.text}`)
          .join('\n');
        throw new Error(
          `Found ${offenders.length} unsanctioned Object.getOwnPropertySymbols ` +
          `reference(s). Only ${[...EXEMPT_BASENAMES].join(', ')} may use the ` +
          `Symbol accessor — every other call site must go through ` +
          `signal-helpers.ts:\n${pretty}`,
        );
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('runtime witness (Layer 3 sibling)', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'gossip-test-'));
    });

    afterEach(() => {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /**
     * Emit enough helper-routed rows to establish the drift detector's tagging
     * epoch. Without this, the detector's bypass-detection path cannot fire
     * because it refuses to look at pre-epoch rows.
     */
    function seedEpoch(writer: PerformanceWriter, n = 5, startOffset = 0): void {
      for (let i = 0; i < n; i++) {
        writer[WRITER_INTERNAL].appendSignals(
          [{
            type: 'meta',
            signal: 'task_completed',
            agentId: 'seed',
            taskId: `seed-${i}`,
            value: 0,
            timestamp: iso(startOffset + i),
          } as unknown as PerformanceSignal],
          'completion-signals-helper',
        );
      }
    }

    it('synthetic reflection bypass increments drift-detector bypassCount', () => {
      const writer = new PerformanceWriter(root);
      seedEpoch(writer, 5, 0);

      // Reach the internal writer exactly the way a hostile call site would —
      // via the Symbol exposed by Object.getOwnPropertySymbols, bypassing the
      // typed `WRITER_INTERNAL` import path that signal-helpers.ts uses.
      const syms = Object.getOwnPropertySymbols(writer);
      expect(syms.length).toBeGreaterThan(0);
      const sym = syms[0];
      const internal = (writer as unknown as Record<symbol, {
        appendSignals: (s: PerformanceSignal[], path?: string) => void;
      }>)[sym];
      expect(typeof internal.appendSignals).toBe('function');

      // Reflection call — no emissionPath argument → stamped as 'unknown'.
      // Use an allowlisted completion-signal name so the bypass check fires,
      // not the unknown-rate check (which is gated by a 100-row minimum).
      internal.appendSignals([
        {
          type: 'meta',
          signal: 'task_completed',
          agentId: 'attacker',
          taskId: 'reflect-1',
          value: 1,
          timestamp: iso(100),
        } as unknown as PerformanceSignal,
      ]);

      const result = new PipelineDriftDetector(root).run();
      expect(result.bypassCount).toBeGreaterThanOrEqual(1);
      expect(result.triggered).toBe(true);
      expect(result.sampleOffenders.some(o =>
        o.taskId === 'reflect-1' && o.signal === 'task_completed',
      )).toBe(true);
    });

    it('negative control: emitConsensusSignals does NOT increment bypassCount', () => {
      const writer = new PerformanceWriter(root);
      // Establish epoch with helper-path writes using the same writer instance
      // the synthetic-bypass test uses. That instance shares the .gossip/ dir
      // with the helper, so the detector sees a unified window.
      seedEpoch(writer, 5, 0);

      // Route a legitimate consensus signal through the sanctioned helper.
      // This stamps `_emission_path: 'signal-helpers-consensus'`, which is
      // NOT the helper path but IS in EMISSION_PATHS — and the allowlist
      // check only trips on completion-signal names, not on consensus names
      // like 'agreement'. So bypassCount must stay at 0.
      emitConsensusSignals(root, [
        {
          type: 'consensus',
          signal: 'agreement',
          agentId: 'reviewer-a',
          taskId: 'legit-1',
          value: 1,
          timestamp: iso(200),
        } as unknown as PerformanceSignal,
      ]);

      const result = new PipelineDriftDetector(root).run();
      expect(result.bypassCount).toBe(0);
    });
  });
});
