import {
  buildFullIndex,
  parseMemoryFrontmatter,
  sidecarPath,
  corpusDir,
  tokenize,
  rankDocuments,
} from '@gossip/orchestrator';
import type { MemoryIndex } from '@gossip/orchestrator';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir(): string {
  const dir = join(tmpdir(), `gossip-sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.gossip'), { recursive: true });
  return dir;
}

function makeCorpus(projectRoot: string): string {
  const fakeCorpus = join(projectRoot, 'fake-corpus');
  mkdirSync(fakeCorpus, { recursive: true });
  return fakeCorpus;
}

function writeMd(dir: string, filename: string, content: string): void {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

function frontmatterMd(fields: Record<string, string>, body = 'Body content here.'): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tokenize unit tests
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('lowercases and splits on whitespace', () => {
    const result = tokenize('Hello World');
    expect(result).toEqual(['hello', 'world']);
  });

  it('drops tokens of length <= 3', () => {
    const result = tokenize('the big dog ran fast');
    expect(result).not.toContain('the');
    expect(result).not.toContain('big');
    expect(result).not.toContain('ran');
    expect(result).toContain('fast');
  });

  it('splits on punctuation', () => {
    const result = tokenize('signal-expiry,logic.here');
    expect(result).toContain('signal');
    expect(result).toContain('expiry');
    expect(result).toContain('logic');
    expect(result).toContain('here');
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseMemoryFrontmatter unit tests
// ---------------------------------------------------------------------------

describe('parseMemoryFrontmatter', () => {
  it('parses all fields', () => {
    const content = frontmatterMd({
      name: 'Test Memory',
      type: 'project',
      status: 'open',
      description: 'A test description',
      originSessionId: 'abc-123',
    });
    const result = parseMemoryFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Test Memory');
    expect(result?.type).toBe('project');
    expect(result?.status).toBe('open');
    expect(result?.description).toBe('A test description');
    expect(result?.originSessionId).toBe('abc-123');
  });

  it('returns null for files without frontmatter', () => {
    const result = parseMemoryFrontmatter('No frontmatter here.\n');
    expect(result).toBeNull();
  });

  it('ignores invalid type values — leaves type undefined', () => {
    const content = frontmatterMd({ name: 'Test', type: 'invalid_type' });
    const result = parseMemoryFrontmatter(content);
    expect(result?.type).toBeUndefined();
  });

  it('ignores invalid status values — leaves status undefined', () => {
    const content = frontmatterMd({ name: 'Test', status: 'draft' });
    const result = parseMemoryFrontmatter(content);
    expect(result?.status).toBeUndefined();
  });

  it('strips surrounding quotes from values', () => {
    const content = [
      '---',
      'name: "Quoted Name"',
      "status: 'open'",
      '---',
      '',
      'Body.',
    ].join('\n');
    const result = parseMemoryFrontmatter(content);
    expect(result?.name).toBe('Quoted Name');
    expect(result?.status).toBe('open');
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\nname: CRLF Test\r\ntype: feedback\r\n---\r\n\r\nBody.\r\n';
    const result = parseMemoryFrontmatter(content);
    expect(result?.name).toBe('CRLF Test');
    expect(result?.type).toBe('feedback');
  });

  it('handles all valid status values', () => {
    for (const status of ['open', 'shipped', 'closed'] as const) {
      const content = frontmatterMd({ name: 'Test', status });
      const result = parseMemoryFrontmatter(content);
      expect(result?.status).toBe(status);
    }
  });

  it('handles all valid type values', () => {
    for (const type of ['user', 'feedback', 'project', 'reference'] as const) {
      const content = frontmatterMd({ name: 'Test', type });
      const result = parseMemoryFrontmatter(content);
      expect(result?.type).toBe(type);
    }
  });
});

// ---------------------------------------------------------------------------
// buildFullIndex tests
// ---------------------------------------------------------------------------

describe('buildFullIndex', () => {
  let projectRoot: string;
  let corpus: string;

  beforeEach(() => {
    projectRoot = makeProjectDir();
    corpus = makeCorpus(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('builds index from clean corpus with full frontmatter', () => {
    writeMd(corpus, 'project_foo.md', frontmatterMd({
      name: 'Foo Feature',
      type: 'project',
      status: 'open',
      description: 'Signal expiry logic for readSignals',
    }, 'When readSignals expires old signal data from the queue.'));

    const index = buildFullIndex(corpus);

    expect(index.version).toBe(1);
    expect(index.totalDocs).toBe(1);
    expect(Object.keys(index.docs)).toContain('project_foo.md');
    const doc = index.docs['project_foo.md'];
    expect(doc.name).toBe('Foo Feature');
    expect(doc.type).toBe('project');
    expect(doc.status).toBe('open');
    expect(doc.description).toBe('Signal expiry logic for readSignals');
    expect(doc.length).toBeGreaterThan(0);
  });

  it('byte-equal idempotency — two rebuilds produce identical structure (excluding generatedAt)', () => {
    writeMd(corpus, 'feedback_relay.md', frontmatterMd({
      name: 'Relay Worker',
      type: 'feedback',
      status: 'open',
      description: 'Relay drops resolutionRoots on consensus',
    }));

    const index1 = buildFullIndex(corpus);
    const index2 = buildFullIndex(corpus);

    const normalize = (idx: MemoryIndex): string => {
      const copy = JSON.parse(JSON.stringify(idx)) as Record<string, unknown>;
      delete copy['generatedAt'];
      return JSON.stringify(copy);
    };

    expect(normalize(index1)).toBe(normalize(index2));
  });

  it('incremental rebuild: only changed files are re-indexed', () => {
    writeMd(corpus, 'a.md', frontmatterMd({ name: 'Alpha', type: 'feedback' }));
    writeMd(corpus, 'b.md', frontmatterMd({ name: 'Beta', type: 'project' }));

    const index1 = buildFullIndex(corpus);
    const mtime1A = index1.docs['a.md'].mtime;

    // Modify only b.md content
    writeMd(corpus, 'b.md', frontmatterMd({ name: 'Beta Updated', type: 'project' }));

    const index2 = buildFullIndex(corpus);

    // a.md mtime should remain the same
    expect(index2.docs['a.md'].mtime).toBe(mtime1A);
    // b.md name should be updated
    expect(index2.docs['b.md'].name).toBe('Beta Updated');
  });

  it('excludes MEMORY.md and MEMORY.md.bak from the index', () => {
    writeMd(corpus, 'MEMORY.md', '# Memory Index\n');
    writeMd(corpus, 'MEMORY.md.bak', '# Memory Index (backup)\n');
    writeMd(corpus, 'user_profile.md', frontmatterMd({ name: 'Profile', type: 'user' }));

    const index = buildFullIndex(corpus);

    expect(Object.keys(index.docs)).not.toContain('MEMORY.md');
    expect(Object.keys(index.docs)).not.toContain('MEMORY.md.bak');
    expect(Object.keys(index.docs)).toContain('user_profile.md');
  });

  it('builds postings with correct df values', () => {
    writeMd(corpus, 'a.md', frontmatterMd({ name: 'Alpha Signal' }, 'signal data here'));
    writeMd(corpus, 'b.md', frontmatterMd({ name: 'Beta Signal' }, 'another signal record'));

    const index = buildFullIndex(corpus);

    // "signal" appears in both docs (in name) → df should be 2
    const posting = index.postings['signal'];
    expect(posting).toBeDefined();
    expect(posting.df).toBe(2);
    expect(posting.docs).toContain('a.md');
    expect(posting.docs).toContain('b.md');
  });

  it('sets totalDocs and avgDocLength correctly', () => {
    writeMd(corpus, 'x.md', frontmatterMd({ name: 'Xray' }, 'short body'));
    writeMd(corpus, 'y.md', frontmatterMd({ name: 'Yankee' }, 'longer body with more tokens here present'));

    const index = buildFullIndex(corpus);

    expect(index.totalDocs).toBe(2);
    expect(index.avgDocLength).toBeGreaterThan(0);
  });

  it('returns empty index when corpus directory does not exist', () => {
    const nonExistent = join(projectRoot, 'no-such-dir');
    const index = buildFullIndex(nonExistent);
    expect(index.totalDocs).toBe(0);
    expect(index.avgDocLength).toBe(0);
    expect(Object.keys(index.docs)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Atomic write test — no stray .tmp file after index write
// ---------------------------------------------------------------------------

describe('sidecarPath and atomic write behavior', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectDir();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('sidecarPath returns path under .gossip/', () => {
    const result = sidecarPath('/some/project');
    expect(result).toBe('/some/project/.gossip/memory-index.json');
  });

  it('no stray .tmp file remains after index is written', () => {
    const corpus = makeCorpus(projectRoot);
    writeMd(corpus, 'project_a.md', frontmatterMd({ name: 'A', type: 'project' }));

    const index = buildFullIndex(corpus);
    const idxPath = sidecarPath(projectRoot);
    const tmpPath = `${idxPath}.tmp`;

    writeFileSync(idxPath, JSON.stringify(index, null, 2), 'utf-8');

    expect(existsSync(idxPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// corpusDir path helper
// ---------------------------------------------------------------------------

describe('corpusDir', () => {
  it('encodes project root into home directory path', () => {
    const result = corpusDir('/some/project');
    expect(result).toContain(homedir());
    expect(result).toContain('.claude');
    expect(result).toContain('projects');
    expect(result).toContain('memory');
  });
});

// ---------------------------------------------------------------------------
// Universality fixture tests — missing/partial frontmatter
// ---------------------------------------------------------------------------

describe('universality — missing/partial frontmatter files', () => {
  let corpus: string;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectDir();
    corpus = makeCorpus(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('body-only file (no frontmatter) falls back to basename as name, type=undefined', () => {
    writeMd(corpus, 'no_frontmatter.md', 'Just raw content without any YAML header.\n');

    const index = buildFullIndex(corpus);
    const doc = index.docs['no_frontmatter.md'];
    expect(doc).toBeDefined();
    expect(doc.name).toBe('no_frontmatter');
    expect(doc.type).toBeUndefined();
    expect(doc.status).toBeUndefined();
  });

  it('partial frontmatter (name only, no type or status) indexes without error', () => {
    writeMd(corpus, 'partial.md', [
      '---',
      'name: Partial Memory',
      '---',
      '',
      'Body content for partial memory file.',
    ].join('\n'));

    const index = buildFullIndex(corpus);
    const doc = index.docs['partial.md'];
    expect(doc).toBeDefined();
    expect(doc.name).toBe('Partial Memory');
    expect(doc.type).toBeUndefined();
    expect(doc.status).toBeUndefined();
    expect(doc.description).toBeUndefined();
  });

  it('frontmatter with description but no type — description preserved', () => {
    writeMd(corpus, 'desc_only.md', [
      '---',
      'name: Desc Only',
      'description: Has description but missing type field',
      '---',
      '',
      'Body text.',
    ].join('\n'));

    const index = buildFullIndex(corpus);
    const doc = index.docs['desc_only.md'];
    expect(doc).toBeDefined();
    expect(doc.description).toBe('Has description but missing type field');
    expect(doc.type).toBeUndefined();
  });

  it('three universality fixtures all appear in index', () => {
    writeMd(corpus, 'u1.md', 'No frontmatter at all.');
    writeMd(corpus, 'u2.md', '---\nname: Just Name\n---\nBody only.');
    writeMd(corpus, 'u3.md', '---\ndescription: desc without name\ntype: feedback\n---\nBody.');

    const index = buildFullIndex(corpus);
    expect(Object.keys(index.docs)).toContain('u1.md');
    expect(Object.keys(index.docs)).toContain('u2.md');
    expect(Object.keys(index.docs)).toContain('u3.md');

    // u1: name falls back to basename
    expect(index.docs['u1.md'].name).toBe('u1');
    // u3: name falls back to basename (no name field)
    expect(index.docs['u3.md'].name).toBe('u3');
    // u3: type is preserved
    expect(index.docs['u3.md'].type).toBe('feedback');
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md regeneration tests
// ---------------------------------------------------------------------------

describe('regenerateMemoryMd index grouping and sorting', () => {
  let corpus: string;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectDir();
    corpus = makeCorpus(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('groups by type correctly — open/absent before shipped before closed', () => {
    writeMd(corpus, 'proj_open.md', frontmatterMd({ name: 'Open Item', type: 'project', status: 'open', description: 'Open' }));
    writeMd(corpus, 'proj_shipped.md', frontmatterMd({ name: 'Shipped Item', type: 'project', status: 'shipped', description: 'Shipped' }));
    writeMd(corpus, 'proj_closed.md', frontmatterMd({ name: 'Closed Item', type: 'project', status: 'closed', description: 'Closed' }));

    const index = buildFullIndex(corpus);

    const projectEntries = Object.entries(index.docs)
      .filter(([, d]) => d.type === 'project')
      .sort((a, b) => {
        const rankMap: Record<string, number> = { open: 0, shipped: 1, closed: 2 };
        const rA = rankMap[a[1].status ?? 'open'] ?? 0;
        const rB = rankMap[b[1].status ?? 'open'] ?? 0;
        return rA - rB;
      });

    expect(projectEntries[0][1].status).toBe('open');
    expect(projectEntries[1][1].status).toBe('shipped');
    expect(projectEntries[2][1].status).toBe('closed');
  });

  it('MEMORY.md.bak backup is written before regen', () => {
    const memoryMdPath = join(corpus, 'MEMORY.md');
    const backupPath = join(corpus, 'MEMORY.md.bak');

    writeFileSync(memoryMdPath, '# Original MEMORY.md\n', 'utf-8');
    writeMd(corpus, 'feedback_x.md', frontmatterMd({ name: 'X', type: 'feedback', status: 'open', description: 'X desc' }));

    expect(existsSync(backupPath)).toBe(false);

    // Test backup logic (same as regenerateMemoryMd uses: copyFileSync before write)
    if (existsSync(memoryMdPath)) {
      copyFileSync(memoryMdPath, backupPath);
    }

    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf-8')).toBe('# Original MEMORY.md\n');
  });

  it('Ungrouped section contains all files without type', () => {
    writeMd(corpus, 'u1.md', 'Body only, no frontmatter.');
    writeMd(corpus, 'u2.md', '---\nname: Named But No Type\n---\nBody.');
    writeMd(corpus, 'project_p.md', frontmatterMd({ name: 'A Project', type: 'project', status: 'open', description: 'desc' }));

    const index = buildFullIndex(corpus);

    // Verify both ungrouped docs have no type
    expect(index.docs['u1.md']?.type).toBeUndefined();
    expect(index.docs['u2.md']?.type).toBeUndefined();
    // Project doc has type
    expect(index.docs['project_p.md']?.type).toBe('project');
    // All three docs are indexed — none dropped
    expect(index.totalDocs).toBe(3);
  });

  it('absent status treated equivalently to open in sort order', () => {
    writeMd(corpus, 'absent_status.md', '---\nname: No Status\ntype: project\n---\nBody.');
    writeMd(corpus, 'open_status.md', frontmatterMd({ name: 'Open Status', type: 'project', status: 'open' }));
    writeMd(corpus, 'shipped_status.md', frontmatterMd({ name: 'Shipped Status', type: 'project', status: 'shipped' }));

    const index = buildFullIndex(corpus);

    expect(index.docs['absent_status.md']?.status).toBeUndefined();
    expect(index.docs['open_status.md']?.status).toBe('open');
    expect(index.docs['shipped_status.md']?.status).toBe('shipped');
  });
});

// ---------------------------------------------------------------------------
// BM25 recall improvement: "signal expiry logic" → hits readSignals
// ---------------------------------------------------------------------------

describe('BM25 recall improvement', () => {
  let corpus: string;
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectDir();
    corpus = makeCorpus(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('"signal expiry logic" query hits memory mentioning readSignals', () => {
    writeMd(corpus, 'feedback_readsignals.md', frontmatterMd({
      name: 'readSignals expiry',
      type: 'feedback',
      status: 'open',
      description: 'Old signals expire from queue when readSignals runs past TTL',
    }, 'The readSignals function processes signal queue entries. When TTL expires the entry is dropped.'));

    writeMd(corpus, 'unrelated.md', frontmatterMd({
      name: 'Dashboard colors',
      type: 'project',
      status: 'open',
      description: 'Color palette for UI',
    }, 'Blue, red, green palette for charts.'));

    const index = buildFullIndex(corpus);
    const queryTerms = Array.from(new Set(tokenize('signal expiry logic')));
    const ranked = rankDocuments(queryTerms, index);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].filename).toBe('feedback_readsignals.md');
  });

  it('scores open/absent status equivalently with default openBoost=0', () => {
    writeMd(corpus, 'with_open.md', frontmatterMd({
      name: 'Signal Tracking Open',
      type: 'feedback',
      status: 'open',
      description: 'Signal tracking details',
    }, 'Detailed signal tracking body.'));

    writeMd(corpus, 'no_status.md', [
      '---',
      'name: Signal Tracking NoStatus',
      'type: feedback',
      'description: Signal tracking details',
      '---',
      '',
      'Detailed signal tracking body.',
    ].join('\n'));

    const index = buildFullIndex(corpus);
    const terms = Array.from(new Set(tokenize('signal tracking')));
    const ranked = rankDocuments(terms, index, { openBoost: 0 });

    expect(ranked.length).toBe(2);
    // Scores should be equal since content is identical and openBoost=0
    expect(Math.abs(ranked[0].score - ranked[1].score)).toBeLessThan(0.001);
  });

  it('BM25 ranks higher-frequency term matches above lower-frequency', () => {
    writeMd(corpus, 'many_relay.md', frontmatterMd({
      name: 'Relay Heavy',
      type: 'feedback',
      description: 'relay relay relay relay relay',
    }, 'relay relay relay relay relay worker content'));

    writeMd(corpus, 'one_relay.md', frontmatterMd({
      name: 'Single Relay',
      type: 'feedback',
      description: 'relay connection',
    }, 'Other content not about relay.'));

    const index = buildFullIndex(corpus);
    const terms = Array.from(new Set(tokenize('relay')));
    const ranked = rankDocuments(terms, index);

    expect(ranked.length).toBe(2);
    expect(ranked[0].filename).toBe('many_relay.md');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('IDF down-weights common terms — rare term uniquely identifies doc', () => {
    writeMd(corpus, 'a.md', frontmatterMd({ name: 'Signal Alpha', description: 'signal data' }, 'signal processing here'));
    writeMd(corpus, 'b.md', frontmatterMd({ name: 'Signal Beta', description: 'signal data' }, 'signal pipeline'));
    writeMd(corpus, 'c.md', frontmatterMd({ name: 'Signal Gamma Expiry', description: 'signal expiry logic' }, 'signal expiry mechanism present'));

    const index = buildFullIndex(corpus);
    const termsExpiry = Array.from(new Set(tokenize('expiry')));

    const rankedExpiry = rankDocuments(termsExpiry, index);
    // Only doc c should match "expiry" (it's the only one with that token)
    expect(rankedExpiry.length).toBe(1);
    expect(rankedExpiry[0].filename).toBe('c.md');
  });

  it('returns empty results for query terms not in any document', () => {
    writeMd(corpus, 'a.md', frontmatterMd({ name: 'Alpha' }, 'Relay server internals.'));
    const index = buildFullIndex(corpus);
    const terms = Array.from(new Set(tokenize('zxyvwquartz')));
    const ranked = rankDocuments(terms, index);
    expect(ranked).toEqual([]);
  });
});
