// packages/orchestrator/src/performance-writer.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PerformanceSignal } from './consensus-types';

export class PerformanceWriter {
  private readonly filePath: string;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'agent-performance.jsonl');
  }

  appendSignal(signal: PerformanceSignal): void {
    appendFileSync(this.filePath, JSON.stringify(signal) + '\n');
  }

  appendSignals(signals: PerformanceSignal[]): void {
    if (signals.length === 0) return;
    const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
    appendFileSync(this.filePath, data);
  }
}
