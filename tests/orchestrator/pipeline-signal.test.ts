import { PerformanceWriter } from '@gossip/orchestrator';
import type { PipelineSignal } from '@gossip/orchestrator';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// L2: sanctioned internal accessor for tests (Step 5 exemption).
import { WRITER_INTERNAL } from '../../packages/orchestrator/src/_writer-internal';

describe('PipelineSignal', () => {
  const testDir = join(tmpdir(), 'gossip-pipeline-signal-' + Date.now());
  beforeAll(() => mkdirSync(join(testDir, '.gossip'), { recursive: true }));
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  // Option C (spec 2026-04-27-self-telemetry-crash-consistency): the writer
  // emits `_meta`/`round_counter_bumped` records inline alongside signal rows.
  // Tests assert against the last *signal* row, so filter those meta-records
  // out of `readLines()` rather than walking from the end of the file.
  const readLines = () =>
    readFileSync(join(testDir, '.gossip', 'agent-performance.jsonl'), 'utf-8')
      .trim().split('\n').map(l => JSON.parse(l))
      .filter((r: any) => r.type !== '_meta');

  test('accepts valid pipeline signal with agentId', () => {
    const writer = new PerformanceWriter(testDir);
    const sig: PipelineSignal = {
      type: 'pipeline',
      signal: 'finding_dropped_format',
      agentId: 'sonnet-reviewer',
      taskId: 't1',
      value: 3,
      metadata: { tags_dropped_unknown_type: 3 },
      timestamp: new Date().toISOString(),
    };
    expect(() => writer[WRITER_INTERNAL].appendSignal(sig)).not.toThrow();
    const lines = readLines();
    const last = lines[lines.length - 1];
    expect(last.type).toBe('pipeline');
    expect(last.signal).toBe('finding_dropped_format');
    expect(last.value).toBe(3);
  });

  test('accepts _system sentinel agentId for system-scoped events', () => {
    const writer = new PerformanceWriter(testDir);
    const sig: PipelineSignal = {
      type: 'pipeline',
      signal: 'synthesis_completed',
      agentId: '_system',
      taskId: 't2',
      consensusId: 'abcd1234-ef567890',
      timestamp: new Date().toISOString(),
    };
    writer[WRITER_INTERNAL].appendSignal(sig);
    const lines = readLines();
    const last = lines[lines.length - 1];
    expect(last.signal).toBe('synthesis_completed');
    expect(last.agentId).toBe('_system');
    expect(last.consensusId).toBe('abcd1234-ef567890');
  });

  test('rejects unknown pipeline signal type', () => {
    const writer = new PerformanceWriter(testDir);
    const bad = {
      type: 'pipeline',
      signal: 'not_a_real_signal',
      agentId: '_system',
      taskId: 't3',
      timestamp: new Date().toISOString(),
    } as unknown as PipelineSignal;
    expect(() => writer[WRITER_INTERNAL].appendSignal(bad)).toThrow(/unknown pipeline signal/);
  });

  test('rejects empty agentId', () => {
    const writer = new PerformanceWriter(testDir);
    const bad = {
      type: 'pipeline',
      signal: 'dispatch_started',
      agentId: '',
      taskId: 't4',
      timestamp: new Date().toISOString(),
    } as unknown as PipelineSignal;
    expect(() => writer[WRITER_INTERNAL].appendSignal(bad)).toThrow(/agentId/);
  });

  test('still requires valid timestamp', () => {
    const writer = new PerformanceWriter(testDir);
    const badTs = {
      type: 'pipeline',
      signal: 'dispatch_started',
      agentId: '_system',
      taskId: 't5',
      timestamp: 'not-a-date',
    } as unknown as PipelineSignal;
    expect(() => writer[WRITER_INTERNAL].appendSignal(badTs)).toThrow(/timestamp/);
  });
});
