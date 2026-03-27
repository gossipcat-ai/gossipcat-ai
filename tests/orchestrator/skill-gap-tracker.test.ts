import { SkillGapTracker } from '@gossip/orchestrator';
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
