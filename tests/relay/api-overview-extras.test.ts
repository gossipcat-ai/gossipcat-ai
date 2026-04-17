import { overviewHandler } from '../../packages/relay/src/dashboard/api-overview';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-overview-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  return root;
}

describe('overviewHandler extras', () => {
  it('skillVerdictSummary counts bucketed statuses across skill files', async () => {
    const root = setupRoot();
    const agentsDir = join(root, '.gossip', 'agents');
    const aliceSkills = join(agentsDir, 'alice', 'skills');
    const bobSkills = join(agentsDir, 'bob', 'skills');
    mkdirSync(aliceSkills, { recursive: true });
    mkdirSync(bobSkills, { recursive: true });

    writeFileSync(join(aliceSkills, 's1.md'), '---\nname: "s1"\nstatus: passed\n---\nbody\n');
    writeFileSync(join(aliceSkills, 's2.md'), '---\nname: "s2"\nstatus: "failed"\n---\nbody\n');
    writeFileSync(join(bobSkills, 's3.md'), '---\nname: "s3"\nstatus: pending\n---\nbody\n');
    writeFileSync(join(bobSkills, 's4.md'), '---\nname: "s4"\nstatus: silent_skill\n---\nbody\n');
    // No-status file should be skipped
    writeFileSync(join(bobSkills, 's5.md'), '---\nname: "s5"\n---\nbody\n');

    const data = await overviewHandler(root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    expect(data.skillVerdictSummary).toBeDefined();
    expect(data.skillVerdictSummary!.passed).toBe(1);
    expect(data.skillVerdictSummary!.failed).toBe(1);
    expect(data.skillVerdictSummary!.pending).toBe(1);
    expect(data.skillVerdictSummary!.silent_skill).toBe(1);
    expect(data.skillVerdictSummary!.insufficient_evidence).toBe(0);
  });

  it('droppedFindingTypeCounts aggregates from recent consensus reports', async () => {
    const root = setupRoot();
    const dir = join(root, '.gossip', 'consensus-reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'r1.json'),
      JSON.stringify({ id: 'r1', droppedFindingsByType: { approval: 2, concern: 1 } }),
    );
    writeFileSync(
      join(dir, 'r2.json'),
      JSON.stringify({ id: 'r2', droppedFindingsByType: { approval: 3 } }),
    );
    writeFileSync(
      join(dir, 'r3.json'),
      JSON.stringify({ id: 'r3' }), // no droppedFindingsByType
    );

    const data = await overviewHandler(root, { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] });
    expect(data.droppedFindingTypeCounts).toBeDefined();
    expect(data.droppedFindingTypeCounts!.approval).toBe(5);
    expect(data.droppedFindingTypeCounts!.concern).toBe(1);
  });
});
