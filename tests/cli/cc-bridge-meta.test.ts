/**
 * cc-bridge channel notification meta: the durable-inbox id rides along as
 * `inbox_id` so a channel-mode `reply` can pass it as in_reply_to.
 */
import { createBridgeHost, CC_CHANNEL_NOTIFICATION } from '../../apps/cli/src/cc-bridge';

type Note = { method: string; params?: { content: string; meta: Record<string, string> } };

function fakeServer(sent: Note[]) {
  return { server: { notification: (n: Note) => { sent.push(n); return Promise.resolve(); } } } as never;
}

describe('cc-bridge channel meta', () => {
  it('includes inbox_id when the relay persisted the message', () => {
    const sent: Note[] = [];
    const host = createBridgeHost(fakeServer(sent));
    expect(host.deliverBridgeMessage('chat-a', 'hello', '1791782377276-7a90e6acce40')).toBe(true);
    expect(sent).toEqual([{
      method: CC_CHANNEL_NOTIFICATION,
      params: { content: 'hello', meta: { chat_id: 'chat-a', inbox_id: '1791782377276-7a90e6acce40' } },
    }]);
  });

  it('omits inbox_id when there is no inbox record', () => {
    const sent: Note[] = [];
    const host = createBridgeHost(fakeServer(sent));
    host.deliverBridgeMessage('chat-a', 'hello', null);
    host.deliverBridgeMessage('chat-b', 'hi');
    expect(sent.map((n) => n.params?.meta)).toEqual([{ chat_id: 'chat-a' }, { chat_id: 'chat-b' }]);
  });
});
