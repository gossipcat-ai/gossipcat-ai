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
  private readonly indexPath: string;
  private index: Map<string, number> = new Map(); // taskId → last event line number
  private eventCount: number = 0;

  constructor(projectRoot: string) {
    const gossipDir = join(projectRoot, '.gossip');
    mkdirSync(gossipDir, { recursive: true }); // idempotent, no TOCTOU
    this.graphPath = join(gossipDir, 'task-graph.jsonl');
    this.syncMetaPath = join(gossipDir, 'task-graph-sync.json');
    this.indexPath = join(gossipDir, 'task-graph-index.json');
    this.loadIndex();
    if (existsSync(this.graphPath)) {
      // Count lines without loading entire file into memory
      const buf = readFileSync(this.graphPath);
      let count = 0;
      for (let i = 0; i < buf.length; i++) { if (buf[i] === 10) count++; }
      this.eventCount = count;
    }
  }

  private loadIndex(): void {
    if (existsSync(this.indexPath)) {
      try {
        const data = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
        this.index = new Map(Object.entries(data).map(([k, v]) => [k, Number(v)]));
      } catch { /* corrupt index — will rebuild on next write */ }
    }
  }

  /** Save index to disk (call explicitly, not on every append) */
  flushIndex(): void {
    writeFileSync(this.indexPath, JSON.stringify(Object.fromEntries(this.index)));
  }

  private appendEvent(event: TaskGraphEvent): void {
    appendFileSync(this.graphPath, JSON.stringify(event) + '\n');

    // Maintain in-memory index (for future use — not yet queried by getTask)
    if ('taskId' in event) {
      this.index.set((event as any).taskId, this.eventCount);
    }
    if (event.type === 'task.decomposed') {
      this.index.set(event.parentId, this.eventCount);
    }
    this.eventCount++;
    // Index saved periodically, not on every append (was blocking event loop)
  }

  /** Redact common secret patterns from text before persisting */
  private redactSecrets(text: string): string {
    return text
      .replace(/sk[-_]live[-_][a-zA-Z0-9]{20,}/g, '[REDACTED_STRIPE_KEY]')
      .replace(/sk[-_]ant[-_][a-zA-Z0-9]{20,}/g, '[REDACTED_ANTHROPIC_KEY]')
      .replace(/sk[-_][a-zA-Z0-9]{40,}/g, '[REDACTED_API_KEY]')
      .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/gho_[a-zA-Z0-9]{36,}/g, '[REDACTED_GITHUB_OAUTH]')
      .replace(/AIza[a-zA-Z0-9_-]{35}/g, '[REDACTED_GOOGLE_KEY]')
      .replace(/eyJ[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]{50,}\.[a-zA-Z0-9_-]{50,}/g, '[REDACTED_JWT]')
      .replace(/-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  }

  recordCreated(taskId: string, agentId: string, task: string, skills: string[], parentId?: string): void {
    const event: TaskCreatedEvent = {
      type: 'task.created', taskId, agentId, task, skills,
      ...(parentId ? { parentId } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordCompleted(taskId: string, result: string, duration: number, inputTokens?: number, outputTokens?: number, memoryQueryCalled?: boolean): void {
    const event: TaskCompletedEvent = {
      type: 'task.completed', taskId, result: this.redactSecrets(result.slice(0, 4000)), duration,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(memoryQueryCalled !== undefined ? { memoryQueryCalled } : {}),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  recordFailed(taskId: string, error: string, duration: number, inputTokens?: number, outputTokens?: number, memoryQueryCalled?: boolean): void {
    const event: TaskFailedEvent = {
      type: 'task.failed', taskId, error: this.redactSecrets(error), duration,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(memoryQueryCalled !== undefined ? { memoryQueryCalled } : {}),
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
        task.inputTokens = e.inputTokens;
        task.outputTokens = e.outputTokens;
      } else if (e.type === 'task.failed' && e.taskId === taskId) {
        task.status = 'failed'; task.error = e.error;
        task.duration = e.duration; task.completedAt = e.timestamp;
        task.inputTokens = e.inputTokens;
        task.outputTokens = e.outputTokens;
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
    return this.eventCount;
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
