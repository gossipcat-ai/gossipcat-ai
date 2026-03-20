export declare class GitTools {
    private cwd;
    constructor(cwd: string);
    private git;
    gitStatus(): Promise<string>;
    gitDiff(args?: {
        staged?: boolean;
    }): Promise<string>;
    gitLog(args?: {
        count?: number;
    }): Promise<string>;
    gitCommit(args: {
        message: string;
        files?: string[];
    }): Promise<string>;
    gitBranch(args?: {
        name?: string;
    }): Promise<string>;
}
