/**
 * Tests for the dashboard SSE event ring buffer (packages/relay/src/dashboard/api-events.ts).
 *
 * Covers:
 *   - emitDashboardEvent appends with a monotonic, auto-incrementing id
 *   - ring caps at 100 events (oldest evicted on overflow)
 *   - replay-since-id returns only events newer than a given cursor
 */

// Reset module state between tests by re-importing fresh each time.
// jest does not auto-reset module-level singletons; we use jest.resetModules().
let emitDashboardEvent: (type: any, payload: any) => void;
let getBuffer: () => any[];

function loadModule() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../packages/relay/src/dashboard/api-events');
  emitDashboardEvent = mod.emitDashboardEvent;
  // Expose the internal ring for assertions via a thin wrapper
  getBuffer = () => (mod as any)._testGetRing?.() ?? [];
  return mod;
}

// Patch the module to expose internal ring for testing
beforeEach(() => {
  jest.resetModules();
  const mod = jest.requireActual('../../packages/relay/src/dashboard/api-events') as any;
  emitDashboardEvent = mod.emitDashboardEvent;

  // Re-load to reset ring state for each test
  jest.isolateModules(() => {
    const fresh = require('../../packages/relay/src/dashboard/api-events');
    emitDashboardEvent = fresh.emitDashboardEvent;
    getBuffer = () => (fresh as any).__TEST__ring ?? [];
  });
});

// Simpler approach: use the module directly with isolation per test block
describe('api-events ring buffer', () => {
  it('appends events with monotonically increasing ids', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { emitDashboardEvent: emit } = require('../../packages/relay/src/dashboard/api-events');
      // Access internals via the module's exported types — we test via exported functions
      // by checking the SSE output format indirectly through a mock ServerResponse
      // Emit 3 events and verify ids are sequential
      emit('task.completed', { taskId: 'a' });
      emit('task.completed', { taskId: 'b' });
      emit('consensus.completed', { consensusId: 'c' });

      // Capture what would be replayed to a new SSE client
      const written: string[] = [];
      const mockRes = {
        writeHead: jest.fn(),
        write: (data: string) => { written.push(data); return true; },
        on: jest.fn(),
      } as any;
      const mockReq = {
        url: '/dashboard/api/events?last_id=0',
        on: jest.fn(),
      } as any;

      const { handleEventsSSE } = require('../../packages/relay/src/dashboard/api-events');
      handleEventsSSE(mockReq, mockRes);

      // Should have received 3 events
      expect(written.length).toBe(3);

      // Parse ids from SSE lines
      const ids = written.map((chunk) => {
        const match = chunk.match(/^id: (\d+)/);
        return match ? parseInt(match[1], 10) : -1;
      });

      // Ids should be strictly increasing
      expect(ids[1]).toBeGreaterThan(ids[0]);
      expect(ids[2]).toBeGreaterThan(ids[1]);
    });
  });

  it('caps ring at 100 events, evicting the oldest', () => {
    jest.isolateModules(() => {
      const { emitDashboardEvent: emit, handleEventsSSE } = require('../../packages/relay/src/dashboard/api-events');

      // Emit 110 events
      for (let i = 0; i < 110; i++) {
        emit('task.completed', { seq: i });
      }

      // Replay from id=0 — should receive at most 100
      const written: string[] = [];
      const mockRes = {
        writeHead: jest.fn(),
        write: (data: string) => { written.push(data); return true; },
        on: jest.fn(),
      } as any;
      const mockReq = {
        url: '/dashboard/api/events?last_id=0',
        on: jest.fn(),
      } as any;

      handleEventsSSE(mockReq, mockRes);
      expect(written.length).toBe(100);
    });
  });

  it('replay-since-id returns only events with id > last_id', () => {
    jest.isolateModules(() => {
      const { emitDashboardEvent: emit, handleEventsSSE } = require('../../packages/relay/src/dashboard/api-events');

      emit('task.completed', { seq: 1 });
      emit('task.completed', { seq: 2 });
      emit('task.completed', { seq: 3 });
      emit('task.completed', { seq: 4 });
      emit('task.completed', { seq: 5 });

      // Collect all ids first by replaying from 0
      const allWritten: string[] = [];
      const allRes = {
        writeHead: jest.fn(),
        write: (d: string) => { allWritten.push(d); return true; },
        on: jest.fn(),
      } as any;
      handleEventsSSE({ url: '/dashboard/api/events?last_id=0', on: jest.fn() } as any, allRes);

      const thirdId = parseInt(allWritten[2].match(/^id: (\d+)/)![1], 10);

      // Replay since the third event's id — should only get events after it
      const partialWritten: string[] = [];
      const partialRes = {
        writeHead: jest.fn(),
        write: (d: string) => { partialWritten.push(d); return true; },
        on: jest.fn(),
      } as any;
      handleEventsSSE({ url: `/dashboard/api/events?last_id=${thirdId}`, on: jest.fn() } as any, partialRes);

      // Should receive 2 events (4th and 5th)
      expect(partialWritten.length).toBe(2);
      // All replayed ids should be > thirdId
      for (const chunk of partialWritten) {
        const id = parseInt(chunk.match(/^id: (\d+)/)![1], 10);
        expect(id).toBeGreaterThan(thirdId);
      }
    });
  });
});
