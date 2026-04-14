import {
  toDisplayType,
  type Memory,
} from '../../packages/dashboard-v2/src/lib/memory-taxonomy';

function mem(over: Partial<Memory>): Memory {
  return {
    filename: over.filename ?? 'unspecified.md',
    frontmatter: over.frontmatter,
    content: over.content ?? '',
  };
}

describe('toDisplayType — primary cases', () => {
  test('prefix=session, type=project → session (drift absorbed)', () => {
    expect(
      toDisplayType(mem({ filename: 'session_2026_04_15.md', frontmatter: { type: 'project' } })),
    ).toBe('session');
  });

  test('prefix=session, no frontmatter → session', () => {
    expect(toDisplayType(mem({ filename: 'session_recap.md' }))).toBe('session');
  });

  test('prefix=project, status=shipped → record', () => {
    expect(
      toDisplayType(mem({ filename: 'project_dashboard_rewrite.md', frontmatter: { status: 'shipped' } })),
    ).toBe('record');
  });

  test('prefix=project, status=closed → record', () => {
    expect(
      toDisplayType(mem({ filename: 'project_old_decision.md', frontmatter: { status: 'closed' } })),
    ).toBe('record');
  });

  test('prefix=project, status=open → backlog', () => {
    expect(
      toDisplayType(mem({ filename: 'project_active.md', frontmatter: { status: 'open' } })),
    ).toBe('backlog');
  });

  test('prefix=project, no status → backlog (safe default)', () => {
    expect(toDisplayType(mem({ filename: 'project_unspecified.md' }))).toBe('backlog');
  });

  test('prefix=feedback → rule', () => {
    expect(toDisplayType(mem({ filename: 'feedback_clean_code.md' }))).toBe('rule');
  });

  test('prefix=user → rule', () => {
    expect(toDisplayType(mem({ filename: 'user_profile.md' }))).toBe('rule');
  });

  test('prefix=gossip → record', () => {
    expect(toDisplayType(mem({ filename: 'gossip_updates.md' }))).toBe('record');
  });

  test('prefix=xyz (unknown), type=reference → record', () => {
    expect(
      toDisplayType(mem({ filename: 'xyz_misc.md', frontmatter: { type: 'reference' } })),
    ).toBe('record');
  });

  test('prefix=xyz, no frontmatter → backlog', () => {
    expect(toDisplayType(mem({ filename: 'xyz_misc.md' }))).toBe('backlog');
  });
});

describe('toDisplayType — edge cases', () => {
  test("filename='MEMORY.md' → record (the index guard)", () => {
    expect(toDisplayType(mem({ filename: 'MEMORY.md' }))).toBe('record');
  });

  test("filename='notes.md' (no underscore) → backlog (fallback)", () => {
    expect(toDisplayType(mem({ filename: 'notes.md' }))).toBe('backlog');
  });

  test("filename='_leading.md' (empty prefix) → backlog", () => {
    expect(toDisplayType(mem({ filename: '_leading.md' }))).toBe('backlog');
  });

  test("prefix=project, status='Shipped' (uppercase) → record (case-insensitive)", () => {
    expect(
      toDisplayType(mem({ filename: 'project_x.md', frontmatter: { status: 'Shipped' } })),
    ).toBe('record');
  });

  test('prefix=PROJECT, status=shipped (uppercase prefix) → record', () => {
    expect(
      toDisplayType(mem({ filename: 'PROJECT_x.md', frontmatter: { status: 'shipped' } })),
    ).toBe('record');
  });

  test('prefix=project, status=blocked → backlog (unknown status, stays visible)', () => {
    expect(
      toDisplayType(mem({ filename: 'project_x.md', frontmatter: { status: 'blocked' } })),
    ).toBe('backlog');
  });

  test('prefix=project, status=archived → backlog (unknown status)', () => {
    expect(
      toDisplayType(mem({ filename: 'project_x.md', frontmatter: { status: 'archived' } })),
    ).toBe('backlog');
  });

  test("prefix=xyz, type='Project' (uppercase) → backlog (fallback lowercase)", () => {
    expect(
      toDisplayType(mem({ filename: 'xyz_misc.md', frontmatter: { type: 'Project' } })),
    ).toBe('backlog');
  });
});

describe('toDisplayType — additional safety', () => {
  test('prefix=SESSION (uppercase) → session', () => {
    expect(toDisplayType(mem({ filename: 'SESSION_recap.md' }))).toBe('session');
  });

  test('prefix=FEEDBACK (uppercase) → rule', () => {
    expect(toDisplayType(mem({ filename: 'FEEDBACK_x.md' }))).toBe('rule');
  });

  test('prefix=session beats frontmatter type=feedback', () => {
    expect(
      toDisplayType(mem({ filename: 'session_x.md', frontmatter: { type: 'feedback' } })),
    ).toBe('session');
  });

  test('frontmatter status without project prefix is ignored', () => {
    expect(
      toDisplayType(mem({ filename: 'session_x.md', frontmatter: { status: 'shipped' } })),
    ).toBe('session');
  });
});
