"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("@gossip/tools");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
const child_process_1 = require("child_process");
describe('GitTools', () => {
    // Use a fresh temp git repo for all git tests
    const gitDir = (0, path_1.resolve)((0, os_1.tmpdir)(), 'gossip-git-test-' + Date.now());
    let gitTools;
    beforeAll(() => {
        (0, fs_1.mkdirSync)(gitDir, { recursive: true });
        // Initialize a fresh git repo with a commit
        (0, child_process_1.execFileSync)('git', ['init'], { cwd: gitDir });
        (0, child_process_1.execFileSync)('git', ['config', 'user.email', 'test@test.com'], { cwd: gitDir });
        (0, child_process_1.execFileSync)('git', ['config', 'user.name', 'Test User'], { cwd: gitDir });
        (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'README.md'), '# Test\n');
        (0, child_process_1.execFileSync)('git', ['add', 'README.md'], { cwd: gitDir });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'initial commit'], { cwd: gitDir });
        gitTools = new tools_1.GitTools(gitDir);
    });
    afterAll(() => {
        try {
            const { rmSync } = require('fs');
            rmSync(gitDir, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    });
    describe('gitStatus', () => {
        it('returns empty string for clean repo', async () => {
            const result = await gitTools.gitStatus();
            expect(result).toBe('');
        });
        it('shows untracked files', async () => {
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'untracked.ts'), 'const x = 1;\n');
            const result = await gitTools.gitStatus();
            expect(result).toContain('untracked.ts');
            // Cleanup: remove it
            const { rmSync } = require('fs');
            rmSync((0, path_1.resolve)(gitDir, 'untracked.ts'));
        });
    });
    describe('gitDiff', () => {
        it('returns empty for clean working tree', async () => {
            const result = await gitTools.gitDiff();
            expect(result).toBe('');
        });
        it('shows unstaged changes', async () => {
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'README.md'), '# Test\nModified line\n');
            const result = await gitTools.gitDiff();
            expect(result).toContain('Modified line');
            // Restore
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'README.md'), '# Test\n');
            (0, child_process_1.execFileSync)('git', ['checkout', 'README.md'], { cwd: gitDir });
        });
        it('returns staged diff when staged=true', async () => {
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'staged.ts'), 'const y = 2;\n');
            (0, child_process_1.execFileSync)('git', ['add', 'staged.ts'], { cwd: gitDir });
            const result = await gitTools.gitDiff({ staged: true });
            expect(result).toContain('staged.ts');
            // Cleanup
            (0, child_process_1.execFileSync)('git', ['reset', 'HEAD', 'staged.ts'], { cwd: gitDir });
            const { rmSync } = require('fs');
            rmSync((0, path_1.resolve)(gitDir, 'staged.ts'));
        });
    });
    describe('gitLog', () => {
        it('shows commit history', async () => {
            const result = await gitTools.gitLog();
            expect(result).toContain('initial commit');
        });
        it('respects count limit', async () => {
            const result = await gitTools.gitLog({ count: 1 });
            const lines = result.split('\n').filter(Boolean);
            expect(lines.length).toBeLessThanOrEqual(1);
        });
    });
    describe('gitCommit', () => {
        it('commits staged files', async () => {
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'new-file.ts'), 'export const a = 1;\n');
            (0, child_process_1.execFileSync)('git', ['add', 'new-file.ts'], { cwd: gitDir });
            const result = await gitTools.gitCommit({ message: 'add new-file.ts' });
            expect(result).toContain('add new-file.ts');
        });
        it('stages and commits specified files', async () => {
            (0, fs_1.writeFileSync)((0, path_1.resolve)(gitDir, 'another.ts'), 'export const b = 2;\n');
            const result = await gitTools.gitCommit({
                message: 'add another.ts',
                files: ['another.ts']
            });
            expect(result).toContain('add another.ts');
        });
        it('throws when there is nothing to commit', async () => {
            // Nothing staged or changed
            await expect(gitTools.gitCommit({ message: 'empty commit' }))
                .rejects.toThrow();
        });
    });
    describe('gitBranch', () => {
        it('lists branches', async () => {
            const result = await gitTools.gitBranch();
            // Should contain at least one branch (master or main)
            expect(result.length).toBeGreaterThan(0);
        });
        it('creates a new branch', async () => {
            const result = await gitTools.gitBranch({ name: 'test-branch-' + Date.now() });
            expect(result).toBe('');
        });
    });
});
//# sourceMappingURL=git-tools.test.js.map