import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolServer } from '../../packages/tools/src/tool-server';

jest.mock('@gossip/client', () => ({
  GossipAgent: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    agentId: 'tool-server',
    sendEnvelope: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('verify_write tool', () => {
  let server: ToolServer;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-verify-'));
    server = new ToolServer({ relayUrl: 'ws://localhost:0', projectRoot });
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns "no changes" when git diff is empty', async () => {
    const result = await server.executeTool('verify_write', {}, 'agent-1');
    expect(result).toContain('No changes detected');
  });

  it('is not blocked by scope enforcement for scoped agents', async () => {
    server.assignScope('agent-1', 'packages/relay/');
    // verify_write should NOT throw "Shell execution blocked"
    try {
      const result = await server.executeTool('verify_write', {}, 'agent-1');
      expect(result).toContain('No changes detected');
    } catch (err) {
      // May fail for non-scope reasons, but not scope enforcement
      expect((err as Error).message).not.toContain('Shell execution blocked');
      expect((err as Error).message).not.toContain('outside scope');
    }
  });
});
