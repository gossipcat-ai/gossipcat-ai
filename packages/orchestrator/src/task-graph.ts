import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  TaskGraphEvent, TaskCreatedEvent, TaskCompletedEvent, TaskFailedEvent,
  TaskCancelledEvent, TaskDecomposedEvent, TaskReferenceEvent,
  ReconstructedTask, SyncMeta,
} from './types';

const MAX_SCAN_LINES = 1000;

export class TaskGraph {
  private readonly graphPath: string;
  private readonly syncMetaPath: string;

  constructor(projectRoot: string) {
    const gossipDir = join(projectRoot, '.gossip');
    if (!existsSync(gossipDir)) {
      mkdirSync(gossipDir, { recursive: true });
    }
    this.graphPath = join(gossipDir, 'task-graph.jsonl');
    this.syncMetaPath = join(gossipDir, 'task-graph-sync.json');
  }

  private appendEvent(event: TaskGraphEvent): void {
    appendFileSync(this.graphPath, JSON.stringify(event) + '\n');
  }

  recordCreated(taskId: string, agentId: string, task: string, skills: string[], parentId?: string): void {
    const event: TaskCreatedEvent = {
      type: 'task.created', taskId, agentId, task, skills,
      ...(parentId ? { parentId } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordCompleted(taskId: string, result: string, duration: number): void {
    const event: TaskCompletedEvent = {
      type: 'task.completed', taskId, result: result.slice(0, 4000), duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordFailed(taskId: string, error: string, duration: number): void {
    const event: TaskFailedEvent = {
      type: 'task.failed', taskId, error, duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordCancelled(taskId: string, reason: string, duration: number): void {
    const event: TaskCancelledEvent = {
      type: 'task.cancelled', taskId, reason, duration,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordDecomposed(parentId: string, strategy: string, subTaskIds: string[]): void {
    const event: TaskDecomposedEvent = {
      type: 'task.decomposed', parentId,
      strategy: strategy as 'single' | 'parallel' | 'sequential',
      subTaskIds,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordReference(fromTaskId: string, toTaskId: string, relationship: string, evidence?: string): void {
    const event: TaskReferenceEvent = {
      type: 'task.reference', fromTaskId, toTaskId,
      relationship: relationship as TaskReferenceEvent['relationship'],
      ...(evidence ? { evidence } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  // ── Read methods ─────────────────────────────────────────────────────

  private readEvents(): TaskGraphEvent[] {
    if (!existsSync(this.graphPath)) return [];
    const content = readFileSync(this.graphPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_SCAN_LINES);
    return tail.map(line => {
      try { return JSON.parse(line) as TaskGraphEvent; }
      catch { return null; }
    }).filter(Boolean) as TaskGraphEvent[];
  }

  getTask(taskId: string): ReconstructedTask | null {
    const events = this.readEvents();
    const created = events.find(
      (e): e is TaskCreatedEvent => e.type === 'task.created' && e.taskId === taskId
    );
    if (!created) return null;

    const task: ReconstructedTask = {
      taskId, agentId: created.agentId, task: created.task,
      skills: created.skills, parentId: created.parentId,
      status: 'created', createdAt: created.timestamp,
    };

    for (const e of events) {
      if (e.type === 'task.completed' && e.taskId === taskId) {
        task.status = 'completed'; task.result = e.result;
        task.duration = e.duration; task.completedAt = e.timestamp;
      } else if (e.type === 'task.failed' && e.taskId === taskId) {
        task.status = 'failed'; task.error = e.error;
        task.duration = e.duration; task.completedAt = e.timestamp;
      } else if (e.type === 'task.cancelled' && e.taskId === taskId) {
        task.status = 'cancelled'; task.error = e.reason;
        task.duration = e.duration; task.completedAt = e.timestamp;
      }
    }

    const decomposed = events.find(
      (e): e is TaskDecomposedEvent => e.type === 'task.decomposed' && e.parentId === taskId
    );
    if (decomposed) task.children = decomposed.subTaskIds;

    const refs = events.filter(
      (e): e is TaskReferenceEvent =>
        e.type === 'task.reference' && (e.fromTaskId === taskId || e.toTaskId === taskId)
    );
    if (refs.length) task.references = refs;

    return task;
  }

  getRecentTasks(limit: number = 20): ReconstructedTask[] {
    const events = this.readEvents();
    const created = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created')
      .reverse()
      .slice(0, limit);
    return created.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  getTasksByAgent(agentId: string, limit: number = 20): ReconstructedTask[] {
    const events = this.readEvents();
    const created = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created' && e.agentId === agentId)
      .reverse()
      .slice(0, limit);
    return created.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  getChildren(parentId: string): ReconstructedTask[] {
    const events = this.readEvents();
    const children = events
      .filter((e): e is TaskCreatedEvent => e.type === 'task.created' && e.parentId === parentId);
    return children.map(c => this.getTask(c.taskId)).filter(Boolean) as ReconstructedTask[];
  }

  getReferences(taskId: string): TaskReferenceEvent[] {
    return this.readEvents().filter(
      (e): e is TaskReferenceEvent =>
        e.type === 'task.reference' && (e.fromTaskId === taskId || e.toTaskId === taskId)
    );
  }

  getEventCount(): number {
    if (!existsSync(this.graphPath)) return 0;
    const content = readFileSync(this.graphPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).length;
  }

  getSyncMeta(): SyncMeta {
    if (!existsSync(this.syncMetaPath)) {
      return { lastSync: '', lastSyncEventCount: 0 };
    }
    return JSON.parse(readFileSync(this.syncMetaPath, 'utf-8'));
  }

  updateSyncMeta(meta: Partial<SyncMeta>): void {
    const current = this.getSyncMeta();
    writeFileSync(this.syncMetaPath, JSON.stringify({ ...current, ...meta }, null, 2));
  }

  getUnsynced(lastSyncTimestamp: string): TaskGraphEvent[] {
    if (!lastSyncTimestamp) return this.readEvents();
    return this.readEvents().filter(e => e.timestamp > lastSyncTimestamp);
  }
}
