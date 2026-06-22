import { Message, MessageType } from '@gossip/types';

describe('Message', () => {
  it('creates DIRECT message with valid UUID', () => {
    const msg = Message.createDirect('sender', 'receiver', new TextEncoder().encode('hi'));
    expect(msg.envelope.t).toBe(MessageType.DIRECT);
    expect(msg.envelope.sid).toBe('sender');
    expect(msg.envelope.rid).toBe('receiver');
    // Verify crypto.randomUUID format (not Math.random)
    expect(msg.envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('creates CHANNEL message', () => {
    const msg = Message.createChannel('sender', 'my-channel', new Uint8Array(0));
    expect(msg.envelope.t).toBe(MessageType.CHANNEL);
    expect(msg.envelope.rid).toBe('my-channel');
  });

  it('creates RPC_REQUEST with requestId', () => {
    const msg = Message.createRpcRequest('a', 'b', 'req-1', new Uint8Array(0));
    expect(msg.envelope.t).toBe(MessageType.RPC_REQUEST);
    expect(msg.envelope.rid_req).toBe('req-1');
  });

  it('creates RPC_RESPONSE with requestId', () => {
    const msg = Message.createRpcResponse('b', 'a', 'req-1', new Uint8Array(0));
    expect(msg.envelope.t).toBe(MessageType.RPC_RESPONSE);
    expect(msg.envelope.rid_req).toBe('req-1');
  });

  it('creates SUBSCRIPTION message', () => {
    const msg = Message.createSubscription('agent', 'channel');
    expect(msg.envelope.t).toBe(MessageType.SUBSCRIPTION);
  });

  it('creates PRESENCE message', () => {
    const msg = Message.createPresence('agent', new Uint8Array(0));
    expect(msg.envelope.t).toBe(MessageType.PRESENCE);
    expect(msg.envelope.rid).toBe('');
  });

  it('creates ERROR message with metadata', () => {
    const msg = Message.createError('server', 'client', 'AUTH_FAILED', 'Bad key');
    expect(msg.envelope.t).toBe(MessageType.ERROR);
    expect(msg.envelope.meta?.error_code).toBe('AUTH_FAILED');
    expect(msg.envelope.meta?.description).toBe('Bad key');
  });

  it('getTypeName returns readable name', () => {
    const msg = Message.createDirect('a', 'b', new Uint8Array(0));
    expect(msg.getTypeName()).toBe('DIRECT');
  });

  it('generates unique IDs for each message', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () =>
        Message.createDirect('a', 'b', new Uint8Array(0)).envelope.id
      )
    );
    expect(ids.size).toBe(100);
  });
});
