import { randomUUID } from 'crypto';
import { readFileSync, mkdirSync, realpathSync, appendFileSync } from 'fs';
import { resolve as resolvePath, join } from 'path';
import { AgentConfig, DispatchOptions, TaskEntry, TaskExecutionResult, PlanState, MIN_AGENTS_FOR_CONSENSUS } from './types';
import { ILLMProvider } from './llm-client';
import { loadSkills } from './skill-loader';
import { assemblePrompt, extractSpecReferences, buildSpecReviewEnrichment, parseSpecFrontMatter } from './prompt-assembler';
import { AgentMemoryReader } from './agent-memory';
import { MemoryWriter } from './memory-writer';
import { discoverProjectStructure } from './project-structure';
import { MemoryCompactor } from './memory-compactor';
import { TaskGraph } from './task-graph';
import { SkillCatalog } from './skill-catalog';
import { SkillGapTracker } from './skill-gap-tracker';
import { GossipPublisher } from './gossip-publisher';
import { PerformanceWriter } from './performance-writer';
import { MetaSignal } from './consensus-types';
import { ScopeTracker } from './scope-tracker';
import { WorktreeManager } from './worktree-manager';
import { TaskGraphSync } from './task-graph-sync';
import { OverlapDetector } from './overlap-detector';
import { LensGenerator } from './lens-generator';
import { PerformanceReader } from './performance-reader';
import { DispatchDifferentiator } from './dispatch-differentiator';
import { CollectResult } from './consensus-types';
import { WorkerLike } from './worker-like';
import { SkillIndex } from './skill-index';
import { SkillCounterTracker } from './skill-counters';
import { TaskStreamEvent, TaskStreamEventType } from './task-stream';
import { ConsensusCoordinator } from './consensus-coordinator';
import { SessionContext } from './session-context';
import { parseAgentFindingsStrict } from './parse-findings';
import { extractCategories } from './category-extractor';
import { inferTaskType } from './task-type-inference';

import { gossipLog as log } from './log';

export interface SkillGapSuggestionResult {
  agentId: string;
  category: string;
  score: number;
  median: number;
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
  keyProvider?: (provider: string) => Promise<string | null>;
}

type TrackedTask = TaskEntry & {
    stream: AsyncGenerator<TaskStreamEvent, void, undefined>;
    finalResultPromise: Promise<TaskExecutionResult>;
};

/**
 * Mechanical format compliance check — regex only, no LLM judgment.
 *
 * Uses `parseAgentFindingsStrict` so the "accepted" count reflects the same
 * type enum the consensus engine enforces. Surfaces `tags_dropped_unknown_type`
 * and `tags_dropped_short_content` separately so downstream consumers (dashboard,
 * score panel) can tell the difference between "agent emitted nothing" and
 * "agent emitted tags but all had invalid type=" — the second case points at
 * a skill/prompt-format drift that instruction edits won't fix.
 */
export interface FormatComplianceResult {
  findingCount: number;
  citationCount: number;
  formatCompliant: boolean;
  tags_total: number;
  tags_accepted: number;
  tags_dropped_unknown_type: number;
  tags_dropped_short_content: number;
  /**
   * Structured diagnostics from the strict parser (HTML_ENTITY_* etc). Empty
   * array on clean output. Plumbed through to the `format_compliance`
   * meta-signal as `diagnostic_codes` so the dashboard can render a banner
   * identifying WHY a round appears empty.
   */
  diagnostics: import('./parse-findings').ParseDiagnostic[];
}

export function detectFormatCompliance(result: string): FormatComplianceResult {
  const parseRes = parseAgentFindingsStrict(result);
  const tags_total = parseRes.rawTagCount;
  const tags_accepted = parseRes.findings.length;
  const tags_dropped_unknown_type =
    Object.values(parseRes.droppedUnknownType).reduce((a, b) => a + b, 0) +
    parseRes.droppedMissingType;
  const tags_dropped_short_content = parseRes.droppedShortContent;
  // Preserve legacy raw-tag count (includes dropped tags) for back-compat.
  const findingCount = (result.match(/<agent_finding[\s>]/g) ?? []).length;
  const citationCount = (result.match(/\b[\w./-]+\.\w+:\d+\b/g) ?? []).length;
  // Compliance now requires ACCEPTED tags (previous behavior accepted
  // dropped-type tags too, which let format-invalid output pass as compliant).
  const formatCompliant = tags_accepted > 0 && citationCount >= tags_accepted;
  return {
    findingCount,
    citationCount,
    formatCompliant,
    tags_total,
    tags_accepted,
    tags_dropped_unknown_type,
    tags_dropped_short_content,
    diagnostics: parseRes.diagnostics,
  };
}

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
  private sessionContext: SessionContext;

  private tasks: Map<string, TrackedTask> = new Map();
  private batches: Map<string, Set<string>> = new Map();
  private sequentialQueues: Map<string, Promise<unknown>> = new Map(); // agentId → tail promise

  readonly scopeTracker: ScopeTracker;
  private readonly worktreeManager: WorktreeManager;
  private overlapDetector: OverlapDetector | null = null;
  private lensGenerator: LensGenerator | null = null;
  private bootWarningShown = false;

  private dispatchDifferentiator: DispatchDifferentiator | null = null;
  private perfReader: PerformanceReader | null = null;
  private skillIndex: SkillIndex | null = null;
  private skillCounters: SkillCounterTracker | null = null;
  private consensusCoordinator: ConsensusCoordinator;
  private _precomputedLenses: Map<string, string> | null = null;

  private projectStructureCache: string | null = null;

  private getProjectStructure(): string | undefined {
    if (this.projectStructureCache !== null) return this.projectStructureCache || undefined;
    const parts = discoverProjectStructure(this.projectRoot);
    this.projectStructureCache = parts.length > 0 ? parts.join('\n') : '';
    return this.projectStructureCache || undefined;
  }

  /**
   * Invalidate the cached project structure so the next prompt regenerates it.
   * Call this when the project layout has changed mid-session (e.g. new
   * top-level packages, agent scaffold, gossip_setup adding agent dirs).
   * Without this, every prompt sees the boot-time-cached layout and agents
   * reason against stale structure. Drift audit haiku #8.
   */
  public invalidateProjectStructureCache(): void {
    this.projectStructureCache = null;
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
    this.perfReader = new PerformanceReader(config.projectRoot);
    this.consensusCoordinator = new ConsensusCoordinator({
      llm: config.llm ?? null,
      registryGet: config.registryGet,
      projectRoot: config.projectRoot,
      keyProvider: config.keyProvider ?? null,
      getAgentSkillsContent: (agentId, task) => {
        const agentSkills = this.registryGet(agentId)?.skills || [];
        try {
          const res = loadSkills(agentId, agentSkills, this.projectRoot, this.skillIndex ?? undefined, task);
          return res.content || undefined;
        } catch {
          return undefined;
        }
      },
    });

    try { this.catalog = new SkillCatalog(config.projectRoot); }
    catch (err) { this.catalog = null; log(`SkillCatalog unavailable: ${(err as Error).message}`); }

    this.sessionContext = new SessionContext({ llm: config.llm ?? null, projectRoot: config.projectRoot });

    // Clean up orphaned worktrees from previous runs
    this.worktreeManager.pruneOrphans().catch(err => log(`Orphan cleanup failed: ${(err as Error).message}`));

    // Ensure _project memory directory exists (don't clear gossip — it survives reconnects)
    try {
      const projectMemDir = join(config.projectRoot, '.gossip', 'agents', '_project', 'memory');
      mkdirSync(projectMemDir, { recursive: true });
    } catch { /* best-effort */ }
  }

  /** Build chain context string for a plan step (used by native agent bridge) */
  getChainContext(planId: string, step: number): string {
    return this.sessionContext.getChainContext(planId, step);
  }

  private static readonly MAX_TASKS = 500;

  /** Derive memory compaction cap from task result content */
  private static deriveMaxEntries(result: string | undefined): number {
    const findingsCount = (result || '').split('\n').filter(l => /^\s*[-*•]\s|^#{1,3}\s.*\[/.test(l)).length;
    return findingsCount >= 8 ? 30 : findingsCount <= 1 ? 12 : 20;
  }

  dispatch(agentId: string, task: string, options?: DispatchOptions): { taskId: string; finalResultPromise: Promise<TaskExecutionResult> } {
    if (this.tasks.size >= DispatchPipeline.MAX_TASKS) {
      throw new Error(`Too many active tasks (${this.tasks.size}). Collect results before dispatching more.`);
    }
    const worker = this.workers.get(agentId);
    if (!worker) {
      log(`❌ dispatch FAILED: agent "${agentId}" not found. Available: [${[...this.workers.keys()].join(', ')}]`);
      throw new Error(`Agent "${agentId}" not found`);
    }
    log(`→ dispatch → ${agentId}: "${task.slice(0, 80)}..." writeMode=${options?.writeMode || 'default'}`);

    // Scoped write mode: validate scope and check for overlaps
    if (options?.writeMode === 'scoped') {
      if (!options.scope) throw new Error('scoped write mode requires a scope path');
      const overlap = this.scopeTracker.hasOverlap(options.scope);
      if (overlap.overlaps) {
        throw new Error(`Scope "${options.scope}" overlaps with active scope "${overlap.conflictScope}" (task ${overlap.conflictTaskId})`);
      }
    }

    const taskId = randomUUID().slice(0, 8);
    const agentSkills = this.registryGet(agentId)?.skills || [];

    // 1. Load skills (index takes precedence when available, contextual filtered by task)
    //    Extract task categories (regex-driven, zero LLM cost) so contextual
    //    skills get a fractional boost when their category matches the task's
    //    inferred category set. See skill-loader.categoryBoost and consensus
    //    f2ff0fac-fb384daa.
    const taskCategories = extractCategories(task);
    // Dispatch-side task type: prefer caller-provided, else infer from write
    // mode + task verb. Passed through to loadSkills so skills declared with
    // `task_type: implement|review|research` get filtered before the keyword
    // gate. Skills without the axis (default 'any') still activate for all.
    const dispatchTaskType = options?.taskType ?? inferTaskType(task, options?.writeMode);
    const skillResult = loadSkills(agentId, agentSkills, this.projectRoot, this.skillIndex ?? undefined, task, taskCategories, dispatchTaskType);
    const skills = skillResult.content;
    if (skillResult.dropped.length > 0) {
      const dropSummary = skillResult.dropped.map(d => `${d.skill} (${d.reason}${d.hits ? `, hits=${d.hits}` : ''})`).join(', ');
      log(`Dropped ${skillResult.dropped.length} skill(s) for ${agentId}: ${dropSummary}`);
    }
    // Track contextual skill activations for lifecycle management
    if (this.skillCounters && this.skillIndex) {
      const allContextual = this.skillIndex.getAgentSlots(agentId)
        .filter(s => s.enabled && s.mode === 'contextual')
        .map(s => s.skill);
      if (allContextual.length > 0) {
        this.skillCounters.recordDispatch(agentId, allContextual, skillResult.activatedContextual);
      }
    }

    // 2. Load memory (agent knowledge files) + pre-fetch consensus findings
    const memory = this.memReader.loadMemory(agentId, task);
    const consensusFindings = this.memReader.prefetchConsensusFindingsText(task);
    if (consensusFindings.length > 0) {
      log(`📋 pre-fetched ${consensusFindings.length} consensus findings for ${agentId}`);
    }

    // 3. Check skill coverage
    const skillWarnings = this.catalog
      ? this.catalog.checkCoverage(agentSkills, task)
      : [];

    // 4. Build session + chain context
    const sessionGossip = this.sessionContext.getSessionGossip();
    let sessionCtx = '';
    if (sessionGossip.length > 0) {
      sessionCtx = '[Session Context — prior task results]\n' +
        sessionGossip.map(g => `- ${g.agentId}: ${g.taskSummary}`).join('\n');
    }

    let chainContext = '';
    if (options?.planId && options?.step && options.step > 1) {
      const plan = this.sessionContext.getPlans().get(options.planId);
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
        const realSpecPath = realpathSync(specPath);
        const realRoot = realpathSync(this.projectRoot);
        if (realSpecPath.startsWith(realRoot + '/')) {
          const specContent = readFileSync(realSpecPath, 'utf-8');
          const implFiles = extractSpecReferences(task, specContent);
          // Parse YAML front-matter to extract the spec's lifecycle status
          // (proposal | implemented | retired). The status is injected into
          // the review enrichment so reviewers frame findings correctly — see
          // project_task_framing_drift.md (2026-04-08).
          const { status } = parseSpecFrontMatter(specContent);
          const enrichment = buildSpecReviewEnrichment(implFiles, status);
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
      sessionContext: sessionCtx || undefined,
      chainContext: chainContext || undefined,
      consensusSummary: options?.consensus,
      specReviewContext,
      projectStructure: this.getProjectStructure(),
      consensusFindings: consensusFindings.length > 0 ? consensusFindings : undefined,
    });

    // 6. Record TaskGraph created
    this.taskGraph.recordCreated(taskId, agentId, task, agentSkills);

    // 7. Create task entry
    const entry: TrackedTask = {
      id: taskId, agentId, task, status: 'running',
      startedAt: Date.now(), skillWarnings,
      stream: null as any,
      finalResultPromise: null as any,
    };
    entry.writeMode = options?.writeMode;
    entry.scope = options?.scope;
    entry.planId = options?.planId;
    entry.planStep = options?.step;

    // Register scope for overlap tracking
    if (options?.writeMode === 'scoped' && options.scope) {
      this.scopeTracker.register(options.scope, taskId);
    }

    // Sequential write mode: chain after the previous task for this agent
    const prevSequential = options?.writeMode === 'sequential'
      ? this.sequentialQueues.get(agentId)
      : undefined;

    const runTask = async () => {
      if (prevSequential) await prevSequential.catch(() => {}); // wait for previous, ignore its errors

      // Worktree write mode: create an isolated worktree before running the task
      if (options?.writeMode === 'worktree') {
        const wtInfo = await this.worktreeManager.create(taskId);
        entry.worktreeInfo = wtInfo;
        this.toolServer?.assignRoot(agentId, wtInfo.path);
      }
      const stream = worker.executeTask(task, options?.lens, promptContent, taskId);
      entry.stream = stream;
      for await (const event of stream) {
        entry.lastEventAt = Date.now();
        switch (event.type) {
          case TaskStreamEventType.PROGRESS:
            entry.toolCalls = event.payload.toolCalls;
            entry.inputTokens = event.payload.inputTokens;
            entry.outputTokens = event.payload.outputTokens;
            break;
          case TaskStreamEventType.FINAL_RESULT:
            entry.status = 'completed';
            entry.result = event.payload.result;
            entry.inputTokens = event.payload.inputTokens;
            entry.outputTokens = event.payload.outputTokens;
            entry.completedAt = Date.now();
            entry.memoryQueryCalled = event.payload.memoryQueryCalled ?? false;
            if (entry.writeMode === 'scoped') this.scopeTracker.release(entry.id);
            // Visibility fix (Option A): emit log + persist task.completed so async dispatch results
            // are debuggable. Without this, the result lives only in this.tasks Map until gossip_collect
            // is called — invisible to gossip_progress and lost on process restart. Symmetric persistence
            // (mirroring native-tasks.ts:262) is the next-session implementation task.
            try {
              const elapsedMs = (entry.completedAt ?? Date.now()) - entry.startedAt;
              log(`✅ relay ← ${entry.agentId} [${entry.id}] OK (${(elapsedMs / 1000).toFixed(1)}s, ${(event.payload.result || '').length} chars)`);
              appendFileSync(join(this.projectRoot, '.gossip', 'task-graph.jsonl'), JSON.stringify({
                type: 'task.completed',
                taskId: entry.id,
                agentId: entry.agentId,
                durationMs: elapsedMs,
                resultLength: (event.payload.result || '').length,
                memoryQueryCalled: entry.memoryQueryCalled,
                timestamp: new Date().toISOString(),
              }) + '\n');
            } catch { /* best-effort visibility — never crash dispatch on log/write failure */ }
            // Emit meta signals for non-consensus dispatch telemetry
            try {
              const perfWriter = new PerformanceWriter(this.projectRoot);
              const now = new Date().toISOString();
              const durationMs = (entry.completedAt ?? Date.now()) - entry.startedAt;
              const compliance = detectFormatCompliance(event.payload.result ?? '');
              const metaSignals: MetaSignal[] = [
                { type: 'meta', signal: 'task_completed', agentId: entry.agentId, taskId: entry.id, value: durationMs, timestamp: now },
                { type: 'meta', signal: 'task_tool_turns', agentId: entry.agentId, taskId: entry.id, value: entry.toolCalls ?? 0, timestamp: now },
                { type: 'meta', signal: 'format_compliance', agentId: entry.agentId, taskId: entry.id, value: compliance.formatCompliant ? 1 : 0, metadata: { findingCount: compliance.findingCount, citationCount: compliance.citationCount, tags_total: compliance.tags_total, tags_accepted: compliance.tags_accepted, tags_dropped_unknown_type: compliance.tags_dropped_unknown_type, tags_dropped_short_content: compliance.tags_dropped_short_content, diagnostic_codes: compliance.diagnostics.map(d => d.code) }, timestamp: now },
              ];
              perfWriter.appendSignals(metaSignals);
            } catch { /* best-effort — never crash dispatch on signal write failure */ }
            return event.payload;
          case TaskStreamEventType.ERROR:
            entry.status = 'failed';
            entry.error = event.payload.error;
            entry.completedAt = Date.now();
            if (entry.writeMode === 'scoped') this.scopeTracker.release(entry.id);
            if (entry.writeMode === 'worktree' && entry.worktreeInfo) {
              this.worktreeManager.cleanup(entry.id, entry.worktreeInfo.path).catch(() => {});
            }
            // Visibility fix (Option A): same as FINAL_RESULT but for the failed path. Silent worker
            // errors in async dispatch were the diagnostic blindness that ate ~45min of session 2026-04-07.
            try {
              const elapsedMs = (entry.completedAt ?? Date.now()) - entry.startedAt;
              log(`❌ relay ← ${entry.agentId} [${entry.id}] FAILED (${(elapsedMs / 1000).toFixed(1)}s) — ${event.payload.error}`);
              appendFileSync(join(this.projectRoot, '.gossip', 'task-graph.jsonl'), JSON.stringify({
                type: 'task.failed',
                taskId: entry.id,
                agentId: entry.agentId,
                durationMs: elapsedMs,
                error: event.payload.error,
                timestamp: new Date().toISOString(),
              }) + '\n');
            } catch { /* best-effort */ }
            throw new Error(event.payload.error);
          default:
            // LOG, PARTIAL_RESULT, etc. — tracked via lastEventAt above
            break;
        }
      }
      throw new Error('Task stream ended without a final result or error.');
    };

    entry.finalResultPromise = runTask();

    // Update sequential queue tail
    if (options?.writeMode === 'sequential') {
      this.sequentialQueues.set(agentId, entry.finalResultPromise);
    }

    this.tasks.set(taskId, entry);
    return { taskId, finalResultPromise: entry.finalResultPromise };
  }

  getTask(taskId: string): TaskEntry | undefined {
    return this.tasks.get(taskId);
  }

  /** Get metadata for all running tasks — used by relay task persistence */
  getRunningTaskRecords(): Array<{ id: string; agentId: string; task: string; startedAt: number; timeoutMs: number }> {
    return Array.from(this.tasks.entries())
      .filter(([, t]) => t.status === 'running')
      .map(([id, t]) => ({
        id, agentId: t.agentId, task: t.task, startedAt: t.startedAt, timeoutMs: 300_000,
      }));
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
        // Stuck = no events received in a long time. Uses lastEventAt (any event type)
        // rather than toolCalls alone, so LLM-thinking tasks aren't falsely flagged.
        isLikelyStuck: (now - (t.lastEventAt ?? t.startedAt) > 180_000),
      }));
  }

  /**
   * Get recently-completed/failed tasks for `gossip_progress` display.
   * Without this, completed relay tasks vanish from the UI: they're filtered out of
   * `getActiveTasksHealth()` (running-only) AND `gossip_progress`'s recentlyCompleted
   * loop only inspects nativeResultMap. Result: relay-task invisibility bug.
   */
  getRecentlyCompletedTasks(maxAgeMs: number): Array<{
    id: string; agentId: string; status: string; durationMs: number; completedAgoMs: number;
  }> {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    return Array.from(this.tasks.values())
      .filter(t => (t.status === 'completed' || t.status === 'failed') && t.completedAt && t.completedAt >= cutoff)
      .map(t => ({
        id: t.id,
        agentId: t.agentId,
        status: t.status,
        durationMs: (t.completedAt ?? now) - t.startedAt,
        completedAgoMs: now - (t.completedAt ?? now),
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
    this.sessionContext.registerPlan(plan);
  }

  async collect(taskIds?: string[], timeoutMs: number = 120_000, options?: { consensus?: boolean; consume?: boolean }): Promise<CollectResult> {
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
      Promise.all(targets.map(t => t.finalResultPromise.catch(() => {}))),
      new Promise(r => { timer = setTimeout(r, timeoutMs); timer.unref(); }),
    ]).finally(() => clearTimeout(timer!));

    // Post-collect pipeline
    for (const t of targets) {
      const duration = t.completedAt ? t.completedAt - t.startedAt : -1;

      // 1. TaskGraph (non-completed paths)
      if (t.status === 'failed') {
        try {
          this.taskGraph.recordFailed(t.id, t.error || 'Unknown', duration, t.inputTokens, t.outputTokens);
        } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }
      } else if (t.status === 'running') {
        try {
          this.taskGraph.recordFailed(t.id, 'collect timeout', duration);
        } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }
      }

      // 2. Post-completion pipeline: TaskGraph + memory + compact
      if (t.status === 'completed') {
        await this._postTaskComplete(t);
      }

      // 2b. Session gossip summarization (fire-and-forget — don't block collect)
      if (t.status === 'completed' && t.result && this.llm) {
        this.sessionContext.summarizeAndStoreGossip(t.agentId, t.result);
      }

      // 2c. Store result in plan state for chain threading
      if (t.planId && t.planStep) {
        this.sessionContext.recordPlanStepResult(t.planId, t.planStep, t.result || '');
        // Also update completedAt directly on the plan step
        const plan = this.sessionContext.getPlans().get(t.planId);
        if (plan) {
          const step = plan.steps.find(s => s.step === t.planStep);
          if (step) step.completedAt = Date.now();
        }
      }
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
    const plans = this.sessionContext.getPlans();
    for (const [id, plan] of plans) {
      const allDone = plan.steps.every(s => s.result !== undefined);
      const expired = Date.now() - plan.createdAt > 3_600_000;
      if (allDone || expired) plans.delete(id);
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
    if (options?.consensus && this.llm && results.filter(r => r.status === 'completed').length >= MIN_AGENTS_FOR_CONSENSUS) {
      consensusReport = await this.runConsensus(results);
    }

    // Cleanup tasks from tracking map.
    // Default to consume:true for backwards compat, but the MCP collect handler
    // passes consume:false to keep tasks queryable across multiple gossip_collect
    // calls (e.g. inspect mid-round, then synthesize with consensus:true).
    // Without this, an inspection-only collect would silently drop the task
    // from the tracking map and break a subsequent consensus synthesis.
    const consume = options?.consume !== false;
    if (consume) {
      for (const t of targets) {
        this.tasks.delete(t.id);
      }
    }

    const result: CollectResult = { results, consensus: consensusReport };
    if (skillsReadyCount > 0) {
      result.skillsReady = skillsReadyCount;
    }

    // Flush skill counters and check lifecycle (auto-disable stale, promote frequent)
    try {
      if (this.skillCounters && this.skillIndex) {
        const lifecycle = this.skillCounters.checkLifecycle(this.skillIndex);
        this.skillCounters.flush();
        if (lifecycle.disabled.length > 0 || lifecycle.promoted.length > 0) {
          result.skillLifecycle = lifecycle;
        }
      }
    } catch { /* best-effort — don't block collect */ }

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

    // Use pre-computed lenses if injected via dispatchParallelWithLenses
    let lensMap: Map<string, string> | null = null;
    if (this._precomputedLenses) {
      lensMap = this._precomputedLenses;
      log(`Using pre-computed lenses:\n${[...lensMap].map(([id, focus]) => `  ${id} → ${focus.slice(0, 80)}`).join('\n')}`);
    }

    // Profile-based differentiation (preferred — uses learned agent scores)
    if (!lensMap && this.perfReader && this.dispatchDifferentiator) {
      const scores = taskDefs
        .map(d => this.perfReader!.getAgentScore(d.agentId))
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (scores.length >= 2) {
        const diffMap = this.dispatchDifferentiator.differentiate(scores, taskDefs[0]?.task || '');
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
          log(`⚠️  Skill overlap detected:\n  ${warning}`);
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
            const { taskId, finalResultPromise } = this.dispatch(def.agentId, def.task, {
              ...def.options,
              ...(lens ? { lens } : {}),
              ...(pipelineOptions?.consensus ? { consensus: true } : {}),
            });
            taskIds.push(taskId);
            batchTaskIds.add(taskId);
    
            // Gossip trigger on completion
            if (this.gossipPublisher) {
              finalResultPromise.then(async (result) => {
                const remaining = Array.from(batchTaskIds)
                  .map(tid => this.tasks.get(tid))
                  .filter((t): t is TrackedTask => t !== undefined && t.status === 'running' && t.agentId !== def.agentId)
                  .map(t => this.registryGet(t.agentId))
                  .filter((ac): ac is AgentConfig => ac !== undefined);
    
                if (remaining.length > 0) {
                  this.gossipPublisher!.publishGossip({
                    batchId,
                    completedAgentId: def.agentId,
                    completedResult: result.result,
                    remainingSiblings: remaining.map(ac => ({
                      agentId: ac.id, preset: ac.preset || 'custom', skills: ac.skills,
                    })),
                  }).catch(err => log(`Gossip: ${(err as Error).message}`));
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

  /**
   * Generate differentiation lenses for a set of agents and a shared task.
   * Extracts the overlap detection + lens generation logic so it can be
   * invoked externally (e.g., by a native utility agent) before dispatch.
   */
  async generateLensesForAgents(
    taskDefs: Array<{ agentId: string; task: string }>,
  ): Promise<Map<string, string> | null> {
    // Profile-based differentiation first (preferred)
    if (this.perfReader && this.dispatchDifferentiator) {
      const scores = taskDefs
        .map(d => this.perfReader!.getAgentScore(d.agentId))
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (scores.length >= 2) {
        const diffMap = this.dispatchDifferentiator.differentiate(scores, taskDefs[0]?.task || '');
        if (diffMap.size > 0) {
          log(`generateLensesForAgents: profile-based differentiation produced ${diffMap.size} lenses`);
          return diffMap;
        }
      }
    }

    // Fall back to overlap detection + LensGenerator
    if (this.overlapDetector) {
      const agentConfigs = taskDefs
        .map(d => this.registryGet(d.agentId))
        .filter((c): c is AgentConfig => c !== undefined);
      const overlapResult = this.overlapDetector.detect(agentConfigs);

      if (overlapResult.hasOverlaps && this.lensGenerator) {
        try {
          const lenses = await this.lensGenerator.generateLenses(
            overlapResult.agents, taskDefs[0]?.task || '', overlapResult.sharedSkills,
          );
          if (lenses.length > 0) {
            const lensMap = new Map(lenses.map(l => [l.agentId, l.focus]));
            log(`generateLensesForAgents: overlap-based lenses produced ${lensMap.size} lenses`);
            return lensMap;
          }
        } catch (err) {
          log(`generateLensesForAgents: lens generation failed: ${(err as Error).message}`);
        }
      }
    }

    return null;
  }

  /**
   * Dispatch parallel tasks with optional pre-computed lenses.
   * Stores lenses on the instance, delegates to dispatchParallel, then clears.
   */
  async dispatchParallelWithLenses(
    taskDefs: Array<{ agentId: string; task: string; options?: DispatchOptions }>,
    pipelineOptions?: { consensus?: boolean },
    precomputedLenses?: Map<string, string>,
  ): Promise<{ taskIds: string[]; errors: string[] }> {
    this._precomputedLenses = precomputedLenses ?? null;
    try {
      return await this.dispatchParallel(taskDefs, pipelineOptions);
    } finally {
      this._precomputedLenses = null;
    }
  }

  /** Write memory inline (for handleMessage synchronous path) */
  async writeMemoryForTask(taskId: string): Promise<void> {
    const t = this.tasks.get(taskId);
    if (!t || t.status !== 'completed') return;

    await this._postTaskComplete(t);

    this.tasks.delete(t.id);
  }

  /** Shared post-completion pipeline: TaskGraph + memory write + compact */
  private async _postTaskComplete(t: TaskEntry): Promise<void> {
    const duration = t.completedAt ? t.completedAt - t.startedAt : -1;

    // 1. TaskGraph
    try {
      this.taskGraph.recordCompleted(t.id, (t.result || '').slice(0, 4000), duration, t.inputTokens, t.outputTokens);
    } catch (err) { log(`TaskGraph write failed for ${t.id}: ${(err as Error).message}`); }

    // 2. Write agent memory (task log + knowledge extraction)
    try {
      const agentScore = this.perfReader?.getAgentScore(t.agentId);
      await this.memWriter.writeTaskEntry(t.agentId, {
        taskId: t.id, task: t.task,
        skills: this.registryGet(t.agentId)?.skills || [],
        scores: {
          relevance: (t.result && t.result.length > 200) ? 4 : 3,
          accuracy: agentScore ? Math.max(1, Math.round(agentScore.accuracy * 5)) : 3,
          uniqueness: agentScore ? Math.max(1, Math.round(agentScore.uniqueness * 5)) : 3,
        },
      });
      if (t.result) {
        const agentAccuracy = this.perfReader?.getAgentScore(t.agentId)?.reliability;
        await this.memWriter.writeKnowledgeFromResult(t.agentId, {
          taskId: t.id, task: t.task, result: t.result,
          ...(agentAccuracy !== undefined ? { agentAccuracy } : {}),
        });
      }
      this.memWriter.rebuildIndex(t.agentId);
    } catch (err) { log(`Memory write failed for ${t.agentId}/${t.id}: ${(err as Error).message}`); }

    // 3. Compact memory (dynamic cap based on findings count)
    try {
      const compactResult = this.memCompactor.compactIfNeeded(t.agentId, DispatchPipeline.deriveMaxEntries(t.result));
      if (compactResult.message) log(compactResult.message);
    } catch (err) { log(`Memory compact failed for ${t.agentId}: ${(err as Error).message}`); }
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
    this.consensusCoordinator.setGossipPublisher(publisher);
  }

  setOverlapDetector(detector: OverlapDetector | null): void {
    this.overlapDetector = detector;
  }

  setLensGenerator(generator: LensGenerator | null): void {
    this.lensGenerator = generator;
  }

  setSkillIndex(index: SkillIndex): void {
    this.skillIndex = index;
    // Auto-create counter tracker when skill index is set
    this.skillCounters = new SkillCounterTracker(this.projectRoot);
  }

  setSummaryLlm(llm: import('./llm-client').ILLMProvider): void {
    this.memWriter.setSummaryLlm(llm);
  }

  getSkillIndex(): SkillIndex | null {
    return this.skillIndex;
  }

  getSkillCounters(): SkillCounterTracker | null {
    return this.skillCounters;
  }

  setDispatchDifferentiator(differ: DispatchDifferentiator): void {
    this.dispatchDifferentiator = differ;
  }

  /**
   * Run consensus cross-review + judge verification + signal pipeline on any set of results.
   * Delegates to ConsensusCoordinator which owns the full consensus logic.
   */
  async runConsensus(results: TaskEntry[]): Promise<import('./consensus-types').ConsensusReport | undefined> {
    return this.consensusCoordinator.runConsensus(results);
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
  recordNativeTaskCompleted(taskId: string, result: string, error?: string, durationMs?: number): void {
    const duration = durationMs ?? -1;
    if (error) {
      this.taskGraph.recordFailed(taskId, error, duration);
    } else {
      this.taskGraph.recordCompleted(taskId, (result || '').slice(0, 4000), duration);
    }
  }

  /** Record a native task result into the plan so subsequent steps get chain context */
  recordPlanStepResult(planId: string, step: number, result: string): void {
    this.sessionContext.recordPlanStepResult(planId, step, result);
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
  getSessionConsensusHistory() { return this.consensusCoordinator.sessionConsensusHistory; }
  getConsensusCoordinator(): ConsensusCoordinator { return this.consensusCoordinator; }
  getSessionStartTime() { return this.sessionContext.getSessionStartTime(); }
  getSessionGossip() { return this.sessionContext.getSessionGossip(); }
  getLlm(): ILLMProvider | null { return this.llm; }
  getAgentConfig(agentId: string): AgentConfig | undefined { return this.registryGet(agentId); }

  // Track which (agentId, category) pairs have been suggested this session to avoid repeats
  private suggestedSkillGaps = new Set<string>();

  /** Record that a skill gap has been addressed (e.g., develop action called) */
  suppressSkillGapAlert(agentId: string, category: string): void {
    this.suggestedSkillGaps.add(`${agentId}::${category}`);
  }

  getSkillGapSuggestions(): SkillGapSuggestionResult[] {
    if (!this.perfReader) return [];

    const agentScores = this.perfReader.getScores();
    if (agentScores.size < 2) return [];

    // Two metrics, two jobs:
    //   - categoryStrengths: additive, volume-weighted — good signal for "does the
    //     team as a whole have experience here?" → drives the peer-median benchmark.
    //   - categoryAccuracy: correct / (correct + hallucinated) — UX-aligned label for
    //     "is this specific agent right when they speak up?" → drives weakness flag.
    // Using strengths for the weakness side would flag agents as weak purely for
    // lacking volume, even when their few signals were correct. Accuracy is the
    // honest weakness metric.
    const WEAKNESS_ACCURACY_THRESHOLD = 0.3;
    const PEER_STRENGTH_THRESHOLD = 0.6;
    const MIN_CATEGORY_SIGNALS = 5;

    // Collect ALL categories seen across agents (union of strengths + accuracy keys
    // so we don't miss a category that exists in one map but not the other).
    const allCategories = new Set<string>();
    for (const [, score] of agentScores) {
      for (const cat of Object.keys(score.categoryStrengths)) allCategories.add(cat);
      for (const cat of Object.keys(score.categoryAccuracy ?? {})) allCategories.add(cat);
    }

    // Compute peer medians on categoryStrengths — include ALL agents (use 0 neutral
    // for missing categories). This asks "is the TEAM strong here?", a volume-aware
    // question where strengths is the right input.
    const categoryMedians = new Map<string, number>();
    for (const cat of allCategories) {
      const values: number[] = [];
      for (const [, score] of agentScores) {
        values.push(score.categoryStrengths[cat] ?? 0);
      }
      if (values.length < 2) continue;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      categoryMedians.set(cat, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
    }

    const suggestions: SkillGapSuggestionResult[] = [];
    for (const [, score] of agentScores) {
      for (const [cat, median] of categoryMedians) {
        if (median < PEER_STRENGTH_THRESHOLD) continue; // peers aren't strong enough
        const accuracyMap = (score.categoryAccuracy ?? {}) as Record<string, number>;
        // Two-factor gate: require BOTH enough signals AND low accuracy.
        // Signal count source matches the trigger in mcp-server-sdk.ts so the
        // dashboard trigger and dispatch-time suggestion fire under the same rule.
        const correct = (score.categoryCorrect ?? {})[cat] ?? 0;
        const hallucinated = (score.categoryHallucinated ?? {})[cat] ?? 0;
        if (correct + hallucinated < MIN_CATEGORY_SIGNALS) continue;
        // categoryAccuracy is only populated when the reader's own MIN_CATEGORY_N
        // gate passes, so a missing entry means insufficient data — skip rather
        // than defaulting to 0 and over-triggering.
        if (!(cat in accuracyMap)) continue;
        const catScore = accuracyMap[cat];
        if (catScore < WEAKNESS_ACCURACY_THRESHOLD) {
          // Suppress if already suggested this session
          const key = `${score.agentId}::${cat}`;
          if (this.suggestedSkillGaps.has(key)) continue;
          // Upstream freshness filter: skip if skill was bound within the 24h window.
          // Covers BOTH the auto-develop path (here) and the MCP develop path
          // (mcp-server-sdk.ts) from a single upstream chokepoint. Evidence windows
          // cannot accumulate when bound_at is reset on every pending-phase develop —
          // suppressing the suggestion prevents churn before it reaches skill-engine.
          if (this.gapTracker.isSkillFresh(score.agentId, cat)) {
            process.stderr.write(
              `[gossipcat] skill-suggestion suppressed: ${score.agentId}/${cat} bound within 24h freshness window\n`,
            );
            continue;
          }
          // NOTE: do NOT suppress here — caller must suppress after successful action
          suggestions.push({ agentId: score.agentId, category: cat, score: catScore, median });
        }
      }
    }
    return suggestions;
  }

  async summarizeAndStoreGossip(agentId: string, result: string): Promise<void> {
    return this.sessionContext.summarizeAndStoreGossip(agentId, result);
  }

  /** @internal Delegates to SessionContext — kept for backward compatibility */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected rotateJsonlFile(filePath: string, maxEntries: number, keepEntries: number): void {
    this.sessionContext.rotateJsonlFile(filePath, maxEntries, keepEntries);
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
