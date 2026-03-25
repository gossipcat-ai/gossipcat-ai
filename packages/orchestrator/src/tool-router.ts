/**
 * @gossip/orchestrator — Parse and validate [TOOL_CALL] blocks from LLM responses,
 * and execute validated tool calls via ToolExecutor.
 */

import { TOOL_SCHEMAS, PLAN_CHOICES, PENDING_PLAN_CHOICES } from './tool-definitions';
import type { ToolCall, ToolResult, DispatchPlan, PlannedTask, TaskProgressEvent } from './types';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const log = (msg: string) => process.stderr.write(`[tool-router] ${msg}\n`);
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Parse YAML-like tool call format that LLMs commonly produce:
 *   tool: dispatch
 *   args:
 *     agent_id: gemini-reviewer
 *     task: "review this code"
 */
/**
 * Convert a YAML-like args block to a JSON object.
 * Handles flat key: value pairs, nested objects, and arrays (- item syntax).
 * This is NOT a full YAML parser — it covers the subset LLMs commonly produce.
 */
function yamlToJson(yamlLines: string[], _baseIndent: number): unknown {
  if (yamlLines.length === 0) return {};

  // Detect if this is an array (first meaningful line starts with "- ")
  const firstLine = yamlLines[0];
  const firstTrimmed = firstLine.trimStart();
  if (firstTrimmed.startsWith('- ')) {
    // Array mode: split into items by top-level "- " markers
    const items: string[][] = [];
    let current: string[] = [];
    const itemIndent = firstLine.length - firstTrimmed.length;

    for (const line of yamlLines) {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;
      if (indent === itemIndent && trimmed.startsWith('- ')) {
        if (current.length > 0) items.push(current);
        // First line of item: strip the "- " prefix, keep as content
        const afterDash = trimmed.slice(2);
        current = afterDash ? [' '.repeat(itemIndent + 2) + afterDash] : [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) items.push(current);

    return items.map(itemLines => {
      // Single-line scalar item: "- value" with no child lines
      if (itemLines.length === 1) {
        const val = itemLines[0].trim();
        // If it doesn't look like "key: value", treat as scalar
        if (!/^\w[\w_-]*:\s/.test(val)) {
          // Strip quotes
          if (/^["'].*["']$/.test(val)) return val.slice(1, -1);
          if (/^\d+$/.test(val)) return parseInt(val, 10);
          if (val === 'true') return true;
          if (val === 'false') return false;
          return val;
        }
      }
      return yamlToJson(itemLines, itemIndent + 2);
    });
  }

  // Object mode: parse key: value pairs
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < yamlLines.length) {
    const line = yamlLines[i];
    const trimmed = line.trimStart();
    if (!trimmed) { i++; continue; }

    const kvMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)/);
    if (!kvMatch) { i++; continue; }

    const key = kvMatch[1];
    let rawValue = kvMatch[2].trim();

    if (rawValue) {
      // Strip quotes
      if (/^["'].*["']$/.test(rawValue)) rawValue = rawValue.slice(1, -1);
      // Parse numbers
      if (/^\d+$/.test(rawValue)) { result[key] = parseInt(rawValue, 10); }
      else if (rawValue === 'true') { result[key] = true; }
      else if (rawValue === 'false') { result[key] = false; }
      else { result[key] = rawValue; }
      i++;
    } else {
      // Value is on subsequent indented lines (nested object or array)
      const childLines: string[] = [];
      const keyIndent = line.length - trimmed.length;
      i++;
      while (i < yamlLines.length) {
        const nextLine = yamlLines[i];
        const nextTrimmed = nextLine.trimStart();
        if (!nextTrimmed) { i++; continue; }
        const nextIndent = nextLine.length - nextTrimmed.length;
        if (nextIndent <= keyIndent) break; // back to same or higher level
        childLines.push(nextLine);
        i++;
      }
      result[key] = yamlToJson(childLines, keyIndent + 2);
    }
  }
  return result;
}

function parseYamlLikeToolCall(content: string): { tool: string; args: Record<string, unknown> } | null {
  const lines = content.split('\n').map(l => l.trimEnd());

  // Find tool name
  const toolLine = lines.find(l => /^tool:\s*/.test(l));
  if (!toolLine) return null;
  const tool = toolLine.replace(/^tool:\s*/, '').trim().replace(/^["']|["']$/g, '');
  if (!tool) return null;

  // Find args
  const argsIdx = lines.findIndex(l => /^args:\s*/.test(l));
  if (argsIdx === -1) {
    // No args section — check if args are inline: args: {}
    const inlineArgs = toolLine.match(/args:\s*\{(.*)\}/);
    if (inlineArgs) {
      try { return { tool, args: JSON.parse(`{${inlineArgs[1]}}`) }; } catch { /* continue */ }
    }
    return { tool, args: {} };
  }

  // Check for inline args: args: { ... }
  const inlineArgsMatch = lines[argsIdx].match(/^args:\s*\{(.*)\}\s*$/);
  if (inlineArgsMatch) {
    try { return { tool, args: JSON.parse(`{${inlineArgsMatch[1]}}`) }; } catch { /* continue */ }
  }

  // Collect all indented lines after "args:"
  const argLines: string[] = [];
  for (let i = argsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line && argLines.length === 0) continue; // skip leading blank lines
    if (line && /^\S/.test(line)) break; // stop at non-indented line
    argLines.push(line);
  }
  // Trim trailing blank lines
  while (argLines.length > 0 && !argLines[argLines.length - 1].trim()) argLines.pop();

  const parsed = yamlToJson(argLines, 0);
  const args = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};

  return { tool, args };
}
// Match both [TOOL_CALL]...[/TOOL_CALL] and ```\n[TOOL_CALL]...\n``` formats
const BLOCK_RE = /\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/g;
const BLOCK_IN_FENCE_RE = /```[^\n]*\n\[TOOL_CALL\]([\s\S]*?)(?:\[\/TOOL_CALL\])?\s*```/g;

export class ToolRouter {
  /** Parse the FIRST [TOOL_CALL] block from LLM text. Returns null on any failure. */
  static parseToolCall(text: string): ToolCall | null {
    try {
      // Try spec format first: [TOOL_CALL]...[/TOOL_CALL]
      let match = /\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/.exec(text);

      // Fallback: [TOOL_CALL] inside markdown code fences (common LLM behavior)
      if (!match) {
        match = /```[^\n]*\n\[TOOL_CALL\]([\s\S]*?)(?:\[\/TOOL_CALL\])?\s*```/.exec(text);
      }

      // Fallback: [TOOL_CALL] without closing tag, ends at double newline or fence
      if (!match) {
        match = /\[TOOL_CALL\]\s*([\s\S]*?)(?:\n\n|\n```)/.exec(text);
      }

      // Fallback: [TOOL_CALL] at end of text (no closing tag, no trailing content)
      if (!match) {
        match = /\[TOOL_CALL\]\s*([\s\S]+)$/.exec(text);
      }

      if (!match) return null;

      let content = match[1].trim();
      // Strip any remaining code fences
      content = content.replace(/^```(?:json|yaml)?\s*/i, '').replace(/\s*```$/, '');

      // Try JSON parse first
      let tool: string;
      let args: Record<string, unknown>;
      const jsonAttempt = content.replace(/,\s*([}\]])/g, '$1');
      try {
        const parsed = JSON.parse(jsonAttempt);
        // Handle multiple key naming conventions:
        // Standard: { tool, args }
        // Gemini native: { tool_name, tool_input }
        // Other: { name, parameters } or { function, arguments }
        tool = parsed.tool || parsed.tool_name || parsed.name || parsed.function;
        const rawArgs = parsed.args || parsed.tool_input || parsed.parameters || parsed.arguments;

        // If args contains a complex plan structure, extract task from description/title
        if (rawArgs && typeof rawArgs === 'object' && !rawArgs.task && (rawArgs.description || rawArgs.title)) {
          args = { task: rawArgs.description || rawArgs.title };
        } else {
          args = rawArgs ?? {};
        }
      } catch {
        // Fallback 1: parse YAML-like format (tool: X, args:\n  key: value)
        const yamlResult = parseYamlLikeToolCall(content);
        if (yamlResult) {
          tool = yamlResult.tool;
          args = yamlResult.args;
        } else {
          // Fallback 2: function-call syntax — gossip_plan({...}) or plan({...})
          const funcMatch = content.match(/^([\w_]+)\s*\(\s*([\s\S]*)\)\s*$/);
          if (funcMatch) {
            tool = funcMatch[1];
            try {
              const jsonBody = funcMatch[2].trim();
              const parsed = JSON.parse(jsonBody.replace(/,\s*([}\]])/g, '$1'));
              // For plan tool: if LLM passed a complex object, extract just the description as task
              if (typeof parsed === 'object' && !parsed.task && (parsed.description || parsed.title)) {
                args = { task: parsed.description || parsed.title };
              } else {
                args = typeof parsed === 'object' ? parsed : {};
              }
            } catch {
              // If JSON inside parens fails, treat the whole content after tool name as task
              args = { task: funcMatch[2].trim().slice(0, 2000) };
            }
          } else {
            log(`failed to parse tool call content: ${content.slice(0, 200)}`);
            return null;
          }
        }
      }

      // Normalize MCP-style tool names (gossip_plan → plan, gossip_dispatch → dispatch)
      if (typeof tool === 'string' && tool.startsWith('gossip_')) {
        const stripped = tool.replace(/^gossip_/, '');
        if (TOOL_SCHEMAS[stripped]) {
          tool = stripped;
        }
      }

      if (typeof tool !== 'string' || !TOOL_SCHEMAS[tool]) {
        log(`unknown tool: ${tool}`);
        return null;
      }
      // Normalize: if 'task' is required but missing, check for description/title
      if (!args.task && (args.description || args.title)) {
        args.task = args.description || args.title;
      }

      const schema = TOOL_SCHEMAS[tool];
      for (const req of schema.requiredArgs) {
        if (!(req in args)) {
          log(`missing required arg '${req}' for tool '${tool}'`);
          return null;
        }
      }
      // Validate agent_id
      if (args.agent_id !== undefined && !AGENT_ID_RE.test(String(args.agent_id))) {
        log(`invalid agent_id: ${args.agent_id}`);
        return null;
      }
      // Validate agent_ids array
      if (Array.isArray(args.agent_ids)) {
        for (const id of args.agent_ids) {
          if (!AGENT_ID_RE.test(String(id))) {
            log(`invalid agent_id in agent_ids: ${id}`);
            return null;
          }
        }
      }
      return { tool, args };
    } catch (err) {
      log(`parse error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Remove ALL [TOOL_CALL] blocks from text, collapse excess newlines. */
  static stripToolCallBlocks(text: string): string {
    let result = text;
    // Strip fenced blocks containing [TOOL_CALL]
    const fencedMatches = result.match(BLOCK_IN_FENCE_RE);
    if (fencedMatches) {
      result = result.replace(BLOCK_IN_FENCE_RE, '');
    }
    // Strip raw [TOOL_CALL]...[/TOOL_CALL] blocks
    const rawMatches = result.match(BLOCK_RE);
    if (rawMatches) {
      result = result.replace(BLOCK_RE, '');
    }
    // Strip [TOOL_CALL] at end of text (no closing tag)
    result = result.replace(/\[TOOL_CALL\][\s\S]*$/, '');
    const totalMatches = (fencedMatches?.length ?? 0) + (rawMatches?.length ?? 0);
    if (totalMatches > 1) {
      log(`warning: ${totalMatches} tool call blocks found, stripping all`);
    }
    return result.replace(/\n{3,}/g, '\n\n').trim();
  }
}

// ── ToolExecutor ──────────────────────────────────────────────────────────

export interface ToolExecutorConfig {
  pipeline: any;       // DispatchPipeline — use any to avoid circular imports
  registry: any;       // AgentRegistry
  projectRoot: string;
  dispatcher?: any;    // TaskDispatcher
  initializer?: any;   // ProjectInitializer
  teamManager?: any;   // TeamManager
  llm?: any;           // ILLMProvider — for result synthesis
}

interface AgentLike {
  id: string;
  provider: string;
  model: string;
  skills: string[];
}

interface CollectResultLike {
  results: Array<{ agentId: string; status: string; result?: string; error?: string }>;
  consensus?: { summary: string };
}

/**
 * Executes validated ToolCalls by calling the appropriate pipeline/registry
 * methods, with auto-chaining for dispatch tools.
 */
export class ToolExecutor {
  pendingPlan: { plan: DispatchPlan; tasks: PlannedTask[] } | null = null;
  pendingInstructionUpdate: { agentIds: string[]; instruction: string } | null = null;

  private readonly pipeline: any;
  private readonly registry: any;
  private readonly projectRoot: string;
  private readonly dispatcher: any;
  private readonly initializer: any;
  private readonly teamManager: any;
  private readonly llm: any;

  constructor(private readonly config: ToolExecutorConfig) {
    this.pipeline = config.pipeline;
    this.registry = config.registry;
    this.projectRoot = config.projectRoot;
    this.dispatcher = config.dispatcher ?? null;
    this.initializer = config.initializer ?? null;
    this.teamManager = config.teamManager ?? null;
    this.llm = config.llm ?? null;
  }

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    try {
      switch (toolCall.tool) {
        case 'dispatch':
          return await this.handleDispatch(toolCall.args);
        case 'dispatch_parallel':
          return await this.handleDispatchParallel(toolCall.args);
        case 'dispatch_consensus':
          return await this.handleDispatchConsensus(toolCall.args);
        case 'plan':
          return await this.handlePlan(toolCall.args);
        case 'agents':
          return this.handleAgents();
        case 'agent_status':
          return this.handleAgentStatus(toolCall.args);
        case 'agent_performance':
          return this.handleAgentPerformance();
        case 'update_instructions':
          return this.handleUpdateInstructions(toolCall.args);
        case 'read_task_history':
          return this.handleReadTaskHistory(toolCall.args);
        case 'init_project':
          return await this.handleInitProject(toolCall.args);
        case 'update_team':
          return this.handleUpdateTeam(toolCall.args);
        default:
          return { text: `Tool error: unknown tool "${toolCall.tool}"` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { text: `Tool error: ${message}` };
    }
  }

  /**
   * Progress callback for plan execution.
   * Called for init, start, progress, done, error, and finish events.
   */
  onTaskProgress: ((event: TaskProgressEvent) => void) | null = null;

  async executePlan(pending: { plan: DispatchPlan; tasks: PlannedTask[] }): Promise<ToolResult> {
    try {
      const { plan, tasks } = pending;
      const agentSet = new Set<string>();

      // Emit init event
      this.onTaskProgress?.({
        taskIndex: 0, totalTasks: tasks.length,
        agentId: '', taskDescription: '',
        status: 'init',
        agents: tasks.map(t => ({ agentId: t.agentId, task: t.task })),
      });

      // Wire pipeline progress callback
      const taskIdToIndex = new Map<string, number>();
      this.pipeline.setTaskProgressCallback?.((taskId: string, evt: any) => {
        const idx = taskIdToIndex.get(taskId);
        if (idx != null) {
          this.onTaskProgress?.({
            taskIndex: idx, totalTasks: tasks.length,
            agentId: tasks[idx].agentId, taskDescription: tasks[idx].task,
            status: 'progress',
            toolCalls: evt.toolCalls, inputTokens: evt.inputTokens,
            outputTokens: evt.outputTokens, currentTool: evt.currentTool, turn: evt.turn,
          });
        }
      });

      if (plan.strategy === 'parallel') {
        const taskDefs = tasks.map(t => ({
          agentId: t.agentId,
          task: t.task,
          options: t.writeMode ? { writeMode: t.writeMode, scope: t.scope } : undefined,
        }));

        for (let i = 0; i < tasks.length; i++) {
          agentSet.add(tasks[i].agentId);
          this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: tasks[i].agentId, taskDescription: tasks[i].task, status: 'start' });
        }

        const { taskIds, errors } = await this.pipeline.dispatchParallel(taskDefs);
        // Populate immediately — must happen before any await that could yield to worker callbacks
        for (let i = 0; i < taskIds.length; i++) taskIdToIndex.set(taskIds[i], i);
        if (errors.length > 0) {
          return { text: `Plan execution failed.\n\nErrors:\n${errors.map((e: string) => `  - ${e}`).join('\n')}` };
        }
        const collectResult: CollectResultLike = await this.pipeline.collect(taskIds, 300_000);
        const lines: string[] = [];
        for (let i = 0; i < collectResult.results.length; i++) {
          const r = collectResult.results[i];
          agentSet.add(r.agentId);
          if (r.status === 'completed') {
            this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: r.agentId, taskDescription: tasks[i].task, status: 'done', result: r.result });
            lines.push(r.result || '(no output)');
          } else {
            const errorMsg = r.status === 'running'
              ? `Timed out — agent may be stuck`
              : (r.error || 'Task failed with no error message');
            this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: r.agentId, taskDescription: tasks[i].task, status: 'error', error: errorMsg });
            lines.push(`ERROR (${r.agentId}): ${errorMsg}`);
          }
        }

        // Emit finish event
        this.onTaskProgress?.({
          taskIndex: tasks.length, totalTasks: tasks.length,
          agentId: '', taskDescription: '', status: 'finish',
        });

        const synthesized = await this.synthesizeResults(plan.originalTask, lines, tasks);
        return { text: synthesized, agents: [...agentSet] };
      }

      // Sequential: dispatch one by one with progress.
      // Each subsequent task gets: (1) git diff from prior tasks showing exactly what
      // files were created/modified, and (2) a text summary of what each task did.
      // This prevents conflicting decisions (e.g. one agent picks TS, another JS).
      const results: string[] = [];
      const priorSummaries: string[] = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        agentSet.add(t.agentId);
        this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: t.agentId, taskDescription: t.task, status: 'start' });

        // Build context for this task from prior task results + file state
        let taskWithContext = t.task;
        if (i > 0) {
          const contextParts: string[] = [];

          // File manifest: what exists now (lightweight — just file names)
          try {
            const { execSync } = require('child_process');
            const currentFiles = execSync(
              'git status --porcelain --short 2>/dev/null || find . -maxdepth 3 -type f -not -path "./.git/*" -not -path "./node_modules/*" | head -50',
              { cwd: this.projectRoot, encoding: 'utf-8', timeout: 5000 },
            ).trim();
            if (currentFiles) {
              contextParts.push(`[Current project files]\n${currentFiles}`);
            }
          } catch { /* ignore */ }

          // Prior task summaries
          if (priorSummaries.length > 0) {
            contextParts.push(`[What prior tasks accomplished]\n${priorSummaries.join('\n')}`);
          }

          if (contextParts.length > 0) {
            taskWithContext = `${t.task}\n\n[Context — follow the same technology choices, file structure, and coding patterns]\n${contextParts.join('\n\n')}`;
          }
        }

        const opts = t.writeMode ? { writeMode: t.writeMode, scope: t.scope } : undefined;
        const { taskId } = this.pipeline.dispatch(t.agentId, taskWithContext, opts);
        taskIdToIndex.set(taskId, i);
        const collectResult: CollectResultLike = await this.pipeline.collect([taskId], 300_000);
        const entry = collectResult.results[0];

        if (entry?.status === 'completed') {
          this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: t.agentId, taskDescription: t.task, status: 'done', result: entry.result });
          results.push(`[${t.agentId}] ${entry.result || '(no output)'}`);
          priorSummaries.push(`- Task ${i + 1} (${t.agentId}): ${(entry.result || '').slice(0, 300)}`);
        } else {
          const errorMsg = entry?.status === 'running'
            ? `Timed out after 300s — agent may be stuck`
            : (entry?.error || 'Task failed with no error message');
          this.onTaskProgress?.({ taskIndex: i, totalTasks: tasks.length, agentId: t.agentId, taskDescription: t.task, status: 'error', error: errorMsg });
          results.push(`[${t.agentId}] ERROR: ${errorMsg}`);
          priorSummaries.push(`- Task ${i + 1} (${t.agentId}): FAILED — ${errorMsg}`);
        }
      }

      // Emit finish event
      this.onTaskProgress?.({
        taskIndex: tasks.length, totalTasks: tasks.length,
        agentId: '', taskDescription: '', status: 'finish',
      });

      const synthesized = await this.synthesizeResults(plan.originalTask, results, tasks);
      return { text: synthesized, agents: [...agentSet] };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { text: `Tool error: ${message}` };
    } finally {
      this.pipeline.setTaskProgressCallback?.(null);
    }
  }

  /**
   * Synthesize raw agent results into a concise orchestrator summary.
   * Instead of dumping raw output, the orchestrator reviews what agents did
   * and presents: what was built, any issues, and suggested next steps.
   */
  private async synthesizeResults(
    originalTask: string,
    rawResults: string[],
    tasks: PlannedTask[],
  ): Promise<string> {
    // If no LLM available, fall back to raw output
    if (!this.llm) return rawResults.join('\n\n');

    // If single task, skip synthesis overhead
    if (rawResults.length === 1) return rawResults[0];

    const agentOutputs = rawResults.map((r, i) =>
      `Task ${i + 1} (${tasks[i]?.agentId || 'unknown'}): ${tasks[i]?.task || ''}\nResult: ${r.slice(0, 800)}`
    ).join('\n\n---\n\n');

    try {
      const response = await this.llm.generate([
        {
          role: 'system',
          content: `You are the orchestrator reviewing completed agent work. Synthesize the agent results into a concise report for the developer. Do NOT repeat the raw agent output.

Your report should have these sections:
## What was built
Brief summary of what the agents created (files, features, tech stack).

## Issues found
Any errors, unfinished work, or concerns from the agents. If none, say "None."

## Next steps
1-3 concrete suggestions for what to do next (test it, add a feature, fix an issue).

Be concise — 10-15 lines max. The developer has already seen the progress bars.`,
        },
        { role: 'user', content: `Original task: ${originalTask}\n\nAgent results:\n${agentOutputs}` },
      ]);
      return response.text;
    } catch {
      // Synthesis failed — fall back to raw output
      return rawResults.join('\n\n');
    }
  }

  async applyInstructionUpdate(pending: { agentIds: string[]; instruction: string }): Promise<ToolResult> {
    try {
      const fsp = await import('fs/promises');
      const updatedIds: string[] = [];

      for (const id of pending.agentIds) {
        const agentDir = join(this.projectRoot, '.gossip', 'agents', id);
        const filePath = join(agentDir, 'instructions.md');

        if (!existsSync(agentDir)) {
          await fsp.mkdir(agentDir, { recursive: true });
        }

        if (existsSync(filePath)) {
          await fsp.appendFile(filePath, `\n\n${pending.instruction}`, 'utf-8');
        } else {
          await fsp.writeFile(filePath, pending.instruction, 'utf-8');
        }
        updatedIds.push(id);
      }

      return { text: `Updated instructions for: ${updatedIds.join(', ')}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { text: `Tool error: ${message}` };
    }
  }

  // ── Private handlers ──────────────────────────────────────────────────

  private async handleDispatch(args: Record<string, unknown>): Promise<ToolResult> {
    const agentId = String(args.agent_id);
    const task = String(args.task);

    if (!this.registry.get(agentId)) {
      return { text: `Tool error: agent "${agentId}" not found in registry` };
    }

    // Pass through write_mode/scope if LLM provided them
    const options: Record<string, unknown> = {};
    if (args.write_mode) options.writeMode = args.write_mode;
    if (args.scope) options.scope = args.scope;
    const dispatchOpts = Object.keys(options).length > 0 ? options : undefined;

    const { taskId } = dispatchOpts
      ? this.pipeline.dispatch(agentId, task, dispatchOpts as any)
      : this.pipeline.dispatch(agentId, task);
    const collectResult: CollectResultLike = await this.pipeline.collect([taskId], 300_000);
    const entry = collectResult.results[0];

    if (!entry) {
      return { text: `Tool error: task ${taskId} returned no result. The agent may have crashed or the relay disconnected.`, agents: [agentId] };
    }
    if (entry.status === 'failed') {
      return { text: `Agent ${agentId} failed: ${entry.error || 'unknown error'}`, agents: [agentId] };
    }
    if (entry.status !== 'completed') {
      // Task still running after timeout — likely hung
      return { text: `Agent ${agentId} timed out after 120s. The task may be too complex or the agent is stuck. Task: "${task.slice(0, 100)}"`, agents: [agentId] };
    }

    return { text: entry.result ?? '', agents: [agentId] };
  }

  private async handleDispatchParallel(args: Record<string, unknown>): Promise<ToolResult> {
    const tasks = args.tasks as Array<{ agent_id: string; task: string }>;
    const agents: string[] = [];

    // Validate all agent_ids first
    for (const t of tasks) {
      if (!this.registry.get(t.agent_id)) {
        return { text: `Tool error: agent "${t.agent_id}" not found in registry` };
      }
      agents.push(t.agent_id);
    }

    const taskDefs = tasks.map(t => ({ agentId: t.agent_id, task: t.task }));
    const { taskIds, errors } = await this.pipeline.dispatchParallel(taskDefs);

    if (errors.length > 0) {
      return { text: `Tool error: ${errors.join('; ')}`, agents };
    }

    const collectResult: CollectResultLike = await this.pipeline.collect(taskIds, 300_000);
    const lines = collectResult.results.map(r => {
      if (r.status === 'completed') return `[${r.agentId}] ${r.result}`;
      if (r.status === 'running') return `[${r.agentId}] ERROR: Timed out — agent may be stuck`;
      return `[${r.agentId}] ERROR: ${r.error || 'failed with no error message'}`;
    });

    return { text: lines.join('\n\n'), agents };
  }

  private async handleDispatchConsensus(args: Record<string, unknown>): Promise<ToolResult> {
    const task = String(args.task);
    const specifiedIds = args.agent_ids as string[] | undefined;

    let agents: AgentLike[];
    if (specifiedIds) {
      const missing = specifiedIds.filter((id: string) => !this.registry.get(id));
      if (missing.length > 0) {
        return { text: `Tool error: agents not found in registry: ${missing.join(', ')}` };
      }
      agents = specifiedIds.map((id: string) => this.registry.get(id)!);
    } else {
      agents = this.registry.getAll();
    }

    if (agents.length < 2) {
      return { text: 'Tool error: consensus requires at least 2 agents' };
    }

    const agentIds = agents.map(a => a.id);
    const taskDefs = agentIds.map(id => ({ agentId: id, task }));
    const { taskIds, errors } = await this.pipeline.dispatchParallel(taskDefs, { consensus: true });

    if (errors.length > 0) {
      return { text: `Tool error: ${errors.join('; ')}`, agents: agentIds };
    }

    const collectResult: CollectResultLike = await this.pipeline.collect(taskIds, 300_000, { consensus: true });
    const lines = collectResult.results.map(r =>
      `[${r.agentId}] ${r.status === 'completed' ? r.result : `ERROR: ${r.error}`}`
    );

    let text = lines.join('\n\n');
    if (collectResult.consensus?.summary) {
      text += `\n\n## Consensus Report\n${collectResult.consensus.summary}`;
    }

    return { text, agents: agentIds };
  }

  private async handlePlan(args: Record<string, unknown>): Promise<ToolResult> {
    const task = String(args.task);

    if (this.pendingPlan) {
      return {
        text: 'A plan is already pending approval. Choose an action:',
        choices: {
          message: 'A plan is already pending. What would you like to do?',
          options: [
            { value: PENDING_PLAN_CHOICES.EXECUTE_PENDING, label: 'Execute pending plan' },
            { value: PENDING_PLAN_CHOICES.DISCARD, label: 'Discard and create new plan' },
            { value: PENDING_PLAN_CHOICES.CANCEL, label: 'Cancel' },
          ],
        },
      };
    }

    if (!this.dispatcher) {
      return { text: 'Tool error: dispatcher not available for plan decomposition' };
    }

    const plan: DispatchPlan = await this.dispatcher.decompose(task);
    const assigned: DispatchPlan = this.dispatcher.assignAgents(plan);
    const tasks: PlannedTask[] = await this.dispatcher.classifyWriteModes(assigned);

    this.pendingPlan = { plan: assigned, tasks };

    // Format plan for display
    const warnings = assigned.warnings?.length
      ? `\n⚠ ${assigned.warnings.join('\n⚠ ')}\n`
      : '';

    const taskLines = tasks.map((t, i) => {
      const icon = t.access === 'write' ? '✏' : '👁';
      const mode = t.writeMode ? ` [${t.writeMode}${t.scope ? `: ${t.scope}` : ''}]` : '';
      return `  ${icon} ${i + 1}. ${t.agentId} → ${t.task}${mode}`;
    });

    const strategyLabel = assigned.strategy === 'single' ? 'Single agent'
      : assigned.strategy === 'parallel' ? 'Parallel execution'
      : 'Sequential execution';

    return {
      text: `## Plan: ${task}\n\n${strategyLabel} · ${tasks.length} task${tasks.length !== 1 ? 's' : ''}${warnings}\n\n${taskLines.join('\n')}`,
      choices: {
        message: 'How would you like to proceed?',
        options: [
          { value: PLAN_CHOICES.EXECUTE, label: 'Execute plan' },
          { value: PLAN_CHOICES.MODIFY, label: 'Modify plan' },
          { value: PLAN_CHOICES.CANCEL, label: 'Cancel' },
        ],
      },
    };
  }

  private handleAgents(): ToolResult {
    const agents: AgentLike[] = this.registry.getAll();
    if (agents.length === 0) {
      return { text: 'No agents registered.' };
    }

    const lines = agents.map(a =>
      `- **${a.id}** (${a.provider}/${a.model}) — skills: ${a.skills.join(', ') || 'none'}`
    );

    return { text: `## Registered Agents\n\n${lines.join('\n')}` };
  }

  private handleAgentStatus(args: Record<string, unknown>): ToolResult {
    const agentId = String(args.agent_id);

    if (!this.registry.get(agentId)) {
      return { text: `Tool error: agent "${agentId}" not found in registry` };
    }

    const tasksPath = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory', 'tasks.jsonl');
    if (!existsSync(tasksPath)) {
      return { text: `Agent "${agentId}" — no task history found.` };
    }

    const rawLines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last5 = rawLines.slice(-5).map(line => {
      try { return JSON.parse(line); } catch (_e) { return null; }
    }).filter(Boolean);

    const formatted = last5.map((entry: Record<string, unknown>) =>
      `- ${entry.task} — warmth: ${entry.warmth ?? 'n/a'}, ${entry.timestamp ?? ''}`
    );

    return { text: `## Agent Status: ${agentId}\n\nLast ${last5.length} tasks:\n${formatted.join('\n')}` };
  }

  private handleAgentPerformance(): ToolResult {
    const perfPath = join(this.projectRoot, '.gossip', 'agent-performance.jsonl');
    if (!existsSync(perfPath)) {
      return { text: 'No performance data found.' };
    }

    const rawLines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    const last20 = rawLines.slice(-20).map(line => {
      try { return JSON.parse(line); } catch (_e) { return null; }
    }).filter(Boolean);

    // Group by agent
    const byAgent = new Map<string, Array<Record<string, unknown>>>();
    for (const signal of last20) {
      const id = String(signal.agentId ?? 'unknown');
      if (!byAgent.has(id)) byAgent.set(id, []);
      byAgent.get(id)!.push(signal as Record<string, unknown>);
    }

    const sections = Array.from(byAgent.entries()).map(([id, signals]) =>
      `### ${id}\n${signals.map(s => `- ${s.signal ?? s.type ?? 'signal'} (${s.outcome ?? 'n/a'})`).join('\n')}`
    );

    return { text: `## Agent Performance (last ${last20.length} signals)\n\n${sections.join('\n\n')}` };
  }

  private handleUpdateInstructions(args: Record<string, unknown>): ToolResult {
    const agentIds = args.agent_ids as string[];
    const instruction = String(args.instruction);

    // Validate all IDs exist
    for (const id of agentIds) {
      if (!this.registry.get(id)) {
        return { text: `Tool error: agent "${id}" not found in registry` };
      }
    }

    this.pendingInstructionUpdate = { agentIds, instruction };

    return {
      text: `Instruction update staged for: ${agentIds.join(', ')}\n\nInstruction: "${instruction}"`,
      choices: {
        message: 'Apply this instruction update?',
        options: [
          { value: 'apply', label: 'Apply instruction update' },
          { value: 'cancel', label: 'Cancel' },
        ],
        type: 'confirm',
      },
    };
  }

  private handleReadTaskHistory(args: Record<string, unknown>): ToolResult {
    const agentId = String(args.agent_id);
    const limit = typeof args.limit === 'number' ? args.limit : 10;

    if (!this.registry.get(agentId)) {
      return { text: `Tool error: agent "${agentId}" not found in registry` };
    }

    const tasksPath = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory', 'tasks.jsonl');
    if (!existsSync(tasksPath)) {
      return { text: `No task history for agent "${agentId}".` };
    }

    const rawLines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
    const entries = rawLines.slice(-limit).map(line => {
      try { return JSON.parse(line); } catch (_e) { return null; }
    }).filter(Boolean);

    const formatted = entries.map((e: Record<string, unknown>) =>
      `- **${e.task}** — warmth: ${e.warmth ?? 'n/a'}, scores: ${JSON.stringify(e.scores ?? {})}, ${e.timestamp ?? ''}`
    );

    return { text: `## Task History: ${agentId} (last ${entries.length})\n\n${formatted.join('\n')}` };
  }

  private async handleInitProject(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.initializer) {
      return { text: 'Project initialization not available in this context.' };
    }
    // Don't re-init if agents already exist
    if (this.registry.getAll().length > 0) {
      return { text: `Project already has ${this.registry.getAll().length} agents configured. Use update_team to modify the team.` };
    }
    const description = String(args.description);
    const signals = this.initializer.scanDirectory(this.config.projectRoot);
    this.initializer.pendingTask = description;
    return this.initializer.proposeTeam(description, signals);
  }

  private handleUpdateTeam(args: Record<string, unknown>): ToolResult {
    if (!this.teamManager) {
      return { text: 'Team management not available in this context.' };
    }
    const action = String(args.action);
    switch (action) {
      case 'add': {
        const preset = String(args.preset || 'implementer');
        const skills = Array.isArray(args.skills) ? args.skills.map(String) : [];
        return this.teamManager.proposeAdd({
          id: String(args.agent_id || `new-${preset}`),
          provider: 'google',
          model: 'gemini-2.5-pro',
          preset,
          skills,
        });
      }
      case 'remove':
        return this.teamManager.proposeRemove(String(args.agent_id));
      case 'modify':
        return this.teamManager.proposeModify(String(args.agent_id), {
          skills: Array.isArray(args.skills) ? args.skills.map(String) : undefined,
          preset: args.preset ? String(args.preset) : undefined,
        });
      default:
        return { text: `Unknown team action: ${action}. Use add, remove, or modify.` };
    }
  }
}
