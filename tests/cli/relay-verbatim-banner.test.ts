/**
 * Relay verbatim banner — 6 sites assert that dispatch/utility banners
 * contain the VERBATIM qualifier instructing orchestrators not to paraphrase.
 *
 * Spec: docs/specs/2026-05-20-relay-verbatim-contract.md
 * Consensus: edbf8675-87b24107
 * Related: PR #270 (parser-side relay_findings_dropped warning), PR A (this PR)
 *
 * The 6 sites checked:
 *  1. mcp-server-sdk.ts — gossip_skills utility banner
 *  2. mcp-server-sdk.ts — gossip_session_save utility banner
 *  3. mcp-server-sdk.ts — gossip_verify_memory utility banner
 *  4. native-tasks.ts  — cognitive-summary utility
 *  5. native-tasks.ts  — gossip-publish utility
 *  6. dispatch.ts      — PRIMARY dispatch path (handleDispatchSingle)
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import { handleDispatchSingle } from '../../apps/cli/src/handlers/dispatch';

/** The literal phrase every banner must contain. */
const VERBATIM_PHRASE = 'VERBATIM — pass the agent\'s raw output; do NOT paraphrase or summarize, or <agent_finding> tags will be lost';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMainAgent(overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'mock-task-id' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLlm: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSkillGapSuggestions: jest.fn().mockReturnValue([]),
    getSkillIndex: jest.fn().mockReturnValue(null),
    getSessionGossip: jest.fn().mockReturnValue([]),
    getSessionConsensusHistory: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    getChainContext: jest.fn().mockReturnValue(''),
    generateLensesForAgents: jest.fn().mockResolvedValue(new Map()),
    dispatchParallel: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    dispatchParallelWithLenses: jest.fn().mockResolvedValue({ taskIds: [], errors: [] }),
    getTask: jest.fn().mockReturnValue(null),
    scopeTracker: {
      hasOverlap: jest.fn().mockReturnValue({ overlaps: false }),
      register: jest.fn(),
      release: jest.fn(),
    },
    pipeline: null,
    projectRoot: '/tmp/gossip-test-project',
    ...overrides,
  };
}

const savedCtx = {
  mainAgent: ctx.mainAgent,
  relay: ctx.relay,
  workers: ctx.workers,
  keychain: ctx.keychain,
  skillEngine: ctx.skillEngine,
  nativeTaskMap: ctx.nativeTaskMap,
  nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  pendingConsensusRounds: ctx.pendingConsensusRounds,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function resetCtx() {
  ctx.mainAgent = makeMainAgent();
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.nativeAgentConfigs = new Map();
  ctx.pendingConsensusRounds = new Map();
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
  ctx.syncWorkersViaKeychain = jest.fn().mockResolvedValue(undefined) as any;
  (ctx as any).skillEngine = null;
}

function restoreCtx() {
  Object.assign(ctx, savedCtx);
}

// ── Site 6: dispatch.ts PRIMARY dispatch path ─────────────────────────────

describe('relay-verbatim-banner — site 6: handleDispatchSingle (primary dispatch)', () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'gossip-verbatim-dispatch-'));
    process.chdir(tmpDir);
    resetCtx();
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('orchestrator banner contains VERBATIM qualifier after gossip_relay line', async () => {
    ctx.nativeAgentConfigs.set('sonnet-reviewer', {
      model: 'claude-sonnet-4-6',
      instructions: 'You are a reviewer.',
      description: 'Reviewer',
      skills: [],
    });

    const result = await handleDispatchSingle('sonnet-reviewer', 'Audit the codebase');
    const orchestratorText = (result.content[0] as { text: string }).text;

    expect(orchestratorText).toContain('gossip_relay');
    expect(orchestratorText).toContain(VERBATIM_PHRASE);
  });
});

// ── Sites 1-5: banner strings in source ───────────────────────────────────
//
// Sites 1-5 produce banners inside tool-handler closures that require a fully
// booted MCP server context (live config, relay workers, etc). Rather than
// standing up the entire MCP server in unit tests, we assert the VERBATIM
// phrase is present in the compiled source strings directly. This matches the
// relay-lint.test.ts philosophy: validate the contract at the code-string
// level when the runtime wiring is expensive to replicate.

import { readFileSync } from 'fs';
import { resolve } from 'path';

function readSource(relPath: string): string {
  return readFileSync(resolve(__dirname, '../../', relPath), 'utf8');
}

describe('relay-verbatim-banner — site 1: gossip_skills utility banner (mcp-server-sdk.ts)', () => {
  it('banner after gossip_relay(...result: "<full agent output>") contains VERBATIM qualifier', () => {
    const src = readSource('apps/cli/src/mcp-server-sdk.ts');
    // The skills banner has "gossip_relay(task_id: " followed shortly by VERBATIM.
    // Verify both strings coexist in the file and the VERBATIM line follows the relay line.
    const relayIdx = src.indexOf('gossip_relay(task_id: "${taskId}", result: "<full agent output>")\\n` +\n                  `   (VERBATIM');
    expect(relayIdx).toBeGreaterThan(-1);
  });
});

describe('relay-verbatim-banner — site 2: gossip_session_save utility banner (mcp-server-sdk.ts)', () => {
  it('banner after gossip_relay(...result: "<full agent output>") contains VERBATIM qualifier', () => {
    const src = readSource('apps/cli/src/mcp-server-sdk.ts');
    // session_save banner: relay line + VERBATIM + re-call gossip_session_save
    const sessionSaveIdx = src.indexOf('gossip_session_save(notes:');
    expect(sessionSaveIdx).toBeGreaterThan(-1);
    // VERBATIM must appear before the re-call line in the same banner block
    const bannerRegion = src.slice(Math.max(0, sessionSaveIdx - 400), sessionSaveIdx);
    expect(bannerRegion).toContain(VERBATIM_PHRASE);
  });
});

describe('relay-verbatim-banner — site 3: gossip_verify_memory utility banner (mcp-server-sdk.ts)', () => {
  it('banner after gossip_relay(...relay_token, result: "<full agent output>") contains VERBATIM qualifier', () => {
    const src = readSource('apps/cli/src/mcp-server-sdk.ts');
    const verifyIdx = src.indexOf('gossip_verify_memory(memory_path:');
    expect(verifyIdx).toBeGreaterThan(-1);
    const bannerRegion = src.slice(Math.max(0, verifyIdx - 500), verifyIdx);
    expect(bannerRegion).toContain(VERBATIM_PHRASE);
  });
});

describe('relay-verbatim-banner — site 4: cognitive-summary utility (native-tasks.ts)', () => {
  it('banner after gossip_relay(...summaryTaskId) contains VERBATIM qualifier', () => {
    const src = readSource('apps/cli/src/handlers/native-tasks.ts');
    const summaryIdx = src.indexOf('gossip_relay(task_id: "${summaryTaskId}", result: "<full agent output>")');
    expect(summaryIdx).toBeGreaterThan(-1);
    // VERBATIM must appear immediately after (within 300 chars)
    const after = src.slice(summaryIdx, summaryIdx + 300);
    expect(after).toContain(VERBATIM_PHRASE);
  });
});

describe('relay-verbatim-banner — site 5: gossip-publish utility (native-tasks.ts)', () => {
  it('banner after gossip_relay(...gossipTaskId) contains VERBATIM qualifier', () => {
    const src = readSource('apps/cli/src/handlers/native-tasks.ts');
    const publishIdx = src.indexOf('gossip_relay(task_id: "${gossipTaskId}", result: "<full agent output>")');
    expect(publishIdx).toBeGreaterThan(-1);
    const after = src.slice(publishIdx, publishIdx + 300);
    expect(after).toContain(VERBATIM_PHRASE);
  });
});
