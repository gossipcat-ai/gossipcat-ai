"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tool_server_1 = require("../../packages/tools/src/tool-server");
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
    let server;
    let projectRoot;
    beforeEach(() => {
        projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-verify-'));
        server = new tool_server_1.ToolServer({ relayUrl: 'ws://localhost:0', projectRoot });
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
        }
        catch (err) {
            // May fail for non-scope reasons, but not scope enforcement
            expect(err.message).not.toContain('Shell execution blocked');
            expect(err.message).not.toContain('outside scope');
        }
    });
});
//# sourceMappingURL=tool-server-verify.test.js.map