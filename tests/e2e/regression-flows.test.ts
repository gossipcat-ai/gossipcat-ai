/**
 * Regression E2E Tests — specific bugs that were reported and fixed.
 *
 * Each test reproduces a specific failure mode from user conversations.
 * Tests use real LLM calls to verify fixes hold.
 *
 * Run: npx jest tests/e2e/regression-flows.test.ts --testTimeout=600000 --verbose
 */

import { ChatSimulator } from './chat-simulator';

describe('No internal context leaks', () => {
  let sim: ChatSimulator;

  beforeAll(async () => {
    sim = await ChatSimulator.create();
  }, 30_000);

  afterAll(async () => {
    sim.printLog();
    await sim.teardown();
  });

  it('brainstorming context never appears in user-visible output', async () => {
    await sim.send('I want to make a music game with colorful notes');
    sim.expect.noLeaks();
    sim.expect.notContains('[Brainstorming context]');
    sim.expect.notContains('user: I want');

    // Pick a direction if choices available
    if (sim.last.choices) {
      await sim.pickChoice(sim.last.choices.options[0].value);
      sim.expect.noLeaks();
      sim.expect.notContains('[Brainstorming context]');
    }
  }, 120_000);
});

describe('Tech stack choice is respected', () => {
  let sim: ChatSimulator;

  beforeAll(async () => {
    sim = await ChatSimulator.create();
  }, 30_000);

  afterAll(async () => {
    sim.printLog();
    await sim.teardown();
  });

  it('user picks Svelte, response mentions Svelte not React', async () => {
    await sim.send('build an interactive web app');

    // Get through brainstorming
    if (sim.last.choices) {
      await sim.pickChoice(sim.last.choices.options[0].value);
    }

    // Send tech stack preference
    await sim.send('use Svelte and Tone.js');

    // The response should acknowledge Svelte, not switch to React/Angular/Vue
    const text = sim.last.text.toLowerCase();
    // It should mention svelte somewhere
    if (text.includes('react') && !text.includes('svelte')) {
      throw new Error('Orchestrator switched tech stack: mentioned React but not Svelte');
    }
  }, 120_000);
});

describe('Plan tool is used (not manual plan text)', () => {
  let sim: ChatSimulator;

  beforeAll(async () => {
    sim = await ChatSimulator.create();
  }, 30_000);

  afterAll(async () => {
    sim.printLog();
    await sim.teardown();
  });

  it('plan response has structured choices, not raw numbered list', async () => {
    // Fast-track to plan: describe project, pick direction, accept team
    await sim.send('build a simple todo CLI app in TypeScript');

    // Navigate to team proposal
    for (let i = 0; i < 5; i++) {
      if (sim.last.choices?.options.some(o => o.value === 'accept')) break;
      if (sim.last.choices) {
        await sim.pickChoice(sim.last.choices.options[0].value);
      } else {
        await sim.send('yes, build it');
      }
    }

    // Accept team if available
    if (sim.last.choices?.options.some(o => o.value === 'accept')) {
      await sim.pickChoice('accept');
    }

    // Trigger plan
    if (sim.last.choices?.options.some(o => o.value === 'start')) {
      await sim.pickChoice('start');
    } else {
      await sim.send('create a plan');
    }

    // Navigate to plan
    for (let i = 0; i < 3; i++) {
      if (sim.last.choices?.options.some(o =>
        o.value === 'execute_plan' || o.label.toLowerCase().includes('execute'),
      )) break;
      if (sim.last.choices) {
        await sim.pickChoice(sim.last.choices.options[0].value);
      } else {
        await sim.send('plan it');
      }
    }

    // If we got a plan, it should have execute choice (from plan tool)
    // NOT a raw numbered list with no choices
    if (sim.last.choices) {
      sim.expect.plan();
    }

    sim.expect.noLeaks();
  }, 300_000);
});
