import { randomUUID } from 'crypto';
import { AgentConfig, TaskEntry } from './types';
import { loadSkills } from './skill-loader';
import { assemblePrompt } from './prompt-assembler';
import { AgentMemoryReader } from './agent-memory';
import { MemoryWriter } from './memory-writer';
import { MemoryCompactor } from './memory-compactor';
import { TaskGraph } from './task-graph';
import { SkillCatalog } from './skill-catalog';
import { SkillGapTracker } from './skill-gap-tracker';
import { GossipPublisher } from './gossip-publisher';

interface WorkerLike {
  executeTask(task: string, lens?: string, promptContent?: string): Promise<string>;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}

export interface DispatchPipelineConfig {
  projectRoot: string;
  workers: Map<string, WorkerLike>;
  registryGet: (agentId: string) => AgentConfig | undefined;
  gossipPublisher?: GossipPublisher | null;
}

type TrackedTask = TaskEntry & { promise: Promise<string> };

export class DispatchPipeline {
  private readonly projectRoot: string;
  private readonly workers: Map<string, WorkerLike>;
  private readonly registryGet: (agentId: string) => AgentConfig | undefined;

  private readonly taskGraph: TaskGraph;
  private readonly memWriter: MemoryWriter;
  private readonly memReader: AgentMemoryReader;
  private readonly memCompactor: MemoryCompactor;
  private readonly gapTracker: SkillGapTracker;
  private readonly catalog: SkillCatalog | null;
  private gossipPublisher: GossipPublisher | null;

  private tasks: Map<string, TrackedTask> = new Map();
  private batches: Map<string, Set<string>> = new Map();

  constructor(config: DispatchPipelineConfig) {
    this.projectRoot = config.projectRoot;
    this.workers = config.workers;
    this.registryGet = config.registryGet;
    this.gossipPublisher = config.gossipPublisher ?? null;

    this.taskGraph = new TaskGraph(config.projectRoot);
    this.memWriter = new MemoryWriter(config.projectRoot);
    this.memReader = new AgentMemoryReader(config.projectRoot);
    this.memCompactor = new MemoryCompactor(config.projectRoot);
    this.gapTracker = new SkillGapTracker(config.projectRoot);

    try { this.catalog = new SkillCatalog(); }
    catch { this.catalog = null; }
  }

  dispatch(agentId: string, task: string): { taskId: string; promise: Promise<string> } {
    const worker = this.workers.get(agentId);
    if (!worker) throw new Error(`Agent "${agentId}" not found`);

    const taskId = randomUUID().slice(0, 8);
    const agentSkills = this.registryGet(agentId)?.skills || [];

    // 1. Load skills
    const skills = loadSkills(agentId, agentSkills, this.projectRoot);

    // 2. Load memory
    const memory = this.memReader.loadMemory(agentId, task);

    // 3. Check skill coverage
    const skillWarnings = this.catalog
      ? this.catalog.checkCoverage(agentSkills, task)
      : [];

    // 4. Assemble prompt
    const promptContent = assemblePrompt({
      memory: memory || undefined,
      skills,
    });

    // 5. Record TaskGraph created
    this.taskGraph.recordCreated(taskId, agentId, task, agentSkills);

    // 6. Create task entry
    const entry: TrackedTask = {
      id: taskId, agentId, task, status: 'running',
      startedAt: Date.now(), skillWarnings,
      promise: null as unknown as Promise<string>,
    };

    // 7. Execute
    entry.promise = worker.executeTask(task, undefined, promptContent)
      .then((result: string) => {
        entry.status = 'completed';
        entry.result = result;
        entry.completedAt = Date.now();
        return result;
      })
      .catch((err: Error) => {
        entry.status = 'failed';
        entry.error = err.message;
        entry.completedAt = Date.now();
        throw err;
      });

    this.tasks.set(taskId, entry);
    return { taskId, promise: entry.promise };
  }

  getTask(taskId: string): TaskEntry | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    return {
      id: t.id, agentId: t.agentId, task: t.task,
      status: t.status, result: t.result, error: t.error,
      startedAt: t.startedAt, completedAt: t.completedAt,
      skillWarnings: t.skillWarnings,
    };
  }

  async collect(taskIds?: string[], timeoutMs: number = 120_000): Promise<TaskEntry[]> {
    const targets = taskIds
      ? taskIds.map(id => this.tasks.get(id)).filter((t): t is TrackedTask => t !== undefined)
      : Array.from(this.tasks.values()).filter(t => t.status === 'running');

    if (targets.length === 0) return [];

    // Wait with timeout
    await Promise.race([
      Promise.all(targets.map(t => t.promise.catch(() => {}))),
      new Promise(r => setTimeout(r, timeoutMs)),
    ]);

    // Post-collect pipeline
    for (const t of targets) {
      const duration = t.completedAt ? t.completedAt - t.startedAt : -1;

      // 1. TaskGraph
      if (t.status === 'completed') {
        this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);
      } else if (t.status === 'failed') {
        this.taskGraph.recordFailed(t.id, t.error || 'Unknown', duration);
      } else if (t.status === 'running') {
        this.taskGraph.recordCancelled(t.id, 'collect timeout', duration);
      }

      // 2. Write agent memory
      if (t.status === 'completed') {
        await this.memWriter.writeTaskEntry(t.agentId, {
          taskId: t.id, task: t.task,
          skills: this.registryGet(t.agentId)?.skills || [],
          scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
        });
        this.memWriter.rebuildIndex(t.agentId);
      }

      // 3. Compact memory
      const compactResult = this.memCompactor.compactIfNeeded(t.agentId);
      if (compactResult.message) {
        process.stderr.write(`[gossipcat] ${compactResult.message}\n`);
      }
    }

    // 4. Skill gap check
    try {
      for (const t of targets) {
        if (t.status !== 'running') {
          this.gapTracker.getSuggestionsSince(t.agentId, t.startedAt);
        }
      }
      this.gapTracker.checkAndGenerate();
    } catch { /* non-blocking */ }

    // 5. Batch cleanup
    for (const [bid, taskIdSet] of this.batches) {
      const allDone = Array.from(taskIdSet).every(tid => {
        const bt = this.tasks.get(tid);
        return !bt || bt.status !== 'running';
      });
      if (allDone) {
        for (const tid of taskIdSet) {
          const bt = this.tasks.get(tid);
          if (bt) {
            const w = this.workers.get(bt.agentId);
            if (w?.unsubscribeFromBatch) w.unsubscribeFromBatch(bid).catch(() => {});
          }
        }
        this.batches.delete(bid);
      }
    }

    // Build clean result entries
    const results: TaskEntry[] = targets.map(t => ({
      id: t.id, agentId: t.agentId, task: t.task,
      status: t.status, result: t.result, error: t.error,
      startedAt: t.startedAt, completedAt: t.completedAt,
      skillWarnings: t.skillWarnings,
    }));

    // Cleanup completed tasks
    // Note: handleMessage path tasks are cleaned by writeMemoryForTask()
    // before they can appear as 'running' to collect(). No double-record risk.
    for (const t of targets) {
      if (t.status !== 'running') this.tasks.delete(t.id);
    }

    return results;
  }

  dispatchParallel(taskDefs: Array<{ agentId: string; task: string }>): {
    taskIds: string[];
    errors: string[];
  } {
    const taskIds: string[] = [];
    const errors: string[] = [];
    const batchId = randomUUID().slice(0, 8);
    const batchTaskIds = new Set<string>();

    // Subscribe workers to batch channel
    for (const def of taskDefs) {
      const worker = this.workers.get(def.agentId);
      if (worker?.subscribeToBatch) {
        worker.subscribeToBatch(batchId).catch(() => {});
      }
    }

    for (const def of taskDefs) {
      try {
        const { taskId, promise } = this.dispatch(def.agentId, def.task);
        taskIds.push(taskId);
        batchTaskIds.add(taskId);

        // Gossip trigger on completion
        if (this.gossipPublisher) {
          promise.then(async (result) => {
            const remaining = Array.from(batchTaskIds)
              .map(tid => this.tasks.get(tid))
              .filter((t): t is TrackedTask => t !== undefined && t.status === 'running' && t.agentId !== def.agentId)
              .map(t => this.registryGet(t.agentId))
              .filter((ac): ac is AgentConfig => ac !== undefined);

            if (remaining.length > 0) {
              this.gossipPublisher!.publishGossip({
                batchId,
                completedAgentId: def.agentId,
                completedResult: result,
                remainingSiblings: remaining.map(ac => ({
                  agentId: ac.id, preset: ac.preset || 'custom', skills: ac.skills,
                })),
              }).catch(err => process.stderr.write(`[gossipcat] Gossip: ${(err as Error).message}\n`));
            }
          }).catch(() => {});
        }
      } catch {
        errors.push(`Agent "${def.agentId}" not found`);
      }
    }

    this.batches.set(batchId, batchTaskIds);
    return { taskIds, errors };
  }

  /** Write memory inline (for handleMessage synchronous path) */
  async writeMemoryForTask(taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'completed') return;

    const duration = t.completedAt ? t.completedAt - t.startedAt : -1;
    this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration);

    await this.memWriter.writeTaskEntry(t.agentId, {
      taskId: t.id, task: t.task,
      skills: this.registryGet(t.agentId)?.skills || [],
      scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
    });
    this.memWriter.rebuildIndex(t.agentId);
    this.memCompactor.compactIfNeeded(t.agentId);
    this.tasks.delete(t.id);
  }

  setGossipPublisher(publisher: GossipPublisher | null): void {
    this.gossipPublisher = publisher;
  }

  /** Flush TaskGraph index on shutdown */
  flushTaskGraph(): void {
    this.taskGraph.flushIndex();
  }

  /** Get suggestion results for formatting in collect responses */
  getSkillSuggestions(agentId: string, sinceMs: number) {
    return this.gapTracker.getSuggestionsSince(agentId, sinceMs);
  }

  getSkeletonMessages(): string[] {
    return this.gapTracker.checkAndGenerate();
  }
}
