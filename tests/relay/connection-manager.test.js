"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const relay_1 = require("@gossip/relay");
describe('ConnectionManager', () => {
    let cm;
    beforeEach(() => {
        cm = new relay_1.ConnectionManager();
    });
    it('registers and retrieves by session ID', () => {
        const conn = { agentId: 'agent-a', sessionId: 'sess-1' };
        cm.register('sess-1', conn);
        expect(cm.get('sess-1')).toBe(conn);
    });
    it('retrieves by agent ID via secondary index (O(1))', () => {
        const conn = { agentId: 'agent-a', sessionId: 'sess-1' };
        cm.register('sess-1', conn);
        expect(cm.getByAgentId('agent-a')).toBe(conn);
    });
    it('removes from both indexes on unregister', () => {
        const conn = { agentId: 'agent-a', sessionId: 'sess-1' };
        cm.register('sess-1', conn);
        cm.unregister('sess-1');
        expect(cm.get('sess-1')).toBeUndefined();
        expect(cm.getByAgentId('agent-a')).toBeUndefined();
    });
    it('rejects duplicate session ID', () => {
        const conn = { agentId: 'agent-a', sessionId: 'sess-1' };
        cm.register('sess-1', conn);
        expect(() => cm.register('sess-1', conn)).toThrow('already registered');
    });
    it('returns count of active connections', () => {
        expect(cm.count).toBe(0);
        cm.register('s1', { agentId: 'a1', sessionId: 's1' });
        cm.register('s2', { agentId: 'a2', sessionId: 's2' });
        expect(cm.count).toBe(2);
    });
    it('unregister returns false for unknown session', () => {
        expect(cm.unregister('nonexistent')).toBe(false);
    });
    it('getAll returns all connections', () => {
        const c1 = { agentId: 'a1', sessionId: 's1' };
        const c2 = { agentId: 'a2', sessionId: 's2' };
        cm.register('s1', c1);
        cm.register('s2', c2);
        const all = cm.getAll();
        expect(all).toHaveLength(2);
        expect(all).toContain(c1);
        expect(all).toContain(c2);
    });
    it('has() returns correct boolean', () => {
        expect(cm.has('s1')).toBe(false);
        cm.register('s1', { agentId: 'a1', sessionId: 's1' });
        expect(cm.has('s1')).toBe(true);
    });
    it('getByAgentId returns undefined for unknown agent', () => {
        expect(cm.getByAgentId('unknown')).toBeUndefined();
    });
    it('clear removes all connections', () => {
        cm.register('s1', { agentId: 'a1', sessionId: 's1' });
        cm.register('s2', { agentId: 'a2', sessionId: 's2' });
        cm.clear();
        expect(cm.count).toBe(0);
        expect(cm.getByAgentId('a1')).toBeUndefined();
    });
});
//# sourceMappingURL=connection-manager.test.js.map