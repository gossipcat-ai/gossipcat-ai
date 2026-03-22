import { ScopeTracker } from '../../packages/orchestrator/src/scope-tracker';

describe('ScopeTracker', () => {
  let tracker: ScopeTracker;
  const projectRoot = '/test/project';

  beforeEach(() => { tracker = new ScopeTracker(projectRoot); });

  describe('overlap detection', () => {
    it('detects parent/child overlap', () => {
      tracker.register('packages/relay/', 'task-1');
      const result = tracker.hasOverlap('packages/relay/src/');
      expect(result.overlaps).toBe(true);
      expect(result.conflictTaskId).toBe('task-1');
    });

    it('detects child/parent overlap', () => {
      tracker.register('packages/relay/src/', 'task-1');
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(true);
    });

    it('allows sibling scopes', () => {
      tracker.register('packages/relay/', 'task-1');
      expect(tracker.hasOverlap('packages/tools/').overlaps).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(() => tracker.register('../../etc/', 'task-1')).toThrow('resolves outside project root');
    });

    it('rejects empty scope', () => {
      expect(() => tracker.register('', 'task-1')).toThrow('Scope must not be empty');
    });

    it('rejects root scope via dot', () => {
      expect(() => tracker.register('.', 'task-1')).toThrow('resolves to project root');
    });
  });

  describe('lifecycle', () => {
    it('releases scope by taskId', () => {
      tracker.register('packages/relay/', 'task-1');
      tracker.release('task-1');
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(false);
    });

    it('clears all scopes', () => {
      tracker.register('packages/relay/', 'task-1');
      tracker.register('packages/tools/', 'task-2');
      tracker.clear();
      expect(tracker.hasOverlap('packages/relay/').overlaps).toBe(false);
    });
  });

  describe('getActiveScopeCount', () => {
    it('returns the number of active scopes', () => {
      expect(tracker.getActiveScopeCount()).toBe(0);

      tracker.register('packages/relay/', 'task-1');
      tracker.register('packages/tools/', 'task-2');
      expect(tracker.getActiveScopeCount()).toBe(2);

      tracker.release('task-1');
      expect(tracker.getActiveScopeCount()).toBe(1);

      tracker.release('task-2');
      expect(tracker.getActiveScopeCount()).toBe(0);
    });
  });
});
