/**
 * tests/eval/yaml-parser.test.ts — inline-flow array quote handling.
 *
 * The hand-rolled YAML parser in eval/harness.ts must split inline flow
 * arrays on top-level commas only. Naive `.split(',')` corrupts values
 * that legitimately contain commas inside quoted strings, e.g.
 * `files: ["path/with,comma.ts"]`.
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { loadCase } from '../../eval/harness';

describe('eval YAML parser — inline flow arrays', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `gossip-eval-yaml-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCase(yaml: string): string {
    const p = join(dir, 'case.yaml');
    writeFileSync(p, yaml);
    return p;
  }

  it('keeps quoted commas inside a single string item (double quotes)', () => {
    const p = writeCase([
      'id: q-comma',
      'title: t',
      'parent_sha: HEAD',
      'scope:',
      '  files: ["path/with,comma.ts"]',
      'ground_truth:',
      '  - id: gt1',
      '    severity: low',
      '    file: path/with,comma.ts',
      '    line_range: [1, 2]',
      '    summary: s',
      '    category: c',
      'prompt: |',
      '  p',
      '',
    ].join('\n'));
    const c = loadCase(p);
    expect(c.scope.files).toEqual(['path/with,comma.ts']);
  });

  it('keeps quoted commas with single quotes', () => {
    const p = writeCase([
      "id: q-single",
      'title: t',
      'parent_sha: HEAD',
      'scope:',
      "  files: ['a,b.ts', 'c.ts']",
      'ground_truth: []',
      'prompt: |',
      '  p',
      '',
    ].join('\n'));
    const c = loadCase(p);
    expect(c.scope.files).toEqual(['a,b.ts', 'c.ts']);
  });

  it('still splits on top-level commas with no quotes', () => {
    const p = writeCase([
      'id: plain',
      'title: t',
      'parent_sha: HEAD',
      'scope:',
      '  files: [a.ts, b.ts, c.ts]',
      'ground_truth: []',
      'prompt: |',
      '  p',
      '',
    ].join('\n'));
    const c = loadCase(p);
    expect(c.scope.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('handles line_range numeric arrays unchanged', () => {
    const p = writeCase([
      'id: lr',
      'title: t',
      'parent_sha: HEAD',
      'scope:',
      '  files: [a.ts]',
      'ground_truth:',
      '  - id: gt1',
      '    severity: low',
      '    file: a.ts',
      '    line_range: [11, 15]',
      '    summary: s',
      '    category: c',
      'prompt: |',
      '  p',
      '',
    ].join('\n'));
    const c = loadCase(p);
    expect(c.ground_truth[0].line_range).toEqual([11, 15]);
  });
});
