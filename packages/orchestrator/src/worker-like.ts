import { TaskExecutionResult } from './types';
import { WorkerProgressCallback } from './worker-agent';

export interface WorkerLike {
  executeTask(
    task: string,
    lens?: string,
    promptContent?: string,
    onProgress?: WorkerProgressCallback,
  ): Promise<TaskExecutionResult>;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}
