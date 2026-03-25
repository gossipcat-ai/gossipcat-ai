/**
 * ChatSimulator — automated multi-turn conversation testing for gossipcat.
 *
 * Boots the full stack (relay, tool server, workers) and provides a fluent
 * API for simulating user interactions and asserting on response structure.
 *
 * Usage:
 *   const sim = await ChatSimulator.create();
 *   await sim.send('build a music game');
 *   sim.expect.brainstorm();
 *   await sim.pickChoice('generative');
 *   sim.expect.teamProposal();
 *   await sim.teardown();
 */

import { MainAgent, createProvider, OverlapDetector, LensGenerator, GossipPublisher } from '../../packages/orchestrator/src';
import { RelayServer } from '../../packages/relay/src';
import { ToolServer } from '../../packages/tools/src';
import { GossipAgent } from '../../packages/client/src';
import { ChatResponse } from '../../packages/orchestrator/src/types';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

function getKey(provider: string): string | null {
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w',
    ], { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

export interface SimulatorConfig {
  provider?: string;
  model?: string;
  projectFiles?: Record<string, string>;  // filename → content for the test project
}

export class ChatSimulator {
  private mainAgent!: MainAgent;
  private relay!: RelayServer;
  private toolServer!: ToolServer;
  private testDir!: string;
  private lastResponse: ChatResponse | null = null;
  private turnLog: Array<{ role: 'user' | 'assistant'; content: string; choices?: string[] }> = [];

  /** Create and boot a fully connected simulator */
  static async create(config: SimulatorConfig = {}): Promise<ChatSimulator> {
    const sim = new ChatSimulator();
    await sim.boot(config);
    return sim;
  }

  private async boot(config: SimulatorConfig): Promise<void> {
    const provider = config.provider || 'google';
    const model = config.model || 'gemini-2.5-pro';
    const key = getKey(provider);
    if (!key) throw new Error(`Need ${provider} API key for ChatSimulator`);

    // Create temp project directory
    this.testDir = join(tmpdir(), `gossip-sim-${Date.now()}`);
    mkdirSync(join(this.testDir, 'src'), { recursive: true });

    // Write project files if provided
    if (config.projectFiles) {
      for (const [path, content] of Object.entries(config.projectFiles)) {
        const fullPath = join(this.testDir, path);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
    }

    // Boot relay
    this.relay = new RelayServer({ port: 0 });
    await this.relay.start();

    // Boot tool server
    this.toolServer = new ToolServer({ relayUrl: this.relay.url, projectRoot: this.testDir });
    await this.toolServer.start();

    // Create MainAgent
    const llm = createProvider(provider, model, key);
    this.mainAgent = new MainAgent({
      provider, model,
      apiKey: key,
      relayUrl: this.relay.url,
      agents: [],
      projectRoot: this.testDir,
      llm,
      keyProvider: async (p: string) => getKey(p),
      toolServer: {
        assignScope: (agentId: string, scope: string) => this.toolServer.assignScope(agentId, scope),
        assignRoot: (agentId: string, root: string) => this.toolServer.assignRoot(agentId, root),
        releaseAgent: (agentId: string) => this.toolServer.releaseAgent(agentId),
      },
    });

    // Wire coordination (same as chat.ts)
    try {
      const llmForLens = createProvider(provider, model, key);
      this.mainAgent.setOverlapDetector(new OverlapDetector());
      this.mainAgent.setLensGenerator(new LensGenerator(llmForLens));
    } catch { /* skip if unavailable */ }

    try {
      const publisherAgent = new GossipAgent({
        agentId: 'gossip-publisher', relayUrl: this.relay.url, reconnect: true,
      });
      await publisherAgent.connect();
      const llmForGossip = createProvider(provider, model, key);
      const gossipPublisher = new GossipPublisher(
        llmForGossip,
        { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) },
      );
      this.mainAgent.setGossipPublisher(gossipPublisher);
    } catch { /* skip */ }
  }

  /** Send a free-text message */
  async send(message: string): Promise<ChatResponse> {
    this.lastResponse = await this.mainAgent.handleMessage(message);
    this.turnLog.push(
      { role: 'user', content: message },
      {
        role: 'assistant',
        content: this.lastResponse.text.slice(0, 200),
        choices: this.lastResponse.choices?.options.map(o => o.value),
      },
    );
    return this.lastResponse;
  }

  /** Pick a choice from the last response's choices */
  async pickChoice(value: string): Promise<ChatResponse> {
    if (!this.lastResponse?.choices) {
      throw new Error(`No choices available. Last response: "${this.lastResponse?.text.slice(0, 100)}"`);
    }
    const option = this.lastResponse.choices.options.find(
      o => o.value === value || o.label.toLowerCase().includes(value.toLowerCase()),
    );
    if (!option) {
      const available = this.lastResponse.choices.options.map(o => `${o.value} (${o.label})`).join(', ');
      throw new Error(`Choice "${value}" not found. Available: ${available}`);
    }
    this.lastResponse = await this.mainAgent.handleChoice('', option.value);
    this.turnLog.push(
      { role: 'user', content: `[choice: ${option.value}]` },
      {
        role: 'assistant',
        content: this.lastResponse.text.slice(0, 200),
        choices: this.lastResponse.choices?.options.map(o => o.value),
      },
    );
    return this.lastResponse;
  }

  /** Get the last response */
  get last(): ChatResponse {
    if (!this.lastResponse) throw new Error('No response yet. Call send() first.');
    return this.lastResponse;
  }

  /** Assertion helpers */
  get expect() {
    const resp = this.last;
    return {
      /** Response has text content */
      text: () => {
        if (!resp.text || resp.text.length < 10) {
          throw new Error(`Expected text response, got: "${resp.text?.slice(0, 50)}"`);
        }
        return true;
      },

      /** Response is brainstorming (has text, no plan, may have choices) */
      brainstorm: () => {
        if (!resp.text || resp.text.length < 20) {
          throw new Error(`Expected brainstorming text, got: "${resp.text?.slice(0, 50)}"`);
        }
        if (resp.text.includes('Strategy:') || resp.text.includes('Single agent')) {
          throw new Error('Expected brainstorming but got a plan');
        }
        return true;
      },

      /** Response contains a team proposal with accept/modify choices */
      teamProposal: () => {
        if (!resp.choices) {
          throw new Error(`Expected team proposal with choices, got none. Text: "${resp.text?.slice(0, 100)}"`);
        }
        const hasAccept = resp.choices.options.some(o => o.value === 'accept');
        if (!hasAccept) {
          const values = resp.choices.options.map(o => o.value).join(', ');
          throw new Error(`Expected 'accept' choice in team proposal. Got: ${values}`);
        }
        return true;
      },

      /** Response confirms team is ready */
      teamReady: () => {
        if (!resp.text.toLowerCase().includes('team ready') && !resp.text.toLowerCase().includes('agents online')) {
          throw new Error(`Expected team ready message. Got: "${resp.text.slice(0, 100)}"`);
        }
        return true;
      },

      /** Response contains a plan with execute/modify/cancel choices */
      plan: () => {
        if (!resp.choices) {
          throw new Error(`Expected plan with choices. Text: "${resp.text?.slice(0, 100)}"`);
        }
        const hasExecute = resp.choices.options.some(o =>
          o.value === 'execute_plan' || o.label.toLowerCase().includes('execute'),
        );
        if (!hasExecute) {
          const values = resp.choices.options.map(o => `${o.value}(${o.label})`).join(', ');
          throw new Error(`Expected 'execute' choice in plan. Got: ${values}`);
        }
        return true;
      },

      /** Response mentions agents (they did work) */
      agentWork: () => {
        if (!resp.agents?.length) {
          throw new Error(`Expected agent attribution, got none`);
        }
        return true;
      },

      /** Response does NOT contain internal context leaks */
      noLeaks: () => {
        const leakPatterns = [
          '[Brainstorming context]',
          'user: I want',
          'assistant: ',
          'I chose: "',
          '[TOOL_CALL]',
        ];
        for (const pattern of leakPatterns) {
          if (resp.text.includes(pattern)) {
            throw new Error(`Internal context leak detected: "${pattern}" in response`);
          }
        }
        return true;
      },

      /** Response has choices */
      hasChoices: () => {
        if (!resp.choices?.options.length) {
          throw new Error('Expected choices, got none');
        }
        return true;
      },

      /** Response has no choices */
      noChoices: () => {
        if (resp.choices?.options.length) {
          throw new Error(`Expected no choices, got: ${resp.choices.options.map(o => o.value).join(', ')}`);
        }
        return true;
      },

      /** Text contains a substring */
      contains: (substr: string) => {
        if (!resp.text.includes(substr)) {
          throw new Error(`Expected text to contain "${substr}". Got: "${resp.text.slice(0, 200)}"`);
        }
        return true;
      },

      /** Text does not contain a substring */
      notContains: (substr: string) => {
        if (resp.text.includes(substr)) {
          throw new Error(`Expected text NOT to contain "${substr}"`);
        }
        return true;
      },
    };
  }

  /** Print the conversation log for debugging */
  printLog(): void {
    console.log('\n=== Conversation Log ===');
    for (const turn of this.turnLog) {
      const prefix = turn.role === 'user' ? '> ' : '  ';
      console.log(`${prefix}${turn.content}`);
      if (turn.choices) console.log(`  [choices: ${turn.choices.join(', ')}]`);
    }
    console.log('========================\n');
  }

  /** Get the test project directory */
  get projectDir(): string {
    return this.testDir;
  }

  /** Get the agent count */
  get agentCount(): number {
    return this.mainAgent.getAgentCount();
  }

  /** Tear down everything */
  async teardown(): Promise<void> {
    try { await this.mainAgent?.stop(); } catch { /* ignore */ }
    try { await this.toolServer?.stop(); } catch { /* ignore */ }
    try { await this.relay?.stop(); } catch { /* ignore */ }
    if (this.testDir && existsSync(this.testDir)) {
      rmSync(this.testDir, { recursive: true, force: true });
    }
  }
}
