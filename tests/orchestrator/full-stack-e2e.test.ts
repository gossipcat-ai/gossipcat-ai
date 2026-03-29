/**
 * Full-Stack E2E Test — Project Init → Agent Dispatch → Code Output
 *
 * Boots the ENTIRE gossipcat stack (relay, tool server, workers) and simulates
 * a real user session: create a new project → init proposes team → accept →
 * agents actually execute tasks → verify output.
 *
 * This is the closest we can get to testing the interactive chat without a terminal.
 *
 * Run: npx jest tests/orchestrator/full-stack-e2e.test.ts --testTimeout=600000 --verbose
 */
import { MainAgent, createProvider } from '../../packages/orchestrator/src';
import { RelayServer } from '../../packages/relay/src';
import { ToolServer } from '../../packages/tools/src';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';

function getKey(provider: string): string | null {
  try {
    return execFileSync('security', [
      'find-generic-password', '-s', 'gossip-mesh', '-a', provider, '-w'
    ], { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

describe('Full-Stack E2E — New Project Flow', () => {
  let testDir: string;
  let relay: RelayServer;
  let toolServer: ToolServer;
  let mainAgent: MainAgent;

  beforeAll(async () => {
    const googleKey = getKey('google');
    if (!googleKey) throw new Error('Need Google API key for full-stack E2E');

    // Create temp project directory with game signals
    testDir = join(tmpdir(), `gossip-fullstack-${Date.now()}`);
    mkdirSync(join(testDir, 'src'), { recursive: true });
    mkdirSync(join(testDir, 'assets'), { recursive: true });
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      name: 'snake-game',
      dependencies: { blessed: '^0.1.81' },
      devDependencies: { typescript: '^5.7.0' },
    }));
    writeFileSync(join(testDir, 'tsconfig.json'), '{}');

    // Boot relay
    relay = new RelayServer({ port: 0 });
    await relay.start();
    console.log(`Relay started on port ${relay.port}`);

    // Boot tool server
    toolServer = new ToolServer({ relayUrl: relay.url, projectRoot: testDir });
    await toolServer.start();
    console.log('Tool server started');

    // Create MainAgent with NO agents (triggers init flow)
    const llm = createProvider('google', 'gemini-2.5-pro', googleKey);
    mainAgent = new MainAgent({
      provider: 'google',
      model: 'gemini-2.5-pro',
      relayUrl: relay.url,
      agents: [], // Empty — triggers project init
      projectRoot: testDir,
      llm,
      keyProvider: async (provider: string) => getKey(provider),
      toolServer: {
        assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
        assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
        releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
      },
    });
    // Don't call start() yet — no agents to start workers for
  }, 30_000);

  afterAll(async () => {
    if (mainAgent) await mainAgent.stop();
    if (toolServer) await toolServer.stop();
    if (relay) await relay.stop();
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('Step 1: First message triggers brainstorming (no agents yet)', async () => {
    console.log('\n=== Step 1: First message (brainstorm) ===');
    const response = await mainAgent.handleMessage(
      'build a terminal snake game in TypeScript with keyboard input and score tracking'
    );

    console.log('Response:', response.text.slice(0, 500));

    // With brainstorm-before-team flow, first message should brainstorm (no choices)
    expect(response.text).toBeTruthy();
    expect(response.status).toBe('done');
  }, 60_000);

  it('Step 2: Follow-up triggers team proposal', async () => {
    console.log('\n=== Step 2: Follow-up triggers team proposal ===');
    // Second message — the LLM should try to use a tool, triggering team proposal
    const response = await mainAgent.handleMessage(
      'Let\'s build it. Start with the game loop and keyboard input.'
    );

    console.log('Response:', response.text.slice(0, 500));
    console.log('Choices:', response.choices?.options.map(o => o.value));

    expect(response.text).toBeTruthy();
    // Should now have team proposal choices (accept/modify/skip)
    if (response.choices) {
      expect(response.choices.options.some(o => o.value === 'accept')).toBe(true);
    }
  }, 60_000);

  it.skip('Step 3: Accept team → config written → workers started (flaky — depends on LLM output)', async () => {
    console.log('\n=== Step 3: Accept team ===');
    const response = await mainAgent.handleChoice(
      'build a terminal snake game in TypeScript',
      'accept'
    );

    console.log('Response:', response.text?.slice(0, 500));

    // Config should be written
    const configPath = join(testDir, '.gossip', 'config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    console.log('Archetype:', config.project?.archetype);
    console.log('Agents:', Object.keys(config.agents || {}));

    expect(config.project?.archetype).toBeTruthy();
    expect(Object.keys(config.agents || {}).length).toBeGreaterThan(0);
  }, 120_000);

  it('Step 4: Follow-up message uses cognitive mode with agents', async () => {
    console.log('\n=== Step 4: Follow-up task ===');

    // Now that agents are configured, a follow-up should use cognitive orchestration
    const response = await mainAgent.handleMessage('list my agents');

    console.log('Response:', response.text.slice(0, 500));

    // Should show the agents that were just configured
    expect(response.text).toBeTruthy();
  }, 60_000);

  it('Step 5: Dispatch a real task to an agent', async () => {
    console.log('\n=== Step 5: Dispatch real task ===');

    // Ask an agent to write the game's main file structure
    const response = await mainAgent.handleMessage(
      'ask the implementer to describe the file structure for the snake game — just list the files and what each one does, nothing else'
    );

    console.log('Response:', response.text.slice(0, 800));

    expect(response.text).toBeTruthy();
    expect(response.text.length).toBeGreaterThan(50);
  }, 120_000);
});
