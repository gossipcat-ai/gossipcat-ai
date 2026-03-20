"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileTools = void 0;
const promises_1 = require("fs/promises");
const path_1 = require("path");
class FileTools {
    sandbox;
    constructor(sandbox) {
        this.sandbox = sandbox;
    }
    async fileRead(args) {
        const absPath = this.sandbox.validatePath(args.path);
        const content = await (0, promises_1.readFile)(absPath, 'utf-8');
        if (args.startLine !== undefined || args.endLine !== undefined) {
            const lines = content.split('\n');
            const start = (args.startLine || 1) - 1;
            const end = args.endLine || lines.length;
            return lines.slice(start, end).join('\n');
        }
        return content;
    }
    async fileWrite(args) {
        const absPath = this.sandbox.validatePath(args.path);
        const dir = (0, path_1.resolve)(absPath, '..');
        await (0, promises_1.mkdir)(dir, { recursive: true });
        await (0, promises_1.writeFile)(absPath, args.content, 'utf-8');
        return `Written ${args.content.length} bytes to ${args.path}`;
    }
    async fileSearch(args) {
        const results = [];
        await this.walkDir(this.sandbox.projectRoot, args.pattern, results);
        return results.join('\n') || 'No files found';
    }
    async fileGrep(args) {
        const searchRoot = args.path
            ? this.sandbox.validatePath(args.path)
            : this.sandbox.projectRoot;
        const regex = new RegExp(args.pattern);
        const results = [];
        await this.grepDir(searchRoot, regex, results);
        return results.join('\n') || 'No matches found';
    }
    async fileTree(args) {
        const root = args.path
            ? this.sandbox.validatePath(args.path)
            : this.sandbox.projectRoot;
        const maxDepth = args.depth || 3;
        const lines = [];
        await this.buildTree(root, '', lines, 0, maxDepth);
        return lines.join('\n');
    }
    // ─── Private helpers ──────────────────────────────────────────────────────
    async walkDir(dir, pattern, results) {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git')
                continue;
            const fullPath = (0, path_1.join)(dir, entry);
            let info;
            try {
                info = await (0, promises_1.stat)(fullPath);
            }
            catch {
                continue;
            }
            if (info.isDirectory()) {
                await this.walkDir(fullPath, pattern, results);
            }
            else {
                // Match glob-style pattern: convert * and ? to regex
                const regexStr = pattern
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.');
                const regex = new RegExp(regexStr);
                const relPath = (0, path_1.relative)(this.sandbox.projectRoot, fullPath);
                if (regex.test(entry) || regex.test(relPath)) {
                    results.push(relPath);
                }
            }
        }
    }
    async grepDir(dir, regex, results) {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry === 'node_modules' || entry === '.git')
                continue;
            const fullPath = (0, path_1.join)(dir, entry);
            let info;
            try {
                info = await (0, promises_1.stat)(fullPath);
            }
            catch {
                continue;
            }
            if (info.isDirectory()) {
                await this.grepDir(fullPath, regex, results);
            }
            else {
                try {
                    const content = await (0, promises_1.readFile)(fullPath, 'utf-8');
                    const lines = content.split('\n');
                    const relPath = (0, path_1.relative)(this.sandbox.projectRoot, fullPath);
                    lines.forEach((line, idx) => {
                        if (regex.test(line)) {
                            results.push(`${relPath}:${idx + 1}: ${line}`);
                        }
                    });
                }
                catch {
                    // Skip binary or unreadable files
                }
            }
        }
    }
    async buildTree(dir, prefix, lines, depth, maxDepth) {
        if (depth >= maxDepth)
            return;
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir);
        }
        catch {
            return;
        }
        const filtered = entries.filter(e => e !== 'node_modules' && e !== '.git');
        for (let i = 0; i < filtered.length; i++) {
            const entry = filtered[i];
            const isLast = i === filtered.length - 1;
            const connector = isLast ? '└── ' : '├── ';
            const fullPath = (0, path_1.join)(dir, entry);
            let info;
            try {
                info = await (0, promises_1.stat)(fullPath);
            }
            catch {
                continue;
            }
            lines.push(`${prefix}${connector}${entry}`);
            if (info.isDirectory()) {
                const childPrefix = prefix + (isLast ? '    ' : '│   ');
                await this.buildTree(fullPath, childPrefix, lines, depth + 1, maxDepth);
            }
        }
    }
}
exports.FileTools = FileTools;
//# sourceMappingURL=file-tools.js.map