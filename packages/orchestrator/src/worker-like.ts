import { TaskStreamEvent } from './task-stream';

export interface WorkerLike {
  executeTask(
    task: string,
    lens?: string,
    promptContent?: string,
    taskId?: string,
    images?: string[],
    projectRoot?: string,
  ): AsyncGenerator<TaskStreamEvent, void, undefined>;
  validateDispatch?(options?: { writeMode?: string; images?: string[] }): void;
  cancelTask?(taskId: string, reason: string): void;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}
