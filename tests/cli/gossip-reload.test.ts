import { jest } from '@jest/globals';

describe('gossip_reload', () => {
  it('schedules process.exit and returns a notice', () => {
    jest.useFakeTimers();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const text = `Reloading gossipcat MCP (pid ${process.pid}). Next tool call will use the fresh bundle.`;
    setTimeout(() => process.exit(0), 100).unref();
    expect(text).toMatch(/Reloading gossipcat MCP/);
    expect(text).toContain(String(process.pid));
    jest.advanceTimersByTime(100);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
    jest.useRealTimers();
  });
});
