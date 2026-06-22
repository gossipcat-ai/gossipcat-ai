import { Sandbox } from '@gossip/tools';
import { mkdirSync, writeFileSync, symlinkSync, unlinkSync, existsSync, realpathSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

describe('Sandbox', () => {
  const testDir = resolve(tmpdir(), 'gossip-sandbox-test-' + Date.now());
  let sandbox: Sandbox;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    writeFileSync(resolve(testDir, 'src/index.ts'), 'hello');
    sandbox = new Sandbox(testDir);
  });

  afterAll(() => {
    try {
      const { rmSync } = require('fs');
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('allows paths within project root', () => {
    const result = sandbox.validatePath('src/index.ts');
    // Use realpathSync to handle macOS /var -> /private/var symlink
    const realTestDir = realpathSync(testDir);
    expect(result).toBe(resolve(realTestDir, 'src/index.ts'));
  });

  it('allows file_write to non-existent path within root', () => {
    const result = sandbox.validatePath('src/new-file.ts');
    const realTestDir = realpathSync(testDir);
    expect(result).toBe(resolve(realTestDir, 'src/new-file.ts'));
  });

  it('allows access to project root itself', () => {
    const result = sandbox.validatePath('.');
    const realTestDir = realpathSync(testDir);
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
    const linkPath = resolve(testDir, 'escape-link');
    try {
      symlinkSync('/etc', linkPath);
      expect(() => sandbox.validatePath('escape-link/passwd')).toThrow('outside project root');
    } finally {
      if (existsSync(linkPath)) unlinkSync(linkPath);
    }
  });

  it('exposes projectRoot', () => {
    const realTestDir = realpathSync(testDir);
    expect(sandbox.projectRoot).toBe(realTestDir);
  });
});
