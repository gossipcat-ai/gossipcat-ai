import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { ConsensusEngine, ILLMProvider } from '@gossip/orchestrator';

// Tier 2 fabrication-branch coverage for consensus-engine.ts synthesize().
// The Tier 2 broadened pre-filter fires emitFabricationHallucinationIfDetected
// from two branches that had no direct test coverage:
//   - unverified branch (the finding was never confirmed or disputed, peers
//     only marked it "unverified")
//   - fallthrough branch (no cross-review entries touched this finding at all)
// Plus capAutoSeverity — previously exercised by exactly one test across the
// whole suite. We cover critical→medium, low passthrough, and undefined default
// via the Tier 2 fallthrough branch which is the easiest branch to drive
// deterministically from a synthetic input.
//
// See consensus round 38ceed43 and project_consensus_engine_tier2_test_debt.md.

const mockLlm = { generate: async () => ({ text: '', toolCalls: [] }) } as unknown as ILLMProvider;
const mockRegistryGet = () => undefined;

describe('Tier 2 fabrication pre-filter — unverified branch', () => {
  const testDir = resolve(tmpdir(), 'gossip-tier2-unverified-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    // Minimal 5-line file so real citations can be constructed.
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/real-module.ts'),
      [
        'export function real() {',         // line 1
        '  return 42;',                      // line 2
        '}',                                  // line 3
        '',                                   // line 4
        'export const TWO = 2;',             // line 5
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('fires hallucination_caught when unverified finding has fabricated citation + hallucination keyword', async () => {
    const results = [
      {
        id: 'task-a',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="high" title="ghost">\n' +
          'The function at nonexistent-file.ts:99 does not exist and is never defined in the module.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
      {
        id: 'task-b',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '<agent_finding type="finding" severity="low" title="other">\nUnrelated observation about packages/orchestrator/src/real-module.ts:2 returning 42.\n</agent_finding>',
        startedAt: Date.now(),
      },
    ];

    const crossReviewEntries = [
      {
        action: 'unverified' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'The function at nonexistent-file.ts:99 does not exist and is never defined in the module.',
        evidence: 'Could not verify from the snippet given.',
        confidence: 2,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // The Tier 2 pre-filter should re-tag the unverified finding as unique
    // and emit a hallucination_caught signal against the original author.
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(hallucinationSignal).toBeDefined();
    expect(hallucinationSignal!.outcome).toBe('fabricated_citation');

    // Finding should have been moved out of the unverified array.
    expect(report.unverified.find(f => f.finding.includes('nonexistent-file'))).toBeUndefined();
  });

  test('does NOT fire when unverified finding has fabricated citation but no hallucination keyword', async () => {
    const results = [
      {
        id: 'task-a',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="medium" title="stale">\n' +
          'The helper at refactored-away.ts:42 used to handle the error path but has moved.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
      {
        id: 'task-b',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '<agent_finding type="finding" severity="low" title="other">\nSome observation about packages/orchestrator/src/real-module.ts:2.\n</agent_finding>',
        startedAt: Date.now(),
      },
    ];

    const crossReviewEntries = [
      {
        action: 'unverified' as const,
        agentId: 'agent-b',
        peerAgentId: 'agent-a',
        finding: 'The helper at refactored-away.ts:42 used to handle the error path but has moved.',
        evidence: 'I could not find this in the current code but that might be my context.',
        confidence: 2,
      },
    ];

    const report = await engine.synthesize(results, crossReviewEntries);

    // No hallucination signal — fabrication detection requires BOTH fabricated
    // citation AND hallucination keyword. Here the citation is fabricated but
    // the phrasing is neutral.
    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(hallucinationSignal).toBeUndefined();
  });
});

describe('Tier 2 fabrication pre-filter — fallthrough branch', () => {
  const testDir = resolve(tmpdir(), 'gossip-tier2-fallthrough-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/real-module.ts'),
      [
        'export function real() {',
        '  return 42;',
        '}',
        '',
        'export const TWO = 2;',
      ].join('\n'),
    );
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('fires hallucination_caught when fallthrough finding has fabricated citation + keyword', async () => {
    // No cross-review entries at all — finding hits the fallthrough branch.
    const results = [
      {
        id: 'task-a',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="high" title="ghost">\n' +
          'The method at ghost-module.ts:50 is fabricated and no such method exists.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
      {
        id: 'task-b',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '<agent_finding type="finding" severity="low" title="real">\nLook at packages/orchestrator/src/real-module.ts:2 returning 42.\n</agent_finding>',
        startedAt: Date.now(),
      },
    ];

    const report = await engine.synthesize(results, []);

    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(hallucinationSignal).toBeDefined();
    expect(hallucinationSignal!.outcome).toBe('fabricated_citation');
  });

  test('does NOT fire when fallthrough finding has valid citation but hallucination keyword', async () => {
    // Finding references a real file/line; phrasing includes a trigger keyword
    // in a legitimate technical context. AND-gate should prevent false positive.
    const results = [
      {
        id: 'task-a',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="medium" title="observation">\n' +
          'The TWO constant at packages/orchestrator/src/real-module.ts:5 does not exist as a function; only as a value.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
      {
        id: 'task-b',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result: '<agent_finding type="finding" severity="low" title="real">\nNote on packages/orchestrator/src/real-module.ts:1 export shape.\n</agent_finding>',
        startedAt: Date.now(),
      },
    ];

    const report = await engine.synthesize(results, []);

    const hallucinationSignal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(hallucinationSignal).toBeUndefined();
  });
});

describe('capAutoSeverity — clamping via Tier 2 fallthrough branch', () => {
  const testDir = resolve(tmpdir(), 'gossip-tier2-severity-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/real-module.ts'),
      'export const ONE = 1;\n',
    );
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  const makeFabricatedResult = (severityAttr: string) => ({
    id: 'task-a',
    agentId: 'agent-a',
    task: 'review',
    status: 'completed' as const,
    result:
      `<agent_finding type="finding"${severityAttr} title="ghost">\n` +
      'The symbol at fabricated-module.ts:77 does not exist anywhere in the project.\n' +
      '</agent_finding>',
    startedAt: Date.now(),
  });

  const companion = {
    id: 'task-b',
    agentId: 'agent-b',
    task: 'review',
    status: 'completed' as const,
    result: '<agent_finding type="finding" severity="low" title="real">\nReference to packages/orchestrator/src/real-module.ts:1 ONE.\n</agent_finding>',
    startedAt: Date.now(),
  };

  test('critical input is capped to medium', async () => {
    const report = await engine.synthesize(
      [makeFabricatedResult(' severity="critical"'), companion],
      [],
    );
    const signal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('medium');
  });

  test('high input is capped to medium', async () => {
    const report = await engine.synthesize(
      [makeFabricatedResult(' severity="high"'), companion],
      [],
    );
    const signal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('medium');
  });

  test('low input passes through unchanged', async () => {
    const report = await engine.synthesize(
      [makeFabricatedResult(' severity="low"'), companion],
      [],
    );
    const signal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('low');
  });

  test('undefined input defaults to medium', async () => {
    // No severity attribute — parseAgentFindings returns severity: undefined.
    const report = await engine.synthesize(
      [makeFabricatedResult(''), companion],
      [],
    );
    const signal = report.signals.find(
      s => s.signal === 'hallucination_caught' && s.agentId === 'agent-a',
    );
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('medium');
  });
});

describe('authorFindingId — per-agent id carried through synthesis', () => {
  const testDir = resolve(tmpdir(), 'gossip-author-id-' + Date.now());
  let engine: ConsensusEngine;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'packages/orchestrator/src'), { recursive: true });
    writeFileSync(
      resolve(testDir, 'packages/orchestrator/src/real-module.ts'),
      'export const ONE = 1;\nexport const TWO = 2;\n',
    );
  });

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  beforeEach(() => {
    engine = new ConsensusEngine({
      llm: mockLlm,
      registryGet: mockRegistryGet,
      projectRoot: testDir,
    });
  });

  test('ConsensusFinding.authorFindingId is set to the per-agent cross-review id', async () => {
    // Each agent produces two findings. Parse assigns them per-agent IDs
    // `agent-a:f1`, `agent-a:f2`, `agent-b:f1`. After synthesis, each finding
    // in the report should carry its original authorFindingId alongside the
    // global finding.id. This is what signal writeback uses to resolve the
    // 3-part finding_id format (`consensusId:agentId:fN`) back to a report
    // finding.
    const results = [
      {
        id: 'task-a',
        agentId: 'agent-a',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="low" title="first">\n' +
          'First finding cites packages/orchestrator/src/real-module.ts:1 ONE.\n' +
          '</agent_finding>\n' +
          '<agent_finding type="finding" severity="low" title="second">\n' +
          'Second finding cites packages/orchestrator/src/real-module.ts:2 TWO.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
      {
        id: 'task-b',
        agentId: 'agent-b',
        task: 'review',
        status: 'completed' as const,
        result:
          '<agent_finding type="finding" severity="low" title="b-first">\n' +
          'Agent-B finding on packages/orchestrator/src/real-module.ts:1 ONE.\n' +
          '</agent_finding>',
        startedAt: Date.now(),
      },
    ];

    const report = await engine.synthesize(results, []);

    // Collect all findings regardless of tag bucket.
    const all = [...report.confirmed, ...report.disputed, ...report.unverified, ...report.unique, ...(report.insights ?? [])];

    const agentAFindings = all.filter(f => f.originalAgentId === 'agent-a');
    const agentBFindings = all.filter(f => f.originalAgentId === 'agent-b');

    // Agent-A contributed 2, agent-B contributed 1 — dedup may merge them
    // (both reference real-module.ts:1) so we assert only on structure.
    expect(agentAFindings.length).toBeGreaterThanOrEqual(1);
    expect(agentBFindings.length).toBeGreaterThanOrEqual(0);

    for (const f of agentAFindings) {
      expect(f.authorFindingId).toBeDefined();
      expect(f.authorFindingId!).toMatch(/^agent-a:f\d+$/);
    }
    for (const f of agentBFindings) {
      expect(f.authorFindingId).toBeDefined();
      expect(f.authorFindingId!).toMatch(/^agent-b:f\d+$/);
    }

    // Global finding.id follows `consensusId:fGlobalN` and is distinct from authorFindingId.
    for (const f of all) {
      if (f.authorFindingId) {
        expect(f.id).not.toBe(f.authorFindingId);
        expect(f.id).toContain(':f');
      }
    }
  });
});
