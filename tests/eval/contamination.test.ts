/**
 * tests/eval/contamination.test.ts — anti-contamination contract.
 *
 * Asserts that the harness never lets a ground_truth string reach the
 * dispatched prompt. Sentinel approach: load a fixture case whose ground
 * truths include uniquely-identifiable strings that could not appear in
 * normal source code, then verify those strings are absent from
 * (a) the DispatchableCase produced by prepareDispatchCase, and
 * (b) the prompt string built by buildDispatchPrompt, and
 * (c) the prompt string handed to a custom dispatcher during runCase.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  buildDispatchPrompt,
  loadCase,
  prepareDispatchCase,
  runCase,
} from '../../eval/harness';

const SENTINEL_SUMMARY = 'CANARY_GROUND_TRUTH_SENTINEL_AB12CD34_DO_NOT_LEAK';
const SENTINEL_CATEGORY = 'CANARY_CATEGORY_SENTINEL_EF56GH78';

describe('eval harness — anti-contamination', () => {
  let dir: string;
  let casePath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `gossip-eval-contam-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    casePath = join(dir, 'sentinel-case.yaml');
    const yaml = [
      'id: sentinel-case',
      'title: Sentinel case for contamination test',
      'parent_sha: HEAD',
      'scope:',
      '  files:',
      '    - some/file.ts',
      'ground_truth:',
      '  - id: gt1',
      '    severity: critical',
      '    file: some/file.ts',
      '    line_range: [1, 5]',
      `    summary: ${SENTINEL_SUMMARY}`,
      `    category: ${SENTINEL_CATEGORY}`,
      'prompt: |',
      '  Review the file. Report findings only with file:line citations.',
      'notes: |',
      '  Sentinel notes — never reach the agent.',
      '',
    ].join('\n');
    writeFileSync(casePath, yaml);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prepareDispatchCase strips ground_truth entirely', () => {
    const c = loadCase(casePath);
    expect(c.ground_truth).toHaveLength(1);
    const sanitized = prepareDispatchCase(c);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(SENTINEL_SUMMARY);
    expect(serialized).not.toContain(SENTINEL_CATEGORY);
    expect((sanitized as unknown as Record<string, unknown>).ground_truth).toBeUndefined();
  });

  it('buildDispatchPrompt does not contain ground-truth sentinel strings', () => {
    const c = loadCase(casePath);
    const prompt = buildDispatchPrompt(prepareDispatchCase(c));
    expect(prompt).not.toContain(SENTINEL_SUMMARY);
    expect(prompt).not.toContain(SENTINEL_CATEGORY);
  });

  it('runCase passes a sanitized case to the dispatcher', async () => {
    const c = loadCase(casePath);
    const seenPrompts: string[] = [];
    const seenCases: unknown[] = [];
    await runCase(c, ['fake-agent'], {
      worktreeRoot: dir,
      outDir: join(dir, 'runs'),
      skipCheckout: true,
      dispatcher: async (sanitized, agents) => {
        seenCases.push(sanitized);
        seenPrompts.push(buildDispatchPrompt(sanitized));
        const out: Record<string, never[]> = {};
        for (const a of agents) out[a] = [];
        return out;
      },
    });
    expect(seenPrompts).toHaveLength(1);
    for (const p of seenPrompts) {
      expect(p).not.toContain(SENTINEL_SUMMARY);
      expect(p).not.toContain(SENTINEL_CATEGORY);
    }
    for (const sc of seenCases) {
      const ser = JSON.stringify(sc);
      expect(ser).not.toContain(SENTINEL_SUMMARY);
      expect(ser).not.toContain(SENTINEL_CATEGORY);
    }
  });
});
