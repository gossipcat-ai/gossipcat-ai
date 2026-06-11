/**
 * Round-trip contract for buildCoverageDegradedMessage / parseCoverageDegradedMessage.
 *
 * Intent: any future drift in the template (consensus-engine.ts producer,
 * routes.ts legacy synthesizer, api-consensus-flow.ts parser) breaks THIS
 * test before it breaks the dashboard chip — giving a single red CI gate
 * rather than a silent rendering regression.
 *
 * consensus 1f50d89d-c28f49c4:fable-reviewer:f2
 */
import {
  buildCoverageDegradedMessage,
  parseCoverageDegradedMessage,
} from '../../packages/orchestrator/src/coverage-degraded';

describe('buildCoverageDegradedMessage', () => {
  it('builds the canonical format', () => {
    const msg = buildCoverageDegradedMessage({ received: 2, expected: 3, droppedAgents: ['agent-x'] });
    expect(msg).toBe('Coverage degraded: 2/3 agents returned content (dropped: agent-x)');
  });

  it('joins multiple dropped agents with ", "', () => {
    const msg = buildCoverageDegradedMessage({ received: 1, expected: 3, droppedAgents: ['a', 'b'] });
    expect(msg).toContain('dropped: a, b');
  });

  it('produces an empty dropped list when droppedAgents is empty', () => {
    const msg = buildCoverageDegradedMessage({ received: 2, expected: 2, droppedAgents: [] });
    expect(msg).toContain('(dropped: )');
  });
});

describe('parseCoverageDegradedMessage', () => {
  it('round-trips a standard message', () => {
    const params = { received: 2, expected: 3, droppedAgents: ['agent-x'] };
    const parsed = parseCoverageDegradedMessage(buildCoverageDegradedMessage(params));
    expect(parsed).toEqual(params);
  });

  it('round-trips with multiple dropped agents', () => {
    const params = { received: 1, expected: 3, droppedAgents: ['gemini-reviewer', 'haiku-researcher'] };
    const parsed = parseCoverageDegradedMessage(buildCoverageDegradedMessage(params));
    expect(parsed).toEqual(params);
  });

  it('round-trips with an empty dropped list', () => {
    const params = { received: 2, expected: 2, droppedAgents: [] };
    const parsed = parseCoverageDegradedMessage(buildCoverageDegradedMessage(params));
    expect(parsed).toEqual(params);
  });

  it('returns undefined for an unrelated string', () => {
    expect(parseCoverageDegradedMessage('some random warning')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(parseCoverageDegradedMessage('')).toBeUndefined();
  });

  it('handles an agent id containing a comma — extracted as separate entries (documented limitation)', () => {
    // An agent id with a comma looks like two separate list entries after split(',').
    // This is a known limitation documented in coverage-degraded.ts. The test
    // pins the current behavior so any change is deliberate.
    const msg = buildCoverageDegradedMessage({ received: 1, expected: 2, droppedAgents: ['agent,comma'] });
    const parsed = parseCoverageDegradedMessage(msg);
    // The comma in the agent id splits into two entries — known behavior.
    expect(parsed).toBeDefined();
    expect(parsed!.received).toBe(1);
    expect(parsed!.expected).toBe(2);
    expect(parsed!.droppedAgents).toEqual(['agent', 'comma']);
  });

  it('handles an agent id containing a parenthesis — greedy last-paren parse', () => {
    // The parse is greedy to the LAST ')' so an agent id containing '(' does
    // not prematurely end the dropped list.
    const msg = 'Coverage degraded: 1/2 agents returned content (dropped: agent(v2))';
    const parsed = parseCoverageDegradedMessage(msg);
    expect(parsed).toBeDefined();
    expect(parsed!.droppedAgents).toContain('agent(v2)');
  });
});
