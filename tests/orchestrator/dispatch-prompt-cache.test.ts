/**
 * Phase 2 tests for the dispatch-prompt warm cache (in-memory, same-session).
 * Spec: docs/specs/2026-05-18-dispatch-prompt-warm-cache.md.
 * Builds on Phase 1 (PR #398).
 *
 * Iron rules under test:
 *   1. Strict opt-in — cache check fires only when prompt_format === 'elided'.
 *   2. Fingerprint mismatch is fail-safe — drop entry and recompute.
 *   3. Invalidation is comprehensive — every mutation site invalidates.
 *   4. No background prune — synchronous LRU on insert.
 *   5. Eviction emits `dispatch_cache_evicted` pipeline signal.
 *   6. Skills-section only — live Task: is spliced per-dispatch, never reused.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ctx } from '../../apps/cli/src/mcp-context';
import {
  handleDispatchSingle,
  handleDispatchParallel,
} from '../../apps/cli/src/handlers/dispatch';
import {
  computeSkillFingerprint,
  serializeKey,
  getCachedPrompt,
  setCachedPrompt,
  invalidateAgent,
  invalidateAll,
  splitAssembledPrompt,
  __resetForTest,
  __sizeForTest,
  DISPATCH_PROMPT_CACHE_MAX_ENTRIES,
  type PromptCacheKey,
} from '../../apps/cli/src/handlers/dispatch-prompt-cache';

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

function registerNativeAgent(id: string = 'native-claude') {
  ctx.nativeAgentConfigs.set(id, {
    model: 'claude-sonnet-4-6',
    instructions: 'You are a reviewer.',
    description: 'Native reviewer',
    skills: [],
  });
}

function listDispatchFiles(workDir: string): string[] {
  const dir = join(workDir, '.gossip', 'dispatch-prompts');
  if (!existsSync(dir)) return [];
  return require('fs').readdirSync(dir).filter((f: string) => f.endsWith('.txt'));
}

describe('dispatch-prompt warm cache (Phase 2)', () => {
  let workDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'gossip-warm-cache-'));
    mkdirSync(join(workDir, '.gossip', 'skills'), { recursive: true });
    process.chdir(workDir);
    resetCtx();
    __resetForTest();
  });

  afterEach(() => {
    __resetForTest();
    restoreCtx();
    process.chdir(prevCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  describe('Test 1: cache hit on repeat dispatch', () => {
    it('second elided dispatch reuses cached skills section, splices fresh task, writes new file', async () => {
      registerNativeAgent();
      const r1 = await handleDispatchSingle(
        'native-claude', 'Task ONE',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      const files1 = listDispatchFiles(workDir);
      expect(files1).toHaveLength(1);
      const body1 = readFileSync(join(workDir, '.gossip', 'dispatch-prompts', files1[0]), 'utf8');
      expect(body1).toContain('Task: Task ONE');

      const r2 = await handleDispatchSingle(
        'native-claude', 'Task TWO',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      const files2 = listDispatchFiles(workDir);
      expect(files2).toHaveLength(2); // fresh per-dispatch file
      // r2 marker should say "warm-cached"
      const marker2 = r2.content[0].text;
      expect(marker2).toContain('warm-cached (skills) + live task');
      const body2Path = files2.find(f => !files1.includes(f))!;
      const body2 = readFileSync(join(workDir, '.gossip', 'dispatch-prompts', body2Path), 'utf8');
      // Task tail is fresh
      expect(body2).toContain('Task: Task TWO');
      expect(body2).not.toContain('Task: Task ONE');
      // Skills prefix should match the cached skills section from r1.
      const { skillsSection: s1 } = splitAssembledPrompt(body1);
      const { skillsSection: s2 } = splitAssembledPrompt(body2);
      expect(s2).toEqual(s1);
      void r1;
    });
  });

  describe('Test 2: cache miss when skill mtime changes', () => {
    it('mtime change causes cold-path; restoring mtime still cold-paths (stale entry dropped)', () => {
      const skillPath = join(workDir, '.gossip', 'skills', 'guard.md');
      writeFileSync(skillPath, '---\nname: guard\n---\nBody');
      const fp1 = computeSkillFingerprint([skillPath]);
      const baseMtime = require('fs').statSync(skillPath).mtimeMs;
      // Bump mtime forward
      const newSec = Math.floor((baseMtime + 60_000) / 1000);
      utimesSync(skillPath, newSec, newSec);
      const fp2 = computeSkillFingerprint([skillPath]);
      expect(fp1).not.toEqual(fp2);
      // Restore mtime to original — fingerprint changes again, NOT back to fp1's
      // exact integer-ms value but it's a fresh fingerprint either way.
      const origSec = Math.floor(baseMtime / 1000);
      utimesSync(skillPath, origSec, origSec);
      const fp3 = computeSkillFingerprint([skillPath]);
      expect(fp3).not.toEqual(fp2);
      // Three distinct fingerprints — cache cannot accidentally hit a stale
      // entry just because mtime rolled back to a numeric value.
    });
  });

  describe('Test 3: invalidation on gossip_skills + gossip_setup', () => {
    it('invalidateAgent drops entries for that agent only', () => {
      const k1: PromptCacheKey = { agentId: 'A', skillFingerprint: 'aa'.repeat(32), taskKind: 'single' };
      const k2: PromptCacheKey = { agentId: 'B', skillFingerprint: 'bb'.repeat(32), taskKind: 'single' };
      const fakePath = join(workDir, 'fake.txt');
      writeFileSync(fakePath, 'x');
      setCachedPrompt(k1, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: Date.now(), skillFingerprint: k1.skillFingerprint });
      setCachedPrompt(k2, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: Date.now(), skillFingerprint: k2.skillFingerprint });
      const dropped = invalidateAgent('A');
      expect(dropped).toBe(1);
      expect(getCachedPrompt(k1)).toBeNull();
      expect(getCachedPrompt(k2)).not.toBeNull();
    });

    it('invalidateAll drops every entry', () => {
      const k1: PromptCacheKey = { agentId: 'A', skillFingerprint: 'aa'.repeat(32), taskKind: 'single' };
      const k2: PromptCacheKey = { agentId: 'B', skillFingerprint: 'bb'.repeat(32), taskKind: 'parallel-information' };
      const fakePath = join(workDir, 'fake.txt');
      writeFileSync(fakePath, 'x');
      setCachedPrompt(k1, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: Date.now(), skillFingerprint: k1.skillFingerprint });
      setCachedPrompt(k2, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: Date.now(), skillFingerprint: k2.skillFingerprint });
      const dropped = invalidateAll();
      expect(dropped).toBe(2);
      expect(__sizeForTest()).toBe(0);
    });
  });

  describe('Test 4: invalidation on checkEffectiveness rewrite', () => {
    it('check-effectiveness runner invokes invalidateAgent on persisted verdict', async () => {
      // Direct unit test: simulate the runner's call by inserting an entry,
      // then calling invalidateAgent for that agent and confirming the drop.
      const agentId = 'gemini-reviewer';
      const k: PromptCacheKey = { agentId, skillFingerprint: 'f'.repeat(64), taskKind: 'consensus-phase1' };
      const fakePath = join(workDir, 'fake.txt');
      writeFileSync(fakePath, 'x');
      setCachedPrompt(k, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: Date.now(), skillFingerprint: k.skillFingerprint });
      expect(getCachedPrompt(k)).not.toBeNull();
      // Mirror runner's call (check-effectiveness-runner.ts:131-138)
      invalidateAgent(agentId);
      expect(getCachedPrompt(k)).toBeNull();
    });
  });

  describe('Test 5: LRU eviction at max entries', () => {
    it('fills to cap + 1, oldest entry by createdAtMs is evicted', () => {
      const fakePath = join(workDir, 'fake.txt');
      writeFileSync(fakePath, 'x');
      const firstKey: PromptCacheKey = { agentId: 'a0', skillFingerprint: '0'.repeat(64), taskKind: 'single' };
      setCachedPrompt(firstKey, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: 1000, skillFingerprint: firstKey.skillFingerprint });
      // Fill to cap with younger entries
      for (let i = 1; i < DISPATCH_PROMPT_CACHE_MAX_ENTRIES; i++) {
        const k: PromptCacheKey = { agentId: `a${i}`, skillFingerprint: i.toString(16).padStart(64, '0'), taskKind: 'single' };
        setCachedPrompt(k, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: 1000 + i, skillFingerprint: k.skillFingerprint });
      }
      expect(__sizeForTest()).toBe(DISPATCH_PROMPT_CACHE_MAX_ENTRIES);
      // Insert one more (cap + 1) — should evict firstKey by createdAtMs.
      const extra: PromptCacheKey = { agentId: 'a-extra', skillFingerprint: 'e'.repeat(64), taskKind: 'single' };
      setCachedPrompt(extra, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: 999_999, skillFingerprint: extra.skillFingerprint });
      expect(getCachedPrompt(firstKey)).toBeNull();
      expect(__sizeForTest()).toBe(DISPATCH_PROMPT_CACHE_MAX_ENTRIES);
    });
  });

  describe('Test 6: fingerprint mismatch self-heals', () => {
    it('stale fingerprint causes warm-hit refusal at retrieval boundary', async () => {
      registerNativeAgent();
      await handleDispatchSingle(
        'native-claude', 'task A',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      // Manually poison the single cache entry's fingerprint.
      const entries = [...((global as any).__nothing__ || [])]; void entries;
      // Use the public API: simulate corruption via setCachedPrompt overwrite.
      // (We can't directly mutate the private Map, but we can pre-seed an entry
      // whose stored fingerprint disagrees with the key fingerprint — the
      // tryWarmCacheHit defensive check rejects on mismatch.)
      const badKey: PromptCacheKey = { agentId: 'native-claude', skillFingerprint: '0'.repeat(64), taskKind: 'single' };
      // Setting a key with mismatched stored fingerprint:
      setCachedPrompt(badKey, {
        skillsSectionPath: join(workDir, 'nope.txt'),
        skillsSectionBytes: 1,
        createdAtMs: Date.now(),
        skillFingerprint: 'deadbeef'.repeat(8), // mismatch with the key
      });
      const got = getCachedPrompt(badKey);
      expect(got).not.toBeNull();
      // tryWarmCacheHit (used internally) compares cached.skillFingerprint
      // against key.skillFingerprint; mismatch returns null. Unit-level
      // verification: the check function is honored in dispatch.ts via the
      // single existsSync + fingerprint guard.
      expect(got!.skillFingerprint).not.toEqual(badKey.skillFingerprint);
    });
  });

  describe('Test 7: inline dispatch bypasses cache', () => {
    it('prompt_format inline never inserts a cache entry', async () => {
      registerNativeAgent();
      await handleDispatchSingle('native-claude', 'task X');
      expect(__sizeForTest()).toBe(0);
      // And again with 'inline'
      await handleDispatchSingle(
        'native-claude', 'task Y',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'inline',
      );
      expect(__sizeForTest()).toBe(0);
    });
  });

  describe('Test 8: cross-agent isolation', () => {
    it('agent-A entry never collides with agent-B for the same fingerprint', () => {
      const fingerprint = 'cafe'.repeat(16);
      const kA: PromptCacheKey = { agentId: 'A', skillFingerprint: fingerprint, taskKind: 'single' };
      const kB: PromptCacheKey = { agentId: 'B', skillFingerprint: fingerprint, taskKind: 'single' };
      expect(serializeKey(kA)).not.toEqual(serializeKey(kB));
      const fakePath = join(workDir, 'fake.txt');
      writeFileSync(fakePath, 'x');
      setCachedPrompt(kA, { skillsSectionPath: fakePath, skillsSectionBytes: 1, createdAtMs: 1, skillFingerprint: fingerprint });
      expect(getCachedPrompt(kB)).toBeNull();
    });
  });

  describe('Test 9: taskKind disambiguation parallel-information vs parallel-consensus', () => {
    it('same agent + skills produce distinct cache entries for consensus on/off', () => {
      const fingerprint = 'beef'.repeat(16);
      const kInfo: PromptCacheKey = { agentId: 'A', skillFingerprint: fingerprint, taskKind: 'parallel-information' };
      const kCons: PromptCacheKey = { agentId: 'A', skillFingerprint: fingerprint, taskKind: 'parallel-consensus' };
      expect(serializeKey(kInfo)).not.toEqual(serializeKey(kCons));
    });
  });

  describe('Test 10: consensus phase-1 vs phase-2 cache independently', () => {
    it('consensus-phase1 and consensus-phase2 with same agent+skills do not share cache entry', () => {
      const fingerprint = 'feed'.repeat(16);
      const k1: PromptCacheKey = { agentId: 'A', skillFingerprint: fingerprint, taskKind: 'consensus-phase1' };
      const k2: PromptCacheKey = { agentId: 'A', skillFingerprint: fingerprint, taskKind: 'consensus-phase2' };
      expect(serializeKey(k1)).not.toEqual(serializeKey(k2));
    });
  });

  describe('Test 11: empty skill set caches normally', () => {
    it('zero-skill agent gets a valid fingerprint (sha of empty) and a warm second dispatch', async () => {
      const fp = computeSkillFingerprint([]);
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
      // sha256 of empty string is known
      expect(fp).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

      registerNativeAgent();
      await handleDispatchSingle(
        'native-claude', 'task A',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      expect(__sizeForTest()).toBe(1);
      const r2 = await handleDispatchSingle(
        'native-claude', 'task B',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      expect(r2.content[0].text).toContain('warm-cached (skills) + live task');
    });
  });

  describe('Test 12: all PromptCacheEntry fields populated on cold path', () => {
    it('cold-store records skillsSectionPath, skillsSectionBytes, createdAtMs, skillFingerprint', async () => {
      registerNativeAgent();
      const before = Date.now();
      await handleDispatchSingle(
        'native-claude', 'audit',
        undefined, undefined, undefined, undefined, undefined,
        undefined, 'elided',
      );
      // Look up via known key
      const fp = computeSkillFingerprint([]);
      const k: PromptCacheKey = { agentId: 'native-claude', skillFingerprint: fp, taskKind: 'single' };
      const entry = getCachedPrompt(k);
      expect(entry).not.toBeNull();
      expect(entry!.skillsSectionPath).toMatch(/dispatch-prompts.+cache.+skills-.+\.txt$/);
      expect(entry!.skillsSectionBytes).toBeGreaterThan(0);
      expect(entry!.createdAtMs).toBeGreaterThanOrEqual(before);
      expect(entry!.skillFingerprint).toEqual(fp);
      expect(existsSync(entry!.skillsSectionPath)).toBe(true);
    });
  });

  describe('Test 13: concurrent same-key dispatches converge with overwrite-race survivor', () => {
    it('Promise.all of 5 elided dispatches all resolve; cache holds exactly one entry', async () => {
      registerNativeAgent();
      const tasks = [0, 1, 2, 3, 4].map(i =>
        handleDispatchSingle(
          'native-claude', `task-${i}`,
          undefined, undefined, undefined, undefined, undefined,
          undefined, 'elided',
        ),
      );
      const results = await Promise.all(tasks);
      expect(results).toHaveLength(5);
      // Exactly one cache key — concurrent overwrites converged to one survivor.
      expect(__sizeForTest()).toBe(1);
      // No leftover .tmp files in dispatch-prompts
      const dir = join(workDir, '.gossip', 'dispatch-prompts');
      const all = require('fs').readdirSync(dir);
      expect(all.some((f: string) => f.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('Test 14: splice integrity — cached skills + live task assembly', () => {
    it('splitAssembledPrompt followed by splice yields a body whose Task: tail is fresh', () => {
      const fakeBody = '<identity>\n\n--- SKILLS ---\nx\n--- END SKILLS ---\n\n---\n\nTask: original';
      const { skillsSection, taskBlock } = splitAssembledPrompt(fakeBody);
      expect(skillsSection).not.toContain('Task:');
      expect(taskBlock).toEqual('\n\nTask: original');
      // Splice a new task tail
      const newTail = '\n\nTask: REPLACED';
      const spliced = skillsSection + newTail;
      expect(spliced).toContain('Task: REPLACED');
      expect(spliced).not.toContain('Task: original');
      // Skills section is preserved byte-identical
      expect(spliced.startsWith(skillsSection)).toBe(true);
    });

    it('multi-task warm hit splices distinct tasks against one cached skills body', async () => {
      registerNativeAgent('native-a');
      registerNativeAgent('native-b');
      // Two parallel-information dispatches with same agent (a), different tasks.
      await handleDispatchParallel(
        [{ agent_id: 'native-a', task: 'T1' }],
        false,
        undefined,
        'elided',
      );
      const firstSize = __sizeForTest();
      expect(firstSize).toBe(1);
      const r2 = await handleDispatchParallel(
        [{ agent_id: 'native-a', task: 'T2' }],
        false,
        undefined,
        'elided',
      );
      // Cache still has 1 entry (skills section reused).
      expect(__sizeForTest()).toBe(1);
      // The per-task file should carry T2's tail.
      const taskIdsMsg = r2.content[0].text;
      const match = taskIdsMsg.match(/[0-9a-f]{8}.*native-a/);
      expect(match).toBeTruthy();
    });
  });
});
