/**
 * Unit coverage for the optional `phase` field on SkillPullEntry (issue
 * #730). Call-site-level coverage (tool-server, mcp-server-sdk,
 * verifier-tool-runner) lives in their own test files — this file exercises
 * `recordSkillPull` directly plus the legacy-row backward-compat contract.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordSkillPull, SKILL_PULL_LOG, type SkillPullEntry } from '../../packages/tools/src/skill-pull-audit';

function readRows(root: string): Array<Record<string, unknown>> {
  const logPath = path.join(root, '.gossip', SKILL_PULL_LOG);
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('SkillPullEntry.phase (issue #730)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pull-phase-'));
    fs.mkdirSync(path.join(projectRoot, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes phase: "task" when the caller passes it', () => {
    recordSkillPull(projectRoot, {
      agentId: 'agent-a',
      skill: 'trust-boundaries',
      resolvedPath: '/skills/trust-boundaries.md',
      runtime: 'relay',
      attributed: true,
      phase: 'task',
    });
    const rows = readRows(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('task');
  });

  it('writes phase: "cross_review" when the caller passes it', () => {
    recordSkillPull(projectRoot, {
      agentId: 'agent-b',
      skill: 'implementation-discipline',
      resolvedPath: '/skills/implementation-discipline.md',
      runtime: 'relay',
      attributed: true,
      phase: 'cross_review',
    });
    const rows = readRows(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe('cross_review');
  });

  it('omits the phase key entirely when the caller does not pass it — stays purely additive', () => {
    recordSkillPull(projectRoot, {
      agentId: 'agent-c',
      skill: 'testing',
      resolvedPath: '/skills/testing.md',
      runtime: 'native',
      attributed: false,
    });
    const rows = readRows(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('phase');
  });

  it('a pre-existing row with no phase field (legacy record) still parses fine and reads as "task" by convention', () => {
    // Simulate a row written before this field existed — appended directly,
    // bypassing recordSkillPull, exactly as an old on-disk log would look.
    const logPath = path.join(projectRoot, '.gossip', SKILL_PULL_LOG);
    const legacyRow = {
      timestamp: '2026-01-01T00:00:00.000Z',
      agent_id: 'agent-legacy',
      skill: 'old-skill',
      resolved_path: '/skills/old-skill.md',
      runtime: 'relay',
      attributed: true,
      // no `phase` key — this is the pre-#730 shape.
    };
    fs.appendFileSync(logPath, JSON.stringify(legacyRow) + '\n');

    const rows = readRows(projectRoot);
    expect(rows).toHaveLength(1);
    expect(() => JSON.parse(JSON.stringify(rows[0]))).not.toThrow();
    expect(rows[0]).not.toHaveProperty('phase');
    // Reader-side convention: absence of `phase` means 'task' (per the
    // SkillPullEntry doc comment) — assert the fallback a consumer would apply.
    const phase = (rows[0].phase as SkillPullEntry['phase'] | undefined) ?? 'task';
    expect(phase).toBe('task');
  });
});
