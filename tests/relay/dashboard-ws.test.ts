import { DashboardWs, DashboardEvent } from '@gossip/relay/dashboard/ws';
import WebSocket from 'ws';

describe('DashboardWs', () => {
  let manager: DashboardWs;

  beforeEach(() => {
    manager = new DashboardWs();
  });

  it('tracks connected clients', () => {
    const mockWs = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(mockWs);
    expect(manager.clientCount).toBe(1);
  });

  it('removes disconnected clients', () => {
    const mockWs = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(mockWs);
    manager.removeClient(mockWs);
    expect(manager.clientCount).toBe(0);
  });

  it('broadcasts events to all connected clients', () => {
    const ws1 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    const ws2 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(ws1);
    manager.addClient(ws2);

    const event: DashboardEvent = {
      type: 'task_dispatched',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test', task: 'review code' },
    };
    manager.broadcast(event);

    const expected = JSON.stringify(event);
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
  });

  it('skips clients with non-OPEN readyState', () => {
    const ws1 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    const ws2 = { readyState: WebSocket.CLOSED, send: jest.fn() } as any;
    manager.addClient(ws1);
    manager.addClient(ws2);

    manager.broadcast({
      type: 'task_completed',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(ws1.send).toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();
  });

  it('handles send errors gracefully', () => {
    const ws1 = {
      readyState: WebSocket.OPEN,
      send: jest.fn(() => { throw new Error('broken pipe'); }),
    } as any;
    manager.addClient(ws1);

    expect(() => manager.broadcast({
      type: 'agent_connected',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test' },
    })).not.toThrow();
  });
});
