export interface ToolServerConfig {
    relayUrl: string;
    projectRoot: string;
    agentId?: string;
}
export declare class ToolServer {
    private agent;
    private fileTools;
    private shellTools;
    private gitTools;
    private sandbox;
    constructor(config: ToolServerConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    get agentId(): string;
    private handleToolRequest;
    executeTool(name: string, args: Record<string, unknown>): Promise<string>;
}
