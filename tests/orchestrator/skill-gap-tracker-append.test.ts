import { SkillGapTracker, GapSuggestion } from '@gossip/orchestrator';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const makeDir = () => join(tmpdir(), `gossip-gap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('SkillGapTracker.appendSuggestion', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeDir();
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates skill-gaps.jsonl and appends a suggestion', () => {
    const tracker = new SkillGapTracker(testDir);
    const suggestion: GapSuggestion = {
      type: 'suggestion',
      skill: 'trust-boundaries',
      reason: 'Agent hallucinated about auth flow',
      agent: 'sonnet-reviewer',
      task_context: 'task-123',
      timestamp: new Date().toISOString(),
    };

    tracker.appendSuggestion(suggestion);

    const gapPath = join(testDir, '.gossip', 'skill-gaps.jsonl');
    expect(existsSync(gapPath)).toBe(true);
    const lines = readFileSync(gapPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.skill).toBe('trust-boundaries');
    expect(parsed.agent).toBe('sonnet-reviewer');
  });

  it('appends multiple suggestions', () => {
    const tracker = new SkillGapTracker(testDir);

    for (let i = 0; i < 3; i++) {
      tracker.appendSuggestion({
        type: 'suggestion',
        skill: 'concurrency',
        reason: `Hallucination ${i}`,
        agent: i < 2 ? 'sonnet-reviewer' : 'haiku-researcher',
        task_context: `task-${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const gapPath = join(testDir, '.gossip', 'skill-gaps.jsonl');
    const lines = readFileSync(gapPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('reaches threshold after 3 suggestions from 2 agents', () => {
    const tracker = new SkillGapTracker(testDir);

    tracker.appendSuggestion({ type: 'suggestion', skill: 'concurrency', reason: 'r1', agent: 'sonnet-reviewer', task_context: 't1', timestamp: new Date().toISOString() });
    tracker.appendSuggestion({ type: 'suggestion', skill: 'concurrency', reason: 'r2', agent: 'sonnet-reviewer', task_context: 't2', timestamp: new Date().toISOString() });
    tracker.appendSuggestion({ type: 'suggestion', skill: 'concurrency', reason: 'r3', agent: 'haiku-researcher', task_context: 't3', timestamp: new Date().toISOString() });

    expect(tracker.isAtThreshold('concurrency')).toBe(true);
    const thresholds = tracker.checkThresholds();
    expect(thresholds.pending).toContain('concurrency');
  });
});
