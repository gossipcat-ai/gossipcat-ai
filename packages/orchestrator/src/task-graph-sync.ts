import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TaskGraph } from './task-graph';
import type {
  TaskGraphEvent, TaskCreatedEvent, TaskCompletedEvent,
  TaskFailedEvent, TaskCancelledEvent, TaskDecomposedEvent, TaskReferenceEvent,
} from './types';

export class TaskGraphSync {
  private readonly gossipDir: string;

  constructor(
    private graph: TaskGraph,
    private supabaseUrl: string,
    private supabaseKey: string,
    private userId: string,
    private projectId: string,
    projectRoot: string,
  ) {
    this.gossipDir = join(projectRoot, '.gossip');
  }

  isConfigured(): boolean {
    return !!(this.supabaseUrl && this.supabaseKey);
  }

  async sync(): Promise<{ events: number; scores: number; errors: string[] }> {
    if (!this.isConfigured()) return { events: 0, scores: 0, errors: ['Not configured'] };
    const meta = this.graph.getSyncMeta();
    const events = this.graph.getUnsynced(meta.lastSync);
    if (events.length === 0) return { events: 0, scores: 0, errors: [] };
    let synced = 0;
    const errors: string[] = [];
    for (const event of events) {
      try {
        await this.syncEvent(event);
        synced++;
      } catch (err) {
        errors.push(`${event.type}: ${(err as Error).message}`);
      }
    }
    let scores = 0;
    try { scores = await this.syncAgentScores(); }
    catch (err) { errors.push(`agent_scores: ${(err as Error).message}`); }
    if (synced > 0) {
      this.graph.updateSyncMeta({
        lastSync: events[events.length - 1].timestamp,
        lastSyncEventCount: meta.lastSyncEventCount + synced,
      });
    }
    return { events: synced, scores, errors };
  }

  private async syncEvent(event: TaskGraphEvent): Promise<void> {
    switch (event.type) {
      case 'task.created': return this.syncCreated(event);
      case 'task.completed': return this.syncCompleted(event);
      case 'task.failed': return this.syncFailed(event);
      case 'task.cancelled': return this.syncCancelled(event);
      case 'task.decomposed': return this.syncDecomposed(event);
      case 'task.reference': return this.syncReference(event);
    }
  }

  private async syncCreated(event: TaskCreatedEvent): Promise<void> {
    await this.upsert('/rest/v1/tasks?on_conflict=id', {
      id: event.taskId, agent_id: event.agentId, task: event.task,
      skills: event.skills, parent_id: event.parentId || null,
      status: 'created', user_id: this.userId, project_id: this.projectId,
      created_at: event.timestamp,
    });
  }

  private async syncCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.upsert('/rest/v1/tasks?on_conflict=id', {
      id: event.taskId, status: 'completed', result: event.result,
      duration_ms: event.duration, completed_at: event.timestamp,
    });
  }

  private async syncFailed(event: TaskFailedEvent): Promise<void> {
    await this.upsert('/rest/v1/tasks?on_conflict=id', {
      id: event.taskId, status: 'failed', error: event.error,
      duration_ms: event.duration, completed_at: event.timestamp,
    });
  }

  private async syncCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.upsert('/rest/v1/tasks?on_conflict=id', {
      id: event.taskId, status: 'cancelled', error: event.reason,
      duration_ms: event.duration, completed_at: event.timestamp,
    });
  }

  private async syncDecomposed(event: TaskDecomposedEvent): Promise<void> {
    await this.upsert('/rest/v1/task_decompositions', {
      parent_id: event.parentId, strategy: event.strategy,
      sub_task_ids: event.subTaskIds, created_at: event.timestamp,
    });
  }

  private async syncReference(event: TaskReferenceEvent): Promise<void> {
    await this.upsert('/rest/v1/task_references', {
      from_task_id: event.fromTaskId, to_task_id: event.toTaskId,
      relationship: event.relationship, evidence: event.evidence || null,
      created_at: event.timestamp,
    });
  }

  async syncAgentScores(): Promise<number> {
    const perfPath = join(this.gossipDir, 'agent-performance.jsonl');
    if (!existsSync(perfPath)) return 0;
    const content = readFileSync(perfPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const meta = this.graph.getSyncMeta();
    let synced = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (meta.lastSync && entry.timestamp <= meta.lastSync) continue;
        await this.upsert('/rest/v1/agent_scores', {
          user_id: this.userId, agent_id: entry.agentId, task_id: entry.taskId,
          skills: entry.skills || [], relevance: entry.scores?.relevance,
          accuracy: entry.scores?.accuracy, uniqueness: entry.scores?.uniqueness,
          source: 'judgment', created_at: entry.timestamp,
        });
        synced++;
      } catch { /* skip malformed entries */ }
    }
    return synced;
  }

  private async upsert(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'apikey': this.supabaseKey,
        'Authorization': `Bearer ${this.supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`UPSERT ${path} failed: ${res.status} ${await res.text()}`);
  }
}
