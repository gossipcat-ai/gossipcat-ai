"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("@gossip/tools");
const fs_1 = require("fs");
const path_1 = require("path");
const os_1 = require("os");
describe('FileTools', () => {
    const testDir = (0, path_1.resolve)((0, os_1.tmpdir)(), 'gossip-file-tools-test-' + Date.now());
    let sandbox;
    let fileTools;
    beforeAll(() => {
        (0, fs_1.mkdirSync)((0, path_1.resolve)(testDir, 'src'), { recursive: true });
        (0, fs_1.mkdirSync)((0, path_1.resolve)(testDir, 'lib'), { recursive: true });
        (0, fs_1.writeFileSync)((0, path_1.resolve)(testDir, 'src/index.ts'), 'export const hello = "world";\nexport const foo = 42;\n');
        (0, fs_1.writeFileSync)((0, path_1.resolve)(testDir, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
        (0, fs_1.writeFileSync)((0, path_1.resolve)(testDir, 'lib/helpers.js'), 'const x = require("./utils");\nmodule.exports = x;\n');
        (0, fs_1.writeFileSync)((0, path_1.resolve)(testDir, 'README.md'), '# Test Project\nThis is a test.\n');
        sandbox = new tools_1.Sandbox(testDir);
        fileTools = new tools_1.FileTools(sandbox);
    });
    afterAll(() => {
        try {
            const { rmSync } = require('fs');
            rmSync(testDir, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    });
    // ─── fileRead ──────────────────────────────────────────────────────────────
    describe('fileRead', () => {
        it('reads entire file content', async () => {
            const result = await fileTools.fileRead({ path: 'src/index.ts' });
            expect(result).toContain('hello');
            expect(result).toContain('world');
        });
        it('reads specific line range', async () => {
            const result = await fileTools.fileRead({ path: 'src/index.ts', startLine: 1, endLine: 1 });
            expect(result).toContain('hello');
            expect(result).not.toContain('foo');
        });
        it('reads from startLine to end when endLine omitted', async () => {
            const result = await fileTools.fileRead({ path: 'src/index.ts', startLine: 2 });
            expect(result).toContain('foo');
        });
        it('throws for path outside project root', async () => {
            await expect(fileTools.fileRead({ path: '../../etc/passwd' })).rejects.toThrow('outside project root');
        });
        it('throws for nonexistent file', async () => {
            await expect(fileTools.fileRead({ path: 'src/nonexistent.ts' })).rejects.toThrow();
        });
    });
    // ─── fileWrite ─────────────────────────────────────────────────────────────
    describe('fileWrite', () => {
        it('writes content to an existing directory', async () => {
            const result = await fileTools.fileWrite({ path: 'src/new-file.ts', content: 'const x = 1;\n' });
            expect(result).toContain('Written');
            expect(result).toContain('src/new-file.ts');
            expect((0, fs_1.existsSync)((0, path_1.resolve)(testDir, 'src/new-file.ts'))).toBe(true);
        });
        it('creates parent directories as needed', async () => {
            const result = await fileTools.fileWrite({
                path: 'new-dir/sub/file.ts',
                content: 'export {};\n'
            });
            expect(result).toContain('Written');
            expect((0, fs_1.existsSync)((0, path_1.resolve)(testDir, 'new-dir/sub/file.ts'))).toBe(true);
        });
        it('reports byte count in result', async () => {
            const content = 'hello world';
            const result = await fileTools.fileWrite({ path: 'src/count-test.ts', content });
            expect(result).toContain(`${content.length} bytes`);
        });
        it('blocks writes outside project root', async () => {
            await expect(fileTools.fileWrite({ path: '../../evil.ts', content: 'bad' }))
                .rejects.toThrow('outside project root');
        });
    });
    // ─── fileSearch ────────────────────────────────────────────────────────────
    describe('fileSearch', () => {
        it('finds files matching *.ts pattern', async () => {
            const result = await fileTools.fileSearch({ pattern: '*.ts' });
            expect(result).toContain('index.ts');
            expect(result).toContain('utils.ts');
        });
        it('finds files matching *.md pattern', async () => {
            const result = await fileTools.fileSearch({ pattern: '*.md' });
            expect(result).toContain('README.md');
        });
        it('returns no files found message for unmatched pattern', async () => {
            const result = await fileTools.fileSearch({ pattern: '*.xyz' });
            expect(result).toBe('No files found');
        });
    });
    // ─── fileGrep ──────────────────────────────────────────────────────────────
    describe('fileGrep', () => {
        it('finds matches across files', async () => {
            const result = await fileTools.fileGrep({ pattern: 'export' });
            expect(result).toContain('index.ts');
        });
        it('includes line numbers in results', async () => {
            const result = await fileTools.fileGrep({ pattern: 'hello' });
            expect(result).toMatch(/:\d+:/); // contains ":linenum:"
        });
        it('limits search to a specific path', async () => {
            const result = await fileTools.fileGrep({ pattern: 'require', path: 'lib' });
            expect(result).toContain('helpers.js');
        });
        it('returns no matches message when nothing found', async () => {
            const result = await fileTools.fileGrep({ pattern: 'NONEXISTENT_UNIQUE_STRING_XYZ' });
            expect(result).toBe('No matches found');
        });
    });
    // ─── fileTree ──────────────────────────────────────────────────────────────
    describe('fileTree', () => {
        it('renders a tree of the project root', async () => {
            const result = await fileTools.fileTree({});
            expect(result).toContain('src');
            expect(result).toContain('lib');
        });
        it('renders tree for a subdirectory', async () => {
            const result = await fileTools.fileTree({ path: 'src' });
            expect(result).toContain('index.ts');
        });
        it('respects depth limit', async () => {
            const result = await fileTools.fileTree({ depth: 1 });
            // At depth 1, only top-level entries show; files inside src should NOT appear
            expect(result).toContain('src');
            expect(result).not.toContain('index.ts');
        });
    });
});
//# sourceMappingURL=file-tools.test.js.map