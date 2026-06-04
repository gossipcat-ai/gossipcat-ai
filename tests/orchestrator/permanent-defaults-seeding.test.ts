import {
  SkillIndex,
  seedPermanentDefaults,
  IMPLEMENTER_PERMANENT_DEFAULTS,
} from '@gossip/orchestrator';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('seedPermanentDefaults', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `gossip-permanent-defaults-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // (a) REGRESSION GUARD — a constant typo in the boot-path source is caught.
  it('IMPLEMENTER_PERMANENT_DEFAULTS contains implementation-discipline', () => {
    expect(IMPLEMENTER_PERMANENT_DEFAULTS).toContain('implementation-discipline');
  });

  describe('suffix routing', () => {
    let index: SkillIndex;

    beforeEach(() => {
      index = new SkillIndex(testDir);
      seedPermanentDefaults(index, ['x-implementer', 'y-reviewer', 'z-researcher', 'plain']);
    });

    // (b) implementer gets implementer defaults + global
    it('binds implementer + global defaults to an -implementer agent', () => {
      const skills = index.getEnabledSkills('x-implementer');
      expect(skills).toContain('verify-the-premise');
      expect(skills).toContain('implementation-discipline');
      expect(skills).toContain('memory-retrieval');
    });

    // (c) reviewer gets researcher/reviewer defaults + global, NOT implementer
    it('binds researcher/reviewer + global to a -reviewer agent, not implementer', () => {
      const skills = index.getEnabledSkills('y-reviewer');
      expect(skills).toContain('emit-structured-claims');
      expect(skills).toContain('memory-retrieval');
      expect(skills).not.toContain('implementation-discipline');
    });

    // (d) plain agent gets global-only
    it('binds global-only to an agent with no matching suffix', () => {
      expect(index.getEnabledSkills('plain')).toEqual(['memory-retrieval']);
    });

    // (f) bound implementer slot has permanent mode
    it('binds implementation-discipline with permanent mode', () => {
      expect(index.getSkillMode('x-implementer', 'implementation-discipline')).toBe('permanent');
    });
  });

  // (e) hybrid suffix routing — locks in the ACTUAL boot-path behavior.
  //
  // NOTE: CLAUDE.md / .claude/rules/gossipcat.md claim a hybrid id like
  // `foo-researcher-implementer` inherits BOTH the implementer AND the
  // researcher/reviewer defaults. That is NOT what the boot path does: the
  // suffix filter is `endsWith('-researcher') || endsWith('-reviewer')`, and
  // `foo-researcher-implementer` ends in `-implementer`, so it matches ONLY
  // the implementer filter. This test is a behavior-preserving lock on the
  // EXTRACTED routine — it must mirror the boot path exactly, not the prose.
  // The doc/code discrepancy is reported separately as a finding.
  it('routes a -researcher-implementer hybrid to implementer-only (boot-path behavior)', () => {
    const index = new SkillIndex(testDir);
    const result = seedPermanentDefaults(index, ['foo-researcher-implementer']);
    expect(result.implementer).toEqual(['foo-researcher-implementer']);
    expect(result.researcherReviewer).toEqual([]);
    const skills = index.getEnabledSkills('foo-researcher-implementer');
    expect(skills).toContain('implementation-discipline');
    expect(skills).toContain('memory-retrieval');
    expect(skills).not.toContain('emit-structured-claims');
  });

  // A genuinely both-matching id is unreachable via endsWith (a string has one
  // ending), confirming the disjoint-by-construction nature of the two filters.
  it('confirms implementer and researcher/reviewer filters are mutually exclusive via endsWith', () => {
    const index = new SkillIndex(testDir);
    const result = seedPermanentDefaults(index, [
      'a-implementer',
      'b-reviewer',
      'c-researcher',
    ]);
    // No id appears in more than one suffix group.
    const inImpl = new Set(result.implementer);
    const inRR = new Set(result.researcherReviewer);
    for (const id of inImpl) expect(inRR.has(id)).toBe(false);
  });

  it('ignores empty / non-string agent ids', () => {
    const index = new SkillIndex(testDir);
    const result = seedPermanentDefaults(index, ['', 'a-implementer', undefined as unknown as string]);
    expect(result.global).toEqual(['a-implementer']);
    expect(result.implementer).toEqual(['a-implementer']);
  });
});
