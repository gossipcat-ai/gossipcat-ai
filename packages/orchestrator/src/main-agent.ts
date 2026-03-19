/**
 * MainAgent — the developer's single point of contact.
 *
 * Receives natural language tasks, decomposes them via TaskDispatcher,
 * fans out to WorkerAgents, and synthesizes results.
 */

import { ILLMProvider, createProvider } from './llm-client';
import { AgentRegistry } from './agent-registry';
import { TaskDispatcher } from './task-dispatcher';
import { WorkerAgent } from './worker-agent';
import { AgentConfig, TaskResult } from './types';
import { ALL_TOOLS } from '@gossip/tools';

export interface MainAgentConfig {
  provider: string;
  model: string;
  apiKey?: string;
  relayUrl: string;
  agents: AgentConfig[];
}

export class MainAgent {
  private llm: ILLMProvider;
  private registry: AgentRegistry;
  private dispatcher: TaskDispatcher;
  private workers: Map<string, WorkerAgent> = new Map();
  private relayUrl: string;

  constructor(config: MainAgentConfig) {
    this.llm = createProvider(config.provider, config.model, config.apiKey);
    this.registry = new AgentRegistry();
    this.dispatcher = new TaskDispatcher(this.llm, this.registry);
    this.relayUrl = config.relayUrl;

    for (const agent of config.agents) {
      this.registry.register(agent);
    }
  }

  /** Start all worker agents (connect to relay) */
  async start(): Promise<void> {
    for (const config of this.registry.getAll()) {
      const llm = createProvider(config.provider, config.model);
      const worker = new WorkerAgent(config.id, llm, this.relayUrl, ALL_TOOLS);
      await worker.start();
      this.workers.set(config.id, worker);
    }
  }

  /** Stop all worker agents */
  async stop(): Promise<void> {
    for (const worker of this.workers.values()) {
      await worker.stop();
    }
    this.workers.clear();
  }

  /** Handle a user message: decompose, dispatch, synthesize */
  async handleMessage(userMessage: string): Promise<string> {
    const plan = await this.dispatcher.decompose(userMessage);
    this.dispatcher.assignAgents(plan);

    // Handle unassigned tasks directly with main LLM
    const unassigned = plan.subTasks.filter(st => !st.assignedAgent);
    if (unassigned.length === plan.subTasks.length) {
      // All unassigned — handle directly
      const response = await this.llm.generate([
        { role: 'system', content: 'You are a helpful developer assistant. Be concise.' },
        { role: 'user', content: userMessage },
      ]);
      return response.text;
    }

    // Execute assigned sub-tasks
    const results: TaskResult[] = [];
    const assigned = plan.subTasks.filter(st => st.assignedAgent);

    if (plan.strategy === 'parallel') {
      const promises = assigned.map(subTask => this.executeSubTask(subTask));
      results.push(...await Promise.all(promises));
    } else {
      for (const subTask of assigned) {
        results.push(await this.executeSubTask(subTask));
      }
    }

    return this.synthesize(userMessage, results);
  }

  private async executeSubTask(subTask: { assignedAgent?: string; description: string }): Promise<TaskResult> {
    const worker = this.workers.get(subTask.assignedAgent!);
    if (!worker) {
      return { agentId: 'unknown', task: subTask.description, result: '', error: 'No worker', duration: 0 };
    }
    const start = Date.now();
    try {
      const result = await worker.executeTask(subTask.description);
      return { agentId: subTask.assignedAgent!, task: subTask.description, result, duration: Date.now() - start };
    } catch (err) {
      return {
        agentId: subTask.assignedAgent!, task: subTask.description,
        result: '', error: (err as Error).message, duration: Date.now() - start,
      };
    }
  }

  private async synthesize(originalTask: string, results: TaskResult[]): Promise<string> {
    if (results.length === 1) {
      return results[0].error || results[0].result;
    }

    const summaryPrompt = results.map(r =>
      `Agent ${r.agentId} (${r.duration}ms):\n${r.error ? `ERROR: ${r.error}` : r.result}`
    ).join('\n\n---\n\n');

    const response = await this.llm.generate([
      { role: 'system', content: 'Synthesize the following agent results into a single coherent response. Be concise.' },
      { role: 'user', content: `Original task: ${originalTask}\n\nAgent results:\n${summaryPrompt}` },
    ]);

    return response.text;
  }
}
