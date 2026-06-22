import { MemorySearcher, buildFullIndex, tokenize as bm25Tokenize, rankDocuments, corpusDir } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const makeDir = () => join(tmpdir(), `gossip-searcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setupAgent(testDir: string, agentId: string): { memDir: string; knowledgeDir: string } {
  const memDir = join(testDir, '.gossip', 'agents', agentId, 'memory');
  const knowledgeDir = join(memDir, 'knowledge');
  mkdirSync(knowledgeDir, { recursive: true });
  return { memDir, knowledgeDir };
}

describe('MemorySearcher', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns results sorted by relevance score descending', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    writeFileSync(join(knowledgeDir, 'relay.md'), [
      '---',
      'name: relay server',
      'description: relay server internals and connection handling',
      'importance: 0.8',
      'lastAccessed: 2026-03-21',
      'accessCount: 5',
      '---',
      '',
      'The relay server manages websocket connections.',
      'Each relay connection uses a unique frame ID.',
    ].join('\n'));

    writeFileSync(join(knowledgeDir, 'dispatch.md'), [
      '---',
      'name: dispatch pipeline',
      'description: task dispatch and agent selection',
      'importance: 0.6',
      'lastAccessed: 2026-03-20',
      'accessCount: 2',
      '---',
      '',
      'The dispatch pipeline routes tasks to agents.',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay server connection');

    expect(results.length).toBeGreaterThan(0);
    // relay.md should rank higher — more keyword matches
    expect(results[0].name).toBe('relay server');
    // scores should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('returns empty array for empty query', () => {
    setupAgent(testDir, 'agent1');
    const searcher = new MemorySearcher(testDir);
    expect(searcher.search('agent1', '')).toEqual([]);
    expect(searcher.search('agent1', '   ')).toEqual([]);
  });

  it('returns empty array for unknown agent', () => {
    const searcher = new MemorySearcher(testDir);
    expect(searcher.search('nonexistent-agent', 'relay connection')).toEqual([]);
  });

  it('snippets contain the matching keyword', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    writeFileSync(join(knowledgeDir, 'auth.md'), [
      '---',
      'name: authentication',
      'description: auth token validation',
      'importance: 0.7',
      'lastAccessed: 2026-03-21',
      'accessCount: 3',
      '---',
      '',
      'Token validation uses HMAC signatures.',
      'Invalid tokens are rejected immediately.',
      'Session cookies store the token after login.',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'token validation');

    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    expect(result.snippets.length).toBeGreaterThan(0);
    // At least one snippet should contain "token" or "validation"
    const hasKeyword = result.snippets.some(s =>
      s.toLowerCase().includes('token') || s.toLowerCase().includes('valid')
    );
    expect(hasKeyword).toBe(true);
  });

  it('tasks.jsonl entries are searchable', () => {
    const { memDir } = setupAgent(testDir, 'agent1');

    const entries = [
      { taskId: 'task-1', task: 'Review the relay server authentication code', skills: ['security', 'relay'] },
      { taskId: 'task-2', task: 'Fix memory compaction bug in knowledge store', skills: ['memory', 'storage'] },
    ];

    writeFileSync(
      join(memDir, 'tasks.jsonl'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'memory compaction knowledge');

    expect(results.length).toBeGreaterThan(0);
    // The memory compaction task should be found
    const found = results.find(r => r.source === 'tasks.jsonl' && r.name === 'task-2');
    expect(found).toBeDefined();
  });

  it('respects max_results limit', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    // Create 5 files all matching the query
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(knowledgeDir, `file${i}.md`), [
        '---',
        `name: relay topic ${i}`,
        'description: relay server internals',
        `importance: ${0.5 + i * 0.1}`,
        'lastAccessed: 2026-03-21',
        'accessCount: 1',
        '---',
        '',
        'relay connection websocket frame',
      ].join('\n'));
    }

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay connection', 2);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('max_results is capped at 10', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    for (let i = 0; i < 15; i++) {
      writeFileSync(join(knowledgeDir, `file${i}.md`), [
        '---',
        `name: relay topic ${i}`,
        'description: relay server connection internals',
        `importance: 0.5`,
        'lastAccessed: 2026-03-21',
        'accessCount: 1',
        '---',
        '',
        'relay connection frame',
      ].join('\n'));
    }

    const searcher = new MemorySearcher(testDir);
    // Pass 20, should be capped at 10
    const results = searcher.search('agent1', 'relay connection', 20);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('returns empty array when query has only short words', () => {
    setupAgent(testDir, 'agent1');
    const searcher = new MemorySearcher(testDir);
    // All words are <= 3 chars, extractKeywords returns []
    expect(searcher.search('agent1', 'the an or')).toEqual([]);
  });

  it('rejects path traversal in agentId', () => {
    setupAgent(testDir, 'agent1');
    const searcher = new MemorySearcher(testDir);
    expect(searcher.search('../../../etc', 'relay connection')).toEqual([]);
    expect(searcher.search('agent1/../../etc', 'relay connection')).toEqual([]);
    expect(searcher.search('', 'relay connection')).toEqual([]);
  });

  it('caps query length at 500 characters', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');
    writeFileSync(join(knowledgeDir, 'test.md'), [
      '---',
      'name: relay server',
      'description: relay connection handling',
      'importance: 0.8',
      '---',
      '',
      'The relay server manages connections.',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    // Very long query should not crash — just gets truncated
    const longQuery = 'relay '.repeat(200);
    const results = searcher.search('agent1', longQuery);
    // Should still find results (keyword "relay" is in first 500 chars)
    expect(results.length).toBeGreaterThan(0);
  });

  it('caps keywords at MAX_KEYWORDS', () => {
    setupAgent(testDir, 'agent1');
    const searcher = new MemorySearcher(testDir);
    // 30 unique words > 3 chars — should be capped
    const manyWords = Array.from({ length: 30 }, (_, i) => `keyword${i}`).join(' ');
    // Should not crash
    const results = searcher.search('agent1', manyWords);
    expect(results).toEqual([]);
  });

  it('clamps importance to [0, 1] range', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    writeFileSync(join(knowledgeDir, 'extreme.md'), [
      '---',
      'name: relay extreme',
      'description: relay internals',
      'importance: 1e308',
      '---',
      '',
      'relay content here',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay content');
    expect(results.length).toBe(1);
    // Score should be finite (importance clamped to 1, not 1e308)
    expect(results[0].score).toBeLessThan(100);
    expect(Number.isFinite(results[0].score)).toBe(true);
  });

  it('handles CRLF frontmatter', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    // Write with CRLF line endings
    writeFileSync(join(knowledgeDir, 'crlf.md'),
      '---\r\nname: relay crlf\r\ndescription: relay with windows newlines\r\nimportance: 0.7\r\n---\r\n\r\nrelay content here\r\n'
    );

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay content');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('relay crlf');
  });

  it('handles importance=0 correctly with nullish coalescing', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    writeFileSync(join(knowledgeDir, 'zero.md'), [
      '---',
      'name: relay zero',
      'description: relay internals',
      'importance: 0',
      '---',
      '',
      'relay content here',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay content');
    // importance=0 should produce score=0 (not fall back to 0.5)
    expect(results).toEqual([]);
  });

  it('importance boosts score — higher importance ranks first', () => {
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    // Both files match "relay" once in description; higher importance should win
    writeFileSync(join(knowledgeDir, 'high.md'), [
      '---',
      'name: relay high',
      'description: relay internals',
      'importance: 0.9',
      'lastAccessed: 2026-03-21',
      'accessCount: 1',
      '---',
      '',
      'content here',
    ].join('\n'));

    writeFileSync(join(knowledgeDir, 'low.md'), [
      '---',
      'name: relay low',
      'description: relay internals',
      'importance: 0.1',
      'lastAccessed: 2026-03-21',
      'accessCount: 1',
      '---',
      '',
      'content here',
    ].join('\n'));

    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay internals');

    expect(results.length).toBe(2);
    expect(results[0].name).toBe('relay high');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

// ---------------------------------------------------------------------------
// BM25 corpus search via _project sentinel
// ---------------------------------------------------------------------------

describe('MemorySearcher BM25 corpus search (_project)', () => {
  // The _project sentinel routes through searchCorpus() → BM25.
  // When the corpus dir doesn't exist, results should be empty (no crash).
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `gossip-bm25-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpRoot, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns empty array when corpus does not exist (no crash)', () => {
    const searcher = new MemorySearcher(tmpRoot);
    const results = searcher.search('_project', 'signal expiry logic');
    expect(results).toEqual([]);
  });

  it('_project route does not require a .gossip/agents/_project/memory dir', () => {
    // No agents dir created — should still return without throwing
    const searcher = new MemorySearcher(tmpRoot);
    expect(() => searcher.search('_project', 'relay connection')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MemorySearcher BM25 sidecar wiring — end-to-end _project corpus search
// ---------------------------------------------------------------------------

describe('MemorySearcher BM25 sidecar wiring (_project end-to-end)', () => {
  // These tests write fixture *.md files to the corpus directory that
  // corpusDir(projectRoot) resolves to (under ~/.claude/projects/<encoded>/memory/).
  // After the test, the corpus dir is cleaned up.
  let tmpRoot: string;
  let corpus: string;

  function fmFmt(fields: Record<string, string>, body = 'Body.'): string {
    const lines = ['---'];
    for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
    lines.push('---', '', body);
    return lines.join('\n') + '\n';
  }

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `gossip-sidecar-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpRoot, '.gossip'), { recursive: true });
    corpus = corpusDir(tmpRoot);
    mkdirSync(corpus, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    try { rmSync(corpus, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('spec failure-mode: "signal expiry" ranks description-match above body-only match', () => {
    // Doc A: frontmatter description mentions "signal" and "expiry" — spec high-rank doc
    writeFileSync(join(corpus, 'feedback_signal_expiry.md'), fmFmt({
      name: 'Signal expiry tracking',
      type: 'feedback',
      status: 'open',
      description: 'Signal expiry window causes stale signals to persist beyond TTL',
    }, 'When a signal expires, the window closes and the next batch proceeds.'));

    // Doc B: only mentions readSignals in body, no "signal" or "expiry" in description
    writeFileSync(join(corpus, 'feedback_readsignals_impl.md'), fmFmt({
      name: 'readSignals implementation detail',
      type: 'feedback',
      status: 'open',
      description: 'Implementation notes for the readSignals helper',
    }, 'The readSignals helper reads from the signal queue. It calls readSignals internally.'));

    // Doc C: completely unrelated
    writeFileSync(join(corpus, 'project_dashboard_theme.md'), fmFmt({
      name: 'Dashboard theme palette',
      type: 'project',
      status: 'open',
      description: 'Editorial cream ink palette for the dashboard UI',
    }, 'Serif typography and editorial color palette for dashboard.'));

    const searcher = new MemorySearcher(tmpRoot);
    const results = searcher.search('_project', 'signal expiry', 10);

    // Must return at least the description-match doc
    expect(results.length).toBeGreaterThan(0);

    // Results must be sorted descending by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // Doc A (description mentions signal+expiry with field weights) must outrank Doc B
    // (body-only readSignals mention). BM25 with name=3×/desc=2× weights ensures this.
    const topSource = results[0].source;
    expect(topSource).toBe('feedback_signal_expiry.md');
  });

  it('returns stable ranked list with no exceptions for a query with no corpus matches', () => {
    writeFileSync(join(corpus, 'feedback_unrelated.md'), fmFmt({
      name: 'Unrelated topic',
      type: 'feedback',
      status: 'open',
      description: 'A completely unrelated feedback entry',
    }, 'Nothing here matches the test query at all.'));

    const searcher = new MemorySearcher(tmpRoot);
    let results: ReturnType<typeof searcher.search> | undefined;
    expect(() => {
      results = searcher.search('_project', 'zxyvwquartz', 10);
    }).not.toThrow();
    expect(Array.isArray(results)).toBe(true);
    expect(results!.length).toBe(0);
  });

  it('lazy rebuild trigger: re-indexing fires when a corpus file mtime advances', () => {
    // Write initial corpus file and build the index via the first search
    const fixturePath = join(corpus, 'feedback_relay_expiry.md');
    writeFileSync(fixturePath, fmFmt({
      name: 'Relay expiry window',
      type: 'feedback',
      status: 'open',
      description: 'Relay expiry causes dropped tasks when window elapses',
    }, 'Relay expiry drops tasks after the window elapses.'));

    const searcher = new MemorySearcher(tmpRoot);

    // First search — builds the index from scratch
    const first = searcher.search('_project', 'relay expiry', 5);
    expect(first.length).toBeGreaterThan(0);

    // Advance mtime by writing an updated file with a future timestamp.
    // utimesSync sets atime/mtime to simulate the file being updated.
    const futureMs = Date.now() + 60_000; // 60s in the future
    const futureSec = futureMs / 1000;
    writeFileSync(fixturePath, fmFmt({
      name: 'Relay expiry window updated',
      type: 'feedback',
      status: 'open',
      description: 'Relay expiry causes dropped tasks — updated with fix reference',
    }, 'Relay expiry drops tasks. Fixed in PR #400.'));
    utimesSync(fixturePath, futureSec, futureSec);

    // Second search — loadIndex should detect mtime drift and trigger incremental rebuild.
    // The new name should now be reflected in the results.
    const second = searcher.search('_project', 'relay expiry', 5);
    expect(second.length).toBeGreaterThan(0);

    // After rebuild, the updated document name must be visible
    const updatedResult = second.find(r => r.source === 'feedback_relay_expiry.md');
    expect(updatedResult).toBeDefined();
    expect(updatedResult!.name).toBe('Relay expiry window updated');
  });
});

// ---------------------------------------------------------------------------
// BM25 scoring via rankDocuments
// ---------------------------------------------------------------------------

describe('BM25 scoring via rankDocuments', () => {
  let corpus: string;

  beforeEach(() => {
    corpus = join(tmpdir(), `gossip-bm25-corpus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(corpus, { recursive: true });
  });

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  function writeMdFile(filename: string, content: string): void {
    writeFileSync(join(corpus, filename), content, 'utf-8');
  }

  function fmFmt(fields: Record<string, string>, body = 'Body.'): string {
    const lines = ['---'];
    for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
    lines.push('---', '', body);
    return lines.join('\n') + '\n';
  }

  it('recall test: "signal expiry logic" hits memories mentioning readSignals', () => {
    writeMdFile('feedback_readsignals.md', fmFmt({
      name: 'readSignals expiry',
      type: 'feedback',
      status: 'open',
      description: 'Signal expiry in readSignals function',
    }, 'The readSignals function expires old signal data from the processing queue based on TTL settings.'));

    writeMdFile('unrelated_dashboard.md', fmFmt({
      name: 'Dashboard Theme',
      type: 'project',
      status: 'open',
      description: 'Cream ink palette for dashboard',
    }, 'Editorial cream ink palette with serif typography.'));

    const index = buildFullIndex(corpus);
    const terms = Array.from(new Set(bm25Tokenize('signal expiry logic')));
    const ranked = rankDocuments(terms, index);

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].filename).toBe('feedback_readsignals.md');
  });

  it('returns empty results for query terms not in any document', () => {
    writeMdFile('a.md', fmFmt({ name: 'Alpha' }, 'Relay server internals.'));
    const index = buildFullIndex(corpus);
    const terms = Array.from(new Set(bm25Tokenize('zxyvwquartz')));
    const ranked = rankDocuments(terms, index);
    expect(ranked).toEqual([]);
  });

  it('IDF down-weights common terms — rare term uniquely identifies doc', () => {
    writeMdFile('a.md', fmFmt({ name: 'Signal Alpha', description: 'signal data' }, 'signal processing here'));
    writeMdFile('b.md', fmFmt({ name: 'Signal Beta', description: 'signal data' }, 'signal pipeline'));
    writeMdFile('c.md', fmFmt({ name: 'Signal Gamma Expiry', description: 'signal expiry logic' }, 'signal expiry mechanism present'));

    const index = buildFullIndex(corpus);
    const termsExpiry = Array.from(new Set(bm25Tokenize('expiry')));

    const rankedExpiry = rankDocuments(termsExpiry, index);
    // Only doc c should match "expiry"
    expect(rankedExpiry.length).toBe(1);
    expect(rankedExpiry[0].filename).toBe('c.md');
  });
});
