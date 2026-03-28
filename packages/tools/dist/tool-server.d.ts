export interface ToolServerConfig {
    relayUrl: string;
    projectRoot: string;
    agentId?: string;
    allowedCallers?: string[];
    perfWriter?: {
        appendSignal(signal: unknown): void;
    };
}
export declare class ToolServer {
    private agent;
    private fileTools;
    private shellTools;
    private gitTools;
    private skillTools;
    private sandbox;
    private allowedCallers;
    private agentScopes;
    private agentRoots;
    private writeAgents;
    private pendingReviews;
    private agentWrittenFiles;
    private static readonly MAX_WRITTEN_FILES_PER_AGENT;
    private perfWriter?;
    constructor(config: ToolServerConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    get agentId(): string;
    assignScope(agentId: string, scope: string): void;
    assignRoot(agentId: string, root: string): void;
    releaseAgent(agentId: string): void;
    private handleToolRequest;
    private enforceWriteScope;
    executeTool(name: string, args: Record<string, unknown>, callerId?: string): Promise<string>;
    private handleVerifyWrite;
    private requestPeerReview;
}
