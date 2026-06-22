"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("@gossip/tools");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('Sandbox', () => {
    const testDir = (0, path_1.resolve)((0, os_1.tmpdir)(), 'gossip-sandbox-test-' + Date.now());
    let sandbox;
    beforeAll(() => {
        (0, fs_1.mkdirSync)((0, path_1.resolve)(testDir, 'src'), { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.resolve)(testDir, 'src/index.ts'), 'hello');
        sandbox = new tools_1.Sandbox(testDir);
    });
    afterAll(() => {
        try {
            const { rmSync } = require('fs');
            rmSync(testDir, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    });
    it('allows paths within project root', () => {
        const result = sandbox.validatePath('src/index.ts');
        // Use realpathSync to handle macOS /var -> /private/var symlink
        const realTestDir = (0, fs_1.realpathSync)(testDir);
        expect(result).toBe((0, path_1.resolve)(realTestDir, 'src/index.ts'));
    });
    it('allows file_write to non-existent path within root', () => {
        const result = sandbox.validatePath('src/new-file.ts');
        const realTestDir = (0, fs_1.realpathSync)(testDir);
        expect(result).toBe((0, path_1.resolve)(realTestDir, 'src/new-file.ts'));
    });
    it('allows access to project root itself', () => {
        const result = sandbox.validatePath('.');
        const realTestDir = (0, fs_1.realpathSync)(testDir);
        expect(result).toBe(realTestDir);
    });
    it('blocks path traversal with ../', () => {
        expect(() => sandbox.validatePath('../../etc/passwd')).toThrow('outside project root');
    });
    it('blocks absolute paths outside root', () => {
        expect(() => sandbox.validatePath('/etc/passwd')).toThrow('outside project root');
    });
    it('blocks path that resolves to parent of root', () => {
        expect(() => sandbox.validatePath('../')).toThrow('outside project root');
    });
    it('blocks symlinks pointing outside project', () => {
        const linkPath = (0, path_1.resolve)(testDir, 'escape-link');
        try {
            (0, fs_1.symlinkSync)('/etc', linkPath);
            expect(() => sandbox.validatePath('escape-link/passwd')).toThrow('outside project root');
        }
        finally {
            if ((0, fs_1.existsSync)(linkPath))
                (0, fs_1.unlinkSync)(linkPath);
        }
    });
    it('exposes projectRoot', () => {
        const realTestDir = (0, fs_1.realpathSync)(testDir);
        expect(sandbox.projectRoot).toBe(realTestDir);
    });
});
//# sourceMappingURL=sandbox.test.js.map