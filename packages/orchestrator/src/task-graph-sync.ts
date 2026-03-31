import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { TaskGraph } from './task-graph';
import type {
  TaskGraphEvent, TaskCreatedEvent, TaskCompletedEvent,
  TaskFailedEvent, TaskCancelledEvent, TaskDecomposedEvent, TaskReferenceEvent,
} from './types';

/** Validate that a value is safe to interpolate into PostgREST URL params.
 *  Rejects characters that could inject query operators (&, =, (, ), |, !) */
function safeId(value: string): string {
  if (!value || /[&=?|()\s!]/.test(value)) {
    throw new Error(`Invalid ID for PostgREST query: ${value?.slice(0, 20)}`);
  }
  return encodeURIComponent(value);
}

export interface SyncMigrationConfig {
  oldProjectId?: string;
  oldUserId?: string;
}

export class TaskGraphSync {
  private readonly gossipDir: string;
  private migrationDone = false;

  constructor(
    private graph: TaskGraph,
    private supabaseUrl: string,
    private supabaseKey: string,
    private userId: string,
    private projectId: string,
    projectRoot: string,
    private displayName?: string | null,
    private migration?: SyncMigrationConfig,
  ) {
    this.gossipDir = join(projectRoot, '.gossip');
  }

  isConfigured(): boolean {
    return !!(this.supabaseUrl && this.supabaseKey);
  }

  async sync(): Promise<{ events: number; scores: number; errors: string[] }> {
    if (!this.isConfigured()) return { events: 0, scores: 0, errors: ['Not configured'] };

    // One-time migration
    if (this.migration && !this.migrationDone) {
      try { await this.runMigrations(); }
      catch (err) { return { events: 0, scores: 0, errors: [`Migration failed: ${(err as Error).message}`] }; }
      this.migrationDone = true;
    }

    const meta = this.graph.getSyncMeta();
    const events = this.graph.getUnsynced(meta.lastSync);
    if (events.length === 0) return { events: 0, scores: 0, errors: [] };
    let synced = 0;
    let lastSyncedTimestamp = '';
    const errors: string[] = [];
    for (const event of events) {
      try {
        await this.syncEvent(event);
        synced++;
        lastSyncedTimestamp = event.timestamp;
      } catch (err) {
        errors.push(`${event.type}: ${(err as Error).message}`);
        // Stop advancing timestamp — failed events must be retried next sync
        break;
      }
    }
    let scores = 0;
    try { scores = await this.syncAgentScores(); }
    catch (err) { errors.push(`agent_scores: ${(err as Error).message}`); }
    if (synced > 0 && lastSyncedTimestamp) {
      this.graph.updateSyncMeta({
        lastSync: lastSyncedTimestamp,
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
      display_name: this.displayName || null,
      created_at: event.timestamp,
    });
  }

  private async syncCompleted(event: TaskCompletedEvent): Promise<void> {
    await this.patch(`/rest/v1/tasks?id=eq.${safeId(event.taskId)}`, {
      status: 'completed', result: event.result,
      duration_ms: event.duration, completed_at: event.timestamp,
      input_tokens: event.inputTokens ?? null,
      output_tokens: event.outputTokens ?? null,
    });
  }

  private async syncFailed(event: TaskFailedEvent): Promise<void> {
    await this.patch(`/rest/v1/tasks?id=eq.${safeId(event.taskId)}`, {
      status: 'failed', error: event.error,
      duration_ms: event.duration, completed_at: event.timestamp,
      input_tokens: event.inputTokens ?? null,
      output_tokens: event.outputTokens ?? null,
    });
  }

  private async syncCancelled(event: TaskCancelledEvent): Promise<void> {
    await this.patch(`/rest/v1/tasks?id=eq.${safeId(event.taskId)}`, {
      status: 'cancelled', error: event.reason,
      duration_ms: event.duration, completed_at: event.timestamp,
    });
  }

  private async syncDecomposed(event: TaskDecomposedEvent): Promise<void> {
    // Plain POST — UUID PK means no natural dedup key for upsert.
    // Re-sync may create duplicates; cosmetic only (low volume).
    await this.post('/rest/v1/task_decompositions', {
      parent_id: event.parentId, strategy: event.strategy,
      sub_task_ids: event.subTaskIds, created_at: event.timestamp,
    });
  }

  private async syncReference(event: TaskReferenceEvent): Promise<void> {
    await this.post('/rest/v1/task_references', {
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
        if (!entry.agentId || !entry.signal) continue; // skip malformed
        await this.post('/rest/v1/agent_scores', {
          user_id: this.userId,
          agent_id: entry.agentId,
          task_id: entry.taskId || null,
          signal: entry.signal,
          evidence: (entry.evidence || '').slice(0, 500),
          source: 'consensus',
          created_at: entry.timestamp,
          project_id: this.projectId,
          display_name: this.displayName || null,
        });
        synced++;
      } catch { /* skip malformed entries */ }
    }
    return synced;
  }

  private async runMigrations(): Promise<void> {
    if (this.migration?.oldProjectId) {
      await this.patch(
        `/rest/v1/tasks?project_id=eq.${safeId(this.migration.oldProjectId)}&user_id=eq.${safeId(this.userId)}`,
        { project_id: this.projectId }
      );
      await this.patch(
        `/rest/v1/agent_scores?project_id=eq.${safeId(this.migration.oldProjectId)}&user_id=eq.${safeId(this.userId)}`,
        { project_id: this.projectId }
      );
    }
    if (this.migration?.oldUserId) {
      await this.patch(
        `/rest/v1/tasks?user_id=eq.${safeId(this.migration.oldUserId)}&project_id=eq.${safeId(this.projectId)}`,
        { user_id: this.userId, display_name: this.displayName || null }
      );
      await this.patch(
        `/rest/v1/agent_scores?user_id=eq.${safeId(this.migration.oldUserId)}&project_id=eq.${safeId(this.projectId)}`,
        { user_id: this.userId, display_name: this.displayName || null }
      );
    }
  }

  private async patch(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}${path}`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  }

  private async upsert(path: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`UPSERT ${path} failed: ${res.status} ${await res.text()}`);
  }

  private headers(): Record<string, string> {
    return {
      'apikey': this.supabaseKey,
      'Authorization': `Bearer ${this.supabaseKey}`,
      'Content-Type': 'application/json',
    };
  }
}
