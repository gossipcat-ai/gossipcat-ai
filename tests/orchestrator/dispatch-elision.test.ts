/**
 * Phase 1 tests for server-side prompt elision (Option B).
 * Spec: docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md.
 *
 * Iron rules under test:
 *   1. Strict opt-in — server elides ONLY when prompt_format === 'elided'.
 *      Default 'inline' is byte-equivalent to the pre-PR dispatch path.
 *   2. Item 2 ABSENT under elision — no skeleton, no placeholder. The
 *      orchestrator MUST Read the cited file or fail loudly.
 *   3. On-disk file contains ONLY the agent-facing prompt. relay_token
 *      and task_id orchestration metadata MUST NOT appear.
 *   4. All three dispatch entry points (single / parallel / consensus) honor
 *      the param identically.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import {
  handleDispatchSingle,
  handleDispatchParallel,
  handleDispatchConsensus,
} from '../../apps/cli/src/handlers/dispatch';

const originalCtx = {
  mainAgent: ctx.mainAgent,
  nativeTaskMap: ctx.nativeTaskMap,
  nativeResultMap: ctx.nativeResultMap,
  nativeAgentConfigs: ctx.nativeAgentConfigs,
  pendingConsensusRounds: ctx.pendingConsensusRounds,
  booted: ctx.booted,
  boot: ctx.boot,
  syncWorkersViaKeychain: ctx.syncWorkersViaKeychain,
};

function makeMainAgent(): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'default-task-id' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
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
    projectRoot: process.cwd(),
  };
}

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
  Object.assign(ctx, originalCtx);
}

function findAgentPromptItem(content: Array<{ text: string }>): { text: string } | undefined {
  return content.find(c => c.text.startsWith('AGENT_PROMPT:'));
}

function registerNativeAgent(id: string = 'native-claude') {
  ctx.nativeAgentConfigs.set(id, {
    model: 'claude-sonnet-4-6',
    instructions: 'You are a reviewer.',
    description: 'Native reviewer',
    skills: [],
  });
}

describe('dispatch elision (Option B server-side prompt elision)', () => {
  let workDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'gossip-elision-'));
    mkdirSync(join(workDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(workDir);
    resetCtx();
  });

  afterEach(() => {
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('handleDispatchSingle', () => {
    it('inline (default) preserves the two-item content split with AGENT_PROMPT', async () => {
      registerNativeAgent();
      const result = await handleDispatchSingle('native-claude', 'Audit x');
      expect(result.content).toHaveLength(2);
      const promptItem = findAgentPromptItem(result.content);
      expect(promptItem).toBeDefined();
      expect(promptItem!.text).toContain('--- FINDING TAG SCHEMA ---');
      // No on-disk file should have been written.
      expect(existsSync(join(workDir, '.gossip', 'dispatch-prompts'))).toBe(false);
    });

    it('elided omits Item 2 entirely and writes the prompt body to disk', async () => {
      registerNativeAgent();
      const result = await handleDispatchSingle(
        'native-claude', 'Audit x',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      // Item 2 ABSENT — only Item 1.
      expect(result.content).toHaveLength(1);
      expect(findAgentPromptItem(result.content)).toBeUndefined();

      // Item 1 must cite the on-disk path with byte count.
      const item1 = result.content[0].text;
      expect(item1).toMatch(/\[skills section elided: see .+dispatch-prompts.+\.txt, \d+ bytes/);

      // On-disk file must exist and carry the FINDING TAG SCHEMA.
      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      expect(existsSync(dir)).toBe(true);
      const files = require('fs').readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
      expect(files).toHaveLength(1);
      const body = readFileSync(join(dir, files[0]), 'utf8');
      expect(body).toContain('--- FINDING TAG SCHEMA ---');
    });

    it('elided on-disk file contains NO relay_token or task_id orchestration metadata', async () => {
      registerNativeAgent();
      await handleDispatchSingle(
        'native-claude', 'Audit x',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      const files = require('fs').readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
      const body = readFileSync(join(dir, files[0]), 'utf8');
      // relay_token MUST stay in Item 1 only (spec §5 two-item invariant).
      expect(body).not.toMatch(/relay_token/i);
      // The literal phrase REQUIRED_NEXT_ACTION belongs to orchestration framing.
      expect(body).not.toContain('REQUIRED_NEXT_ACTION');
      // The on-disk file is the PROMPT BODY — not the orchestrator banner. It
      // should NOT carry the AGENT_PROMPT: tag prefix used in the inline path.
      expect(body.startsWith('AGENT_PROMPT:')).toBe(false);
    });

    it('elided persists promptPath on the nativeTaskMap entry for crash recovery', async () => {
      registerNativeAgent();
      const _result = await handleDispatchSingle(
        'native-claude', 'Audit x',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      void _result;
      const entries = [...ctx.nativeTaskMap.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0].promptPath).toBeDefined();
      expect(entries[0].promptPath).toMatch(/dispatch-prompts.+\.txt$/);
    });

    it('crash-recovery integration: restoreNativeTaskMap prunes orphan prompt files but preserves tracked tasks', async () => {
      // Arrange — one elided dispatch creates a tracked prompt file.
      registerNativeAgent();
      await handleDispatchSingle(
        'native-claude', 'Audit x',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      const trackedIds = [...ctx.nativeTaskMap.keys()];
      expect(trackedIds).toHaveLength(1);
      const trackedId = trackedIds[0];

      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      const trackedPath = join(dir, `${trackedId}.txt`);
      expect(existsSync(trackedPath)).toBe(true);

      // Simulate a previous-session abandonment: an extra prompt file on disk
      // whose taskId is not present in the restored nativeTaskMap.
      const { writeFileSync } = require('fs');
      const orphanPath = join(dir, 'orphan-from-crash.txt');
      writeFileSync(orphanPath, 'stranded body from a crashed prior session', 'utf8');
      expect(existsSync(orphanPath)).toBe(true);

      // Act — simulate /mcp boot. restoreNativeTaskMap reads (absent)
      // native-tasks.json and then calls pruneOrphanDispatchPrompts with the
      // known set derived from ctx.nativeTaskMap.keys() (= {trackedId}).
      const { restoreNativeTaskMap } = require('../../apps/cli/src/handlers/native-tasks');
      // Wire projectRoot on mainAgent so the dispatch-prompts dir resolves under workDir.
      ctx.mainAgent.projectRoot = workDir;
      restoreNativeTaskMap(workDir);

      // Assert — orphan gone, tracked file survives.
      expect(existsSync(orphanPath)).toBe(false);
      expect(existsSync(trackedPath)).toBe(true);
    });
  });

  describe('handleDispatchParallel', () => {
    it('inline (default) emits one AGENT_PROMPT item per native task', async () => {
      registerNativeAgent('native-a');
      registerNativeAgent('native-b');
      const result = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'X' },
          { agent_id: 'native-b', task: 'Y' },
        ],
        false,
      );
      const promptItems = result.content.filter((c: any) => c.text.startsWith('AGENT_PROMPT:'));
      expect(promptItems).toHaveLength(2);
    });

    it('elided emits ZERO AGENT_PROMPT items and writes one file per task', async () => {
      registerNativeAgent('native-a');
      registerNativeAgent('native-b');
      const result = await handleDispatchParallel(
        [
          { agent_id: 'native-a', task: 'X' },
          { agent_id: 'native-b', task: 'Y' },
        ],
        false,
        undefined,
        'elided',
      );
      const promptItems = result.content.filter((c: any) => c.text.startsWith('AGENT_PROMPT:'));
      expect(promptItems).toHaveLength(0);

      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      const files = require('fs').readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
      expect(files).toHaveLength(2);
    });

    it('phase-2 read-path: marker in Item 1 cites a readable file whose content round-trips', async () => {
      // Arrange — single agent so there is exactly one marker to parse.
      registerNativeAgent('native-a');
      const taskDescription = 'Phase-2 lifecycle read-path test task';

      // Act — dispatch with elision.
      const result = await handleDispatchParallel(
        [{ agent_id: 'native-a', task: taskDescription }],
        false,
        undefined,
        'elided',
      );

      // Item 2 must be absent.
      const promptItems = result.content.filter((c: any) => c.text.startsWith('AGENT_PROMPT:'));
      expect(promptItems).toHaveLength(0);

      // Item 1 must contain the marker with an absolute path and byte count.
      const item1 = result.content.find((c: any) =>
        c.text.includes('[skills section elided: see ')
      );
      expect(item1).toBeDefined();
      const markerMatch = item1!.text.match(
        /\[skills section elided: see (.+\.txt), (\d+) bytes/
      );
      expect(markerMatch).not.toBeNull();

      const promptPath = markerMatch![1];
      const markerBytes = parseInt(markerMatch![2], 10);

      // Assert — file is readable and round-trips.
      const body = readFileSync(promptPath, 'utf8');

      // Body must contain the FINDING TAG SCHEMA block injected by assemblePrompt.
      expect(body).toContain('--- FINDING TAG SCHEMA ---');

      // Body must contain the task description.
      expect(body).toContain(taskDescription);

      // relay_token and task_id orchestration metadata MUST NOT appear in the body.
      expect(body).not.toMatch(/relay_token/i);
      expect(body).not.toMatch(/\btask_id\b/);

      // Byte-length must match the marker's advertised size.
      const actualBytes = Buffer.byteLength(body, 'utf8');
      expect(actualBytes).toBe(markerBytes);
    });
  });

  describe('handleDispatchConsensus (Phase 1 cross-review)', () => {
    it('inline (default) emits AGENT_PROMPT items embedding the CONSENSUS OUTPUT FORMAT', async () => {
      registerNativeAgent();
      const result = await handleDispatchConsensus([
        { agent_id: 'native-claude', task: 'Audit' },
      ]);
      const promptItem = findAgentPromptItem(result.content);
      expect(promptItem).toBeDefined();
      expect(promptItem!.text).toContain('--- CONSENSUS OUTPUT FORMAT');
    });

    it('elided omits AGENT_PROMPT items and writes one file per consensus participant', async () => {
      registerNativeAgent('native-a');
      registerNativeAgent('native-b');
      const result = await handleDispatchConsensus(
        [
          { agent_id: 'native-a', task: 'Audit X' },
          { agent_id: 'native-b', task: 'Audit Y' },
        ],
        undefined,
        undefined,
        'elided',
      );
      const promptItems = result.content.filter((c: any) => c.text.startsWith('AGENT_PROMPT:'));
      expect(promptItems).toHaveLength(0);
      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      const files = require('fs').readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
      expect(files).toHaveLength(2);
      // Both files must carry the consensus framing — proves agentPrompt was
      // actually written, not an empty placeholder.
      for (const f of files) {
        const body = readFileSync(join(dir, f), 'utf8');
        expect(body).toContain('--- CONSENSUS OUTPUT FORMAT');
      }
    });
  });
});
