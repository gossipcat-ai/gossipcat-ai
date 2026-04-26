import { readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logUncategorizedFinding } from '../../packages/orchestrator/src/uncategorized-logger';
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
  // Original PR #277 fixture used CSRF/Sec-Fetch as an example of "no
  // built-in match" — the same vocabulary this PR adds to trust_boundaries.
  // Update the fixture to use UI/branding text that genuinely has no home
  // in any of the 14 categories.
  test('UI/branding vocabulary produces no category', () => {
    const uncategorizedFindings = [
      'Hover gradient on primary button is too aggressive for the new brand palette',
      'Onboarding modal padding feels uneven on the right edge',
      'Copywriting in the empty-state illustration is too playful for the audience',
    ];
    for (const text of uncategorizedFindings) {
      expect(extractCategories(text)).toHaveLength(0);
    }
  });

  test('when extractCategories returns empty, logUncategorizedFinding writes JSONL', () => {
    const integDir = join(tmpdir(), 'uncat-integ-' + Date.now());
    const finding = 'Hover gradient on primary button is too aggressive for the new brand palette';
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
