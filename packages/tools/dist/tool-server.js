"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolServer = void 0;
const client_1 = require("@gossip/client");
const types_1 = require("@gossip/types");
const msgpack_1 = require("@msgpack/msgpack");
const crypto_1 = require("crypto");
const file_tools_1 = require("./file-tools");
const shell_tools_1 = require("./shell-tools");
const git_tools_1 = require("./git-tools");
const skill_tools_1 = require("./skill-tools");
const sandbox_1 = require("./sandbox");
const path_1 = require("path");
function truncateAtLine(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    const cut = text.lastIndexOf('\n', maxLength);
    return text.slice(0, cut !== -1 ? cut : maxLength);
}
class ToolServer {
    agent;
    fileTools;
    shellTools;
    gitTools;
    skillTools;
    sandbox;
    allowedCallers;
    agentScopes = new Map(); // agentId → scope path
    agentRoots = new Map(); // agentId → worktree root path
    writeAgents = new Set(); // agents with any write mode active
    pendingReviews = new Map();
    agentWrittenFiles = new Map(); // agentId → written file paths
    static MAX_WRITTEN_FILES_PER_AGENT = 1024;
    perfWriter;
    constructor(config) {
        this.allowedCallers = config.allowedCallers ? new Set(config.allowedCallers) : null;
        this.sandbox = new sandbox_1.Sandbox(config.projectRoot);
        this.fileTools = new file_tools_1.FileTools(this.sandbox);
        this.shellTools = new shell_tools_1.ShellTools();
        this.gitTools = new git_tools_1.GitTools(config.projectRoot);
        this.skillTools = new skill_tools_1.SkillTools(config.projectRoot);
        this.perfWriter = config.perfWriter;
        this.agent = new client_1.GossipAgent({
            agentId: config.agentId || 'tool-server',
            relayUrl: config.relayUrl,
            reconnect: true
        });
    }
    async start() {
        await this.agent.connect();
        this.agent.on('message', this.handleToolRequest.bind(this));
        this.agent.on('error', (err) => console.error(`[ToolServer] Relay error: ${err.message}`));
        if (!this.allowedCallers) {
            console.warn('[ToolServer] WARNING: No allowedCallers configured — any relay agent can call any tool');
        }
    }
    async stop() {
        await this.agent.disconnect();
    }
    get agentId() { return this.agent.agentId; }
    assignScope(agentId, scope) {
        const normalized = scope.endsWith('/') ? scope : scope + '/';
        this.agentScopes.set(agentId, normalized);
        this.writeAgents.add(agentId);
    }
    assignRoot(agentId, root) {
        this.agentRoots.set(agentId, root);
        this.writeAgents.add(agentId);
    }
    releaseAgent(agentId) {
        this.agentScopes.delete(agentId);
        this.agentRoots.delete(agentId);
        this.writeAgents.delete(agentId);
        this.agentWrittenFiles.delete(agentId);
    }
    async handleToolRequest(data, envelope) {
        // Handle review responses from orchestrator
        if (envelope.t === types_1.MessageType.RPC_RESPONSE) {
            const correlationId = (envelope.rid_req || envelope.id);
            const pending = this.pendingReviews.get(correlationId);
            if (pending) {
                this.pendingReviews.delete(correlationId);
                const payload = data;
                if (payload?.error)
                    pending.reject(new Error(payload.error));
                else
                    pending.resolve(payload?.result || '');
            }
            return;
        }
        if (envelope.t !== types_1.MessageType.RPC_REQUEST)
            return;
        // Authorization: check if caller is allowed
        if (this.allowedCallers && !this.allowedCallers.has(envelope.sid)) {
            console.error(`[ToolServer] Unauthorized tool call from ${envelope.sid}`);
            return;
        }
        const payload = data;
        const toolName = payload?.tool;
        const args = (payload?.args || {});
        let result;
        let responsePayload;
        try {
            result = await this.executeTool(toolName, args, envelope.sid);
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
    enforceWriteScope(toolName, args, callerId) {
        const scope = this.agentScopes.get(callerId);
        const root = this.agentRoots.get(callerId);
        if (toolName === 'file_write') {
            const filePath = args.path;
            if (scope) {
                // Resolve path to prevent traversal attacks (e.g. 'packages/tools/../relay/evil.ts')
                const resolved = (0, path_1.resolve)(this.sandbox.projectRoot, filePath);
                const rel = (0, path_1.relative)(this.sandbox.projectRoot, resolved);
                if (rel.startsWith('..')) {
                    throw new Error(`Write blocked: "${filePath}" resolves outside project root`);
                }
                const normalizedRel = rel.endsWith('/') ? rel : rel + '/';
                if (!normalizedRel.startsWith(scope)) {
                    throw new Error(`Write blocked: "${filePath}" is outside scope "${scope}"`);
                }
            }
            if (root) {
                const resolved = (0, path_1.resolve)(root, filePath);
                if (!resolved.startsWith(root)) {
                    throw new Error(`Write blocked: "${filePath}" is outside worktree root "${root}"`);
                }
            }
        }
        if (toolName === 'shell_exec') {
            // Block shell entirely for scoped agents (can't constrain arbitrary commands)
            if (scope) {
                throw new Error('shell_exec is permanently unavailable in scoped write mode. Use file_read to verify your work instead. Do not retry.');
            }
            // Worktree agents: block dangerous patterns
            if (root) {
                const fullCmd = [args.command, ...(args.args || [])].join(' ');
                const blockedPatterns = [
                    /\.git\/hooks/i,
                    /\.git\/config/i,
                    /core\.hookspath/i,
                    /\.\.\//,
                ];
                for (const pattern of blockedPatterns) {
                    if (pattern.test(fullCmd)) {
                        throw new Error(`Shell command blocked for write-mode agent: matches ${pattern}`);
                    }
                }
            }
        }
        if (toolName === 'git_commit') {
            // Scoped agents: block git commit (they write files, main orchestrator commits)
            if (scope) {
                throw new Error('Git commit blocked for scoped write agents');
            }
            // Worktree agents: allow (they commit in their worktree)
        }
        if (toolName === 'git_branch') {
            if (scope) {
                throw new Error('Git branch blocked for scoped write agents');
            }
        }
    }
    async executeTool(name, args, callerId) {
        // Fail-closed: write agents with no registered scope/root are rejected
        if (callerId && this.writeAgents.has(callerId)) {
            if (!this.agentScopes.has(callerId) && !this.agentRoots.has(callerId)) {
                throw new Error(`Agent ${callerId} is a write agent but has no scope/root registered — rejecting (fail-closed)`);
            }
            const writableTools = ['file_write', 'file_delete', 'shell_exec', 'git_commit', 'git_branch'];
            if (writableTools.includes(name)) {
                this.enforceWriteScope(name, args, callerId);
            }
        }
        // Per-agent root for worktree isolation
        const agentRoot = callerId ? this.agentRoots.get(callerId) : undefined;
        switch (name) {
            case 'file_read':
                return this.fileTools.fileRead(args);
            case 'file_write': {
                // Check cap BEFORE write to avoid write-success-with-false-error
                if (callerId) {
                    if (!this.agentWrittenFiles.has(callerId))
                        this.agentWrittenFiles.set(callerId, new Set());
                    const tracked = this.agentWrittenFiles.get(callerId);
                    if (tracked.size >= ToolServer.MAX_WRITTEN_FILES_PER_AGENT && !tracked.has(args.path)) {
                        throw new Error(`Agent ${callerId} exceeded max tracked file writes (${ToolServer.MAX_WRITTEN_FILES_PER_AGENT})`);
                    }
                }
                const result = await this.fileTools.fileWrite(args);
                if (callerId) {
                    this.agentWrittenFiles.get(callerId).add(args.path);
                }
                return result;
            }
            case 'file_delete':
                return this.fileTools.fileDelete(args);
            case 'file_search':
                return this.fileTools.fileSearch(args);
            case 'file_grep':
                return this.fileTools.fileGrep(args);
            case 'file_tree':
                return this.fileTools.fileTree(args);
            case 'shell_exec':
                return this.shellTools.shellExec({
                    ...args,
                    cwd: agentRoot || this.sandbox.projectRoot
                });
            case 'git_status':
                return agentRoot ? new git_tools_1.GitTools(agentRoot).gitStatus() : this.gitTools.gitStatus();
            case 'git_diff':
                return agentRoot ? new git_tools_1.GitTools(agentRoot).gitDiff(args) : this.gitTools.gitDiff(args);
            case 'git_log':
                return agentRoot ? new git_tools_1.GitTools(agentRoot).gitLog(args) : this.gitTools.gitLog(args);
            case 'git_commit':
                return agentRoot ? new git_tools_1.GitTools(agentRoot).gitCommit(args) : this.gitTools.gitCommit(args);
            case 'git_branch':
                return agentRoot ? new git_tools_1.GitTools(agentRoot).gitBranch(args) : this.gitTools.gitBranch(args);
            case 'suggest_skill':
                return this.skillTools.suggestSkill(args, callerId);
            case 'verify_write':
                return this.handleVerifyWrite(callerId || 'unknown', args.test_file);
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    async handleVerifyWrite(callerId, testFile) {
        // 1. Capture git diff scoped to files the agent actually wrote (avoids noisy unrelated changes)
        const writtenFiles = this.agentWrittenFiles.get(callerId);
        const scope = this.agentScopes.get(callerId);
        const paths = writtenFiles?.size ? [...writtenFiles] : scope ? [scope] : undefined;
        let fullDiff = '';
        try {
            const diff = await this.gitTools.gitDiff({ staged: false, paths });
            const staged = await this.gitTools.gitDiff({ staged: true, paths });
            // Include untracked (new) files — git diff doesn't show them
            const untracked = paths ? await this.gitTools.gitUntrackedDiff(paths) : '';
            fullDiff = [diff, staged, untracked].filter(Boolean).join('\n');
        }
        catch {
            // Silently skip — git diff can fail on new projects with no commits,
            // untracked directories, or other edge cases. Not critical for verify_write.
        }
        if (!fullDiff.trim()) {
            return 'No changes detected. Nothing to verify.';
        }
        // 2. Run tests — validate testFile is a safe file path (not a CLI flag or config override)
        if (testFile) {
            if (testFile.startsWith('-')) {
                throw new Error(`verify_write: test_file must be a file path, not a flag: "${testFile}"`);
            }
            this.sandbox.validatePath(testFile);
            if (/\.(js|json)$/i.test(testFile) && !testFile.includes('.test.') && !testFile.includes('.spec.')) {
                throw new Error(`verify_write: test_file must be a test file (.test.ts/.spec.ts), got: "${testFile}"`);
            }
        }
        const testArgs = ['jest', '--config', 'jest.config.base.js'];
        if (testFile)
            testArgs.push(testFile);
        testArgs.push('--verbose');
        let testResult;
        try {
            testResult = await this.shellTools.shellExec({ command: 'npx', args: testArgs, cwd: this.sandbox.projectRoot, timeout: 30000 });
        }
        catch (err) {
            testResult = `Tests failed: ${err.message}`;
        }
        // 3. Request peer review via RPC (best-effort)
        let reviewResult = '';
        try {
            reviewResult = await this.requestPeerReview(callerId, fullDiff, testResult);
        }
        catch (err) {
            reviewResult = `Peer review unavailable: ${err.message}`;
        }
        // Emit impl signals
        const testStatus = testResult.includes('FAIL') ? 'FAIL' : 'PASS';
        if (this.perfWriter) {
            const now = new Date().toISOString();
            this.perfWriter.appendSignal({
                type: 'impl',
                signal: testStatus === 'PASS' ? 'impl_test_pass' : 'impl_test_fail',
                agentId: callerId,
                taskId: callerId,
                evidence: testStatus === 'FAIL' ? testResult.slice(-500) : undefined,
                timestamp: now,
            });
            if (reviewResult && !reviewResult.includes('unavailable')) {
                const approved = !reviewResult.toLowerCase().includes('reject') && !reviewResult.toLowerCase().includes('fail');
                this.perfWriter.appendSignal({
                    type: 'impl',
                    signal: approved ? 'impl_peer_approved' : 'impl_peer_rejected',
                    agentId: callerId,
                    taskId: callerId,
                    evidence: reviewResult.slice(0, 500),
                    timestamp: now,
                });
            }
        }
        // 4. Format result
        return `## Verification Result\n\n### Tests: ${testStatus}\n${testResult.slice(-2000)}\n\n### Peer Review\n${reviewResult || 'No reviewer available'}\n\n### Diff Summary\n${truncateAtLine(fullDiff, 3000)}`;
    }
    async requestPeerReview(callerId, diff, testResult) {
        const requestId = (0, crypto_1.randomUUID)();
        const reviewPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingReviews.delete(requestId);
                reject(new Error('Review timed out'));
            }, 55_000);
            timer.unref();
            this.pendingReviews.set(requestId, {
                resolve: (r) => { clearTimeout(timer); resolve(r); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        });
        try {
            const body = Buffer.from((0, msgpack_1.encode)({
                tool: 'review_request',
                args: { callerId, diff: truncateAtLine(diff, 3000), testResult: truncateAtLine(testResult, 1000) },
            }));
            const msg = types_1.Message.createRpcRequest(this.agent.agentId, 'orchestrator', requestId, body);
            await this.agent.sendEnvelope(msg.toEnvelope());
        }
        catch (err) {
            // Clean up pending review if send fails
            const pending = this.pendingReviews.get(requestId);
            if (pending) {
                this.pendingReviews.delete(requestId);
                pending.reject(err);
            }
        }
        return reviewPromise;
    }
}
exports.ToolServer = ToolServer;
//# sourceMappingURL=tool-server.js.map