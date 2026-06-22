/**
 * Optimistic-concurrency behavior for SkillEngine.writeSkillFileFromParts.
 *
 * writeSkillFileFromParts is private, so these tests exercise it through two
 * public paths that routinely invoke it:
 *   - SkillEngine constructor → runOneTimeStatusMigration() (status-field
 *     migrator that calls writeSkillFileFromParts with frontmatter.version =
 *     current + 1)
 *   - SkillEngine.checkEffectiveness() (verdict writeback path)
 *
 * Everything here uses the exported __setSkillEngineTestHook to deterministically
 * race a sibling writer INTO the window between the drift check and the atomic
 * rename. Without the hook these races are thread-unreliable on a single-writer
 * Node.js process — see Variant E notes in skill-effectiveness-e2e.test.ts.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SkillEngine,
  __setSkillEngineTestHook,
} from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';

function makeStubLLM(): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: '' }),
  } as unknown as ILLMProvider;
}

function makeStubReader(projectRoot: string): PerformanceReader {
  const reader = new PerformanceReader(projectRoot);
  jest.spyOn(reader, 'getCountersSince').mockReturnValue({ correct: 0, hallucinated: 0 });
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map());
  return reader;
}

function writeRawSkill(
  projectRoot: string,
  agentId: string,
  skillFilename: string,
  frontmatter: Record<string, unknown>,
): string {
  const dir = join(projectRoot, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, skillFilename);
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => (typeof v === 'string' ? `${k}: "${v}"` : `${k}: ${v}`))
    .join('\n');
  writeFileSync(path, `---\n${fm}\n---\n\n## Body\n\nStuff.\n`);
  return path;
}

function readFrontmatterField(path: string, field: string): string | null {
  const raw = readFileSync(path, 'utf-8');
  const m = raw.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

function readVersion(path: string): number {
  const v = readFrontmatterField(path, 'version');
  if (v == null) return 0;
  return Number(v);
}

describe('SkillEngine optimistic concurrency', () => {
  let projectRoot: string;
  let stderrSpy: jest.SpyInstance;
  const AGENT = 'fixture-reviewer';

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'skill-conc-'));
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    __setSkillEngineTestHook(null);
    stderrSpy.mockRestore();
    jest.restoreAllMocks();
  });

  // (a) Two sequential writes advance version monotonically.
  test('sequential writes bump version +1 each call', () => {
    // status: "active" is invalid → migrator rewrites to "pending" and bumps version.
    const skillPath = writeRawSkill(projectRoot, AGENT, 'injection-vectors.md', {
      name: 'injection-vectors',
      category: 'injection_vectors',
      status: 'active',
      version: 0,
    });

    // Constructor runs runOneTimeStatusMigration (first run: 0 → 1).
    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);
    expect(readVersion(skillPath)).toBe(1);
    expect(readFrontmatterField(skillPath, 'status')).toBe('pending');

    // Re-poison status so a fresh SkillEngine's migrator has work to do.
    const raw = readFileSync(skillPath, 'utf-8').replace(/status:\s*"?pending"?/, 'status: "active"');
    writeFileSync(skillPath, raw);
    expect(readVersion(skillPath)).toBe(1); // precondition: version persisted

    // A new SkillEngine re-runs its one-shot migrator (second run: 1 → 2).
    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);
    expect(readVersion(skillPath)).toBe(2);
    expect(readFrontmatterField(skillPath, 'status')).toBe('pending');
  });

  // (b) Deterministic race via hook: while writer A is paused between the
  // drift check and the rename, a sibling writer lands v1. Writer A must
  // abort rather than clobbering the sibling's fresher state.
  test('race via hook: paused writer aborts when sibling lands first', () => {
    const skillPath = writeRawSkill(projectRoot, AGENT, 'injection-vectors.md', {
      name: 'injection-vectors',
      category: 'injection_vectors',
      status: 'active', // invalid → triggers migrator write
      version: 0,
    });

    // Install hook BEFORE SkillEngine construction — the migrator runs in the
    // constructor. Hook fires once inside writer A, after the drift check and
    // before the atomic rename. It simulates a sibling writer B that lands v1
    // in that window. When A resumes, its post-hook re-read must observe disk
    // at v1 (not v0) and abort.
    __setSkillEngineTestHook(() => {
      // Simulate sibling writer B (legal v0→v1 write) via a direct file patch.
      // Invoking the full migrator recursively is not meaningful here — we
      // only need the same post-condition a legitimate B would leave behind.
      const current = readFileSync(skillPath, 'utf-8');
      const patched = current
        .replace(/status:\s*"?active"?/, 'status: "pending"')
        .replace(/version:\s*0/, 'version: 1');
      writeFileSync(skillPath, patched);
    });

    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);

    // Writer B wins (disk at v1). Writer A aborted — it must NOT have
    // overwritten with its own v1 derived from a stale v0 snapshot.
    expect(readVersion(skillPath)).toBe(1);
    expect(readFrontmatterField(skillPath, 'status')).toBe('pending');

    // Writer A's abort should surface a stderr drift message.
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrCalls).toMatch(/drift|aborted/i);
  });

  // (c) Missing version field is treated as v0; first write lands at v1.
  test('missing version field → first write lands at v1', () => {
    const skillPath = writeRawSkill(projectRoot, AGENT, 'injection-vectors.md', {
      name: 'injection-vectors',
      category: 'injection_vectors',
      status: 'active',
      // no `version` field at all
    });
    expect(readFrontmatterField(skillPath, 'version')).toBeNull();

    // Constructor runs runOneTimeStatusMigration.
    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);

    expect(readVersion(skillPath)).toBe(1);
    expect(readFrontmatterField(skillPath, 'status')).toBe('pending');
  });

  // (d) On-disk version AHEAD of expected → abort with stderr.
  // Here we simulate: caller snapshotted the file at v0, computed
  // newVersion=1, but between snapshot and write another actor landed v5
  // on disk. The drift check in writeSkillFileFromParts must reject.
  test('disk version ahead of expected → abort with stderr', () => {
    const skillPath = writeRawSkill(projectRoot, AGENT, 'injection-vectors.md', {
      name: 'injection-vectors',
      category: 'injection_vectors',
      status: 'active',
      version: 0,
    });

    // Install hook BEFORE SkillEngine construction (migrator runs in ctor).
    // Hook fires between A's drift check (pass: disk v0, expected v0) and A's
    // atomic rename. Sibling lands v5 on disk. A's post-hook re-read should
    // see v5 ≠ expectedDisk(v0) and abort.
    __setSkillEngineTestHook(() => {
      const current = readFileSync(skillPath, 'utf-8');
      const patched = current
        .replace(/status:\s*"?active"?/, 'status: "pending"')
        .replace(/version:\s*0/, 'version: 5');
      writeFileSync(skillPath, patched);
    });

    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);

    // Sibling's v5 must survive — A must not have clobbered it with v1.
    expect(readVersion(skillPath)).toBe(5);
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(stderrCalls).toMatch(/drift|aborted/i);
  });

  // Regression guard: hook is read-and-cleared so sibling writes invoked
  // from within the hook don't recurse forever.
  test('hook is cleared on entry (no re-entrant recursion)', () => {
    const skillPath = writeRawSkill(projectRoot, AGENT, 'injection-vectors.md', {
      name: 'injection-vectors',
      category: 'injection_vectors',
      status: 'active',
      version: 0,
    });

    let hookInvocations = 0;
    __setSkillEngineTestHook(() => {
      hookInvocations++;
      // A re-entrant write from inside the hook must NOT re-fire the hook.
      if (hookInvocations > 5) throw new Error('hook re-entered');
    });

    // Constructor runs runOneTimeStatusMigration.
    new SkillEngine(makeStubLLM(), makeStubReader(projectRoot), projectRoot);

    expect(hookInvocations).toBe(1);
    expect(existsSync(skillPath)).toBe(true);
  });
});
