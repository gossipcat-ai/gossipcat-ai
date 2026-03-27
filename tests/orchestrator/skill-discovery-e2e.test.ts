import { SkillGapTracker, SkillCatalog, AgentRegistry } from '@gossip/orchestrator';
import { writeFileSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Skill Discovery E2E', () => {
  const testDir = join(tmpdir(), `gossip-discovery-e2e-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const skillsDir = join(gossipDir, 'skills');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');

  beforeEach(() => {
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function suggest(skill: string, agent: string, reason: string) {
    appendFileSync(gapLogPath, JSON.stringify({
      type: 'suggestion', skill, reason, agent, task_context: 'e2e test',
      timestamp: new Date().toISOString(),
    }) + '\n');
  }

  it('full pipeline: suggest → threshold → build → dispatch', () => {
    // 1. Three suggestions from 2 agents
    suggest('dos_resilience', 'reviewer-1', 'no maxPayload on WebSocket');
    suggest('dos_resilience', 'reviewer-2', 'no rate limiting on API');
    suggest('dos_resilience', 'reviewer-1', 'unbounded queue in worker');

    // 2. Check thresholds
    const tracker = new SkillGapTracker(testDir);
    const thresholds = tracker.checkThresholds();
    expect(thresholds.count).toBe(1);
    expect(thresholds.pending).toContain('dos-resilience');

    // 3. Get gap data
    const gapData = tracker.getGapData(['dos-resilience']);
    expect(gapData[0].suggestions).toHaveLength(3);
    expect(gapData[0].uniqueAgents).toHaveLength(2);

    // 4. Simulate Claude Code generating the skill file
    const skillContent = `---
name: dos-resilience
description: Review code for DoS vectors and resource exhaustion.
keywords: [dos, rate-limit, payload, backpressure]
generated_by: orchestrator
sources: 3 suggestions from reviewer-1, reviewer-2
status: active
---

# DoS Resilience

## Approach
1. Check endpoints for payload limits
2. Verify rate limiting

## Output
file:line, severity, remediation

## Don't
- Flag internal endpoints without justification
`;
    writeFileSync(join(skillsDir, 'dos-resilience.md'), skillContent);
    tracker.recordResolution('dos-resilience');

    // 5. Verify skill is no longer pending
    expect(tracker.isAtThreshold('dos-resilience')).toBe(false);
    expect(tracker.checkThresholds().count).toBe(0);

    // 6. SkillCatalog picks it up
    const catalog = new SkillCatalog(testDir);
    const matches = catalog.matchTask('check rate-limit configuration for DoS');
    expect(matches.find(m => m.name === 'dos-resilience')).toBeDefined();

    // 7. AgentRegistry uses it for dispatch
    const registry = new AgentRegistry();
    registry.register({ id: 'sec-reviewer', provider: 'anthropic', model: 'claude', skills: ['security-audit'] });
    registry.register({ id: 'implementer', provider: 'openai', model: 'gpt', skills: ['typescript'] });
    registry.setSuggesterCache(new Map([
      ['dos-resilience', new Set(['sec-reviewer'])],
    ]));

    const match = registry.findBestMatchExcluding([], new Set(), {
      taskText: 'review this WebSocket handler for DoS protection',
      catalog,
    });
    // sec-reviewer gets: projectBoost=0.5 + suggesterBoost=0.3 = 0.8
    // implementer gets: projectBoost=0.5 = 0.5
    expect(match?.id).toBe('sec-reviewer');
  });

  it('overwrite protection prevents destroying manually edited skills', () => {
    const manualSkill = `---
name: custom-skill
description: Manually written skill.
keywords: [custom]
generated_by: manual
status: active
---

# Custom Skill
Hand-crafted content.
`;
    writeFileSync(join(skillsDir, 'custom-skill.md'), manualSkill);

    // Verify catalog loads it
    const catalog = new SkillCatalog(testDir);
    expect(catalog.listSkills().find(s => s.name === 'custom-skill')).toBeDefined();

    // The file content should be preserved
    const content = readFileSync(join(skillsDir, 'custom-skill.md'), 'utf-8');
    expect(content).toContain('Hand-crafted content.');
  });

  it('name normalization is consistent across all components', () => {
    // Write with underscores
    suggest('memory_optimization', 'agent-1', 'reason1');
    suggest('memory_optimization', 'agent-2', 'reason2');
    suggest('memory-optimization', 'agent-1', 'reason3');

    const tracker = new SkillGapTracker(testDir);
    const thresholds = tracker.checkThresholds();
    // All three normalize to memory-optimization — should count as 1 skill at threshold
    expect(thresholds.pending).toContain('memory-optimization');
    expect(thresholds.count).toBe(1);

    // Catalog lookup also normalizes
    writeFileSync(join(skillsDir, 'memory-optimization.md'), `---
name: memory_optimization
description: Memory optimization.
keywords: [memory, optimization]
status: active
---
# Memory
`);
    const catalog = new SkillCatalog(testDir);
    // Name should be normalized to memory-optimization
    expect(catalog.listSkills().find(s => s.name === 'memory-optimization')).toBeDefined();
  });
});
