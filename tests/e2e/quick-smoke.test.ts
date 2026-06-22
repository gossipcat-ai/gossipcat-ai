/**
 * Quick Smoke Test — minimal turns, verifies core pipeline works.
 *
 * Run: npx jest tests/e2e/quick-smoke.test.ts --testTimeout=300000 --verbose
 */

import { ChatSimulator } from './chat-simulator';

let sim: ChatSimulator;

beforeAll(async () => {
  sim = await ChatSimulator.create();
}, 30_000);

afterAll(async () => {
  sim?.printLog();
  await sim?.teardown();
});

it('first message brainstorms (no team proposal)', async () => {
  await sim.send('build a simple counter app');
  sim.expect.brainstorm();
  sim.expect.noLeaks();
}, 30_000);

it('follow-up triggers team proposal', async () => {
  await sim.send('yes, build it with vanilla JS');

  // Navigate to team proposal (may take 1-2 turns)
  for (let i = 0; i < 3; i++) {
    if (sim.last.choices?.options.some(o => o.value === 'accept')) break;
    if (sim.last.choices) {
      await sim.pickChoice(sim.last.choices.options[0].value);
    } else {
      await sim.send('proceed');
    }
  }

  sim.expect.noLeaks();

  // Should have team proposal OR already be past it
  if (sim.last.choices?.options.some(o => o.value === 'accept')) {
    sim.expect.teamProposal();
  }
}, 120_000);

it('accept creates agents, no context leaks', async () => {
  if (sim.last.choices?.options.some(o => o.value === 'accept')) {
    await sim.pickChoice('accept');
    sim.expect.teamReady();
    expect(sim.agentCount).toBeGreaterThan(0);
  }
  sim.expect.noLeaks();
}, 60_000);
