"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitTools = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
class GitTools {
    cwd;
    constructor(cwd) {
        this.cwd = cwd;
    }
    async git(...args) {
        try {
            const { stdout } = await execFileAsync('git', args, { cwd: this.cwd });
            return stdout.trim();
        }
        catch (err) {
            const error = err;
            const msg = error.stderr ? error.stderr.trim() : error.message;
            throw new Error(`git ${args[0]} failed: ${msg}`);
        }
    }
    async gitStatus() {
        return this.git('status', '--short');
    }
    async gitDiff(args) {
        const flags = args?.staged ? ['diff', '--staged'] : ['diff'];
        if (args?.paths?.length)
            flags.push('--', ...args.paths);
        return this.git(...flags);
    }
    async gitUntrackedDiff(paths) {
        const diffs = [];
        // Get all untracked files under the given paths
        let untrackedFiles = [];
        try {
            const status = await this.git('status', '--porcelain', '--', ...paths);
            untrackedFiles = status.split('\n')
                .filter(line => line.startsWith('??'))
                .map(line => line.slice(3).trim());
        }
        catch { /* no untracked files */ }
        for (const file of untrackedFiles) {
            try {
                // git diff --no-index exits 1 when files differ — that's expected
                const { stdout } = await execFileAsync('git', ['diff', '--no-index', '/dev/null', file], { cwd: this.cwd }).catch((err) => {
                    const e = err;
                    return { stdout: e.stdout || '' };
                });
                if (stdout)
                    diffs.push(stdout.trim());
            }
            catch (err) {
                // skip files that can't be diffed (binary, symlinks, etc.)
            }
        }
        return diffs.join('\n');
    }
    async gitLog(args) {
        return this.git('log', '--oneline', `-${args?.count || 20}`);
    }
    async gitCommit(args) {
        if (args.files?.length) {
            await this.git('add', ...args.files);
        }
        return this.git('commit', '-m', args.message);
    }
    async gitBranch(args) {
        if (args?.name) {
            return this.git('checkout', '-b', args.name);
        }
        return this.git('branch', '--list');
    }
}
exports.GitTools = GitTools;
//# sourceMappingURL=git-tools.js.map