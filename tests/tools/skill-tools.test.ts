import { SkillTools } from '@gossip/tools';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillTools', () => {
  const testDir = join(tmpdir(), `gossip-skill-tools-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  let skillTools: SkillTools;

  beforeEach(() => {
    mkdirSync(gossipDir, { recursive: true });
    skillTools = new SkillTools(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates gap log file and appends suggestion', async () => {
    const result = await skillTools.suggestSkill({
      skill_name: 'dos_resilience',
      reason: 'WebSocket has no maxPayload',
      task_context: 'Reviewing relay server',
    }, 'gemini-reviewer');

    expect(result).toContain('Suggestion noted');
    expect(result).toContain('dos_resilience');
    expect(existsSync(gapLogPath)).toBe(true);

    const lines = readFileSync(gapLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe('suggestion');
    expect(entry.skill).toBe('dos_resilience');
    expect(entry.reason).toBe('WebSocket has no maxPayload');
    expect(entry.agent).toBe('gemini-reviewer');
    expect(entry.timestamp).toBeDefined();
  });

  it('appends multiple suggestions to same file', async () => {
    await skillTools.suggestSkill(
      { skill_name: 'a', reason: 'r1', task_context: 'c1' }, 'agent-1'
    );
    await skillTools.suggestSkill(
      { skill_name: 'b', reason: 'r2', task_context: 'c2' }, 'agent-2'
    );

    const lines = readFileSync(gapLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).skill).toBe('a');
    expect(JSON.parse(lines[1]).skill).toBe('b');
  });

  it('creates .gossip directory if it does not exist', async () => {
    rmSync(gossipDir, { recursive: true, force: true });
    const freshTools = new SkillTools(testDir);

    await freshTools.suggestSkill(
      { skill_name: 'x', reason: 'y', task_context: 'z' }, 'agent-1'
    );
    expect(existsSync(gapLogPath)).toBe(true);
  });

  it('defaults agent to "unknown" when callerId not provided', async () => {
    await skillTools.suggestSkill(
      { skill_name: 'test', reason: 'reason', task_context: 'ctx' }
    );
    const entry = JSON.parse(readFileSync(gapLogPath, 'utf-8').trim());
    expect(entry.agent).toBe('unknown');
  });
});
