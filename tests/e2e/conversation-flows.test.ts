/**
 * Conversation Flow E2E Tests
 *
 * Tests full multi-turn conversation flows with real LLM calls.
 * Each test simulates a real user session and asserts on response structure.
 *
 * Run: npx jest tests/e2e/conversation-flows.test.ts --testTimeout=600000 --verbose
 */

import { ChatSimulator } from './chat-simulator';

let sim: ChatSimulator;

beforeAll(async () => {
  sim = await ChatSimulator.create();
}, 30_000);

afterAll(async () => {
  if (sim) {
    sim.printLog();
    await sim.teardown();
  }
});

describe('Brainstorm → Team → Plan → Execute', () => {
  it('first message triggers brainstorming, not team proposal', async () => {
    await sim.send('build an arcade music game that teaches notes and scales with colors');
    sim.expect.brainstorm();
    sim.expect.noLeaks();
  }, 60_000);

  it('brainstorming presents choices for creative direction', async () => {
    sim.expect.hasChoices();
  });

  it('picking a direction continues brainstorming or proposes team', async () => {
    // Pick the first available choice
    const firstChoice = sim.last.choices!.options[0].value;
    await sim.pickChoice(firstChoice);
    sim.expect.noLeaks();
    sim.expect.text();
  }, 60_000);

  it('eventually proposes a team with accept choice', async () => {
    // May need one more message to trigger team proposal
    if (!sim.last.choices?.options.some(o => o.value === 'accept')) {
      // Send a follow-up to trigger team proposal
      await sim.send('let\'s build it');
    }

    // Should now have team proposal or tech stack choices
    // If tech stack choices, pick one
    if (sim.last.choices && !sim.last.choices.options.some(o => o.value === 'accept')) {
      const firstChoice = sim.last.choices.options[0].value;
      await sim.pickChoice(firstChoice);
    }

    // Retry up to 2 more times
    for (let i = 0; i < 2; i++) {
      if (sim.last.choices?.options.some(o => o.value === 'accept')) break;
      await sim.send('yes, let\'s proceed with that');
    }

    sim.expect.teamProposal();
    sim.expect.noLeaks();
  }, 120_000);

  it('accepting team creates agents', async () => {
    await sim.pickChoice('accept');
    sim.expect.teamReady();
    sim.expect.noLeaks();
    expect(sim.agentCount).toBeGreaterThan(0);
  }, 120_000);

  it('"start" triggers plan via plan tool', async () => {
    if (sim.last.choices?.options.some(o => o.value === 'start')) {
      await sim.pickChoice('start');
    } else {
      await sim.send('start building');
    }

    // Should get a plan with execute choice
    // The LLM might brainstorm first or go straight to plan
    for (let i = 0; i < 3; i++) {
      if (sim.last.choices?.options.some(o =>
        o.value === 'execute_plan' || o.label.toLowerCase().includes('execute'),
      )) break;
      if (sim.last.choices) {
        await sim.pickChoice(sim.last.choices.options[0].value);
      } else {
        await sim.send('create a plan and dispatch to agents');
      }
    }

    sim.expect.plan();
    sim.expect.noLeaks();
  }, 180_000);

  it('executing plan dispatches to agents', async () => {
    // Find the execute choice
    const executeChoice = sim.last.choices!.options.find(o =>
      o.value === 'execute_plan' || o.label.toLowerCase().includes('execute'),
    );
    await sim.pickChoice(executeChoice!.value);

    // Should have agent work
    sim.expect.text();
    sim.expect.noLeaks();
  }, 300_000);
});
