/**
 * Unit tests for the activity-mirror arg scrubber + PostToolUse allowlist
 * (apps/cli/src/hooks/mirror-scrub.ts). Spec §Security P0 + sonnet:f8.
 */
import {
  scrubSecrets,
  scrubAndTruncate,
  truncate,
  buildActivityLine,
  REDACTED,
  SCRUB_SUMMARY_MAX,
} from '../../apps/cli/src/hooks/mirror-scrub';

describe('scrubSecrets', () => {
  it('redacts Bearer tokens', () => {
    const out = scrubSecrets('curl -H "Authorization: Bearer sk-abc123def456" https://x');
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).not.toContain('sk-abc123def456');
  });

  it('redacts --password values', () => {
    expect(scrubSecrets('mysql --password hunter2 db')).not.toContain('hunter2');
    expect(scrubSecrets('mysql --password=hunter2 db')).not.toContain('hunter2');
  });

  it('redacts api_key / api-key assignments', () => {
    expect(scrubSecrets('api_key=ABCDEF1234')).toBe(`api_key=${REDACTED}`);
    expect(scrubSecrets('api-key=ABCDEF1234')).toBe(`api-key=${REDACTED}`);
  });

  it('redacts secret-bearing env-var assignments', () => {
    expect(scrubSecrets('export OPENAI_API_KEY=sk-xyz')).toContain(`OPENAI_API_KEY=${REDACTED}`);
    expect(scrubSecrets('GITHUB_TOKEN=ghp_aaa bbb')).toContain(`GITHUB_TOKEN=${REDACTED}`);
    expect(scrubSecrets('DB_PASSWORD=p4ss')).toContain(`DB_PASSWORD=${REDACTED}`);
    expect(scrubSecrets('STRIPE_SECRET=zzz')).toContain(`STRIPE_SECRET=${REDACTED}`);
  });

  it('redacts standalone long hex/base64 runs (>=32 chars)', () => {
    const hex = 'a'.repeat(40);
    expect(scrubSecrets(`token ${hex} end`)).toBe(`token ${REDACTED} end`);
    // A short hex run is left intact.
    expect(scrubSecrets('short abc123 end')).toBe('short abc123 end');
  });

  it('collapses newlines/whitespace to a single line', () => {
    expect(scrubSecrets('a\n  b\t c')).toBe('a b c');
  });

  it('returns empty string for non-string input', () => {
    expect(scrubSecrets(undefined as unknown as string)).toBe('');
  });
});

describe('scrubAndTruncate (scrub THEN truncate — sonnet:f8)', () => {
  it('redacts a secret near the END before truncation drops it', () => {
    // A long benign prefix then a secret at the tail. Truncate-first would
    // chop the secret out of VIEW but it would still have ridden through; the
    // contract is the secret is REDACTED regardless of position.
    const prefix = 'x'.repeat(SCRUB_SUMMARY_MAX);
    const out = scrubAndTruncate(`${prefix} Bearer sk-tailsecret`);
    expect(out).not.toContain('sk-tailsecret');
    expect(out.length).toBeLessThanOrEqual(SCRUB_SUMMARY_MAX);
  });

  it('truncates to SCRUB_SUMMARY_MAX with an ellipsis', () => {
    // Use short space-separated words so the long-hex/base64 sweep doesn't
    // collapse the whole thing to a single «redacted» token.
    const out = scrubAndTruncate('word '.repeat(60));
    expect(out.length).toBeLessThanOrEqual(SCRUB_SUMMARY_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('truncate', () => {
  it('leaves short strings intact', () => {
    expect(truncate('abc', 80)).toBe('abc');
  });
  it('truncates and ellipsizes', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});

describe('buildActivityLine — allowlist + scrub', () => {
  it('returns null for non-allowlisted tools (Read/Grep flood guard)', () => {
    expect(buildActivityLine('Read', { file_path: '/etc/passwd' })).toBeNull();
    expect(buildActivityLine('Grep', { pattern: 'x' })).toBeNull();
    expect(buildActivityLine('WebFetch', {})).toBeNull();
  });

  it('builds a scrubbed Bash one-liner', () => {
    const line = buildActivityLine('Bash', { command: 'curl -H "Authorization: Bearer sk-secret123456"' });
    expect(line).not.toBeNull();
    expect(line).toContain('🔧 Bash');
    expect(line).not.toContain('sk-secret123456');
  });

  it('builds Edit/Write file-path lines', () => {
    expect(buildActivityLine('Edit', { file_path: '/a/b.ts' })).toContain('/a/b.ts');
    expect(buildActivityLine('Write', { file_path: '/a/c.ts' })).toContain('Write');
  });

  it('builds a dispatch line with the agent id', () => {
    expect(buildActivityLine('mcp__gossipcat__gossip_dispatch', { agent_id: 'opus-implementer' }))
      .toContain('opus-implementer');
    expect(buildActivityLine('mcp__gossipcat__gossip_run', { agent: 'sonnet-reviewer' }))
      .toContain('sonnet-reviewer');
  });

  it('builds a collect line', () => {
    expect(buildActivityLine('mcp__gossipcat__gossip_collect', {})).toContain('collect');
  });

  it('NEVER includes tool_response (it is not even an input to the builder)', () => {
    // The function signature has no tool_response param — this asserts the
    // contract at the type+behavior level: even a malicious tool_input cannot
    // smuggle a response field into the line beyond its own scrubbed value.
    const line = buildActivityLine('Bash', { command: 'echo hi', tool_response: 'SECRET-OUTPUT' });
    expect(line).not.toContain('SECRET-OUTPUT');
  });
});
