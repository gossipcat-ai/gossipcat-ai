import { SkillGapTracker } from '@gossip/orchestrator';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillGapTracker', () => {
  const testDir = join(tmpdir(), `gossip-gap-tracker-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  const skillsDir = join(gossipDir, 'skills');

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
    expect(tracker.getPendingSkills()).toEqual([]);
  });

  it('does not trigger skeleton below threshold (2 suggestions, 1 agent)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
  });

  it('does not trigger skeleton below threshold (3 suggestions, 1 agent)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
  });

  it('triggers skeleton at threshold (3 suggestions, 2 agents)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(true);
  });

  it('generates skeleton file with correct template', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    const result = tracker.generateSkeleton('dos_resilience');

    expect(result.generated).toBe(true);
    expect(result.path).toBe(join(skillsDir, 'dos-resilience.md'));
    expect(existsSync(result.path!)).toBe(true);

    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('dos_resilience');
    expect(content).toContain('REVIEW AND EDIT BEFORE ASSIGNING');
    expect(content).toContain('no maxPayload');
    expect(content).toContain('no rate limiting');
  });

  it('appends resolution entry after generating skeleton', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    tracker.generateSkeleton('dos_resilience');

    const tracker2 = new SkillGapTracker(testDir);
    expect(tracker2.shouldGenerate('dos_resilience')).toBe(false);
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
});
