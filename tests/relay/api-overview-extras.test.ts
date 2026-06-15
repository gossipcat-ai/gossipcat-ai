import { overviewHandler } from '../../packages/relay/src/dashboard/api-overview';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-test-overview-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  return root;
}

function emptyCtx() { return { agentConfigs: [], relayConnections: 0, connectedAgentIds: [] }; }

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

describe('overviewHandler — actionableFindings (resolution-aware)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gossip-test-af-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeFindings(lines: object[]): void {
    writeFileSync(
      join(root, '.gossip', 'implementation-findings.jsonl'),
      lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    );
  }

  function writePerfSignals(signals: string[]): void {
    writeFileSync(
      join(root, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify({ type: 'consensus', signal: s, agentId: 'agent-x', consensusId: 'c1', timestamp: new Date().toISOString() })).join('\n') + '\n',
    );
  }

  it('(a) counts open non-insight findings', async () => {
    writeFindings([
      { taskId: 'f1', type: 'finding', status: 'open' },
      { taskId: 'f2', type: 'finding', status: 'open' },
      { taskId: 'f3', type: null, status: 'open' }, // legacy null-type: counts
    ]);
    const data = await overviewHandler(root, emptyCtx());
    expect(data.actionableFindings).toBe(3);
  });

  it('(b) excludes resolved findings (status:resolved)', async () => {
    writeFindings([
      { taskId: 'f1', type: 'finding', status: 'open' },
      { taskId: 'f2', type: 'finding', status: 'resolved' },
      { taskId: 'f3', type: 'finding', status: 'resolved', resolvedBy: 'stale_anchor' },
    ]);
    const data = await overviewHandler(root, emptyCtx());
    expect(data.actionableFindings).toBe(1);
  });

  it('(c) excludes insight-type findings', async () => {
    writeFindings([
      { taskId: 'f1', type: 'insight', status: 'open' },
      { taskId: 'f2', type: 'finding', status: 'open' },
    ]);
    const data = await overviewHandler(root, emptyCtx());
    expect(data.actionableFindings).toBe(1);
  });

  it('(d) does NOT change when disagreement/hallucination_caught/new_finding signals are added', async () => {
    writeFindings([
      { taskId: 'f1', type: 'finding', status: 'open' },
    ]);
    const dataWithoutSignals = await overviewHandler(root, emptyCtx());
    expect(dataWithoutSignals.actionableFindings).toBe(1);

    // Now add a batch of signals that previously pumped actionableFindings
    writePerfSignals(['disagreement', 'disagreement', 'hallucination_caught', 'new_finding', 'new_finding']);
    const dataWithSignals = await overviewHandler(root, emptyCtx());
    expect(dataWithSignals.actionableFindings).toBe(1); // must be unchanged
  });

  it('returns 0 when implementation-findings.jsonl is absent', async () => {
    // No findings file written
    const data = await overviewHandler(root, emptyCtx());
    expect(data.actionableFindings).toBe(0);
  });
});
