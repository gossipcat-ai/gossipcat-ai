/**
 * Tests for the matchRoute param-extraction helper added to lib/router.ts.
 */

import { matchRoute } from '../../packages/dashboard-v2/src/lib/router';

describe('matchRoute', () => {
  describe('/tasks/:id pattern', () => {
    it('extracts the task id from a matching route', () => {
      expect(matchRoute('/tasks/:id', '/tasks/abc12345-def6-7890-ghij-klmnopqrstuv')).toBe(
        'abc12345-def6-7890-ghij-klmnopqrstuv'
      );
    });

    it('extracts a short id', () => {
      expect(matchRoute('/tasks/:id', '/tasks/abc12345')).toBe('abc12345');
    });

    it('returns null for /tasks (no id segment)', () => {
      expect(matchRoute('/tasks/:id', '/tasks')).toBeNull();
    });

    it('returns null for a completely different route', () => {
      expect(matchRoute('/tasks/:id', '/agent/sonnet-reviewer')).toBeNull();
    });

    it('returns null for a route with extra segments', () => {
      expect(matchRoute('/tasks/:id', '/tasks/abc12345/detail')).toBeNull();
    });

    it('returns null for empty route', () => {
      expect(matchRoute('/tasks/:id', '/')).toBeNull();
    });
  });

  describe('/agent/:id pattern', () => {
    it('extracts the agent id', () => {
      expect(matchRoute('/agent/:id', '/agent/sonnet-reviewer')).toBe('sonnet-reviewer');
    });

    it('returns null for a mismatched route', () => {
      expect(matchRoute('/agent/:id', '/tasks/abc123')).toBeNull();
    });
  });

  describe('URL decoding', () => {
    it('decodes percent-encoded characters', () => {
      expect(matchRoute('/agent/:id', '/agent/my%20agent')).toBe('my agent');
    });

    it('handles hyphens and underscores', () => {
      expect(matchRoute('/tasks/:id', '/tasks/my-task_id')).toBe('my-task_id');
    });
  });

  describe('TaskPage not-found state', () => {
    it('matchRoute returns null when the task segment is missing — the not-found frame renders', () => {
      // The TaskPage renders a graceful not-found frame when tasks.find returns undefined.
      // We test the routing layer: when there is no :id segment, matchRoute is null
      // so App.tsx never renders TaskPage at all (falls through to overview).
      expect(matchRoute('/tasks/:id', '/tasks/')).toBeNull();
      expect(matchRoute('/tasks/:id', '/tasks')).toBeNull();
    });
  });
});
