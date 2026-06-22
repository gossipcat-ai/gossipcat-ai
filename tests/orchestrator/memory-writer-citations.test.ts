import { MemoryWriter } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests the private validateCitations method via bracket access. The public
 * behavior (frontmatter emission) is exercised indirectly — we assert on the
 * structured result since the caller just renders it.
 */
describe('MemoryWriter.validateCitations (annotation-only)', () => {
  let projectRoot: string;
  let writer: MemoryWriter;
  // Helper to invoke the private method without re-typing bracket access everywhere
  const validate = (body: string, roots?: string[]) =>
    (writer as any).validateCitations(body, roots) as {
      total: number;
      verified: number;
      unverified: string[];
    };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-citations-'));
    writer = new MemoryWriter(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('counts a valid citation as verified with no fabricated list', () => {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/foo.ts'), 'line1\nline2\nline3\n');
    const result = validate('See src/foo.ts for details.');
    expect(result.total).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.unverified).toEqual([]);
  });

  it('flags non-existent file paths as unverified', () => {
    const result = validate('Missing path: src/does-not-exist.ts here.');
    expect(result.total).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.unverified).toContain('src/does-not-exist.ts');
  });

  it('counts out-of-range :NN line suffix as unverified', () => {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/small.ts'), 'l1\nl2\n'); // 3 lines (trailing empty)
    const result = validate('See src/small.ts:999 broken ref.');
    expect(result.total).toBe(1);
    expect(result.verified).toBe(0);
    expect(result.unverified).toContain('src/small.ts:999');
  });

  it('reports mixed 2/3 verified', () => {
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/a.ts'), 'x\n');
    writeFileSync(join(projectRoot, 'src/b.ts'), 'y\n');
    const body = 'Check src/a.ts and src/b.ts and src/ghost.ts now';
    const result = validate(body);
    expect(result.total).toBe(3);
    expect(result.verified).toBe(2);
    expect(result.unverified).toEqual(['src/ghost.ts']);
  });

  it('skips http(s):// URLs as non-citations', () => {
    const body = 'See https://github.com/x/y.ts#L42 for the upstream.';
    const result = validate(body);
    expect(result.total).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.unverified).toEqual([]);
  });

  it('returns 0/0 when body contains no citations', () => {
    const result = validate('Just prose, no file refs here at all.');
    expect(result.total).toBe(0);
    expect(result.verified).toBe(0);
    expect(result.unverified).toEqual([]);
  });

  it('resolves against resolutionRoots when file lives in a worktree root', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'gossip-citations-wt-'));
    try {
      mkdirSync(join(worktree, 'pkg'), { recursive: true });
      writeFileSync(join(worktree, 'pkg/only-here.ts'), 'x\n');
      const result = validate('Reference pkg/only-here.ts please.', [worktree]);
      expect(result.total).toBe(1);
      expect(result.verified).toBe(1);
      expect(result.unverified).toEqual([]);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  it('verifies a bare filename with no :NN when it exists at projectRoot', () => {
    writeFileSync(join(projectRoot, 'bare.ts'), 'x\n');
    const result = validate('Look at bare.ts directly.');
    expect(result.total).toBe(1);
    expect(result.verified).toBe(1);
    expect(result.unverified).toEqual([]);
  });

  // Item A regression: when writeConsensusKnowledge is invoked without a
  // caller-provided taskId, the synthetic fallback was `consensus-${timestamp}`
  // which collides for two rejections landing in the same millisecond. The fix
  // appends a short crypto-random suffix so each emitted citation_fabricated
  // signal gets a distinct taskId even within a single ms.
  it('Item A: synthetic taskId fallback is collision-distinct within same millisecond', () => {
    const perfFile = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    // Body references a fabricated path so validateCitations produces
    // unverified entries and emitCitationFabricatedSignal fires.
    const findings = [
      { originalAgentId: 'peer-a', finding: 'See src/ghost-one.ts for details.', tag: 'unverified' },
    ];
    // Two back-to-back calls — same agent, same findings, no taskId passed.
    // On a fast machine both land within the same millisecond; the format
    // strip in writeConsensusKnowledge slices to second precision so even
    // cross-ms this test asserts on the full fallback, not ms drift.
    writer.writeConsensusKnowledge('opus-implementer', findings);
    writer.writeConsensusKnowledge('opus-implementer', findings);

    const lines = readFileSync(perfFile, 'utf-8').trim().split('\n').filter(Boolean);
    const emitted = lines.map(l => JSON.parse(l)).filter(s => s.signal === 'citation_fabricated');
    expect(emitted.length).toBe(2);
    const [a, b] = emitted;
    expect(a.taskId).toMatch(/^consensus-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(b.taskId).toMatch(/^consensus-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{6}$/);
    expect(a.taskId).not.toBe(b.taskId);
  });
});
