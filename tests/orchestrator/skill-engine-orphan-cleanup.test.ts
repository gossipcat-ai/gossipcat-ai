import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

function makeStubLLM(): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: '' }),
  } as unknown as ILLMProvider;
}

function makeStubPerfReader(projectRoot: string): PerformanceReader {
  const reader = new PerformanceReader(projectRoot);
  jest.spyOn(reader, 'getCountersSince').mockReturnValue({ correct: 0, hallucinated: 0 });
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map());
  return reader;
}

function makeSkillsDir(tmpDir: string, agentId: string): string {
  const skillsDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return skillsDir;
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

// Skill body includes status: pending + migration_count: 2 so the
// runOneTimeStatusMigration pass (which runs before orphan cleanup) leaves
// the file byte-for-byte untouched. That lets us assert exact content
// preservation across rename.
const SKILL_BODY = `---
name: sample
category: trust_boundaries
status: pending
migration_count: 2
---

## Body
Sample content.
`;

describe('SkillEngine orphan cleanup', () => {
  let tmpDir: string;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-engine-orphan-'));
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('deletes .md.bak-<timestamp> artifacts and stderr-logs each', () => {
    const skillsDir = makeSkillsDir(tmpDir, 'agent-a');
    const bakPath = join(skillsDir, 'trust-boundaries.md.bak-1776463176302');
    writeFile(bakPath, 'old backup content');

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(existsSync(bakPath)).toBe(false);
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(warnings).toContain('deleted backup artifact');
    expect(warnings).toContain(bakPath);
  });

  it('deletes underscore duplicate when hyphen canonical exists', () => {
    const skillsDir = makeSkillsDir(tmpDir, 'agent-b');
    const hyphenPath = join(skillsDir, 'trust-boundaries.md');
    const underscorePath = join(skillsDir, 'trust_boundaries.md');
    writeFile(hyphenPath, SKILL_BODY);
    writeFile(underscorePath, '---\nname: orphan\n---\nOrphan body.\n');

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(existsSync(hyphenPath)).toBe(true);
    expect(existsSync(underscorePath)).toBe(false);
    // Canonical content preserved, orphan discarded.
    expect(readFileSync(hyphenPath, 'utf-8')).toBe(SKILL_BODY);
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(warnings).toContain('deleted underscore duplicate');
    expect(warnings).toContain(underscorePath);
  });

  it('renames underscore skill to hyphen canonical when no counterpart exists', () => {
    const skillsDir = makeSkillsDir(tmpDir, 'agent-c');
    const underscorePath = join(skillsDir, 'input_validation.md');
    const canonicalPath = join(skillsDir, 'input-validation.md');
    writeFile(underscorePath, SKILL_BODY);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(existsSync(underscorePath)).toBe(false);
    expect(existsSync(canonicalPath)).toBe(true);
    // Content preserved through the rename.
    expect(readFileSync(canonicalPath, 'utf-8')).toBe(SKILL_BODY);
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(warnings).toContain('renamed');
    expect(warnings).toContain(underscorePath);
    expect(warnings).toContain(canonicalPath);
  });

  it('leaves unrelated files like README.md untouched', () => {
    const skillsDir = makeSkillsDir(tmpDir, 'agent-d');
    const readmePath = join(skillsDir, 'README.md');
    const regularPath = join(skillsDir, 'trust-boundaries.md');
    // README-style file with pending/valid status so status-migration is a
    // no-op; the point of this test is orphan-cleanup scope, not status.
    const readmeBody = `---\nname: readme\nstatus: pending\nmigration_count: 2\n---\n\n# Readme\n`;
    writeFile(readmePath, readmeBody);
    writeFile(regularPath, SKILL_BODY);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(existsSync(readmePath)).toBe(true);
    expect(existsSync(regularPath)).toBe(true);
    expect(readFileSync(readmePath, 'utf-8')).toBe(readmeBody);
    expect(readFileSync(regularPath, 'utf-8')).toBe(SKILL_BODY);
  });

  it('does not throw when no .gossip/agents dir exists', () => {
    expect(
      () => new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir),
    ).not.toThrow();
  });

  it('is idempotent — a second construction on the same dir does no work and does not throw', () => {
    const skillsDir = makeSkillsDir(tmpDir, 'agent-e');
    const bakPath = join(skillsDir, 'trust-boundaries.md.bak-1000000000000');
    const underscorePath = join(skillsDir, 'concurrency.md');
    writeFile(bakPath, 'bak');
    writeFile(underscorePath, SKILL_BODY);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    // Post-first-run state
    const afterFirst = readdirSync(skillsDir).sort();
    expect(afterFirst).toEqual(['concurrency.md']);

    // Second construction — must not throw and must not re-log cleanup actions.
    stderrSpy.mockClear();
    expect(
      () => new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir),
    ).not.toThrow();

    const afterSecond = readdirSync(skillsDir).sort();
    expect(afterSecond).toEqual(['concurrency.md']);

    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(warnings).not.toContain('deleted backup artifact');
    expect(warnings).not.toContain('deleted underscore duplicate');
    expect(warnings).not.toContain('renamed');
  });
});
