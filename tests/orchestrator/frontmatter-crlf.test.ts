import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// A file checked out on Windows has CRLF: no frontmatter pattern may need a bare \n.
it('every frontmatter pattern accepts CRLF', () => {
  const needle = '/^---' + String.fromCharCode(92) + 'n';
  const files = execSync('git ls-files packages apps', { encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.ts'));
  const bare = files.flatMap(f =>
    readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.includes(needle)).map(l => `${f}: ${l.trim()}`),
  );
  expect(bare).toEqual([]);
});
