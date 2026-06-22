import { FileTools, Sandbox, MAX_GREP_FILE_BYTES, MAX_GREP_MATCHES, MAX_GREP_FILES } from '@gossip/tools';
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

      // (a) File with > MAX_GREP_MATCHES matching lines — produces cap+1 lines, each matching /^LINE/
      const manyLines = Array.from({ length: MAX_GREP_MATCHES + 1 }, (_, i) => `LINE${i}`).join('\n');
      writeFileSync(resolve(capDir, 'data/many-lines.txt'), manyLines);

      // (b) File larger than MAX_GREP_FILE_BYTES — should be skipped entirely.
      // Write exactly MAX_GREP_FILE_BYTES + 1 bytes of 'x' characters.
      const bigContent = 'x'.repeat(MAX_GREP_FILE_BYTES + 1);
      writeFileSync(resolve(capDir, 'data/big-file.txt'), bigContent);

      // Under-size companion: exactly MAX_GREP_FILE_BYTES - 1 bytes, all 'x'.
      // grepDir MUST scan this file (size is under cap) and match the ^x+$ pattern.
      const underContent = 'x'.repeat(MAX_GREP_FILE_BYTES - 1);
      writeFileSync(resolve(capDir, 'data/under-size.txt'), underContent);

      // Small file that IS readable — presence proves big-file was skipped, not the walk
      writeFileSync(resolve(capDir, 'data/small-match.txt'), 'MARKER_LINE\n');

      capSandbox = new Sandbox(capDir);
      capTools = new FileTools(capSandbox);
    }, 30_000);

    afterAll(() => {
      try {
        const { rmSync } = require('fs');
        rmSync(capDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    it('(a) caps total matches at MAX_GREP_MATCHES and appends truncation notice', async () => {
      // Pattern matches every LINE in many-lines.txt (cap+1 lines > cap)
      const result = await capTools.fileGrep({ pattern: '^LINE' });
      const lines = result.split('\n');
      // Last line should be the truncation notice
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toContain('truncated');
      // Exactly MAX_GREP_MATCHES match lines + 1 notice line
      expect(lines).toHaveLength(MAX_GREP_MATCHES + 1);
    });

    it('(b-under) under-size all-x file IS scanned and matched', async () => {
      // under-size.txt is under the 2 MiB threshold and contains only 'x' chars on one line.
      // Search the containing directory — grepDir must scan the file and match ^x+$.
      // This proves the pattern works on that content (i.e., size is the only gate).
      const result = await capTools.fileGrep({ pattern: '^x+$', path: 'data' });
      expect(result).toContain('under-size.txt');
      expect(result).not.toContain('truncated');
    });

    it('(b-over) over-size file is skipped — same pattern in data dir produces no match for big-file', async () => {
      // big-file.txt is > MAX_GREP_FILE_BYTES so grepDir skips it — it must NOT appear.
      // under-size.txt would match too, so we use a pattern unique to big-file content
      // that cannot appear in the small files (impossible: both are all 'x' content).
      // Instead, isolate via a dedicated directory containing only big-file.txt.
      const bigOnlyDir = resolve(capDir, 'bigonly');
      mkdirSync(bigOnlyDir, { recursive: true });
      const bigOnlyContent = 'x'.repeat(MAX_GREP_FILE_BYTES + 1);
      writeFileSync(resolve(bigOnlyDir, 'big-only.txt'), bigOnlyContent);
      const bigOnlySandbox = new Sandbox(bigOnlyDir);
      const bigOnlyTools = new FileTools(bigOnlySandbox);
      // Pattern ^x+$ would match if the file were read — but it's skipped due to size.
      const result = await bigOnlyTools.fileGrep({ pattern: '^x+$' });
      expect(result).toBe('No matches found');
    }, 10_000);

    it('(b-walk) size-skip does not break the broader walk', async () => {
      // big-file.txt is in the same dir as small-match.txt; skipping it must not
      // abort the walk — MARKER_LINE in small-match.txt must still be found.
      const result = await capTools.fileGrep({ pattern: 'MARKER_LINE' });
      expect(result).toContain('MARKER_LINE');
    });

    it('(c-false-positive) exactly MAX_GREP_MATCHES real matches with nothing dropped → no truncation notice', async () => {
      // Write a file with exactly MAX_GREP_MATCHES lines matching /^EXACT/.
      // grepDir fills matches to the cap without ever setting truncated.
      // fileGrep must NOT append a truncation notice.
      const exactDir = resolve(capDir, 'exact');
      mkdirSync(exactDir, { recursive: true });
      const exactLines = Array.from({ length: MAX_GREP_MATCHES }, (_, i) => `EXACT${i}`).join('\n');
      writeFileSync(resolve(exactDir, 'exact-cap.txt'), exactLines);
      const exactSandbox = new Sandbox(exactDir);
      const exactTools = new FileTools(exactSandbox);
      const result = await exactTools.fileGrep({ pattern: '^EXACT' });
      const lines = result.split('\n');
      // All MAX_GREP_MATCHES lines returned
      expect(lines).toHaveLength(MAX_GREP_MATCHES);
      // No truncation notice
      const lastLine = lines[lines.length - 1];
      expect(lastLine).not.toContain('truncated');
    }, 30_000);

    it('(d-file-cap) walk aborts when MAX_GREP_FILES tiny files are scanned with no matches', async () => {
      // Create MAX_GREP_FILES + 1 tiny files that match nothing (pattern NOMATCH_SENTINEL).
      // The walk must abort and set truncated before scanning all of them.
      // To keep test fast, use a small sub-cap: export MAX_GREP_FILES is 5000 by default,
      // but we create just over that count. Since creating 5001 files takes ~1-2s, we allow
      // up to 10s for this test.
      const fileCapDir = resolve(capDir, 'filecap');
      mkdirSync(fileCapDir, { recursive: true });
      const count = MAX_GREP_FILES + 1;
      for (let i = 0; i < count; i++) {
        writeFileSync(resolve(fileCapDir, `f${i}.txt`), 'content\n');
      }
      const fileCapSandbox = new Sandbox(fileCapDir);
      const fileCapTools = new FileTools(fileCapSandbox);
      const result = await fileCapTools.fileGrep({ pattern: 'NOMATCH_SENTINEL_XYZ' });
      // No matches found but truncation notice must appear
      expect(result).toContain('truncated');
    }, 30_000);
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
