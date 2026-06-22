import { persistRelayTasks, restoreRelayTasksAsFailed } from '../../apps/cli/src/handlers/relay-tasks';
import { ctx } from '../../apps/cli/src/mcp-context';
import { MainAgent } from '@gossip/orchestrator';

// Mock fs module
const fs = {
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  readFileSync: jest.fn(),
  existsSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdirSync: jest.fn(),
};
jest.mock('fs', () => fs);
jest.mock('path', () => ({
  join: (...args: string[]) => args.join('/'),
}));

// Mock a portion of the mcp-server-sdk to test the refreshBootstrap call site
jest.mock('../../apps/cli/src/mcp-server-sdk', () => ({
  ...jest.requireActual('../../apps/cli/src/mcp-server-sdk'),
  __esModule: true, // This is important for ESM compatibility
}));

const mockTask = (overrides: Partial<any> = {}) => ({
  id: 'relay-task-1',
  agentId: 'test-agent',
  task: 'do a thing',
  startedAt: Date.now(),
  timeoutMs: 30000,
  status: 'running',
  ...overrides,
});

describe('relay-tasks', () => {
  let mockMainAgent: any;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.nativeResultMap.clear();
    ctx.nativeTaskMap.clear();

    mockMainAgent = {
      getRelayTaskRecords: jest.fn().mockReturnValue([mockTask()]),
      dispatch: jest.fn().mockReturnValue({ taskId: 'mock-task-1' }),
      collect: jest.fn().mockResolvedValue({ results: [] }),
    };
    ctx.mainAgent = mockMainAgent as MainAgent;
    ctx.nativeAgentConfigs = new Map();
  });

  describe('persistRelayTasks', () => {
    it('should write running relay tasks to file', () => {
      const task = mockTask();
      (mockMainAgent.getRelayTaskRecords as jest.Mock).mockReturnValue([task]);
      persistRelayTasks();

      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('.gossip'), { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.tasks).toHaveLength(1);
      expect(written.tasks[0].id).toBe(task.id);
    });

    it('should write atomically: tmp file then rename onto the real path', () => {
      const task = mockTask();
      (mockMainAgent.getRelayTaskRecords as jest.Mock).mockReturnValue([task]);
      persistRelayTasks();

      // The JSON payload is written to a tmp sibling, not the destination directly.
      const writtenPath = fs.writeFileSync.mock.calls[0][0] as string;
      expect(writtenPath).toContain('relay-tasks.json');
      expect(writtenPath).toContain('.tmp');

      // Then renamed tmp → destination (atomic publish).
      expect(fs.renameSync).toHaveBeenCalledTimes(1);
      const [renameFrom, renameTo] = fs.renameSync.mock.calls[0] as [string, string];
      expect(renameFrom).toBe(writtenPath);
      expect(renameTo).toContain('relay-tasks.json');
      expect(renameTo).not.toContain('.tmp');
    });

    it('should not persist tasks that are in nativeResultMap', () => {
      const task = mockTask();
      ctx.nativeResultMap.set(task.id, {} as any);
      (mockMainAgent.getRelayTaskRecords as jest.Mock).mockReturnValue([task]);

      persistRelayTasks();
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.tasks).toHaveLength(0);
    });

    it('should not persist tasks that are in nativeTaskMap', () => {
      const task = mockTask();
      ctx.nativeTaskMap.set(task.id, {} as any);
      (mockMainAgent.getRelayTaskRecords as jest.Mock).mockReturnValue([task]);

      persistRelayTasks();
      const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
      expect(written.tasks).toHaveLength(0);
    });

    it('should exit gracefully if mainAgent is not available', () => {
      (ctx as any).mainAgent = undefined;
      persistRelayTasks();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should not crash if writeFile throws an error', () => {
      fs.writeFileSync.mockImplementationOnce(() => {
        throw new Error('Disk full');
      });
      expect(() => persistRelayTasks()).not.toThrow();
    });
  });

  describe('restoreRelayTasksAsFailed', () => {
    const projectRoot = '/test/project';
    const filePath = `${projectRoot}/.gossip/relay-tasks.json`;
    let stderrWriteSpy: jest.SpyInstance;

    beforeEach(() => {
      stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrWriteSpy.mockRestore();
    });

    it('should restore tasks as timed_out and consume the file', () => {
      const task = mockTask();
      const fileContent = JSON.stringify({ tasks: [task] });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(fileContent);

      restoreRelayTasksAsFailed(projectRoot);

      expect(fs.readFileSync).toHaveBeenCalledWith(filePath, 'utf-8');
      expect(ctx.nativeTaskMap.has(task.id)).toBe(true);
      expect(ctx.nativeResultMap.has(task.id)).toBe(true);

      const result = ctx.nativeResultMap.get(task.id);
      expect(result?.status).toBe('timed_out');
      expect(result?.error).toContain('MCP server restarted');

      expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining(`Restored 1 relay task(s)`));
      expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
    });

    it('should do nothing if file does not exist', () => {
      fs.existsSync.mockReturnValue(false);
      restoreRelayTasksAsFailed(projectRoot);
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('should not crash on corrupt JSON and should unlink the corrupt file so boot starts clean', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"tasks": malformed}');
      expect(() => restoreRelayTasksAsFailed(projectRoot)).not.toThrow();
      expect(ctx.nativeTaskMap.size).toBe(0);
      expect(ctx.nativeResultMap.size).toBe(0);
      // The corrupt file must be removed — otherwise it re-throws at parse on
      // every subsequent boot. The rm at the end of the happy path is
      // unreachable when JSON.parse throws, so the catch unlinks it directly.
      expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
    });

    it('should skip expired tasks', () => {
      const oldTask = mockTask({ startedAt: Date.now() - (2 * 60 * 60 * 1000 + 1) }); // TTL is 2 hours
      const fileContent = JSON.stringify({ tasks: [oldTask] });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(fileContent);

      restoreRelayTasksAsFailed(projectRoot);

      expect(ctx.nativeTaskMap.has(oldTask.id)).toBe(false);
      expect(ctx.nativeResultMap.has(oldTask.id)).toBe(false);
      expect(fs.unlinkSync).toHaveBeenCalledWith(filePath);
    });

    it('should skip tasks already present in nativeTaskMap', () => {
      const task = mockTask();
      ctx.nativeTaskMap.set(task.id, {} as any);
      const fileContent = JSON.stringify({ tasks: [task] });
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(fileContent);

      restoreRelayTasksAsFailed(projectRoot);
      expect(ctx.nativeResultMap.has(task.id)).toBe(false);
      expect(stderrWriteSpy).not.toHaveBeenCalledWith(expect.stringContaining(`Restored`));
    });
  });

});
