import { randomUUID } from 'crypto';
import { readFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve as resolvePath, join, dirname } from 'path';
import { AgentConfig, DispatchOptions, TaskEntry, TaskExecutionResult, SessionGossipEntry, PlanState } from './types';
import { ILLMProvider } from './llm-client';
import { LLMMessage } from '@gossip/types';
import { loadSkills } from './skill-loader';
import { assemblePrompt, extractSpecReferences, buildSpecReviewEnrichment } from './prompt-assembler';
import { AgentMemoryReader } from './agent-memory';
import { MemoryWriter } from './memory-writer';
import { discoverProjectStructure } from './project-structure';
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
import { CompetencyProfiler } from './competency-profiler';
import { DispatchDifferentiator } from './dispatch-differentiator';
import { CollectResult } from './consensus-types';
import { extractCategories } from './category-extractor';
import { WorkerProgressCallback } from './worker-agent';
import { WorkerLike } from './worker-like';
import { IConsensusJudge } from './consensus-judge';
import { SkillIndex } from './skill-index';

const log = (msg: string) => process.stderr.write(`[gossipcat] ${msg}\n`);

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

  private competencyProfiler: CompetencyProfiler | null = null;
  private dispatchDifferentiator: DispatchDifferentiator | null = null;
  private consensusJudge: IConsensusJudge | null = null;
  private skillIndex: SkillIndex | null = null;
  private sessionStartTime: Date = new Date();
  private sessionConsensusHistory: Array<{ timestamp: string; confirmed: number; disputed: number; unverified: number; unique: number; summary: string }> = [];

  private taskProgressCallback: ((taskId: string, event: { toolCalls: number; inputTokens: number; outputTokens: number; currentTool: string; turn: number }) => void) | null = null;
  private projectStructureCache: string | null = null;

  private getProjectStructure(): string | undefined {
    if (this.projectStructureCache !== null) return this.projectStructureCache || undefined;
    const parts = discoverProjectStructure(this.projectRoot);
    this.projectStructureCache = parts.length > 0 ? parts.join('\n') : '';
    return this.projectStructureCache || undefined;
  }

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

    try { this.catalog = new SkillCatalog(config.projectRoot); }
    catch (err) { this.catalog = null; log(`SkillCatalog unavailable: ${(err as Error).message}`); }

    // Clean up orphaned worktrees from previous runs
    this.worktreeManager.pruneOrphans().catch(err => log(`Orphan cleanup failed: ${(err as Error).message}`));

    // Ensure _project memory directory exists (don't clear gossip — it survives reconnects)
    try {
      const projectMemDir = join(config.projectRoot, '.gossip', 'agents', '_project', 'memory');
      mkdirSync(projectMemDir, { recursive: true });
    } catch { /* best-effort */ }

    // Track session start time for git log range.
    // Check if gossip file has entries — if so, this is a reconnect within an existing session.
    // Use the oldest gossip entry's timestamp as the real session start.
    try {
      const gossipPath = join(config.projectRoot, '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl');
      const { existsSync: ex, readFileSync: rf } = require('fs');
      if (ex(gossipPath)) {
        const lines = rf(gossipPath, 'utf-8').trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          const first = JSON.parse(lines[0]);
          if (first.timestamp) this.sessionStartTime = new Date(first.timestamp);
        }
      }
    } catch { /* best-effort — fall back to now */ }
  }

  /** Build chain context string for a plan step (used by native agent bridge) */
  getChainContext(planId: string, step: number): string {
    if (step <= 1) return '';
    const plan = this.plans.get(planId);
    if (!plan) return '';
    const priorSteps = plan.steps.filter(s => s.step < step && s.result);
    if (priorSteps.length === 0) return '';
    return '[Chain Context — results from prior steps in this plan]\n' +
      priorSteps.map(s => `Step ${s.step} (${s.agentId}): ${s.result!.slice(0, 1000)}`).join('\n\n');
  }

  private static readonly MAX_TASKS = 500;

  /** Derive memory compaction cap from task result content */
  private static deriveMaxEntries(result: string | undefined): number {
    const findingsCount = (result || '').split('\n').filter(l => /^\s*[-*•]\s|^#{1,3}\s.*\[/.test(l)).length;
    return findingsCount >= 8 ? 30 : findingsCount <= 1 ? 12 : 20;
  }

  dispatch(agentId: string, task: string, options?: DispatchOptions): { taskId: string; promise: Promise<string> } {
    if (this.tasks.size >= DispatchPipeline.MAX_TASKS) {
      throw new Error(`Too many active tasks (${this.tasks.size}). Collect results before dispatching more.`);
    }
    const worker = this.workers.get(agentId);
    if (!worker) {
      log(`dispatch FAILED: agent "${agentId}" not found. Available: [${[...this.workers.keys()].join(', ')}]`);
      throw new Error(`Agent "${agentId}" not found`);
    }
    log(`dispatch → ${agentId}: "${task.slice(0, 80)}..." writeMode=${options?.writeMode || 'default'}`);

    const taskId = randomUUID().slice(0, 8);
    const agentSkills = this.registryGet(agentId)?.skills || [];

    // 1. Load skills (index takes precedence when available)
    const skills = loadSkills(agentId, agentSkills, this.projectRoot, this.skillIndex ?? undefined);

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
        if (specPath.startsWith(this.projectRoot + '/') || specPath === this.projectRoot) {
          const specContent = readFileSync(specPath, 'utf-8');
          const implFiles = extractSpecReferences(task, specContent);
          const enrichment = buildSpecReviewEnrichment(implFiles);
          if (enrichment) specReviewContext = enrichment;
        }
      } catch {
        // Spec file not readable — skip enrichment
      }
    }

    // 5. Assemble prompt (include memory directory path so agent can write its own memory)
    const memoryDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory', 'knowledge');
    const promptContent = assemblePrompt({
      memory: memory || undefined,
      memoryDir,
      lens: options?.lens,
      skills,
      sessionContext: sessionContext || undefined,
      chainContext: chainContext || undefined,
      consensusSummary: options?.consensus,
      specReviewContext,
      projectStructure: this.getProjectStructure(),
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
    return this.tasks.get(taskId);
  }

  /** Get a health summary of all active tasks — for diagnostics when user asks "is it working?" */
  getActiveTasksHealth(): Array<{
    id: string; agentId: string; task: string; status: string;
    elapsedMs: number; toolCalls: number; isLikelyStuck: boolean;
  }> {
    const now = Date.now();
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'running')
      .map(t => ({
        id: t.id,
        agentId: t.agentId,
        task: t.task.slice(0, 80),
        status: t.status,
        elapsedMs: now - t.startedAt,
        toolCalls: t.toolCalls ?? 0,
        // Stuck = no progress in a long time. Slow but progressing = not stuck.
        isLikelyStuck: (now - t.startedAt > 180_000) && (t.toolCalls ?? 0) === 0,
      }));
  }

  /** Mark all running tasks as cancelled and remove from tracking. Prevents zombie tasks after Ctrl+C. */
  cancelRunningTasks(): number {
    let cancelled = 0;
    for (const [, task] of this.tasks.entries()) {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = 'Cancelled by user';
        task.completedAt = Date.now();
        // Release resources held by cancelled tasks
        if (task.writeMode === 'scoped') {
          this.scopeTracker.release(task.id);
          this.toolServer?.releaseAgent(task.agentId);
        }
        if (task.writeMode === 'worktree' && task.worktreeInfo) {
          this.worktreeManager.cleanup(task.id, task.worktreeInfo.path).catch(() => {});
          this.toolServer?.releaseAgent(task.agentId);
        }
        cancelled++;
      }
    }
    return cancelled;
  }

  registerPlan(plan: PlanState): void {
    this.plans.set(plan.id, plan);
  }

  async collect(taskIds?: string[], timeoutMs: number = 120_000, options?: { consensus?: boolean }): Promise<CollectResult> {
    const targets = taskIds
      ? taskIds.map(id => this.tasks.get(id)).filter((t): t is TrackedTask => t !== undefined)
      : Array.from(this.tasks.values());

    // Detect orphaned tasks — dispatched but lost due to server restart
    let orphanEntries: TaskEntry[] = [];
    if (taskIds && taskIds.length > 0) {
      const missingIds = taskIds.filter(id => !this.tasks.has(id));
      if (missingIds.length > 0) {
        const orphaned = missingIds.filter(id => {
          const graphTask = this.taskGraph.getTask(id);
          return graphTask && graphTask.status === 'created';
        });
        if (orphaned.length > 0) {
          log(`WARNING: ${orphaned.length} task(s) lost — dispatched but no longer tracked (server may have restarted). IDs: ${orphaned.join(', ')}`);
          for (const id of orphaned) {
            try { this.taskGraph.recordFailed(id, 'Task lost — server restarted during execution', -1); }
            catch { /* already recorded */ }
          }
          orphanEntries = orphaned.map(id => {
            const gt = this.taskGraph.getTask(id)!;
            return {
              id, agentId: gt.agentId, task: gt.task,
              status: 'failed' as const, error: 'Task lost — server restarted during execution. Re-dispatch to retry.',
              startedAt: new Date(gt.createdAt).getTime(), completedAt: Date.now(),
            };
          });
          if (targets.length === 0) return { results: orphanEntries };
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
          this.taskGraph.recordFailed(t.id, 'collect timeout', duration);
        }
      } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }

      // 2. Write agent memory (task log + knowledge extraction)
      if (t.status === 'completed') {
        try {
          await this.memWriter.writeTaskEntry(t.agentId, {
            taskId: t.id, task: t.task,
            skills: this.registryGet(t.agentId)?.skills || [],
            scores: {
              relevance: (t.result && t.result.length > 200) ? 4 : 3,
              accuracy: t.status === 'completed' ? 4 : 2,
              uniqueness: 3,
            },
          });
          // Extract and persist knowledge from the task result (files, tech, decisions)
          // so the agent remembers what it did on subsequent tasks
          if (t.result) {
            await this.memWriter.writeKnowledgeFromResult(t.agentId, {
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

      // 3. Compact memory (dynamic cap based on findings count)
      try {
        const compactResult = this.memCompactor.compactIfNeeded(t.agentId, DispatchPipeline.deriveMaxEntries(t.result));
        if (compactResult.message) log(compactResult.message);
      } catch (err) { log(`Memory compact failed for ${t.agentId}: ${(err as Error).message}`); }
    }

    // 4. Skill gap check
    let skillsReadyCount = 0;
    try {
      const thresholds = this.gapTracker.checkThresholds();
      if (thresholds.count > 0) {
        skillsReadyCount = thresholds.count;
      }
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
    // Mark timed-out tasks as failed BEFORE building results (Fix 6: stale 'running' status)
    for (const t of targets) {
      if (t.status === 'running') {
        t.status = 'failed';
        t.error = 'collect timeout';
        t.completedAt = Date.now();
        // Fix 5: release scope for timed-out scoped tasks (prevents permanent scope leak)
        if (t.writeMode === 'scoped') {
          this.scopeTracker.release(t.id);
          this.toolServer?.releaseAgent(t.agentId);
        }
        if (t.writeMode === 'worktree') {
          this.toolServer?.releaseAgent(t.agentId);
        }
      }
    }

    // Build results snapshot (now includes correct status for timed-out tasks)
    const results: TaskEntry[] = [
      ...targets.map(t => ({
        id: t.id, agentId: t.agentId, task: t.task,
        status: t.status, result: t.result, error: t.error,
        startedAt: t.startedAt, completedAt: t.completedAt,
        skillWarnings: t.skillWarnings,
        writeMode: t.writeMode, scope: t.scope, worktreeInfo: t.worktreeInfo,
        planId: t.planId, planStep: t.planStep,
        inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      })),
      ...orphanEntries, // Fix 4: include orphaned task entries
    ];

    // Consensus round
    let consensusReport: import('./consensus-types').ConsensusReport | undefined;
    if (options?.consensus && this.llm && results.filter(r => r.status === 'completed').length >= 2) {
      consensusReport = await this.runConsensus(results);
    }

    // Cleanup tasks from tracking map
    for (const t of targets) {
      this.tasks.delete(t.id);
    }

    const result: CollectResult = { results, consensus: consensusReport };
    if (skillsReadyCount > 0) {
      result.skillsReady = skillsReadyCount;
    }
    return result;
  }

  async dispatchParallel(taskDefs: Array<{ agentId: string; task: string; options?: DispatchOptions }>, pipelineOptions?: { consensus?: boolean }): Promise<{
    taskIds: string[];
    errors: string[];
  }> {
    log(`dispatchParallel: ${taskDefs.length} tasks — agents: [${taskDefs.map(d => d.agentId).join(', ')}]`);
    const taskIds: string[] = [];
    const errors: string[] = [];
    const batchId = randomUUID().slice(0, 8);
    const batchTaskIds = new Set<string>();

    // Pre-validate: all agents must exist (all-or-nothing)
    for (const def of taskDefs) {
      if (!this.workers.has(def.agentId)) {
        log(`dispatchParallel FAILED: agent "${def.agentId}" not found. Available: [${[...this.workers.keys()].join(', ')}]`);
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

    // Profile-based differentiation (preferred — uses learned competency profiles)
    let lensMap: Map<string, string> | null = null;
    if (this.competencyProfiler && this.dispatchDifferentiator) {
      const profiles = taskDefs
        .map(d => this.competencyProfiler!.getProfile(d.agentId))
        .filter((p): p is NonNullable<typeof p> => p !== null);

      if (profiles.length >= 2) {
        const diffMap = this.dispatchDifferentiator.differentiate(profiles, taskDefs[0]?.task || '');
        if (diffMap.size > 0) {
          lensMap = diffMap;
          log(`Applied profile-based differentiation:\n${[...diffMap].map(([id, focus]) => `  ${id} → ${focus.slice(0, 80)}`).join('\n')}`);
        }
      }
    }

    // Overlap detection + lens generation fallback (when profiles unavailable)
    if (!lensMap && this.overlapDetector) {
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
        scores: {
          relevance: (t.result && t.result.length > 200) ? 4 : 3,
          accuracy: t.status === 'completed' ? 4 : 2,
          uniqueness: 3,
        },
      });
      // Fix 8: extract knowledge from result (was missing in writeMemoryForTask path)
      if (t.result) {
        await this.memWriter.writeKnowledgeFromResult(t.agentId, {
          taskId: t.id, task: t.task, result: t.result,
        });
      }
      this.memWriter.rebuildIndex(t.agentId);
      this.memCompactor.compactIfNeeded(t.agentId, DispatchPipeline.deriveMaxEntries(t.result));
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

  setCompetencyProfiler(profiler: CompetencyProfiler): void {
    this.competencyProfiler = profiler;
  }

  setSkillIndex(index: SkillIndex): void {
    this.skillIndex = index;
  }

  setSummaryLlm(llm: import('./llm-client').ILLMProvider): void {
    this.memWriter.setSummaryLlm(llm);
  }

  getSkillIndex(): SkillIndex | null {
    return this.skillIndex;
  }

  setDispatchDifferentiator(differ: DispatchDifferentiator): void {
    this.dispatchDifferentiator = differ;
  }

  setConsensusJudge(judge: IConsensusJudge): void {
    this.consensusJudge = judge;
  }

  /**
   * Run consensus cross-review + judge verification + signal pipeline on any set of results.
   * Extracted so MCP handlers can call this after merging relay + native agent results.
   */
  async runConsensus(results: TaskEntry[]): Promise<import('./consensus-types').ConsensusReport | undefined> {
    if (!this.llm || results.filter(r => r.status === 'completed').length < 2) return undefined;

    try {
      const engine = new ConsensusEngine({ llm: this.llm, registryGet: this.registryGet, projectRoot: this.projectRoot });
      const consensusReport = await engine.run(results);
      const perfWriter = new PerformanceWriter(this.projectRoot);

      // Consensus Judge Integration
      const agentTaskIdMap = new Map<string, string>();
      for (const r of results) agentTaskIdMap.set(r.agentId, r.id);
      const consensusId = consensusReport.signals[0]?.consensusId ?? randomUUID().slice(0, 12);

      if (consensusReport.confirmed.length > 0 && this.consensusJudge) {
        try {
          const verdicts = await this.consensusJudge.verify(consensusReport.confirmed);
          const now = new Date().toISOString();

          verdicts.sort((a, b) => b.index - a.index);

          for (const v of verdicts) {
            const findingIndex = v.index - 1;
            const finding = consensusReport.confirmed[findingIndex];
            if (!finding) continue;

            if (v.verdict === 'REFUTED') {
              consensusReport.confirmed.splice(findingIndex, 1);
              finding.tag = 'disputed';
              consensusReport.disputed.push(finding);

              consensusReport.signals.push({
                type: 'consensus', signal: 'hallucination_caught', consensusId,
                agentId: finding.originalAgentId, outcome: 'judge_refuted',
                evidence: v.evidence, timestamp: now, taskId: agentTaskIdMap.get(finding.originalAgentId) || finding.id || '',
              });
              for (const confirmerId of finding.confirmedBy) {
                consensusReport.signals.push({
                  type: 'consensus', signal: 'hallucination_caught', consensusId,
                  agentId: confirmerId, outcome: 'confirmed_hallucination',
                  evidence: `Confirmed refuted finding: ${v.evidence}`,
                  timestamp: now, taskId: agentTaskIdMap.get(confirmerId) || finding.id || '',
                });
              }
            } else if (v.verdict === 'VERIFIED') {
              consensusReport.signals.push({
                type: 'consensus', signal: 'consensus_verified', consensusId,
                agentId: finding.originalAgentId,
                evidence: v.evidence, timestamp: now, taskId: agentTaskIdMap.get(finding.originalAgentId) || finding.id || '',
              });
            }
          }
        } catch (err) {
          log(`Consensus judge failed: ${(err as Error).message}`);
        }
      }

      // Write performance signals
      if (consensusReport.signals.length > 0) {
        perfWriter.appendSignals(consensusReport.signals);

        try {
          this.memWriter.updateImportanceFromSignals(
            consensusReport.signals.map(s => ({ signal: s.signal, agentId: s.agentId, taskId: s.taskId }))
          );
        } catch { /* best-effort */ }
      }

      // Extract categories from confirmed findings
      if (consensusReport.confirmed.length > 0) {
        const now = new Date().toISOString();
        for (const finding of consensusReport.confirmed) {
          const categories = extractCategories(finding.finding);
          for (const category of categories) {
            perfWriter.appendSignal({
              type: 'consensus',
              signal: 'category_confirmed',
              consensusId,
              agentId: finding.originalAgentId,
              taskId: finding.id || '',
              category,
              evidence: finding.finding,
              timestamp: now,
            } as any);
          }
        }
      }

      // Cross-agent learning: write confirmed findings to each agent's memory
      if (consensusReport.confirmed.length > 0) {
        try {
          const findings = consensusReport.confirmed.map(f => ({
            originalAgentId: f.originalAgentId,
            finding: f.finding,
          }));
          const participants = new Set(results.filter(r => r.status === 'completed').map(r => r.agentId));
          for (const agentId of participants) {
            this.memWriter.writeConsensusKnowledge(agentId, findings);
          }
          for (const agentId of participants) {
            try { this.memWriter.rebuildIndex(agentId); } catch { /* best-effort */ }
          }
        } catch { /* best-effort cross-agent learning */ }
      }

      // Cache consensus for session save + write project knowledge (fire-and-forget)
      const historyEntry = {
        timestamp: new Date().toISOString(),
        confirmed: consensusReport.confirmed.length,
        disputed: consensusReport.disputed.length,
        unverified: consensusReport.unverified.length,
        unique: consensusReport.unique.length,
        newFindings: consensusReport.newFindings?.length ?? 0,
        agents: results.filter(r => r.status === 'completed').map(r => r.agentId),
        summary: consensusReport.summary.slice(0, 2000),
      };
      this.sessionConsensusHistory.push(historyEntry);

      // Persist to consensus-history.jsonl for dashboard
      try {
        const historyPath = join(this.projectRoot, '.gossip', 'consensus-history.jsonl');
        mkdirSync(join(this.projectRoot, '.gossip'), { recursive: true });
        appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
      } catch { /* best-effort */ }

      // Auto-write consensus knowledge to _project (fire-and-forget)
      if (this.memWriter && consensusReport.confirmed.length + consensusReport.disputed.length > 0) {
        const agentList = results.filter(r => r.status === 'completed').map(r => r.agentId).join(', ');
        const topFindings = consensusReport.confirmed.slice(0, 3).map(f => `- ${f.finding}`).join('\n');
        const body = `Consensus run: ${results.length} agents (${agentList})\n${consensusReport.confirmed.length} confirmed, ${consensusReport.disputed.length} disputed, ${consensusReport.unverified.length} unverified\n\nKey findings:\n${topFindings}`;
        this.memWriter.writeKnowledgeFromResult('_project', {
          taskId: `consensus-${Date.now()}`,
          task: `Consensus review by ${agentList}`,
          result: body,
        }).catch(err => log(`Project consensus knowledge write failed: ${(err as Error).message}`));
      }

      return consensusReport;
    } catch (err) {
      process.stderr.write(`[gossipcat] Consensus failed: ${(err as Error).message}\n`);
      return undefined;
    }
  }

  /** Flush TaskGraph index on shutdown */
  flushTaskGraph(): void {
    this.taskGraph.flushIndex();
  }

  /** Record a native agent task creation in TaskGraph (for CLI/sync visibility) */
  recordNativeTaskCreated(taskId: string, agentId: string, task: string, skills: string[]): void {
    this.taskGraph.recordCreated(taskId, agentId, task, skills);
  }

  /** Record a native agent task completion in TaskGraph */
  recordNativeTaskCompleted(taskId: string, result: string, error?: string): void {
    if (error) {
      this.taskGraph.recordFailed(taskId, error, -1);
    } else {
      this.taskGraph.recordCompleted(taskId, (result || '').slice(0, 4000), -1);
    }
  }

  /** Record a native task result into the plan so subsequent steps get chain context */
  recordPlanStepResult(planId: string, step: number, result: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const planStep = plan.steps.find(s => s.step === step);
    if (planStep) {
      planStep.result = (result || '').slice(0, 2000);
    }
  }

  /** Get suggestion results for formatting in collect responses */
  getSkillSuggestions(agentId: string, sinceMs: number) {
    return this.gapTracker.getSuggestionsSince(agentId, sinceMs);
  }

  getSkeletonMessages(): string[] {
    const { pending } = this.gapTracker.checkThresholds();
    return pending.length > 0
      ? [`${pending.length} skill(s) ready to build: ${pending.join(', ')}`]
      : [];
  }

  /**
   * Detect agents weak in categories where peers are strong.
   * Returns suggestions like: "sonnet-reviewer needs a skill in error_handling (score: 0.2, team median: 0.7)"
   */
  getSessionConsensusHistory() { return this.sessionConsensusHistory; }
  getSessionStartTime() { return this.sessionStartTime; }
  getSessionGossip() { return this.sessionGossip; }

  getSkillGapSuggestions(): string[] {
    if (!this.competencyProfiler) return [];

    const profiles = this.competencyProfiler.getProfiles();
    if (profiles.size < 2) return [];

    // Collect all category scores across agents
    const categoryScores = new Map<string, number[]>();
    for (const [, profile] of profiles) {
      for (const [cat, score] of Object.entries(profile.reviewStrengths)) {
        if (!categoryScores.has(cat)) categoryScores.set(cat, []);
        categoryScores.get(cat)!.push(score);
      }
    }

    // Compute medians
    const categoryMedians = new Map<string, number>();
    for (const [cat, scores] of categoryScores) {
      if (scores.length < 2) continue;
      const sorted = [...scores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      categoryMedians.set(cat, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    }

    const suggestions: string[] = [];
    for (const [, profile] of profiles) {
      for (const [cat, median] of categoryMedians) {
        if (median < 0.6) continue; // peers aren't strong enough to justify suggestion
        const agentScore = profile.reviewStrengths[cat] ?? 0;
        if (agentScore < 0.3) {
          suggestions.push(
            `${profile.agentId} needs a skill in "${cat}" (score: ${agentScore.toFixed(2)}, team median: ${median.toFixed(2)}) — call gossip_skills(action: "develop", agent_id: "${profile.agentId}", category: "${cat}")`
          );
        }
      }
    }
    return suggestions;
  }

  async summarizeAndStoreGossip(agentId: string, result: string): Promise<void> {
    try {
      const summary = await this.summarizeForSession(agentId, result);
      if (summary) {
        this.sessionGossip.push({ agentId, taskSummary: summary, timestamp: Date.now() });
        if (this.sessionGossip.length > DispatchPipeline.MAX_SESSION_GOSSIP) {
          this.sessionGossip.shift();
        }
        // Persist to disk for crash safety — gossip_session_save reads this file
        try {
          const gossipPath = join(this.projectRoot, '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl');
          mkdirSync(dirname(gossipPath), { recursive: true });
          appendFileSync(gossipPath, JSON.stringify({ agentId, taskSummary: summary, timestamp: Date.now() }) + '\n');
        } catch { /* best-effort disk persistence */ }
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

const SECURITY_KEYWORDS = /security|vulnerab|auth|inject|exploit|breach|attack|malicious/i;
const OBSERVATION_VERBS = /^(summarize|research|analyze|check|verify|list|explain|document|review|audit|trace|investigate)\b/i;

export function shouldSkipConsensus(
  task: string,
  agents: Array<{ reviewReliability: number; totalTasks: number }>,
  costMode: string,
  agreementHistory: { rate: number; uniquePeerPairings: number },
): boolean {
  if (costMode === 'thorough') return false;
  if (SECURITY_KEYWORDS.test(task)) return false;
  if (agents.some(a => a.reviewReliability < 0.9)) return false;
  if (agents.some(a => a.totalTasks < 10)) return false;
  if (agreementHistory.rate < 0.8 || agreementHistory.uniquePeerPairings < 3) return false;
  // Low-stakes: first word is an observation verb
  const firstWord = task.trim().split(/\s+/)[0] || '';
  return OBSERVATION_VERBS.test(firstWord);
}
