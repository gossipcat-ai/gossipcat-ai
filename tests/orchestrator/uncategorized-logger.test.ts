import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logUncategorizedFinding, getUncategorizedStatusLine, MAX_FILE_SIZE } from '../../packages/orchestrator/src/uncategorized-logger';
import { extractCategories } from '../../packages/orchestrator/src/category-extractor';

describe('logUncategorizedFinding', () => {
  const testDir = join(tmpdir(), 'uncat-logger-' + Date.now());

  afterAll(() => rmSync(testDir, { recursive: true, force: true }));

  test('writes a valid JSONL line to .gossip/uncategorized-findings.jsonl', () => {
    const text = 'CSRF missing Origin validation in middleware';
    logUncategorizedFinding(text, { agent_id: 'sonnet-reviewer', taskId: 'task-abc', finding_id: 'c1:sonnet-reviewer:f1' }, testDir);

    const logPath = join(testDir, '.gossip', 'uncategorized-findings.jsonl');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.text).toBe(text);
    expect(record.agent_id).toBe('sonnet-reviewer');
    expect(record.taskId).toBe('task-abc');
    expect(record.finding_id).toBe('c1:sonnet-reviewer:f1');
    expect(typeof record.timestamp_iso).toBe('string');
    expect(new Date(record.timestamp_iso).getTime()).toBeGreaterThan(0);
  });

  test('creates .gossip dir if it does not exist', () => {
    const freshDir = join(tmpdir(), 'uncat-fresh-' + Date.now());
    logUncategorizedFinding('some finding', {}, freshDir);
    const logPath = join(freshDir, '.gossip', 'uncategorized-findings.jsonl');
    expect(existsSync(logPath)).toBe(true);
    rmSync(freshDir, { recursive: true, force: true });
  });

  test('truncates text longer than 600 chars', () => {
    const longText = 'x'.repeat(700);
    logUncategorizedFinding(longText, {}, testDir);

    const logPath = join(testDir, '.gossip', 'uncategorized-findings.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.text.length).toBe(600);
  });

  test('appends multiple lines without overwriting', () => {
    const appendDir = join(tmpdir(), 'uncat-append-' + Date.now());
    logUncategorizedFinding('finding one', { agent_id: 'a1' }, appendDir);
    logUncategorizedFinding('finding two', { agent_id: 'a2' }, appendDir);

    const logPath = join(appendDir, '.gossip', 'uncategorized-findings.jsonl');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).text).toBe('finding one');
    expect(JSON.parse(lines[1]).text).toBe('finding two');
    rmSync(appendDir, { recursive: true, force: true });
  });

  test('omits optional fields when not provided', () => {
    const emptyCtxDir = join(tmpdir(), 'uncat-empty-' + Date.now());
    logUncategorizedFinding('bare finding', {}, emptyCtxDir);

    const logPath = join(emptyCtxDir, '.gossip', 'uncategorized-findings.jsonl');
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(record.text).toBe('bare finding');
    expect('agent_id' in record).toBe(false);
    expect('taskId' in record).toBe(false);
    expect('finding_id' in record).toBe(false);
    rmSync(emptyCtxDir, { recursive: true, force: true });
  });
});

describe('logUncategorizedFinding — log rotation', () => {
  test('rotation triggers when file exceeds threshold', () => {
    const dir = join(tmpdir(), 'uncat-rotate-' + Date.now());
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    // Seed file above 5MB threshold
    logUncategorizedFinding('seed', {}, dir); // creates .gossip dir
    writeFileSync(logPath, Buffer.alloc(MAX_FILE_SIZE + 100, 'x').toString());
    logUncategorizedFinding('after rotation', { agent_id: 'test' }, dir);
    // Original file should now be the fresh one (single record)
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.text).toBe('after rotation');
    // Rotated backup should exist
    expect(existsSync(logPath + '.1')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('no rotation when file is under threshold', () => {
    const dir = join(tmpdir(), 'uncat-norotate-' + Date.now());
    logUncategorizedFinding('first', {}, dir);
    logUncategorizedFinding('second', {}, dir);
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    expect(existsSync(logPath + '.1')).toBe(false);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('rotation overwrites existing .1 (single-slot semantic)', () => {
    const dir = join(tmpdir(), 'uncat-overwrite-' + Date.now());
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    // Seed main file above threshold and .1 with sentinel
    logUncategorizedFinding('seed', {}, dir);
    writeFileSync(logPath, Buffer.alloc(MAX_FILE_SIZE + 100, 'x').toString());
    writeFileSync(logPath + '.1', 'sentinel-content\n');
    logUncategorizedFinding('fresh', { agent_id: 'a1' }, dir);
    // .1 should now hold the oversized content, not the sentinel
    const backup = readFileSync(logPath + '.1', 'utf-8');
    expect(backup).not.toBe('sentinel-content\n');
    expect(backup.length).toBeGreaterThan(MAX_FILE_SIZE);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('logUncategorizedFinding — error resilience', () => {
  test('does not throw when appendFileSync throws (e.g. EACCES)', () => {
    // Mock appendFileSync to simulate a permission error
    const fs = require('fs');
    const original = fs.appendFileSync;
    fs.appendFileSync = () => {
      const err = new Error('EACCES: permission denied');
      (err as any).code = 'EACCES';
      throw err;
    };
    try {
      // Should not throw — error is swallowed to stderr
      expect(() =>
        logUncategorizedFinding('some finding', { agent_id: 'a1' }, '/tmp/test-dir'),
      ).not.toThrow();
    } finally {
      fs.appendFileSync = original;
    }
  });
});

describe('logUncategorizedFinding — secret redaction', () => {
  test('redacts OpenAI key before writing', () => {
    const dir = join(tmpdir(), 'uncat-redact-' + Date.now());
    const openaiKey = 'sk-' + 'A'.repeat(48); // matches sk-[40+] pattern
    const finding = `API key exposed: ${openaiKey} in config`;
    logUncategorizedFinding(finding, {}, dir);

    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(record.text).not.toContain(openaiKey);
    expect(record.text).toContain('[REDACTED_API_KEY]');
    rmSync(dir, { recursive: true, force: true });
  });

  test('redacts GitHub token before writing', () => {
    const dir = join(tmpdir(), 'uncat-redact-gh-' + Date.now());
    const ghToken = 'ghp_' + 'B'.repeat(36);
    const finding = `Token leaked: ${ghToken}`;
    logUncategorizedFinding(finding, {}, dir);

    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(record.text).not.toContain(ghToken);
    expect(record.text).toContain('[REDACTED_GITHUB_TOKEN]');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('extractCategories empty → logUncategorizedFinding integration', () => {
  test('CSRF/Origin/Sec-Fetch vocabulary produces no category', () => {
    // Vocabulary from the task description's Clerk-auth review example that
    // doesn't match any built-in regex patterns.
    const uncategorizedFindings = [
      'CSRF token missing from middleware handler',
      'Origin header not checked in Sec-Fetch flow',
      'Clerk session cookie missing SameSite attribute',
    ];
    for (const text of uncategorizedFindings) {
      expect(extractCategories(text)).toHaveLength(0);
    }
  });

  test('when extractCategories returns empty, logUncategorizedFinding writes JSONL', () => {
    const integDir = join(tmpdir(), 'uncat-integ-' + Date.now());
    const finding = 'CSRF token missing from middleware handler';
    const categories = extractCategories(finding);
    if (categories.length === 0) {
      logUncategorizedFinding(finding, { agent_id: 'test-agent', taskId: 'task-123' }, integDir);
    }

    const logPath = join(integDir, '.gossip', 'uncategorized-findings.jsonl');
    expect(existsSync(logPath)).toBe(true);
    const record = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    expect(record.text).toBe(finding);
    expect(record.agent_id).toBe('test-agent');
    rmSync(integDir, { recursive: true, force: true });
  });
});

describe('getUncategorizedStatusLine — cold-start and happy-path', () => {
  // Helper: make a JSONL line with a timestamp offset from nowMs.
  const makeLine = (text: string, offsetMs: number, nowMs: number) =>
    JSON.stringify({ text, timestamp_iso: new Date(nowMs + offsetMs).toISOString() });

  test('cold start — no .gossip dir → empty string, no throw', async () => {
    const dir = join(tmpdir(), 'uncat-status-cold-' + Date.now());
    // dir intentionally not created
    const result = await getUncategorizedStatusLine(dir);
    expect(result).toBe('');
  });

  test('cold start — .gossip dir exists but no file → empty string', async () => {
    const dir = join(tmpdir(), 'uncat-status-nofile-' + Date.now());
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    const result = await getUncategorizedStatusLine(dir);
    expect(result).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  test('all entries outside 7d window → empty string', async () => {
    const dir = join(tmpdir(), 'uncat-status-old-' + Date.now());
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    const nowMs = Date.now();
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    // Write entries 8 days ago
    writeFileSync(logPath, makeLine('stale finding', -(8 * 24 * 60 * 60 * 1000), nowMs) + '\n');
    const result = await getUncategorizedStatusLine(dir, { nowMs });
    expect(result).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  test('3 fresh entries → line containing "3 in last 7d" and sample text', async () => {
    const dir = join(tmpdir(), 'uncat-status-fresh-' + Date.now());
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    const nowMs = Date.now();
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    const lines = [
      makeLine('first finding', -1000, nowMs),
      makeLine('second finding', -2000, nowMs),
      makeLine('most recent finding', -500, nowMs),
    ];
    writeFileSync(logPath, lines.join('\n') + '\n');
    const result = await getUncategorizedStatusLine(dir, { nowMs });
    expect(result).toContain('3 in last 7d');
    expect(result).toContain('most recent finding');
    rmSync(dir, { recursive: true, force: true });
  });

  test('entries split across .jsonl and .jsonl.1 → combined count', async () => {
    const dir = join(tmpdir(), 'uncat-status-split-' + Date.now());
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    const nowMs = Date.now();
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    writeFileSync(logPath, makeLine('from main file', -1000, nowMs) + '\n');
    writeFileSync(logPath + '.1', makeLine('from backup file', -2000, nowMs) + '\n');
    const result = await getUncategorizedStatusLine(dir, { nowMs });
    expect(result).toContain('2 in last 7d');
    rmSync(dir, { recursive: true, force: true });
  });

  test('malformed JSON line interleaved with valid → count excludes garbage', async () => {
    const dir = join(tmpdir(), 'uncat-status-malformed-' + Date.now());
    mkdirSync(join(dir, '.gossip'), { recursive: true });
    const nowMs = Date.now();
    const logPath = join(dir, '.gossip', 'uncategorized-findings.jsonl');
    const content = [
      makeLine('valid one', -1000, nowMs),
      'this is not json at all',
      makeLine('valid two', -2000, nowMs),
      '{broken json',
    ].join('\n') + '\n';
    writeFileSync(logPath, content);
    const result = await getUncategorizedStatusLine(dir, { nowMs });
    expect(result).toContain('2 in last 7d');
    rmSync(dir, { recursive: true, force: true });
  });
});
