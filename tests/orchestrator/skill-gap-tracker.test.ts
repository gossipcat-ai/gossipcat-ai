import { SkillGapTracker, SKILL_FRESHNESS_MS } from '@gossip/orchestrator';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillGapTracker', () => {
  const testDir = join(tmpdir(), `gossip-gap-tracker-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  const skillsDir = join(gossipDir, 'skills');
  const resolutionsPath = join(gossipDir, 'skill-resolutions.json');

  beforeEach(() => {
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeSuggestions(entries: Array<{ skill: string; agent: string; reason: string }>) {
    const lines = entries.map(e =>
      JSON.stringify({ type: 'suggestion', skill: e.skill, reason: e.reason, agent: e.agent, task_context: 'test', timestamp: new Date().toISOString() })
    ).join('\n') + '\n';
    writeFileSync(gapLogPath, lines);
  }

  it('returns empty when gap log does not exist', () => {
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.checkThresholds()).toEqual({ pending: [], count: 0 });
  });

  it('does not reach threshold with 2 suggestions from 1 agent', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('dos_resilience')).toBe(false);
  });

  it('does not reach threshold with 3 suggestions from 1 agent', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('dos_resilience')).toBe(false);
  });

  it('reaches threshold at 3 suggestions from 2 agents', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('dos_resilience')).toBe(true);
  });

  it('checkThresholds returns pending skills without writing files', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    const result = tracker.checkThresholds();
    expect(result.count).toBe(1);
    expect(result.pending).toContain('dos-resilience');
    expect(existsSync(join(skillsDir, 'dos-resilience.md'))).toBe(false);
  });

  it('normalizes skill names in pending list', () => {
    writeSuggestions([
      { skill: 'DoS_Resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos-resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    const result = tracker.checkThresholds();
    expect(result.count).toBe(1);
    expect(result.pending).toEqual(['dos-resilience']);
  });

  it('uses resolutions file instead of JSONL scanning', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    writeFileSync(resolutionsPath, JSON.stringify({ 'dos-resilience': new Date().toISOString() }));
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('dos-resilience')).toBe(false);
    expect(tracker.checkThresholds().count).toBe(0);
  });

  it('migrates existing JSONL resolutions on first run', () => {
    const lines = [
      JSON.stringify({ type: 'suggestion', skill: 'old_skill', reason: 'r', agent: 'a1', task_context: 'c', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'old_skill', reason: 'r', agent: 'a2', task_context: 'c', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'old_skill', reason: 'r', agent: 'a1', task_context: 'c', timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'resolution', skill: 'old_skill', skeleton_path: '.gossip/skills/old-skill.md', triggered_by: 3, timestamp: new Date().toISOString() }),
    ].join('\n') + '\n';
    writeFileSync(gapLogPath, lines);

    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('old-skill')).toBe(false);
    expect(existsSync(resolutionsPath)).toBe(true);
    const resolutions = JSON.parse(readFileSync(resolutionsPath, 'utf-8'));
    expect(resolutions['old-skill']).toBeDefined();
  });

  it('getGapData returns suggestions grouped by skill', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    const data = tracker.getGapData(['dos-resilience']);
    expect(data).toHaveLength(1);
    expect(data[0].skill).toBe('dos-resilience');
    expect(data[0].suggestions).toHaveLength(3);
    expect(data[0].suggestions[0].agent).toBe('agent-1');
  });

  it('recordResolution marks skill as resolved', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isAtThreshold('dos-resilience')).toBe(true);
    tracker.recordResolution('dos-resilience');
    expect(tracker.isAtThreshold('dos-resilience')).toBe(false);
  });

  it('getSuggestionsSince filters by agent and time', () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: 'suggestion', skill: 'a', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now - 10000).toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'b', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'c', reason: 'r', agent: 'agent-2', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
    ].join('\n') + '\n';
    writeFileSync(gapLogPath, lines);

    const tracker = new SkillGapTracker(testDir);
    const results = tracker.getSuggestionsSince('agent-1', now);
    expect(results).toHaveLength(1);
    expect(results[0].skill).toBe('b');
  });

  it('truncateIfNeeded runs during checkThresholds', () => {
    const lines = Array.from({ length: 5001 }, (_, i) =>
      JSON.stringify({ type: 'suggestion', skill: `skill-${i % 100}`, reason: 'r', agent: `a-${i % 3}`, task_context: 'c', timestamp: new Date().toISOString() })
    ).join('\n') + '\n';
    writeFileSync(gapLogPath, lines);

    const tracker = new SkillGapTracker(testDir);
    tracker.checkThresholds();

    const content = readFileSync(gapLogPath, 'utf-8');
    const lineCount = content.trim().split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(1000);
  });
});

// ── isSkillFresh ───────────────────────────────────────────────────────────

describe('SkillGapTracker.isSkillFresh', () => {
  const testDir = join(tmpdir(), `gossip-gap-tracker-fresh-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const AGENT = 'gemini-reviewer';
  const CAT = 'trust_boundaries';

  function makeSkillFile(boundAt: string | null, status = 'pending'): void {
    const skillDir = join(gossipDir, 'agents', AGENT, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const lines: string[] = ['name: trust-boundaries', 'description: test'];
    if (boundAt) lines.push(`bound_at: ${boundAt}`);
    lines.push(`status: ${status}`);
    const content = `---\n${lines.join('\n')}\n---\n\n## Body\n`;
    writeFileSync(join(skillDir, 'trust-boundaries.md'), content);
  }

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // Spec test: isSkillFresh returns false when skill file doesn't exist
  it('returns false when no skill file exists (missing bound_at → not fresh)', () => {
    mkdirSync(gossipDir, { recursive: true });
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(false);
  });

  // Spec test: isSkillFresh returns false when bound_at is absent from frontmatter
  it('returns false when bound_at is absent from frontmatter', () => {
    makeSkillFile(null);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(false);
  });

  // Spec test: skill bound 1h ago → fresh (within 24h window)
  it('returns true when skill was bound 1 hour ago (within 24h window)', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    makeSkillFile(oneHourAgo);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(true);
  });

  // Spec test: skill bound 25h ago → not fresh (outside 24h window)
  it('returns false when skill was bound 25 hours ago (outside 24h window)', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
    makeSkillFile(twentyFiveHoursAgo);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(false);
  });

  it('uses custom withinMs parameter', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1_000).toISOString();
    makeSkillFile(fiveMinutesAgo);
    const tracker = new SkillGapTracker(testDir);
    // 5-minute window: fresh
    expect(tracker.isSkillFresh(AGENT, CAT, 10 * 60 * 1_000)).toBe(true);
    // 1-minute window: not fresh
    expect(tracker.isSkillFresh(AGENT, CAT, 60 * 1_000)).toBe(false);
  });

  it('SKILL_FRESHNESS_MS exported constant equals 24h', () => {
    expect(SKILL_FRESHNESS_MS).toBe(24 * 60 * 60 * 1_000);
  });
});

// ── getSkillGapSuggestions freshness filter (integration) ─────────────────
// Tests that a recently-bound skill is suppressed from suggestions.
// We exercise SkillGapTracker.isSkillFresh indirectly via dispatch-pipeline
// in the dispatch-pipeline tests. Here we test the tracker layer directly.

describe('SkillGapTracker.isSkillFresh — malformed frontmatter', () => {
  const testDir2 = join(tmpdir(), `gossip-gap-tracker-malformed-${Date.now()}`);
  const gossipDir2 = join(testDir2, '.gossip');
  const AGENT = 'gemini-reviewer';
  const CAT = 'trust_boundaries';

  afterEach(() => {
    rmSync(testDir2, { recursive: true, force: true });
  });

  it('returns false for malformed frontmatter (no --- block)', () => {
    const skillDir = join(gossipDir2, 'agents', AGENT, 'skills');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'trust-boundaries.md'), '# No frontmatter here\n');
    const tracker = new SkillGapTracker(testDir2);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(false);
  });

  it('returns false for future bound_at (clock skew guard)', () => {
    const skillDir = join(gossipDir2, 'agents', AGENT, 'skills');
    mkdirSync(skillDir, { recursive: true });
    // bound_at set 1 hour in the FUTURE — ageMs < 0 → not fresh
    const future = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    writeFileSync(
      join(skillDir, 'trust-boundaries.md'),
      `---\nbound_at: ${future}\nstatus: pending\n---\n\n## Body\n`,
    );
    const tracker = new SkillGapTracker(testDir2);
    expect(tracker.isSkillFresh(AGENT, CAT)).toBe(false);
  });
});
