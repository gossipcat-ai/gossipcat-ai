import { ProgressTree, formatTokens } from '../../apps/cli/src/progress-tree';

const mockRl = { pause: jest.fn(), resume: jest.fn() };
let output: string[] = [];

beforeEach(() => {
  output = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    output.push(String(chunk));
    return true;
  });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  mockRl.pause.mockClear();
  mockRl.resume.mockClear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const agents = [
  { agentId: 'gemini-impl', task: 'build login form' },
  { agentId: 'gemini-review', task: 'review auth module' },
];

describe('ProgressTree', () => {
  it('start() prints initial lines and pauses readline', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start(agents);

    const combined = output.join('');
    expect(combined).toContain('gemini-impl');
    expect(combined).toContain('gemini-review');
    expect(combined).toContain('pending');
    expect(mockRl.pause).toHaveBeenCalledTimes(1);
  });

  it('update() changes agent status to running', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start(agents);

    // Clear output so we can inspect what's written after the update
    output = [];

    // Advance timer so the interval fires and calls draw()
    tree.update('gemini-impl', {
      taskIndex: 0,
      totalTasks: 2,
      agentId: 'gemini-impl',
      taskDescription: 'build login form',
      status: 'start',
    });

    jest.advanceTimersByTime(80);

    const combined = output.join('');
    // After status:'start', gemini-impl should show a spinner frame, not pending.
    // We verify that by looking for the spinner marker alongside the agent name.
    // gemini-review is still pending so the string "pending" exists but only once.
    const pendingMatches = (combined.match(/○ pending/g) ?? []).length;
    // Only gemini-review should still be pending (1 match)
    expect(pendingMatches).toBe(1);
    tree.finish();
  });

  it('update() with progress shows tool calls in bar', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start(agents);
    output = [];

    tree.update('gemini-impl', {
      taskIndex: 0,
      totalTasks: 2,
      agentId: 'gemini-impl',
      taskDescription: 'build login form',
      status: 'progress',
      toolCalls: 3,
      currentTool: 'write_file',
    });

    jest.advanceTimersByTime(80);

    const combined = output.join('');
    expect(combined).toContain('3/15');
    expect(combined).toContain('write_file');
    tree.finish();
  });

  it('update() with done shows check mark and token count', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start(agents);
    output = [];

    tree.update('gemini-impl', {
      taskIndex: 0,
      totalTasks: 2,
      agentId: 'gemini-impl',
      taskDescription: 'build login form',
      status: 'done',
      inputTokens: 500,
      outputTokens: 347,
      toolCalls: 5,
    });

    jest.advanceTimersByTime(80);

    const combined = output.join('');
    expect(combined).toContain('✓');
    // 500 + 347 = 847 tokens → "847 tok"
    expect(combined).toContain('847 tok');
    tree.finish();
  });

  it('finish() resumes readline and stops interval', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start(agents);
    expect(tree.isActive()).toBe(true);

    tree.finish();
    expect(mockRl.resume).toHaveBeenCalledTimes(1);
    expect(tree.isActive()).toBe(false);
  });

  it('finish() is safe to call when not active', () => {
    const tree = new ProgressTree(mockRl as any);
    expect(() => tree.finish()).not.toThrow();
  });

  it('truncates agent names longer than 16 chars', () => {
    const tree = new ProgressTree(mockRl as any);
    tree.start([{ agentId: 'very-long-agent-name-here', task: 'some task' }]);

    const combined = output.join('');
    expect(combined).toContain('…');
    tree.finish();
  });
});

describe('formatTokens', () => {
  it('returns empty string for 0', () => {
    expect(formatTokens(0)).toBe('');
  });

  it('formats small counts as "N tok"', () => {
    expect(formatTokens(847)).toBe('847 tok');
  });

  it('formats counts >= 1000 as "N.Nk tok"', () => {
    expect(formatTokens(12400)).toBe('12.4k tok');
  });

  it('formats counts just under 1000', () => {
    expect(formatTokens(999)).toBe('999 tok');
  });

  it('formats exactly 1000', () => {
    expect(formatTokens(1000)).toBe('1.0k tok');
  });
});
