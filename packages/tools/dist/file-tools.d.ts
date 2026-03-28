import { Sandbox } from './sandbox';
export declare class FileTools {
    private sandbox;
    constructor(sandbox: Sandbox);
    fileRead(args: {
        path: string;
        startLine?: number;
        endLine?: number;
    }): Promise<string>;
    fileWrite(args: {
        path: string;
        content: string;
    }): Promise<string>;
    fileDelete(args: {
        path: string;
    }): Promise<string>;
    fileSearch(args: {
        pattern: string;
    }): Promise<string>;
    fileGrep(args: {
        pattern: string;
        path?: string;
    }): Promise<string>;
    fileTree(args: {
        path?: string;
        depth?: number;
    }): Promise<string>;
    private walkDir;
    private grepDir;
    private buildTree;
}
