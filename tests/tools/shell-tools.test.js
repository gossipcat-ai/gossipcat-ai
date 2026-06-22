"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("@gossip/tools");
describe('ShellTools', () => {
    const shell = new tools_1.ShellTools();
    it('executes allowed command', async () => {
        const result = await shell.shellExec({ command: 'echo hello' });
        expect(result).toContain('hello');
    });
    it('blocks disallowed command', async () => {
        await expect(shell.shellExec({ command: 'curl http://evil.com' }))
            .rejects.toThrow('not in the allowed commands list');
    });
    it('blocks rm -rf', async () => {
        await expect(shell.shellExec({ command: 'rm -rf /' }))
            .rejects.toThrow(/not in the allowed|blocked by safety/);
    });
    it('enforces timeout', async () => {
        // node is in the allowlist; sleep was removed (DoS vector)
        const result = await shell.shellExec({ command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], timeout: 100 });
        expect(result).toContain('timed out');
    }, 5000);
    it('blocks unknown commands', async () => {
        await expect(shell.shellExec({ command: 'python3 --version' }))
            .rejects.toThrow('not in the allowed commands list');
    });
    it('blocks git push --force', async () => {
        await expect(shell.shellExec({ command: 'git push --force' }))
            .rejects.toThrow('blocked by safety rules');
    });
    it('blocks git reset --hard', async () => {
        await expect(shell.shellExec({ command: 'git reset --hard HEAD' }))
            .rejects.toThrow('blocked by safety rules');
    });
    it('returns stdout from successful commands', async () => {
        const result = await shell.shellExec({ command: 'echo test output' });
        expect(result.trim()).toBe('test output');
    });
    it('blocks semicolon injection attempts via pattern matching', async () => {
        // Even though execFile would not interpret semicolons as shell metacharacters,
        // the command string contains "rm -rf" which is blocked by safety patterns.
        await expect(shell.shellExec({ command: 'echo hello; rm -rf /' }))
            .rejects.toThrow('blocked by safety rules');
    });
    it('executes echo with semicolons when no blocked patterns present', async () => {
        // When the command has no blocked patterns, execFile treats all args literally
        // "echo" is called with args: ["hello;", "world"]
        const result = await shell.shellExec({ command: 'echo hello; world' });
        expect(result).toContain('hello');
        expect(result).toContain(';');
    });
    it('runs ls command', async () => {
        const result = await shell.shellExec({ command: 'ls /tmp' });
        expect(typeof result).toBe('string');
    });
    it('uses custom cwd', async () => {
        const result = await shell.shellExec({ command: 'pwd', cwd: '/tmp' });
        expect(result.trim()).toContain('/tmp');
    });
});
//# sourceMappingURL=shell-tools.test.js.map