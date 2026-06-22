import { FileTools, Sandbox } from '@gossip/tools';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

describe('FileTools', () => {
  const testDir = resolve(tmpdir(), 'gossip-file-tools-test-' + Date.now());
  let sandbox: Sandbox;
  let fileTools: FileTools;

  beforeAll(() => {
    mkdirSync(resolve(testDir, 'src'), { recursive: true });
    mkdirSync(resolve(testDir, 'lib'), { recursive: true });
    writeFileSync(resolve(testDir, 'src/index.ts'), 'export const hello = "world";\nexport const foo = 42;\n');
    writeFileSync(resolve(testDir, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
    writeFileSync(resolve(testDir, 'lib/helpers.js'), 'const x = require("./utils");\nmodule.exports = x;\n');
    writeFileSync(resolve(testDir, 'README.md'), '# Test Project\nThis is a test.\n');
    sandbox = new Sandbox(testDir);
    fileTools = new FileTools(sandbox);
  });

  afterAll(() => {
    try {
      const { rmSync } = require('fs');
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
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
      expect(existsSync(resolve(testDir, 'src/new-file.ts'))).toBe(true);
    });

    it('creates parent directories as needed', async () => {
      const result = await fileTools.fileWrite({
        path: 'new-dir/sub/file.ts',
        content: 'export {};\n'
      });
      expect(result).toContain('Written');
      expect(existsSync(resolve(testDir, 'new-dir/sub/file.ts'))).toBe(true);
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

  // ─── fileSearch — resolutionRoots ranking ─────────────────────────────────
  // Two sandbox.ts files exist in the real repo (packages/tools + apps/cli).
  // Cross-reviewers cite bare filenames; without ranking, fileSearch returns
  // whichever the walk hit first — which for "sandbox.ts" is the wrong one
  // (utility vs. main sandbox). Ranking must prefer matches under an
  // effectiveRoots entry, then under projectRoot, then deterministic order.
  describe('fileSearch — resolutionRoots ranking', () => {
    const rankDir = resolve(tmpdir(), 'gossip-file-tools-rank-' + Date.now());
    const outsideDir = resolve(tmpdir(), 'gossip-file-tools-outside-' + Date.now());
    let rankSandbox: Sandbox;
    let rankTools: FileTools;

    beforeAll(() => {
      mkdirSync(resolve(rankDir, 'packages/tools/src'), { recursive: true });
      mkdirSync(resolve(rankDir, 'apps/cli/src'), { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(resolve(rankDir, 'packages/tools/src/sandbox.ts'), '// utility sandbox\n');
      writeFileSync(resolve(rankDir, 'apps/cli/src/sandbox.ts'), '// main sandbox\n');
      writeFileSync(resolve(outsideDir, 'sandbox.ts'), '// outside sandbox\n');
      rankSandbox = new Sandbox(rankDir);
      rankTools = new FileTools(rankSandbox);
    });

    afterAll(() => {
      try {
        const { rmSync } = require('fs');
        rmSync(rankDir, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    it('no resolutionRoots → behavior matches current (first walk hit)', async () => {
      const result = await rankTools.fileSearch({ pattern: 'sandbox.ts' });
      const lines = result.split('\n');
      // Both in-project matches returned; no ranking applied.
      expect(lines).toHaveLength(2);
      expect(lines).toEqual(expect.arrayContaining([
        'apps/cli/src/sandbox.ts',
        'packages/tools/src/sandbox.ts',
      ]));
    });

    it('one candidate inside a resolutionRoot → inside-root wins', async () => {
      const insideRoot = resolve(rankDir, 'apps/cli');
      const result = await rankTools.fileSearch({
        pattern: 'sandbox.ts',
        resolutionRoots: [insideRoot],
      });
      const lines = result.split('\n');
      // apps/cli/src/sandbox.ts must be first — it sits under the root.
      expect(lines[0]).toBe('apps/cli/src/sandbox.ts');
    });

    it('two candidates both inside resolutionRoots → first root wins', async () => {
      const rootA = resolve(rankDir, 'apps/cli');
      const rootB = resolve(rankDir, 'packages/tools');
      const result = await rankTools.fileSearch({
        pattern: 'sandbox.ts',
        resolutionRoots: [rootA, rootB],
      });
      const lines = result.split('\n');
      // Deterministic: the first resolution root takes priority.
      expect(lines[0]).toBe('apps/cli/src/sandbox.ts');
      expect(lines[1]).toBe('packages/tools/src/sandbox.ts');
    });

    it('first root wins is deterministic when order reverses', async () => {
      const rootA = resolve(rankDir, 'packages/tools');
      const rootB = resolve(rankDir, 'apps/cli');
      const result = await rankTools.fileSearch({
        pattern: 'sandbox.ts',
        resolutionRoots: [rootA, rootB],
      });
      const lines = result.split('\n');
      expect(lines[0]).toBe('packages/tools/src/sandbox.ts');
      expect(lines[1]).toBe('apps/cli/src/sandbox.ts');
    });

    it('empty resolutionRoots array behaves like omitted param', async () => {
      const result = await rankTools.fileSearch({ pattern: 'sandbox.ts', resolutionRoots: [] });
      expect(result.split('\n')).toHaveLength(2);
    });

    it('file walked via agentRoot outside projectRoot lands in otherBucket tail', async () => {
      // agentRoot outside projectRoot makes walkDir produce a relPath with
      // `..` segments; resolve(projectRoot, rel) then lands outside
      // projectRoot → otherBucket. With a resolutionRoot pointing inside
      // projectRoot, the otherBucket entry must still appear, at the tail.
      const insideRoot = resolve(rankDir, 'apps/cli');
      const result = await rankTools.fileSearch(
        { pattern: 'sandbox.ts', resolutionRoots: [insideRoot] },
        outsideDir, // agentRoot outside projectRoot
      );
      const lines = result.split('\n');
      // The outside sandbox.ts was walked; it is neither under insideRoot
      // nor under projectRoot, so it must land in otherBucket (tail).
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const tail = lines[lines.length - 1];
      // Relative path from projectRoot to outsideDir/sandbox.ts starts with '..'
      expect(tail.startsWith('..')).toBe(true);
      expect(tail).toContain('sandbox.ts');
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

  // ─── fileGrep — resource exhaustion caps ──────────────────────────────────

  describe('fileGrep — resource exhaustion caps', () => {
    const capDir = resolve(tmpdir(), 'gossip-file-tools-cap-' + Date.now());
    let capSandbox: Sandbox;
    let capTools: FileTools;

    beforeAll(() => {
      mkdirSync(resolve(capDir, 'data'), { recursive: true });

      // (a) File with > 2000 matching lines — produces 2001 lines, each matching /^LINE/
      const manyLines = Array.from({ length: 2001 }, (_, i) => `LINE${i}`).join('\n');
      writeFileSync(resolve(capDir, 'data/many-lines.txt'), manyLines);

      // (b) File larger than 2 MiB (2 * 1024 * 1024 bytes) — should be skipped entirely
      // Write 2 MiB + 1 byte of data. Each char = 1 byte for ASCII.
      const bigContent = 'x'.repeat(2 * 1024 * 1024 + 1);
      writeFileSync(resolve(capDir, 'data/big-file.txt'), bigContent);

      // Small file that IS readable — presence proves big-file was skipped, not the walk
      writeFileSync(resolve(capDir, 'data/small-match.txt'), 'MARKER_LINE\n');

      capSandbox = new Sandbox(capDir);
      capTools = new FileTools(capSandbox);
    });

    afterAll(() => {
      try {
        const { rmSync } = require('fs');
        rmSync(capDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    it('(a) caps total matches at MAX_GREP_MATCHES and appends truncation notice', async () => {
      // Pattern matches every LINE in many-lines.txt (2001 lines > 2000 cap)
      const result = await capTools.fileGrep({ pattern: '^LINE' });
      const lines = result.split('\n');
      // Last line should be the truncation notice
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toContain('truncated at 2000 matches');
      // Exactly 2000 match lines + 1 notice line
      expect(lines).toHaveLength(2001);
    });

    it('(b) skips files larger than MAX_GREP_FILE_BYTES', async () => {
      // big-file.txt contains 'x' chars — pattern 'x' would match if not skipped
      // small-match.txt contains MARKER_LINE which also has 'x' chars — but we
      // use a pattern unique to small-match.txt to confirm the walk still works
      const result = await capTools.fileGrep({ pattern: 'MARKER_LINE' });
      expect(result).toContain('MARKER_LINE');
      // big-file.txt has no MARKER_LINE, so this is mostly confirming the skip
      // behavior doesn't break the overall walk. To directly verify the skip,
      // search for 'x' (present in big-file only) — should be 'No matches found'
      // because big-file is skipped and small-match.txt has no bare 'x' line.
      const bigResult = await capTools.fileGrep({ pattern: '^x+$', path: 'data/big-file.txt' });
      // big-file.txt is > 2 MiB so grepDir skips it — no matches
      expect(bigResult).toBe('No matches found');
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
