"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const worktree_manager_1 = require("../../packages/orchestrator/src/worktree-manager");
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('WorktreeManager', () => {
    const testDir = (0, path_1.join)((0, os_1.tmpdir)(), `gossip-wt-test-${Date.now()}`);
    let manager;
    beforeAll(() => {
        (0, fs_1.mkdirSync)(testDir, { recursive: true });
        (0, child_process_1.execFileSync)('git', ['init'], { cwd: testDir });
        (0, child_process_1.execFileSync)('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir });
        (0, child_process_1.execFileSync)('git', ['config', 'user.name', 'Test'], { cwd: testDir });
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'README.md'), '# Test');
        (0, child_process_1.execFileSync)('git', ['add', '.'], { cwd: testDir });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'init'], { cwd: testDir });
    });
    afterAll(() => { (0, fs_1.rmSync)(testDir, { recursive: true, force: true }); });
    beforeEach(() => { manager = new worktree_manager_1.WorktreeManager(testDir); });
    it('creates a worktree with a branch', async () => {
        const { path, branch } = await manager.create('test-1');
        expect((0, fs_1.existsSync)(path)).toBe(true);
        expect(branch).toBe('gossip-test-1');
        await manager.cleanup('test-1', path);
    });
    it('merges a worktree with changes', async () => {
        const { path } = await manager.create('test-2');
        (0, fs_1.writeFileSync)((0, path_1.join)(path, 'new-file.txt'), 'hello');
        (0, child_process_1.execFileSync)('git', ['add', '.'], { cwd: path });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'add file'], { cwd: path });
        const result = await manager.merge('test-2');
        expect(result.merged).toBe(true);
        expect((0, fs_1.existsSync)((0, path_1.join)(testDir, 'new-file.txt'))).toBe(true);
        await manager.cleanup('test-2', path);
    });
    it('cleanup force-deletes unmerged branches', async () => {
        const { path } = await manager.create('test-4');
        // Make a commit on the worktree branch (unmerged)
        (0, fs_1.writeFileSync)((0, path_1.join)(path, 'unmerged.txt'), 'data');
        (0, child_process_1.execFileSync)('git', ['add', '.'], { cwd: path });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'unmerged change'], { cwd: path });
        await manager.cleanup('test-4', path);
        // Verify branch is actually deleted
        const branches = (0, child_process_1.execFileSync)('git', ['branch', '--list', 'gossip-test-4'], { cwd: testDir }).toString().trim();
        expect(branches).toBe('');
    });
    it('detects merge conflicts', async () => {
        const { path } = await manager.create('test-3');
        (0, fs_1.writeFileSync)((0, path_1.join)(testDir, 'conflict.txt'), 'main version');
        (0, child_process_1.execFileSync)('git', ['add', '.'], { cwd: testDir });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'main change'], { cwd: testDir });
        (0, fs_1.writeFileSync)((0, path_1.join)(path, 'conflict.txt'), 'worktree version');
        (0, child_process_1.execFileSync)('git', ['add', '.'], { cwd: path });
        (0, child_process_1.execFileSync)('git', ['commit', '-m', 'wt change'], { cwd: path });
        const result = await manager.merge('test-3');
        expect(result.merged).toBe(false);
        expect(result.conflicts).toBeDefined();
        await manager.cleanup('test-3', path);
    });
});
//# sourceMappingURL=worktree-manager.test.js.map