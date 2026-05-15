/**
 * Tests for prose-bullet-resolver (spec 2026-05-14).
 * Uses a fixture memory dir under tmpdir — never touches ~/.claude/projects.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, utimesSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildProseResolverIndex,
  resolveProseBullet,
  extractTokens,
  proseResolverPath,
  PROSE_RESOLVER_VERSION,
  JACCARD_THRESHOLD,
  type ProseResolverIndex,
} from '@gossip/orchestrator';

function mkTmp(suffix: string): { root: string; memDir: string } {
  const root = join(tmpdir(), `prose-resolver-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const memDir = join(root, 'memory');
  mkdirSync(join(root, '.gossip', 'agents'), { recursive: true });
  mkdirSync(memDir, { recursive: true });
  return { root, memDir };
}

function writeMemory(memDir: string, fname: string, name: string, description: string): void {
  const body = `---\nname: ${name}\ndescription: ${description}\ntype: project\nstatus: shipped\n---\n\nbody content here.\n`;
  writeFileSync(join(memDir, fname), body);
}

function writeAgent(root: string, agentId: string): void {
  mkdirSync(join(root, '.gossip', 'agents', agentId), { recursive: true });
}

describe('extractTokens', () => {
  it('extracts PR refs in multiple shapes', () => {
    const t = extractTokens('PR #383 and pr 42 and PR#7', []);
    expect(t.has('pr383')).toBe(true);
    expect(t.has('pr42')).toBe(true);
    expect(t.has('pr7')).toBe(true);
  });

  it('extracts agent IDs when present in text', () => {
    const t = extractTokens('opus-implementer found a bug', ['opus-implementer', 'gemini-reviewer']);
    expect(t.has('opus-implementer')).toBe(true);
    expect(t.has('gemini-reviewer')).toBe(false);
  });

  it('extracts underscore-bearing memory filenames', () => {
    const t = extractTokens('see project_pr383_followup_cleanups.md for details', []);
    expect(t.has('project_pr383_followup_cleanups.md')).toBe(true);
  });

  it('extracts category keywords (closed set)', () => {
    const t = extractTokens('a trust_boundaries violation in error_handling', []);
    expect(t.has('trust_boundaries')).toBe(true);
    expect(t.has('error_handling')).toBe(true);
  });

  it('returns empty set for zero-token prose', () => {
    const t = extractTokens('just some words with nothing matching', []);
    expect(t.size).toBe(0);
  });
});

describe('buildProseResolverIndex', () => {
  it('builds and caches a fresh sidecar', () => {
    const { root, memDir } = mkTmp('build');
    try {
      writeMemory(memDir, 'project_pr383_followup_cleanups.md', 'PR 383 follow-ups', 'next-session ledger auto-verify guardrail PR #383');
      writeMemory(memDir, 'feedback_x.md', 'X feedback', 'something else entirely');
      const idx = buildProseResolverIndex(root, memDir);
      expect(idx.version).toBe(PROSE_RESOLVER_VERSION);
      expect(idx.tokens['pr383']).toContain('project_pr383_followup_cleanups.md');
      expect(existsSync(proseResolverPath(root))).toBe(true);
      // Second call uses cache (filename hash matches).
      const idx2 = buildProseResolverIndex(root, memDir);
      expect(idx2.filenameHash).toBe(idx.filenameHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates sidecar when a memory file is added', () => {
    const { root, memDir } = mkTmp('add');
    try {
      writeMemory(memDir, 'a.md', 'A', 'PR #1 something');
      const idx1 = buildProseResolverIndex(root, memDir);
      writeMemory(memDir, 'b.md', 'B', 'PR #2 something');
      // Force a different dir mtime so cache cannot fall through on it; the
      // filename-hash check should still trip independently.
      const idx2 = buildProseResolverIndex(root, memDir);
      expect(idx2.filenameHash).not.toBe(idx1.filenameHash);
      expect(idx2.tokens['pr2']).toContain('b.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates sidecar on rename (ext4 mtime-stable case)', () => {
    const { root, memDir } = mkTmp('rename');
    try {
      writeMemory(memDir, 'project_foo.md', 'Foo', 'PR #99 about input_validation');
      const idx1 = buildProseResolverIndex(root, memDir);
      // Force-pin the dir mtime back to its pre-rename value so the dir-mtime
      // gate alone CANNOT detect the change (ext4 pathological case).
      const st = statSync(memDir);
      renameSync(join(memDir, 'project_foo.md'), join(memDir, 'project_bar.md'));
      utimesSync(memDir, st.atime, st.mtime);
      const idx2 = buildProseResolverIndex(root, memDir);
      expect(idx2.filenameHash).not.toBe(idx1.filenameHash);
      expect(idx2.tokens['pr99']).toContain('project_bar.md');
      expect(idx2.tokens['pr99']).not.toContain('project_foo.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalidates sidecar on file removal', () => {
    const { root, memDir } = mkTmp('remove');
    try {
      writeMemory(memDir, 'a.md', 'A', 'PR #1');
      writeMemory(memDir, 'b.md', 'B', 'PR #2');
      const idx1 = buildProseResolverIndex(root, memDir);
      rmSync(join(memDir, 'b.md'));
      const idx2 = buildProseResolverIndex(root, memDir);
      expect(idx2.filenameHash).not.toBe(idx1.filenameHash);
      expect(idx2.tokens['pr2']).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveProseBullet', () => {
  function setup(): { root: string; memDir: string; idx: ProseResolverIndex; agentIds: string[] } {
    const { root, memDir } = mkTmp('resolve');
    writeAgent(root, 'opus-implementer');
    writeAgent(root, 'gemini-reviewer');
    writeMemory(
      memDir,
      'project_pr383_followup_cleanups.md',
      'next-session ledger auto-verify PR 383',
      'PR #383 follow-up cleanups including project_pr383_followup_cleanups.md and 5 LOWs',
    );
    writeMemory(
      memDir,
      'feedback_opus_thing.md',
      'Opus feedback',
      'opus-implementer trust_boundaries note',
    );
    writeMemory(
      memDir,
      'project_unrelated.md',
      'unrelated',
      'something entirely different about css',
    );
    const idx = buildProseResolverIndex(root, memDir);
    return { root, memDir, idx, agentIds: ['opus-implementer', 'gemini-reviewer'] };
  }

  it('regression: PR #383 5 LOWs bullet resolves to project_pr383_followup_cleanups.md', () => {
    const { root, idx, agentIds } = setup();
    try {
      const res = resolveProseBullet(
        'PR #383 5 LOWs deferred — see project_pr383_followup_cleanups.md',
        idx,
        agentIds,
      );
      expect(res.kind).toBe('matched');
      if (res.kind === 'matched') {
        expect(res.backingFile).toBe('project_pr383_followup_cleanups.md');
        expect(res.score).toBeGreaterThanOrEqual(JACCARD_THRESHOLD);
        expect(res.matchedTokens).toEqual(expect.arrayContaining(['pr383', 'project_pr383_followup_cleanups.md']));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('agent-ID hit + category keyword matches feedback_opus_thing.md', () => {
    const { root, idx, agentIds } = setup();
    try {
      const res = resolveProseBullet('opus-implementer raised a trust_boundaries question', idx, agentIds);
      expect(res.kind).toBe('matched');
      if (res.kind === 'matched') expect(res.backingFile).toBe('feedback_opus_thing.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('single-token match falls below MIN_TOKEN_MATCHES threshold', () => {
    const { root, idx, agentIds } = setup();
    try {
      // Only 'pr383' matches — no second token in bullet that lands in any memory.
      const res = resolveProseBullet('check the PR #383 status', idx, agentIds);
      expect(res.kind).toBe('none');
      if (res.kind === 'none') expect(res.reason).toBe('below_threshold');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns ambiguous when two memories tie within 5%', () => {
    const { root, memDir } = mkTmp('ambig');
    writeAgent(root, 'opus-implementer');
    // Two memory files with identical frontmatter token sets.
    writeMemory(memDir, 'a.md', 'A', 'PR #500 about trust_boundaries');
    writeMemory(memDir, 'b.md', 'B', 'PR #500 about trust_boundaries');
    const idx = buildProseResolverIndex(root, memDir);
    try {
      const res = resolveProseBullet('look into PR #500 trust_boundaries', idx, ['opus-implementer']);
      expect(res.kind).toBe('ambiguous');
      if (res.kind === 'ambiguous') {
        const files = res.candidates.map((c: { file: string }) => c.file).sort();
        expect(files).toEqual(['a.md', 'b.md']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('zero-token bullet returns kind=none reason=zero_tokens', () => {
    const { root, idx, agentIds } = setup();
    try {
      const res = resolveProseBullet('continue working on the dashboard refactor today', idx, agentIds);
      expect(res.kind).toBe('none');
      if (res.kind === 'none') expect(res.reason).toBe('zero_tokens');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Jaccard math: short bullet with many memory tokens still scores by union not recall', () => {
    const { root, memDir } = mkTmp('jaccard');
    writeAgent(root, 'opus-implementer');
    // Memory with many tokens — pure recall would inflate the score to 1.0.
    writeMemory(
      memDir,
      'big.md',
      'big memory',
      'PR #10 PR #11 PR #12 PR #13 PR #14 PR #15 trust_boundaries error_handling input_validation',
    );
    writeMemory(memDir, 'small.md', 'small', 'PR #10 trust_boundaries');
    const idx = buildProseResolverIndex(root, memDir);
    try {
      // Bullet has tokens {pr10, trust_boundaries}. Both memories match all bullet tokens.
      // True Jaccard:
      //   big: 2 / (2 + 9 - 2) = 2/9 ≈ 0.222 — below threshold
      //   small: 2 / (2 + 2 - 2) = 2/2 = 1.0
      // Resolver should pick `small` (or report `none` for `big`).
      const res = resolveProseBullet('look at PR #10 trust_boundaries', idx, ['opus-implementer']);
      expect(res.kind).toBe('matched');
      if (res.kind === 'matched') {
        expect(res.backingFile).toBe('small.md');
        expect(res.score).toBeCloseTo(1.0, 5);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
