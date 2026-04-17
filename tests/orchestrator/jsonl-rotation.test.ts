import { PerformanceWriter, rotateJsonlIfNeeded, MAX_TELEMETRY_BYTES } from '@gossip/orchestrator';
import type { PipelineSignal } from '@gossip/orchestrator';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('rotateJsonlIfNeeded', () => {
  const testDir = join(tmpdir(), 'gossip-rotate-' + Date.now());
  const testFile = join(testDir, 'test.jsonl');
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('is a no-op on missing file', () => {
    expect(() => rotateJsonlIfNeeded(testFile, 100)).not.toThrow();
    expect(existsSync(testFile)).toBe(false);
  });

  test('does not rotate below threshold', () => {
    writeFileSync(testFile, 'x'.repeat(50));
    rotateJsonlIfNeeded(testFile, 100);
    expect(existsSync(testFile)).toBe(true);
    expect(existsSync(testFile + '.1')).toBe(false);
  });

  test('rotates to .1 at or above threshold', () => {
    writeFileSync(testFile, 'x'.repeat(200));
    rotateJsonlIfNeeded(testFile, 100);
    expect(existsSync(testFile + '.1')).toBe(true);
    expect(existsSync(testFile)).toBe(false);
  });

  test('overwrites pre-existing .1 slot', () => {
    writeFileSync(testFile + '.1', 'old');
    writeFileSync(testFile, 'x'.repeat(200));
    rotateJsonlIfNeeded(testFile, 100);
    expect(readFileSync(testFile + '.1', 'utf-8').length).toBe(200);
  });

  test('MAX_TELEMETRY_BYTES is 5MB', () => {
    expect(MAX_TELEMETRY_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('PerformanceWriter integration with rotation', () => {
  const testDir = join(tmpdir(), 'gossip-perf-rotate-' + Date.now());
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, '.gossip'), { recursive: true });
  });
  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('rotates agent-performance.jsonl once it exceeds 5MB', () => {
    const perfPath = join(testDir, '.gossip', 'agent-performance.jsonl');
    // Pre-populate with >5MB of dummy JSONL
    const fill = JSON.stringify({ filler: 'x'.repeat(1024) }) + '\n';
    const reps = Math.ceil((MAX_TELEMETRY_BYTES + 1024) / fill.length);
    writeFileSync(perfPath, fill.repeat(reps));
    expect(statSync(perfPath).size).toBeGreaterThan(MAX_TELEMETRY_BYTES);

    const writer = new PerformanceWriter(testDir);
    const sig: PipelineSignal = {
      type: 'pipeline',
      signal: 'dispatch_started',
      agentId: '_system',
      taskId: 't1',
      timestamp: new Date().toISOString(),
    };
    writer.appendSignal(sig);

    // Rotation should have fired: .1 holds the old huge file, primary has one fresh line.
    expect(existsSync(perfPath + '.1')).toBe(true);
    const primary = readFileSync(perfPath, 'utf-8').trim().split('\n');
    expect(primary.length).toBe(1);
    expect(JSON.parse(primary[0]).signal).toBe('dispatch_started');
  });
});
