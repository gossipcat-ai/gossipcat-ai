import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { AgentConfig, DispatchOptions, TaskEntry, TaskExecutionResult, SessionGossipEntry, PlanState } from './types';
import { ILLMProvider } from './llm-client';
import { LLMMessage } from '@gossip/types';
import { loadSkills } from './skill-loader';
import { assemblePrompt, extractSpecReferences, buildSpecReviewEnrichment } from './prompt-assembler';
import { AgentMemoryReader } from './agent-memory';
import { MemoryWriter } from './memory-writer';
import { MemoryCompactor } from './memory-compactor';
import { TaskGraph } from './task-graph';
import { SkillCatalog } from './skill-catalog';
import { SkillGapTracker } from './skill-gap-tracker';
import { GossipPublisher } from './gossip-publisher';
import { ScopeTracker } from './scope-tracker';
import { WorktreeManager } from './worktree-manager';
import { TaskGraphSync } from './task-graph-sync';
import { OverlapDetector } from './overlap-detector';
import { LensGenerator } from './lens-generator';
import { ConsensusEngine } from './consensus-engine';
import { PerformanceWriter } from './performance-writer';
import { CollectResult } from './consensus-types';
import { WorkerProgressCallback } from './worker-agent';

const log = (msg: string) => process.stderr.write(`[gossipcat] ${msg}\n`);

interface WorkerLike {
  executeTask(task: string, lens?: string, promptContent?: string, onProgress?: WorkerProgressCallback): Promise<TaskExecutionResult>;
  subscribeToBatch?(batchId: string): Promise<void>;
  unsubscribeFromBatch?(batchId: string): Promise<void>;
}

export interface ToolServerCallbacks {
  assignScope: (agentId: string, scope: string) => void;
  assignRoot: (agentId: string, root: string) => void;
  releaseAgent: (agentId: string) => void;
}

export interface DispatchPipelineConfig {
  projectRoot: string;
  workers: Map<string, WorkerLike>;
  registryGet: (agentId: string) => AgentConfig | undefined;
  gossipPublisher?: GossipPublisher | null;
  llm?: ILLMProvider;
  syncFactory?: () => TaskGraphSync | null;
  toolServer?: ToolServerCallbacks | null;
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
  private readonly llm: ILLMProvider | null;
  private gossipPublisher: GossipPublisher | null;
  private syncFactory: (() => TaskGraphSync | null) | null;
  private toolServer: ToolServerCallbacks | null;
  private isSyncing = false;
  private sessionGossip: SessionGossipEntry[] = [];
  private plans: Map<string, PlanState> = new Map();
  private static readonly MAX_SESSION_GOSSIP = 20;

  private tasks: Map<string, TrackedTask> = new Map();
  private batches: Map<string, Set<string>> = new Map();

  private readonly scopeTracker: ScopeTracker;
  private readonly worktreeManager: WorktreeManager;
  private writeQueue: Array<() => void> = [];
  private writeActive = false;

  private overlapDetector: OverlapDetector | null = null;
  private lensGenerator: LensGenerator | null = null;
  private bootWarningShown = false;

  private taskProgressCallback: ((taskId: string, event: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) | null = null;

  setTaskProgressCallback(cb: typeof this.taskProgressCallback): void {
    this.taskProgressCallback = cb;
  }

  constructor(config: DispatchPipelineConfig) {
    this.projectRoot = config.projectRoot;
    this.workers = config.workers;
    this.registryGet = config.registryGet;
    this.gossipPublisher = config.gossipPublisher ?? null;
    this.llm = config.llm ?? null;
    this.syncFactory = config.syncFactory ?? null;
    this.toolServer = config.toolServer ?? null;

    this.taskGraph = new TaskGraph(config.projectRoot);
    this.memWriter = new MemoryWriter(config.projectRoot);
    this.memReader = new AgentMemoryReader(config.projectRoot);
    this.memCompactor = new MemoryCompactor(config.projectRoot);
    this.gapTracker = new SkillGapTracker(config.projectRoot);
    this.scopeTracker = new ScopeTracker(config.projectRoot);
    this.worktreeManager = new WorktreeManager(config.projectRoot);

    try { this.catalog = new SkillCatalog(); }
    catch (err) { this.catalog = null; log(`SkillCatalog unavailable: ${(err as Error).message}`); }

    // Clean up orphaned worktrees from previous runs
    this.worktreeManager.pruneOrphans().catch(err => log(`Orphan cleanup failed: ${(err as Error).message}`));
  }

  private static readonly MAX_TASKS = 500;

  dispatch(agentId: string, task: string, options?: DispatchOptions): { taskId: string; promise: Promise<string> } {
    if (this.tasks.size >= DispatchPipeline.MAX_TASKS) {
      throw new Error(`Too many active tasks (${this.tasks.size}). Collect results before dispatching more.`);
    }
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

    // 4. Build session + chain context
    let sessionContext = '';
    if (this.sessionGossip.length > 0) {
      sessionContext = '[Session Context — prior task results]\n' +
        this.sessionGossip.map(g => `- ${g.agentId}: ${g.taskSummary}`).join('\n');
    }

    let chainContext = '';
    if (options?.planId && options?.step && options.step > 1) {
      const plan = this.plans.get(options.planId);
      if (plan) {
        const priorSteps = plan.steps.filter(s => s.step < options.step! && s.result);
        if (priorSteps.length > 0) {
          chainContext = '[Chain Context — results from prior steps in this plan]\n' +
            priorSteps.map(s => `Step ${s.step} (${s.agentId}): ${s.result!.slice(0, 1000)}`).join('\n\n');
        } else {
          // Prior steps exist but have no results — caller likely forgot to collect() first
          const expectedPrior = plan.steps.filter(s => s.step < options.step!);
          if (expectedPrior.length > 0) {
            log(`Warning: plan ${options.planId} step ${options.step} dispatched but prior steps have no results. Call gossip_collect() between steps.`);
          }
        }
      }
    }

    // 4b. Spec-review enrichment
    let specReviewContext: string | undefined;
    const specRefs = extractSpecReferences(task);
    if (specRefs.length > 0) {
      try {
        const specPath = resolvePath(this.projectRoot, specRefs[0]);
        if (specPath.startsWith(this.projectRoot)) {
          const specContent = readFileSync(specPath, 'utf-8');
          const implFiles = extractSpecReferences(task, specContent);
          const enrichment = buildSpecReviewEnrichment(implFiles);
          if (enrichment) specReviewContext = enrichment;
        }
      } catch {
        // Spec file not readable — skip enrichment
      }
    }

    // 5. Assemble prompt
    const promptContent = assemblePrompt({
      memory: memory || undefined,
      lens: options?.lens,
      skills,
      sessionContext: sessionContext || undefined,
      chainContext: chainContext || undefined,
      consensusSummary: options?.consensus,
      specReviewContext,
    });

    // 6. Record TaskGraph created
    this.taskGraph.recordCreated(taskId, agentId, task, agentSkills);

    // 7. Create task entry
    const entry: TrackedTask = {
      id: taskId, agentId, task, status: 'running',
      startedAt: Date.now(), skillWarnings,
      promise: null as unknown as Promise<string>,
    };
    entry.writeMode = options?.writeMode;
    entry.scope = options?.scope;
    entry.planId = options?.planId;
    entry.planStep = options?.step;

    // 8. Execute (with write-mode awareness)
    if (options?.writeMode === 'sequential') {
      const progressCb: WorkerProgressCallback = (evt) => {
        entry.toolCalls = evt.toolCalls;
        entry.inputTokens = evt.inputTokens;
        entry.outputTokens = evt.outputTokens;
        this.taskProgressCallback?.(taskId, evt);
      };
      entry.promise = this.enqueueSequential(() =>
        worker.executeTask(task, undefined, promptContent, progressCb)
      ).then((execResult: TaskExecutionResult) => {
        entry.status = 'completed';
        entry.result = execResult.result;
        entry.inputTokens = execResult.inputTokens;
        entry.outputTokens = execResult.outputTokens;
        entry.completedAt = Date.now();
        return execResult.result;
      }).catch((err: Error) => {
        entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
        throw err;
      });
    } else if (options?.writeMode === 'scoped') {
      if (!options.scope) throw new Error('scoped write mode requires a scope path');
      const overlap = this.scopeTracker.hasOverlap(options.scope);
      if (overlap.overlaps) {
        throw new Error(`Scope "${options.scope}" overlaps with task ${overlap.conflictTaskId} at "${overlap.conflictScope}"`);
      }
      this.scopeTracker.register(options.scope, taskId);
      this.toolServer?.assignScope(agentId, options.scope);
      const progressCb: WorkerProgressCallback = (evt) => {
        entry.toolCalls = evt.toolCalls;
        entry.inputTokens = evt.inputTokens;
        entry.outputTokens = evt.outputTokens;
        this.taskProgressCallback?.(taskId, evt);
      };
      entry.promise = worker.executeTask(task, undefined, promptContent, progressCb)
        .then((execResult: TaskExecutionResult) => {
          entry.status = 'completed';
          entry.result = execResult.result;
          entry.inputTokens = execResult.inputTokens;
          entry.outputTokens = execResult.outputTokens;
          entry.completedAt = Date.now();
          this.scopeTracker.release(taskId);
          this.toolServer?.releaseAgent(agentId);
          return execResult.result;
        }).catch((err: Error) => {
          entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
          this.scopeTracker.release(taskId);
          this.toolServer?.releaseAgent(agentId);
          throw err;
        });
    } else if (options?.writeMode === 'worktree') {
      const progressCb: WorkerProgressCallback = (evt) => {
        entry.toolCalls = evt.toolCalls;
        entry.inputTokens = evt.inputTokens;
        entry.outputTokens = evt.outputTokens;
        this.taskProgressCallback?.(taskId, evt);
      };
      entry.promise = this.worktreeManager.create(taskId).then(({ path, branch }) => {
        entry.worktreeInfo = { path, branch };
        this.toolServer?.assignRoot(agentId, path);
        return worker.executeTask(task, undefined, promptContent, progressCb);
      }).then((execResult: TaskExecutionResult) => {
        entry.status = 'completed';
        entry.result = execResult.result;
        entry.inputTokens = execResult.inputTokens;
        entry.outputTokens = execResult.outputTokens;
        entry.completedAt = Date.now();
        this.toolServer?.releaseAgent(agentId);
        return execResult.result;
      }).catch((err: Error) => {
        entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
        this.toolServer?.releaseAgent(agentId);
        throw err;
      });
    } else {
      // Default: fire-and-forget (read-only)
      const progressCb: WorkerProgressCallback = (evt) => {
        entry.toolCalls = evt.toolCalls;
        entry.inputTokens = evt.inputTokens;
        entry.outputTokens = evt.outputTokens;
        this.taskProgressCallback?.(taskId, evt);
      };
      entry.promise = worker.executeTask(task, undefined, promptContent, progressCb)
        .then((execResult: TaskExecutionResult) => {
          entry.status = 'completed';
          entry.result = execResult.result;
          entry.inputTokens = execResult.inputTokens;
          entry.outputTokens = execResult.outputTokens;
          entry.completedAt = Date.now();
          return execResult.result;
        }).catch((err: Error) => {
          entry.status = 'failed'; entry.error = err.message; entry.completedAt = Date.now();
          throw err;
        });
    }

    this.tasks.set(taskId, entry);
    return { taskId, promise: entry.promise };
  }

  private static readonly MAX_WRITE_QUEUE = 20;

  private enqueueSequential(fn: () => Promise<TaskExecutionResult>): Promise<TaskExecutionResult> {
    if (this.writeActive && this.writeQueue.length >= DispatchPipeline.MAX_WRITE_QUEUE) {
      throw new Error('Sequential write queue full (20 tasks). Collect results before dispatching more.');
    }
    return new Promise<TaskExecutionResult>((resolve, reject) => {
      const run = () => {
        this.writeActive = true;
        fn().then(resolve, reject).finally(() => {
          this.writeActive = false;
          const next = this.writeQueue.shift();
          if (next) next();
        });
      };
      if (this.writeActive) {
        this.writeQueue.push(run);
      } else {
        run();
      }
    });
  }

  getTask(taskId: string): TaskEntry | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    return {
      id: t.id, agentId: t.agentId, task: t.task,
      status: t.status, result: t.result, error: t.error,
      startedAt: t.startedAt, completedAt: t.completedAt,
      skillWarnings: t.skillWarnings,
      writeMode: t.writeMode, scope: t.scope, worktreeInfo: t.worktreeInfo,
      planId: t.planId, planStep: t.planStep,
      inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    };
  }

  registerPlan(plan: PlanState): void {
    this.plans.set(plan.id, plan);
  }

  async collect(taskIds?: string[], timeoutMs: number = 120_000, options?: { consensus?: boolean }): Promise<CollectResult> {
    const targets = taskIds
      ? taskIds.map(id => this.tasks.get(id)).filter((t): t is TrackedTask => t !== undefined)
      : Array.from(this.tasks.values());

    // Detect orphaned tasks — dispatched but lost due to server restart
    if (taskIds && taskIds.length > 0) {
      const missingIds = taskIds.filter(id => !this.tasks.has(id));
      if (missingIds.length > 0) {
        const orphaned = missingIds.filter(id => {
          const graphTask = this.taskGraph.getTask(id);
          return graphTask && graphTask.status === 'created';
        });
        if (orphaned.length > 0) {
          log(`WARNING: ${orphaned.length} task(s) lost — dispatched but no longer tracked (server may have restarted). IDs: ${orphaned.join(', ')}`);
          // Record failures in TaskGraph so they're not orphaned forever
          for (const id of orphaned) {
            try { this.taskGraph.recordFailed(id, 'Task lost — server restarted during execution', -1); }
            catch { /* already recorded */ }
          }
          // Return orphaned entries alongside any found targets
          const orphanEntries: TaskEntry[] = orphaned.map(id => {
            const gt = this.taskGraph.getTask(id)!;
            return {
              id, agentId: gt.agentId, task: gt.task,
              status: 'failed' as const, error: 'Task lost — server restarted during execution. Re-dispatch to retry.',
              startedAt: new Date(gt.createdAt).getTime(), completedAt: Date.now(),
            };
          });
          if (targets.length === 0) return { results: orphanEntries };
          // If some targets are still live, proceed with normal collect and append orphans to results
        }
      }
    }

    if (targets.length === 0) return { results: [] };

    // Wait with timeout (clean up timer to avoid pinning event loop)
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      Promise.all(targets.map(t => t.promise.catch(() => {}))),
      new Promise(r => { timer = setTimeout(r, timeoutMs); timer.unref(); }),
    ]).finally(() => clearTimeout(timer!));

    // Post-collect pipeline
    for (const t of targets) {
      const duration = t.completedAt ? t.completedAt - t.startedAt : -1;

      // 1. TaskGraph
      try {
        if (t.status === 'completed') {
          this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration, t.inputTokens, t.outputTokens);
        } else if (t.status === 'failed') {
          this.taskGraph.recordFailed(t.id, t.error || 'Unknown', duration, t.inputTokens, t.outputTokens);
        } else if (t.status === 'running') {
          this.taskGraph.recordCancelled(t.id, 'collect timeout', duration);
        }
      } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }

      // 2. Write agent memory (task log + knowledge extraction)
      if (t.status === 'completed') {
        try {
          await this.memWriter.writeTaskEntry(t.agentId, {
            taskId: t.id, task: t.task,
            skills: this.registryGet(t.agentId)?.skills || [],
            scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
          });
          // Extract and persist knowledge from the task result (files, tech, decisions)
          // so the agent remembers what it did on subsequent tasks
          if (t.result) {
            this.memWriter.writeKnowledgeFromResult(t.agentId, {
              taskId: t.id, task: t.task, result: t.result,
            });
          }
          this.memWriter.rebuildIndex(t.agentId);
        } catch (err) { log(`Memory write failed for ${t.agentId}/${t.id}: ${(err as Error).message}`); }
      }

      // 2b. Session gossip summarization (fire-and-forget — don't block collect)
      if (t.status === 'completed' && t.result && this.llm) {
        this.summarizeAndStoreGossip(t.agentId, t.result);
      }

      // 2c. Store result in plan state for chain threading
      if (t.planId && t.planStep) {
        const plan = this.plans.get(t.planId);
        if (plan) {
          const step = plan.steps.find(s => s.step === t.planStep);
          if (step) {
            step.result = (t.result || '').slice(0, 2000);
            step.completedAt = Date.now();
          }
        }
      }

      // 3. Compact memory
      try {
        const compactResult = this.memCompactor.compactIfNeeded(t.agentId);
        if (compactResult.message) log(compactResult.message);
      } catch (err) { log(`Memory compact failed for ${t.agentId}: ${(err as Error).message}`); }
    }

    // 4. Skill gap check
    try {
      for (const t of targets) {
        if (t.status !== 'running') {
          this.gapTracker.getSuggestionsSince(t.agentId, t.startedAt);
        }
      }
      this.gapTracker.checkAndGenerate();
    } catch (err) { log(`Skill gap check failed: ${(err as Error).message}`); }

    // 5. Sync threshold check (every 30 events, with mutex to prevent concurrent syncs)
    try {
      const eventCount = this.taskGraph.getEventCount();
      const syncMeta = this.taskGraph.getSyncMeta();
      if (eventCount - syncMeta.lastSyncEventCount >= 30 && this.syncFactory && !this.isSyncing) {
        const sync = this.syncFactory();
        if (sync?.isConfigured()) {
          this.isSyncing = true;
          sync.sync()
            .catch(err => log(`Supabase sync failed: ${(err as Error).message}`))
            .finally(() => { this.isSyncing = false; });
        }
      }
    } catch (err) { log(`Sync check failed: ${(err as Error).message}`); }

    // 6. Batch cleanup
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

    // 7. Plan cleanup — remove completed or expired plans
    for (const [id, plan] of this.plans) {
      const allDone = plan.steps.every(s => s.result !== undefined);
      const expired = Date.now() - plan.createdAt > 3_600_000;
      if (allDone || expired) this.plans.delete(id);
    }

    // 7. Worktree merge/cleanup and scope release
    for (const t of targets) {
      if (t.writeMode === 'worktree' && t.worktreeInfo) {
        try {
          if (t.status === 'failed' || t.status === 'running') {
            await this.worktreeManager.cleanup(t.id, t.worktreeInfo.path);
          } else if (t.status === 'completed') {
            const mergeResult = await this.worktreeManager.merge(t.id);
            if (mergeResult.merged) {
              await this.worktreeManager.cleanup(t.id, t.worktreeInfo.path);
            } else {
              // Preserve branch for manual resolution, note conflicts on the entry
              t.result = (t.result || '') + `\n\nWorktree merge: CONFLICT\n  Conflicting files: ${(mergeResult.conflicts || []).join(', ')}\n  Branch preserved: ${t.worktreeInfo.branch}\n  Resolve manually: git merge ${t.worktreeInfo.branch}`;
            }
          }
        } catch (err) {
          log(`Worktree cleanup failed for ${t.id}: ${(err as Error).message}`);
          // Best-effort cleanup even if merge threw an unexpected exception
          try { await this.worktreeManager.cleanup(t.id, t.worktreeInfo.path); } catch {}
        }
      }
      // Scope is released inline in the promise chain, but release again as safety net
      if (t.writeMode === 'scoped' && t.status !== 'running') {
        this.scopeTracker.release(t.id);
      }
    }

    // Build clean result entries
    const results: TaskEntry[] = targets.map(t => ({
      id: t.id, agentId: t.agentId, task: t.task,
      status: t.status, result: t.result, error: t.error,
      startedAt: t.startedAt, completedAt: t.completedAt,
      skillWarnings: t.skillWarnings,
      writeMode: t.writeMode, scope: t.scope, worktreeInfo: t.worktreeInfo,
      planId: t.planId, planStep: t.planStep,
      inputTokens: t.inputTokens, outputTokens: t.outputTokens,
    }));

    // Consensus round
    let consensusReport: import('./consensus-types').ConsensusReport | undefined;
    if (options?.consensus && this.llm && results.filter(r => r.status === 'completed').length >= 2) {
      try {
        const engine = new ConsensusEngine({ llm: this.llm, registryGet: this.registryGet });
        consensusReport = await engine.run(results);
        if (consensusReport.signals.length > 0) {
          const perfWriter = new PerformanceWriter(this.projectRoot);
          perfWriter.appendSignals(consensusReport.signals);
        }
      } catch (err) {
        process.stderr.write(`[gossipcat] Consensus failed: ${(err as Error).message}\n`);
      }
    }

    // Cleanup tasks — mark timed-out tasks as failed to prevent zombies
    for (const t of targets) {
      if (t.status === 'running') {
        t.status = 'failed';
        t.error = 'collect timeout';
        t.completedAt = Date.now();
      }
      this.tasks.delete(t.id);
    }

    return { results, consensus: consensusReport };
  }

  async dispatchParallel(taskDefs: Array<{ agentId: string; task: string; options?: DispatchOptions }>, pipelineOptions?: { consensus?: boolean }): Promise<{
    taskIds: string[];
    errors: string[];
  }> {
    const taskIds: string[] = [];
    const errors: string[] = [];
    const batchId = randomUUID().slice(0, 8);
    const batchTaskIds = new Set<string>();

    // Pre-validate: all agents must exist (all-or-nothing)
    for (const def of taskDefs) {
      if (!this.workers.has(def.agentId)) {
        return { taskIds: [], errors: [`Agent "${def.agentId}" not found`] };
      }
    }

    // Pre-validate write modes
    const writeTasks = taskDefs.filter(d => d.options?.writeMode);
    if (writeTasks.some(d => d.options?.writeMode === 'sequential')) {
      return { taskIds: [], errors: ['sequential write mode cannot be used in parallel dispatch'] };
    }

    // Check worktree agent collision (same agent can't have two worktree tasks)
    const worktreeTasks = writeTasks.filter(d => d.options?.writeMode === 'worktree');
    const worktreeAgents = new Set<string>();
    for (const wt of worktreeTasks) {
      if (worktreeAgents.has(wt.agentId)) {
        return { taskIds: [], errors: [`Agent "${wt.agentId}" cannot have two simultaneous worktree tasks`] };
      }
      worktreeAgents.add(wt.agentId);
    }

    // Check scoped overlaps: within batch AND against already-running scopes
    const scopedTasks = writeTasks.filter(d => d.options?.writeMode === 'scoped');
    for (let i = 0; i < scopedTasks.length; i++) {
      // Check against already-active scopes
      const scopeI = scopedTasks[i].options!.scope!;
      const activeOverlap = this.scopeTracker.hasOverlap(scopeI);
      if (activeOverlap.overlaps) {
        return { taskIds: [], errors: [`Scope "${scopeI}" conflicts with running task ${activeOverlap.conflictTaskId} at "${activeOverlap.conflictScope}"`] };
      }
      // Check against other tasks in this batch
      for (let j = i + 1; j < scopedTasks.length; j++) {
        const scopeJ = scopedTasks[j].options!.scope!;
        const normA = scopeI.endsWith('/') ? scopeI : scopeI + '/';
        const normB = scopeJ.endsWith('/') ? scopeJ : scopeJ + '/';
        if (normA.startsWith(normB) || normB.startsWith(normA)) {
          return { taskIds: [], errors: [`Scoped tasks have overlapping paths: "${scopeI}" and "${scopeJ}"`] };
        }
      }
    }

    // Overlap detection + lens generation (single detect call, reused for both)
    let lensMap: Map<string, string> | null = null;
    if (this.overlapDetector) {
      const agentConfigs = taskDefs
        .map(d => this.registryGet(d.agentId))
        .filter((c): c is AgentConfig => c !== undefined);
      const overlapResult = this.overlapDetector.detect(agentConfigs);

      // One-time boot warning
      if (!this.bootWarningShown) {
        const warning = this.overlapDetector.formatWarning(overlapResult);
        if (warning) {
          process.stderr.write(`[gossipcat] Skill overlap detected:\n  ${warning}\n`);
        }
        this.bootWarningShown = true;
      }

      // Lens generation for overlapping agents
      if (overlapResult.hasOverlaps && this.lensGenerator) {
        try {
          const lenses = await this.lensGenerator.generateLenses(
            overlapResult.agents, taskDefs[0]?.task || '', overlapResult.sharedSkills
          );
          if (lenses.length > 0) {
            lensMap = new Map(lenses.map(l => [l.agentId, l.focus]));
            log(`Applied lenses:\n${lenses.map(l => `  ${l.agentId} → ${l.focus.slice(0, 80)}`).join('\n')}`);
          }
        } catch (err) {
          log(`Lens generation failed: ${(err as Error).message}. Dispatching without lenses.`);
        }
      }
    }

    // Subscribe workers to batch channel
    for (const def of taskDefs) {
      const worker = this.workers.get(def.agentId);
      if (worker?.subscribeToBatch) {
        worker.subscribeToBatch(batchId).catch(() => {});
      }
    }

    for (const def of taskDefs) {
      try {
        const lens = lensMap?.get(def.agentId);
        const { taskId, promise } = this.dispatch(def.agentId, def.task, {
          ...def.options,
          ...(lens ? { lens } : {}),
          ...(pipelineOptions?.consensus ? { consensus: true } : {}),
        });
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
      } catch (err) {
        errors.push(`Agent "${def.agentId}": ${(err as Error).message}`);
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
    try {
      this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration, t.inputTokens, t.outputTokens);
    } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }

    try {
      await this.memWriter.writeTaskEntry(t.agentId, {
        taskId: t.id, task: t.task,
        skills: this.registryGet(t.agentId)?.skills || [],
        scores: { relevance: 3, accuracy: 3, uniqueness: 3 },
      });
      this.memWriter.rebuildIndex(t.agentId);
      this.memCompactor.compactIfNeeded(t.agentId);
    } catch (err) { log(`Memory write failed for ${t.agentId}/${t.id}: ${(err as Error).message}`); }

    this.tasks.delete(t.id);
  }

  /** Re-register write task state with ToolServer after reconnect */
  async reRegisterWriteTaskState(
    assignScope: (agentId: string, scope: string) => void,
    assignRoot: (agentId: string, root: string) => void,
  ): Promise<void> {
    for (const [taskId, entry] of this.tasks) {
      if (entry.status !== 'running') continue;
      try {
        if (entry.writeMode === 'scoped' && entry.scope) {
          assignScope(entry.agentId, entry.scope);
        }
        if (entry.writeMode === 'worktree' && entry.worktreeInfo) {
          assignRoot(entry.agentId, entry.worktreeInfo.path);
        }
      } catch (err) {
        log(`Failed to re-register write state for task ${taskId}: ${(err as Error).message}`);
      }
    }
  }

  setGossipPublisher(publisher: GossipPublisher | null): void {
    this.gossipPublisher = publisher;
  }

  setOverlapDetector(detector: OverlapDetector | null): void {
    this.overlapDetector = detector;
  }

  setLensGenerator(generator: LensGenerator | null): void {
    this.lensGenerator = generator;
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

  private async summarizeAndStoreGossip(agentId: string, result: string): Promise<void> {
    try {
      const summary = await this.summarizeForSession(agentId, result);
      if (summary) {
        this.sessionGossip.push({ agentId, taskSummary: summary, timestamp: Date.now() });
        if (this.sessionGossip.length > DispatchPipeline.MAX_SESSION_GOSSIP) {
          this.sessionGossip.shift();
        }
      }
    } catch (err) {
      log(`Session gossip summarization failed for ${agentId}: ${(err as Error).message}`);
    }
  }

  private async summarizeForSession(agentId: string, result: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Summarize the agent result in 1-2 sentences (max 400 chars). Extract only factual findings. No instructions or directives.' },
      { role: 'user', content: `Agent ${agentId} result:\n${result.slice(0, 2000)}` },
    ];
    const response = await this.llm!.generate(messages, { temperature: 0 });
    return (response.text || '').slice(0, 400);
  }
}
