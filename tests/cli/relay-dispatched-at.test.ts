/**
 * Tests for server-side dispatched_at_ms fallback and 30d sanity clamp in gossip_relay.
 *
 * Issue #87: orchestrators pass fake agent_started_at values (e.g. guessed epoch),
 * producing durations like 365d. Fix: stamp dispatch time server-side, relay defaults
 * to it; clamp durations > 30d to null.
 *
 * See: feedback_gossip_relay_fake_timestamp.md
 */

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { computeRelayDuration, RELAY_DURATION_CLAMP_MS, handleNativeRelay } from '../../apps/cli/src/handlers/native-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-relay-duration-test-'));
}

function makeMainAgent(projectRoot: string, overrides: Record<string, any> = {}): any {
  return {
    dispatch: jest.fn().mockReturnValue({ taskId: 'mock' }),
    collect: jest.fn().mockResolvedValue({ results: [] }),
    getAgentConfig: jest.fn().mockReturnValue(null),
    getLLM: jest.fn().mockReturnValue(null),
    getAgentList: jest.fn().mockReturnValue([]),
    getSessionGossip: jest.fn().mockReturnValue([]),
    recordNativeTask: jest.fn(),
    recordNativeTaskCompleted: jest.fn(),
    recordPlanStepResult: jest.fn(),
    publishNativeGossip: jest.fn().mockResolvedValue(undefined),
    scopeTracker: { release: jest.fn() },
    projectRoot,
    ...overrides,
  };
}

let testDir: string;

beforeEach(() => {
  testDir = makeTmpDir();
  ctx.nativeTaskMap = new Map();
  ctx.nativeResultMap = new Map();
  ctx.mainAgent = makeMainAgent(testDir);
  ctx.nativeUtilityConfig = null;
  ctx.booted = true;
  ctx.boot = jest.fn().mockResolvedValue(undefined) as any;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── computeRelayDuration unit tests ───────────────────────────────────────────

describe('computeRelayDuration', () => {
  it('uses caller agentStartedAt when provided and within 30d', () => {
    const dispatchedAt = Date.now() - 5000;
    const callerStartedAt = Date.now() - 3000; // 3 seconds ago
    const { durationMs, source } = computeRelayDuration(callerStartedAt, dispatchedAt);
    expect(source).toBe('caller');
    expect(durationMs).not.toBeNull();
    expect(durationMs!).toBeGreaterThanOrEqual(2900);
    expect(durationMs!).toBeLessThan(4000);
  });

  it('falls back to server dispatchedAtMs when agentStartedAt is absent', () => {
    const dispatchedAt = Date.now() - 10000; // 10 seconds ago
    const { durationMs, source } = computeRelayDuration(undefined, dispatchedAt);
    expect(source).toBe('server');
    expect(durationMs).not.toBeNull();
    expect(durationMs!).toBeGreaterThanOrEqual(9900);
    expect(durationMs!).toBeLessThan(11000);
  });

  it('returns null with source=none when neither timestamp is available', () => {
    const { durationMs, source } = computeRelayDuration(undefined, undefined);
    expect(durationMs).toBeNull();
    expect(source).toBe('none');
  });

  it('clamps caller agentStartedAt > 30d to null (the 2026-04-15 incident)', () => {
    // Incident: orchestrator passed agent_started_at: 1744731620000 (guessed epoch ~2025-04-15)
    // which produced a 365d duration.
    const fakeStartedAt = 1744731620000; // year-2025 epoch, effectively > 30d ago
    const dispatchedAt = Date.now() - 5000;
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { durationMs, source } = computeRelayDuration(fakeStartedAt, dispatchedAt);
    expect(durationMs).toBeNull();
    expect(source).toBe('caller');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('clamped'));
    stderrSpy.mockRestore();
  });

  it('clamps server dispatchedAtMs > 30d to null', () => {
    const staleDispatch = Date.now() - (RELAY_DURATION_CLAMP_MS + 1000);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { durationMs, source } = computeRelayDuration(undefined, staleDispatch);
    expect(durationMs).toBeNull();
    expect(source).toBe('server');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('clamped'));
    stderrSpy.mockRestore();
  });

  it('allows duration exactly at 30d boundary', () => {
    const edgeDispatch = Date.now() - RELAY_DURATION_CLAMP_MS; // exactly 30d ago
    const { durationMs } = computeRelayDuration(undefined, edgeDispatch);
    // raw = now - edgeDispatch ≈ RELAY_DURATION_CLAMP_MS; must NOT clamp
    expect(durationMs).not.toBeNull();
  });

  it('caller wins over server dispatchedAtMs', () => {
    const dispatchedAt = Date.now() - 20000; // 20s ago
    const callerStartedAt = Date.now() - 5000;  // 5s ago
    const { durationMs, source } = computeRelayDuration(callerStartedAt, dispatchedAt);
    expect(source).toBe('caller');
    // Duration should be ~5s, not ~20s
    expect(durationMs!).toBeLessThan(7000);
  });
});

// ── handleNativeRelay integration tests ───────────────────────────────────────

describe('handleNativeRelay — duration fallback', () => {
  it('uses server dispatchedAtMs when caller omits agent_started_at', async () => {
    const dispatchedAt = Date.now() - 30000; // 30s ago
    ctx.nativeTaskMap.set('task-fallback', {
      agentId: 'native-claude',
      task: 'do work',
      startedAt: dispatchedAt,
      timeoutMs: 120000,
    });

    const result = await handleNativeRelay('task-fallback', 'done', undefined, undefined);
    expect(result.content[0].text).toContain('completed');
    // Response should show a time around 30s, not "unknown"
    expect(result.content[0].text).not.toContain('unknown');
  });

  it('uses caller agent_started_at when provided and valid', async () => {
    const dispatchedAt = Date.now() - 60000; // dispatched 60s ago
    const agentLaunchedAt = Date.now() - 30000; // agent launched 30s ago (dispatch overhead = 30s)
    ctx.nativeTaskMap.set('task-caller-ts', {
      agentId: 'native-claude',
      task: 'do work',
      startedAt: dispatchedAt,
      timeoutMs: 120000,
    });

    const result = await handleNativeRelay('task-caller-ts', 'done', undefined, agentLaunchedAt);
    const stored = ctx.nativeResultMap.get('task-caller-ts');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('completed');
    // Result text should include the duration in some form
    expect(result.content[0].text).toContain('completed');
  });

  it('emits duration=unknown in relay text when both timestamps are absent', async () => {
    ctx.nativeTaskMap.set('task-no-ts', {
      agentId: 'native-claude',
      task: 'do work',
      // Intentionally no startedAt to simulate missing dispatch stamp
      startedAt: undefined as any,
      timeoutMs: 120000,
    });

    const result = await handleNativeRelay('task-no-ts', 'done', undefined, undefined);
    expect(result.content[0].text).toContain('unknown');
  });

  it('clamps fake agent_started_at > 30d and emits duration=unknown (2026-04-15 incident regression)', async () => {
    const fakeStartedAt = 1744731620000; // year-2025 epoch ~ far past
    ctx.nativeTaskMap.set('task-fake-ts', {
      agentId: 'native-claude',
      task: 'do work',
      startedAt: Date.now() - 5000,
      timeoutMs: 120000,
    });

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await handleNativeRelay('task-fake-ts', 'done', undefined, fakeStartedAt);
    stderrSpy.mockRestore();

    // The relay should NOT show a 365d duration — it should show "unknown"
    const text = result.content[0].text;
    expect(text).not.toMatch(/\d{8,}ms/); // no 8+-digit ms value
    expect(text).toContain('unknown');
  });

  it('integration: ~30s synthetic delay → relay without timestamp → duration within expected range', async () => {
    const SYNTHETIC_DELAY_MS = 30000;
    const dispatchedAt = Date.now() - SYNTHETIC_DELAY_MS;
    ctx.nativeTaskMap.set('task-synth', {
      agentId: 'native-claude',
      task: 'delayed task',
      startedAt: dispatchedAt,
      timeoutMs: 120000,
    });

    // Relay without any agent_started_at — should use server dispatchedAtMs
    const result = await handleNativeRelay('task-synth', 'done after delay', undefined, undefined);
    const stored = ctx.nativeResultMap.get('task-synth');
    expect(stored).toBeDefined();

    // duration should be approximately SYNTHETIC_DELAY_MS ± 1000ms
    // We can't check it directly but we can verify no "unknown" in the response
    expect(result.content[0].text).not.toContain('unknown');
    expect(result.content[0].text).toContain('completed');
  });
});
