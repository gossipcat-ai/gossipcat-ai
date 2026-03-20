export declare class Sandbox {
    private root;
    constructor(projectRoot: string);
    get projectRoot(): string;
    /**
     * Validate that a path resolves within the project root.
     * Handles non-existent files (for file_write) by walking up to the
     * deepest existing ancestor and resolving from there.
     * Resolves symlinks to prevent symlink escape attacks.
     */
    validatePath(filePath: string): string;
}
