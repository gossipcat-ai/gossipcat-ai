import { TaskStreamEvent } from './task-stream';

export interface WorkerLike {
  executeTask(
    task: string,
    lens?: string,
    promptContent?: string,
    taskId?: string,
  ): AsyncGenerator<TaskStreamEvent, void, undefined>;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}
