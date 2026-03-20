"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sandbox = void 0;
const path_1 = require("path");
const fs_1 = require("fs");
class Sandbox {
    root;
    constructor(projectRoot) {
        this.root = (0, fs_1.realpathSync)((0, path_1.resolve)(projectRoot));
    }
    get projectRoot() { return this.root; }
    /**
     * Validate that a path resolves within the project root.
     * Handles non-existent files (for file_write) by walking up to the
     * deepest existing ancestor and resolving from there.
     * Resolves symlinks to prevent symlink escape attacks.
     */
    validatePath(filePath) {
        // Resolve relative to project root
        const resolved = (0, path_1.resolve)(this.root, filePath);
        // Walk up to deepest existing ancestor (handles file_write to new paths)
        let checkPath = resolved;
        while (!(0, fs_1.existsSync)(checkPath)) {
            const parent = (0, path_1.dirname)(checkPath);
            if (parent === checkPath)
                break; // filesystem root
            checkPath = parent;
        }
        const real = (0, fs_1.existsSync)(checkPath) ? (0, fs_1.realpathSync)(checkPath) : checkPath;
        const remainder = resolved.slice(checkPath.length);
        const fullReal = real + remainder;
        if (!fullReal.startsWith(this.root + '/') && fullReal !== this.root) {
            throw new Error(`Path "${filePath}" resolves outside project root`);
        }
        return resolved; // Return the resolved absolute path
    }
}
exports.Sandbox = Sandbox;
//# sourceMappingURL=sandbox.js.map