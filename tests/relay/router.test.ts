import { MessageRateLimiter } from '@gossip/relay/message-rate-limiter';
import { ConnectionManager, MessageRouter } from '@gossip/relay';
import { Message, MessageType } from '@gossip/types';

// Minimal mock AgentConnection
function makeMockConn(agentId: string, sessionId: string) {
  const sent: any[] = [];
  return {
    agentId,
    sessionId,
    isActive: () => true,
    send: (envelope: any) => { sent.push(envelope); },
    _sent: sent
  } as any;
}

describe('MessageRouter', () => {
  let cm: ConnectionManager;
  let router: MessageRouter;

  beforeEach(() => {
    cm = new ConnectionManager();
    // Note: Rate limiter is not passed here, so it's disabled by default in tests
    // a specific test will instantiate it.
    router = new MessageRouter(cm);
  });

  it('routes DIRECT message to correct agent by agentId', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    const connB = makeMockConn('agent-b', 'sess-b');
    cm.register('sess-a', connA);
    cm.register('sess-b', connB);

    const msg = Message.createDirect('agent-a', 'agent-b', new TextEncoder().encode('hello'));
    router.route(msg.envelope, connA);

    expect(connB._sent).toHaveLength(1);
    expect(connB._sent[0].sid).toBe('agent-a');
    expect(connB._sent[0].rid).toBe('agent-b');
    expect(new TextDecoder().decode(connB._sent[0].body)).toBe('hello');
  });

  it('routes CHANNEL message to all channel subscribers except sender', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    const connB = makeMockConn('agent-b', 'sess-b');
    const connC = makeMockConn('agent-c', 'sess-c');
    cm.register('sess-a', connA);
    cm.register('sess-b', connB);
    cm.register('sess-c', connC);

    // Subscribe b and c to channel
    const subB = Message.createSubscription('agent-b', 'test-channel');
    const subC = Message.createSubscription('agent-c', 'test-channel');
    router.route(subB.envelope, connB);
    router.route(subC.envelope, connC);

    // Send channel message from agent-a (also subscribe a first)
    const subA = Message.createSubscription('agent-a', 'test-channel');
    router.route(subA.envelope, connA);

    const channelMsg = Message.createChannel('agent-a', 'test-channel', new TextEncoder().encode('broadcast'));
    router.route(channelMsg.envelope, connA);

    // B and C should receive, A should not (no echo to sender)
    expect(connB._sent.filter((e: any) => e.t === MessageType.CHANNEL)).toHaveLength(1);
    expect(connC._sent.filter((e: any) => e.t === MessageType.CHANNEL)).toHaveLength(1);
    expect(connA._sent.filter((e: any) => e.t === MessageType.CHANNEL)).toHaveLength(0);
  });

  it('sends error for unknown recipient', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    cm.register('sess-a', connA);

    const msg = Message.createDirect('agent-a', 'nonexistent', new TextEncoder().encode('hello'));
    router.route(msg.envelope, connA);

    const errors = connA._sent.filter((e: any) => e.t === MessageType.ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].meta.error_code).toBe('AGENT_NOT_FOUND');
  });

  it('handles PING with PONG response', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    cm.register('sess-a', connA);

    const ping = Message.createPing('agent-a', 'relay');
    router.route(ping.envelope, connA);

    // Should receive pong back (type PING echoed with sid='relay')
    const pongs = connA._sent.filter((e: any) => e.t === MessageType.PING && e.sid === 'relay');
    expect(pongs).toHaveLength(1);
  });

  it('handles SUBSCRIPTION and UNSUBSCRIPTION', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    cm.register('sess-a', connA);

    const sub = Message.createSubscription('agent-a', 'my-channel');
    router.route(sub.envelope, connA);

    const cm2 = router.getChannelManager();
    expect(cm2.isSubscribed('my-channel', 'agent-a')).toBe(true);

    const unsub = Message.createUnsubscription('agent-a', 'my-channel');
    router.route(unsub.envelope, connA);
    expect(cm2.isSubscribed('my-channel', 'agent-a')).toBe(false);
  });

  it('cleans up subscriptions on agent disconnect', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    cm.register('sess-a', connA);

    const sub = Message.createSubscription('agent-a', 'chan1');
    router.route(sub.envelope, connA);

    router.onAgentDisconnect('sess-a');

    const cm2 = router.getChannelManager();
    expect(cm2.isSubscribed('chan1', 'agent-a')).toBe(false);
  });

  it('tracks routing metrics', () => {
    const connA = makeMockConn('agent-a', 'sess-a');
    const connB = makeMockConn('agent-b', 'sess-b');
    cm.register('sess-a', connA);
    cm.register('sess-b', connB);

    const msg = Message.createDirect('agent-a', 'agent-b', new Uint8Array(0));
    router.route(msg.envelope, connA);

    const metrics = router.getMetrics();
    expect(metrics.messagesRouted).toBe(1);
    expect(metrics.messagesByType[MessageType.DIRECT]).toBe(1);
  });

  // Router-level rate limiting was removed; enforcement now lives in MessageRateLimiter
  // wired at the connection layer. See tests/relay/message-rate-limiter.test.ts.
  it.skip('drops messages and sends error when rate limit is exceeded', () => {
    const rateLimiter = new MessageRateLimiter({ maxMessages: 2, windowMs: 1000 });
    const routerWithLimit = new MessageRouter(cm);
    (routerWithLimit as any).rateLimiter = rateLimiter;
    const connA = makeMockConn('agent-a', 'sess-a');
    const connB = makeMockConn('agent-b', 'sess-b');
    cm.register('sess-a', connA);
    cm.register('sess-b', connB);

    const msg = Message.createDirect('agent-a', 'agent-b', new Uint8Array(0));

    // First two should be fine
    routerWithLimit.route(msg.envelope, connA);
    routerWithLimit.route(msg.envelope, connA);

    // Third one should be dropped
    routerWithLimit.route(msg.envelope, connA);

    // Check that B only got 2 messages
    expect(connB._sent).toHaveLength(2);

    // Check that A got a rate limit error
    const errors = connA._sent.filter((e: any) => e.t === MessageType.ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].meta.error_code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
