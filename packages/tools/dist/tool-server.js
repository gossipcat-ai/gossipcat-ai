"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolServer = void 0;
const client_1 = require("@gossip/client");
const types_1 = require("@gossip/types");
const msgpack_1 = require("@msgpack/msgpack");
const file_tools_1 = require("./file-tools");
const shell_tools_1 = require("./shell-tools");
const git_tools_1 = require("./git-tools");
const sandbox_1 = require("./sandbox");
class ToolServer {
    agent;
    fileTools;
    shellTools;
    gitTools;
    sandbox;
    constructor(config) {
        this.sandbox = new sandbox_1.Sandbox(config.projectRoot);
        this.fileTools = new file_tools_1.FileTools(this.sandbox);
        this.shellTools = new shell_tools_1.ShellTools();
        this.gitTools = new git_tools_1.GitTools(config.projectRoot);
        this.agent = new client_1.GossipAgent({
            agentId: config.agentId || 'tool-server',
            relayUrl: config.relayUrl,
            reconnect: true
        });
    }
    async start() {
        await this.agent.connect();
        this.agent.on('message', this.handleToolRequest.bind(this));
    }
    async stop() {
        await this.agent.disconnect();
    }
    get agentId() { return this.agent.agentId; }
    async handleToolRequest(data, envelope) {
        // Only handle RPC_REQUEST messages
        if (envelope.t !== types_1.MessageType.RPC_REQUEST)
            return;
        const payload = data;
        const toolName = payload?.tool;
        const args = (payload?.args || {});
        let result;
        let responsePayload;
        try {
            result = await this.executeTool(toolName, args);
            responsePayload = { result };
        }
        catch (err) {
            responsePayload = { error: err.message };
        }
        // Send RPC_RESPONSE back to the requester.
        // Use envelope.rid_req (the caller's correlation ID) so the caller can
        // match the response to its pending promise.
        try {
            const body = Buffer.from((0, msgpack_1.encode)(responsePayload));
            const correlationId = (envelope.rid_req || envelope.id);
            const response = types_1.Message.createRpcResponse(this.agent.agentId, envelope.sid, // respond to the sender
            correlationId, // echo caller's correlation ID
            body);
            await this.agent.sendEnvelope(response.toEnvelope());
        }
        catch (sendErr) {
            console.error('[ToolServer] Failed to send RPC_RESPONSE:', sendErr.message);
        }
    }
    async executeTool(name, args) {
        switch (name) {
            case 'file_read':
                return this.fileTools.fileRead(args);
            case 'file_write':
                return this.fileTools.fileWrite(args);
            case 'file_search':
                return this.fileTools.fileSearch(args);
            case 'file_grep':
                return this.fileTools.fileGrep(args);
            case 'file_tree':
                return this.fileTools.fileTree(args);
            case 'shell_exec':
                return this.shellTools.shellExec({
                    ...args,
                    cwd: this.sandbox.projectRoot
                });
            case 'git_status':
                return this.gitTools.gitStatus();
            case 'git_diff':
                return this.gitTools.gitDiff(args);
            case 'git_log':
                return this.gitTools.gitLog(args);
            case 'git_commit':
                return this.gitTools.gitCommit(args);
            case 'git_branch':
                return this.gitTools.gitBranch(args);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
}
exports.ToolServer = ToolServer;
//# sourceMappingURL=tool-server.js.map