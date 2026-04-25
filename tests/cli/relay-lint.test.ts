/**
 * Path A relay-lint hardening — tests for handleNativeRelay's
 * `relay_findings_dropped` warning emission.
 *
 * Spec: docs/specs/2026-04-25-relay-lint-hardening.md
 *
 * Detection: when a native task was part of an active consensus round AND the
 * relayed `result` payload carries zero `<agent_finding>` tags, the
 * orchestrator likely paraphrased the agent's verbatim output. The relay path
 * (a) appends a JSON line to .gossip/relay-warnings.jsonl, (b) emits a
 * pipeline-typed `relay_findings_dropped` signal (best-effort), and (c) tags
 * the gossip_relay receipt with a one-line warning.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { handleNativeRelay, taskWasInConsensusRound } from '../../apps/cli/src/handlers/native-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-relay-lint-test-'));
}

function makeMainAgent(projectRoot: string): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'mock' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getPerfReader: jest.fn().mockReturnValue(undefined),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    scopeTracker: { release: jest.fn() },
    projectRoot,
  };
}

const AGENT_ID = 'sonnet-reviewer';
const TASK_ID = 'lint-task-1';
const CONSENSUS_ID = 'cafefeed-deadbeef';
const PROSE_PARAPHRASE = 'HIGH (e955d7d0:sonnet:f1) — recordCreated does not redactSecrets before logging.';
const TAGGED_RESULT =
  '<agent_finding type="finding" severity="HIGH">' +
  '  <cite tag="file">apps/cli/src/foo.ts:42</cite>\n' +
  '  recordCreated does not redactSecrets before logging.\n' +
  '</agent_finding>';

let testDir: string;
let originalCwd: string;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  testDir = makeTmpDir();
  originalCwd = process.cwd();
  process.chdir(testDir);

  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.mainAgent = makeMainAgent(testDir);
  ctx.nativeUtilityConfig = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;

  stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  process.chdir(originalCwd);
  rmSync(testDir, { recursive: true, force: true });
});

function seedConsensusRound(taskId: string, agentId: string): void {
  ctx.pendingConsensusRounds.set(CONSENSUS_ID, {
    consensusId: CONSENSUS_ID,
    allResults: [
      { id: taskId, agentId, status: 'completed', result: '<agent_finding type="finding" severity="HIGH">peer</agent_finding>', task: 't' },
    ],
    relayCrossReviewEntries: [],
    relayCrossReviewSkipped: undefined,
    pendingNativeAgents: new Set([agentId]),
    nativeCrossReviewEntries: [],
    deadline: Date.now() + 60_000,
    createdAt: Date.now(),
    nativePrompts: [],
  });
}

function seedTask(taskId: string, agentId: string): void {
  ctx.nativeTaskMap.set(taskId, {
    agentId,
    task: 'review repo for security',
    startedAt: Date.now() - 1000,
    timeoutMs: 120_000,
  });
}

function readWarnings(): any[] {
  const path = join(testDir, '.gossip', 'relay-warnings.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── taskWasInConsensusRound unit tests ────────────────────────────────────────

describe('taskWasInConsensusRound', () => {
  it('returns true when task_id appears in any round.allResults', () => {
    const rounds = new Map();
    rounds.set('r1', {
      allResults: [{ id: 'tA', agentId: 'a' }],
      pendingNativeAgents: new Set(),
      nativeCrossReviewEntries: [],
    });
    expect(taskWasInConsensusRound('tA', undefined, rounds)).toBe(true);
  });

  it('returns true when agentId appears in pendingNativeAgents', () => {
    const rounds = new Map();
    rounds.set('r1', {
      allResults: [],
      pendingNativeAgents: new Set(['agent-x']),
      nativeCrossReviewEntries: [],
    });
    expect(taskWasInConsensusRound('unrelated', 'agent-x', rounds)).toBe(true);
  });

  it('returns false on empty rounds map', () => {
    expect(taskWasInConsensusRound('t', 'a', new Map())).toBe(false);
  });

  it('is defensive — never throws on malformed entries', () => {
    const rounds = new Map();
    rounds.set('r1', { allResults: 'not-an-array' as any });
    expect(() => taskWasInConsensusRound('t', 'a', rounds)).not.toThrow();
  });
});

// ── handleNativeRelay relay-lint integration tests ────────────────────────────

describe('handleNativeRelay — relay-lint Path A', () => {
  it('(a) prose result + consensus dispatch → warning fires', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    // jsonl persisted
    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskId).toBe(TASK_ID);
    expect(warnings[0].agentId).toBe(AGENT_ID);
    expect(warnings[0].reason).toBe('relay_findings_dropped');
    expect(warnings[0].resultLength).toBe(PROSE_PARAPHRASE.length);
    expect(warnings[0].suspectedReason).toBe('orchestrator_paraphrase');
    expect(typeof warnings[0].timestamp).toBe('string');

    // receipt notice
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
    expect(text).toContain('orchestrator may have paraphrased');
  });

  it('(b) tagged result + consensus dispatch → no warning', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, TAGGED_RESULT);

    expect(readWarnings()).toHaveLength(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('relay_findings_dropped');
  });

  it('(c) prose result + non-consensus (solo) dispatch → no warning', async () => {
    seedTask(TASK_ID, AGENT_ID);
    // Intentionally no seedConsensusRound — solo dispatch.

    const res = await handleNativeRelay(TASK_ID, PROSE_PARAPHRASE);

    expect(readWarnings()).toHaveLength(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('relay_findings_dropped');
  });

  it('(d) empty result + consensus dispatch → warning fires', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    const res = await handleNativeRelay(TASK_ID, '');

    const warnings = readWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].resultLength).toBe(0);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('relay_findings_dropped');
  });

  it('does not warn for utility tasks even when result is untagged prose', async () => {
    ctx.nativeTaskMap.set(TASK_ID, {
      agentId: '_utility',
      task: 'cognitive summary',
      startedAt: Date.now() - 500,
      timeoutMs: 120_000,
      utilityType: 'summary',
    });
    // Even if a consensus round somehow listed this taskId, utility tasks are exempt.
    seedConsensusRound(TASK_ID, '_utility');

    await handleNativeRelay(TASK_ID, 'short summary, no tags here');

    expect(readWarnings()).toHaveLength(0);
  });

  it('does not warn on the error path', async () => {
    seedTask(TASK_ID, AGENT_ID);
    seedConsensusRound(TASK_ID, AGENT_ID);

    await handleNativeRelay(TASK_ID, '', 'agent crashed mid-run');

    // Errors carry their own status — paraphrase detection skipped.
    expect(readWarnings()).toHaveLength(0);
  });
});
