export interface ShellToolsOptions {
    allowedCommands?: string[];
    maxOutputSize?: number;
}
export declare class ShellTools {
    private allowedCommands;
    private maxOutputSize;
    constructor(options?: ShellToolsOptions);
    shellExec(args: {
        command: string;
        timeout?: number;
        cwd?: string;
    }): Promise<string>;
}
