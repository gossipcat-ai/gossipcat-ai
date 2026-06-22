import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillEngine,
  VALID_STATUSES,
  coerceStatus,
} from '../../packages/orchestrator/src/skill-engine';
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

function writeSkill(
  tmpDir: string,
  agentId: string,
  skillName: string,
  frontmatterLines: string[],
): string {
  const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, `${skillName}.md`);
  const content = `---\n${frontmatterLines.join('\n')}\n---\n\n## Body\n\nStuff.\n`;
  writeFileSync(skillPath, content);
  return skillPath;
}

function readStatus(path: string): string | null {
  const raw = readFileSync(path, 'utf-8');
  const m = raw.match(/^status:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

describe('SkillEngine one-time status migration', () => {
  let tmpDir: string;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-engine-status-'));
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('rewrites status:"active" to status: pending', () => {
    const skillPath = writeSkill(tmpDir, 'agent-a', 'trust-boundaries', [
      'name: trust-boundaries',
      'category: trust_boundaries',
      'status: active',
      'migration_count: 2',
    ]);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(readStatus(skillPath)).toBe('pending');
  });

  it('adds status: pending when no status field present', () => {
    const skillPath = writeSkill(tmpDir, 'agent-b', 'input-validation', [
      'name: input-validation',
      'category: input_validation',
      'migration_count: 1',
    ]);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(readStatus(skillPath)).toBe('pending');
  });

  it('leaves valid status: passed untouched', () => {
    const skillPath = writeSkill(tmpDir, 'agent-c', 'concurrency', [
      'name: concurrency',
      'category: concurrency',
      'status: passed',
      'migration_count: 2',
      'effectiveness: 0.12',
    ]);
    const before = readFileSync(skillPath, 'utf-8');

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(readFileSync(skillPath, 'utf-8')).toBe(before);
  });

  it('rewrites status even when migration_count >= 2 locks migrateIfNeeded', () => {
    const skillPath = writeSkill(tmpDir, 'gemini-reviewer', 'trust-boundaries', [
      'name: trust-boundaries',
      'category: trust_boundaries',
      'status: active',
      'migration_count: 3',
    ]);

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    expect(readStatus(skillPath)).toBe('pending');
  });

  it('handles missing .gossip/agents dir without throwing', () => {
    expect(
      () => new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir),
    ).not.toThrow();
  });

  it('leaves all eight VerdictStatus values untouched', () => {
    const paths: string[] = [];
    for (const status of VALID_STATUSES) {
      paths.push(
        writeSkill(tmpDir, `agent-${status}`, 'injection-vectors', [
          'name: injection-vectors',
          'category: injection_vectors',
          `status: ${status}`,
          'migration_count: 2',
        ]),
      );
    }
    const before = paths.map(p => readFileSync(p, 'utf-8'));

    new SkillEngine(makeStubLLM(), makeStubPerfReader(tmpDir), tmpDir);

    paths.forEach((p, i) => {
      expect(readFileSync(p, 'utf-8')).toBe(before[i]);
    });
  });
});

describe('coerceStatus', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('passes valid VerdictStatus strings through', () => {
    for (const s of VALID_STATUSES) {
      expect(coerceStatus(s)).toBe(s);
    }
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('remaps invalid strings to pending and warns to stderr', () => {
    expect(coerceStatus('active')).toBe('pending');
    expect(stderrSpy).toHaveBeenCalled();
    const warnings = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(warnings).toContain('invalid status');
    expect(warnings).toContain('"active"');
    expect(warnings).toContain('remapped to pending');
  });

  it('remaps undefined to pending silently', () => {
    expect(coerceStatus(undefined)).toBe('pending');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('remaps null to pending silently', () => {
    expect(coerceStatus(null)).toBe('pending');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('remaps non-string values to pending with warning', () => {
    expect(coerceStatus(42)).toBe('pending');
    expect(coerceStatus({ status: 'passed' })).toBe('pending');
    expect(stderrSpy).toHaveBeenCalled();
  });
});
