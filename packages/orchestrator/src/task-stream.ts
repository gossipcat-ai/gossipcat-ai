export enum TaskStreamEventType {
  LOG = 'log',
  PROGRESS = 'progress',
  PARTIAL_RESULT = 'partial_result',
  FINAL_RESULT = 'final_result',
  ERROR = 'error',
}

export interface TaskStreamEvent {
  type: TaskStreamEventType;
  payload: any;
  timestamp: number;
}
