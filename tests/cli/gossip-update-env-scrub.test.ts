import { jest } from '@jest/globals';

/**
 * Verify that handleGossipUpdate scrubs GOSSIPCAT_* vars from the env passed
 * to execSync — PR #316 pattern. A lifecycle hook reading GOSSIPCAT_ORCHESTRATOR_ROLE
 * could bypass sandbox checks when spawned from an orchestrator session.
 */

// Mock child_process before importing the handler so jest intercepts it.
const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: mockExecSync,
}));

// Minimal existsSync mock — return false so detectInstallMethod falls through
// to 'local', which uses process.cwd() and always runs execSync.
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
}));

// Stub version helpers so the handler can resolve versions without filesystem.
jest.mock('../../apps/cli/src/version', () => ({
  getGossipcatVersion: jest.fn().mockReturnValue('0.0.1'),
}));

// Stub fetch so getLatestVersion returns a higher version, triggering the update path.
const fakeFetchResponse = { ok: true, json: async () => ({ version: '99.0.0' }) };
const mockFetch = jest.fn<() => Promise<typeof fakeFetchResponse>>().mockResolvedValue(fakeFetchResponse);
global.fetch = mockFetch as unknown as typeof fetch;

describe('handleGossipUpdate — env scrub', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    // Inject GOSSIPCAT_* pollution into process.env for the duration of each test.
    process.env.GOSSIPCAT_ORCHESTRATOR_ROLE = 'orchestrator';
    process.env.GOSSIPCAT_PORT = '9999';
    process.env.GOSSIPCAT_HTTP_PORT = '8888';
    process.env.GOSSIPCAT_HTTP_BIND = '127.0.0.1';
    process.env.GOSSIPCAT_HTTP_TOKEN = 'secret-token';
    process.env.SAFE_VAR = 'keep-me';
  });

  afterEach(() => {
    delete process.env.GOSSIPCAT_ORCHESTRATOR_ROLE;
    delete process.env.GOSSIPCAT_PORT;
    delete process.env.GOSSIPCAT_HTTP_PORT;
    delete process.env.GOSSIPCAT_HTTP_BIND;
    delete process.env.GOSSIPCAT_HTTP_TOKEN;
    delete process.env.SAFE_VAR;
  });

  it('passes env to execSync with all GOSSIPCAT_* keys removed', async () => {
    const { handleGossipUpdate } = await import('../../apps/cli/src/handlers/gossip-update');
    await handleGossipUpdate({ check_only: false, confirm: true });

    // Tighten: assert env: option is present, not just call count.
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ env: expect.any(Object) }),
    );
    const [, options] = mockExecSync.mock.calls[0] as [string, { env: NodeJS.ProcessEnv }];
    const envKeys = Object.keys(options.env ?? {});

    // No GOSSIPCAT_* key should survive.
    const leaked = envKeys.filter(k => /^GOSSIPCAT_/i.test(k));
    expect(leaked).toEqual([]);
  });

  it('preserves non-GOSSIPCAT env vars in the scrubbed env', async () => {
    const { handleGossipUpdate } = await import('../../apps/cli/src/handlers/gossip-update');
    await handleGossipUpdate({ check_only: false, confirm: true });

    const [, options] = mockExecSync.mock.calls[0] as [string, { env: NodeJS.ProcessEnv }];
    expect(options.env?.SAFE_VAR).toBe('keep-me');
  });

  it('does not mutate process.env — original vars still present after call', async () => {
    const { handleGossipUpdate } = await import('../../apps/cli/src/handlers/gossip-update');
    await handleGossipUpdate({ check_only: false, confirm: true });

    // Loop over all 5 GOSSIPCAT_* keys to ensure none are deleted from process.env.
    const expectedKeys: Array<[string, string]> = [
      ['GOSSIPCAT_ORCHESTRATOR_ROLE', 'orchestrator'],
      ['GOSSIPCAT_PORT', '9999'],
      ['GOSSIPCAT_HTTP_PORT', '8888'],
      ['GOSSIPCAT_HTTP_BIND', '127.0.0.1'],
      ['GOSSIPCAT_HTTP_TOKEN', 'secret-token'],
    ];
    for (const [key, value] of expectedKeys) {
      expect(process.env[key]).toBe(value);
    }
  });

  it('scrubs GOSSIPCAT_* env vars on global install path', async () => {
    const originalGlobal = process.env.npm_config_global;
    process.env.npm_config_global = 'true';
    try {
      const { handleGossipUpdate } = await import('../../apps/cli/src/handlers/gossip-update');
      await handleGossipUpdate({ check_only: false, confirm: true });

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const [cmd, options] = mockExecSync.mock.calls[0] as [string, { env: NodeJS.ProcessEnv }];
      // Global install uses 'npm install -g ...' command.
      expect(cmd).toContain('-g');
      const leaked = Object.keys(options.env ?? {}).filter(k => /^GOSSIPCAT_/i.test(k));
      expect(leaked).toEqual([]);
    } finally {
      if (originalGlobal === undefined) {
        delete process.env.npm_config_global;
      } else {
        process.env.npm_config_global = originalGlobal;
      }
    }
  });
});
