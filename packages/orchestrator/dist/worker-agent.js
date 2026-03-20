"use strict";
/**
 * WorkerAgent — executes a sub-task using its LLM and requests tools via relay.
 *
 * Multi-turn tool loop with max 10 turns to prevent infinite loops.
 * Tool calls are sent as RPC_REQUEST to tool-server via relay.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerAgent = void 0;
const crypto_1 = require("crypto");
const client_1 = require("@gossip/client");
const types_1 = require("@gossip/types");
const msgpack_1 = require("@msgpack/msgpack");
const MAX_TOOL_TURNS = 10;
const TOOL_CALL_TIMEOUT_MS = 30_000;
class WorkerAgent {
    agentId;
    llm;
    tools;
    agent;
    pendingToolCalls = new Map();
    constructor(agentId, llm, relayUrl, tools) {
        this.agentId = agentId;
        this.llm = llm;
        this.tools = tools;
        this.agent = new client_1.GossipAgent({ agentId, relayUrl, reconnect: true });
    }
    async start() {
        await this.agent.connect();
        this.agent.on('message', this.handleMessage.bind(this));
    }
    async stop() {
        await this.agent.disconnect();
    }
    /**
     * Execute a task with the LLM, using multi-turn tool calling.
     * Returns the final text response.
     */
    async executeTask(task, context) {
        const messages = [
            {
                role: 'system',
                content: `You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.${context ? `\n\nContext:\n${context}` : ''}`,
            },
            { role: 'user', content: task },
        ];
        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
            const response = await this.llm.generate(messages, { tools: this.tools });
            if (!response.toolCalls?.length) {
                return response.text;
            }
            // Add assistant message with tool calls
            messages.push({
                role: 'assistant',
                content: response.text || '',
                toolCalls: response.toolCalls,
            });
            // Execute each tool call via relay RPC
            for (const toolCall of response.toolCalls) {
                const result = await this.callTool(toolCall.name, toolCall.arguments);
                messages.push({
                    role: 'tool',
                    content: result,
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                });
            }
        }
        return 'Max tool turns reached';
    }
    /** Send RPC_REQUEST to tool-server via relay */
    async callTool(name, args) {
        const requestId = (0, crypto_1.randomUUID)();
        const resultPromise = new Promise((resolve, reject) => {
            this.pendingToolCalls.set(requestId, { resolve, reject });
            setTimeout(() => {
                if (this.pendingToolCalls.has(requestId)) {
                    this.pendingToolCalls.delete(requestId);
                    reject(new Error(`Tool call ${name} timed out`));
                }
            }, TOOL_CALL_TIMEOUT_MS);
        });
        const msg = types_1.Message.createRpcRequest(this.agentId, 'tool-server', requestId, Buffer.from((0, msgpack_1.encode)({ tool: name, args })));
        await this.agent.sendEnvelope(msg.envelope);
        return resultPromise;
    }
    /** Handle incoming messages — resolve pending RPC tool calls */
    handleMessage(data, envelope) {
        if (envelope.t === types_1.MessageType.RPC_RESPONSE && envelope.rid_req) {
            const pending = this.pendingToolCalls.get(envelope.rid_req);
            if (pending) {
                this.pendingToolCalls.delete(envelope.rid_req);
                // `data` is the msgpack-decoded payload object emitted by GossipAgent.
                // Prefer it over raw `envelope.body` to avoid double-decoding issues.
                const payload = data;
                if (payload && typeof payload === 'object') {
                    if (payload.error) {
                        pending.reject(new Error(payload.error));
                    }
                    else {
                        pending.resolve(payload.result || '');
                    }
                }
                else {
                    // Fallback: decode body bytes as text (legacy path)
                    const body = new TextDecoder().decode(envelope.body);
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.error) {
                            pending.reject(new Error(parsed.error));
                        }
                        else {
                            pending.resolve(parsed.result || '');
                        }
                    }
                    catch {
                        pending.resolve(body);
                    }
                }
            }
        }
    }
}
exports.WorkerAgent = WorkerAgent;
//# sourceMappingURL=worker-agent.js.map