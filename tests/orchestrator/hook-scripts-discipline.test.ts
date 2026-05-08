/**
 * Tests for the three discipline hook shell scripts.
 *
 * Each test pipes sample stdin JSON to the script and verifies the
 * expected stdout, stderr, and exit code. Scripts must always exit 0
 * (never block).
 */
import { spawnSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync } from 'fs';

// Resolve scripts from repo root — mirrors findDisciplineHook candidate order.
const DISCIPLINE_DIR = resolve(process.cwd(), 'assets', 'hooks', 'discipline');

function scriptPath(name: string): string {
  return join(DISCIPLINE_DIR, name);
}

function runScript(
  script: string,
  stdin: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bash', [script], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('discipline hook scripts — exist on disk', () => {
  it('session-start-bootstrap.sh exists', () => {
    expect(existsSync(scriptPath('session-start-bootstrap.sh'))).toBe(true);
  });
  it('pretool-signals-validate.sh exists', () => {
    expect(existsSync(scriptPath('pretool-signals-validate.sh'))).toBe(true);
  });
  it('posttool-collect-reminder.sh exists', () => {
    expect(existsSync(scriptPath('posttool-collect-reminder.sh'))).toBe(true);
  });
});

describe('session-start-bootstrap.sh', () => {
  const script = scriptPath('session-start-bootstrap.sh');

  it('exits 0', () => {
    const { status } = runScript(script, '');
    expect(status).toBe(0);
  });

  it('outputs bootstrap reminder to stdout', () => {
    const { stdout } = runScript(script, '');
    expect(stdout).toContain('gossip_status()');
    expect(stdout).toContain('[gossipcat]');
  });

  it('produces no stderr output', () => {
    const { stderr } = runScript(script, '');
    expect(stderr).toBe('');
  });
});

describe('pretool-signals-validate.sh', () => {
  const script = scriptPath('pretool-signals-validate.sh');

  it('exits 0 always — non-record action', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_signals',
      tool_input: { action: 'list' },
    });
    const { status } = runScript(script, input);
    expect(status).toBe(0);
  });

  it('exits 0 always — record with no consensus_id (parallel mode)', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_signals',
      tool_input: {
        action: 'record',
        signals: [{ signal: 'agreement', agent_id: 'sonnet-reviewer' }],
      },
    });
    const { status, stderr } = runScript(script, input);
    expect(status).toBe(0);
    expect(stderr).toBe(''); // no warning for parallel mode
  });

  it('warns on stderr when signal lacks finding_id and consensus_id is present', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_signals',
      tool_input: {
        action: 'record',
        consensus_id: 'abc123',
        signals: [
          { signal: 'unique_confirmed', agent_id: 'sonnet-reviewer' }, // no finding_id
        ],
      },
    });
    const { status, stderr } = runScript(script, input);
    expect(status).toBe(0);
    expect(stderr).toContain('missing finding_id');
    expect(stderr).toContain('signal #1');
  });

  it('warns only for signals missing finding_id — not those that have it', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_signals',
      tool_input: {
        action: 'record',
        consensus_id: 'abc123',
        signals: [
          { signal: 'unique_confirmed', agent_id: 'a1', finding_id: 'abc123:a1:f1' },
          { signal: 'agreement', agent_id: 'a2' }, // missing finding_id
          { signal: 'hallucination_caught', agent_id: 'a3', finding_id: 'abc123:a3:f2' },
        ],
      },
    });
    const { status, stderr } = runScript(script, input);
    expect(status).toBe(0);
    // Only signal #2 should warn
    expect(stderr).toContain('signal #2');
    expect(stderr).not.toContain('signal #1');
    expect(stderr).not.toContain('signal #3');
  });

  it('detects consensus_id on individual signal entries (not only top-level)', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_signals',
      tool_input: {
        action: 'record',
        signals: [
          { signal: 'agreement', agent_id: 'a1', consensus_id: 'xyz999' }, // consensus_id on signal
        ],
      },
    });
    const { status, stderr } = runScript(script, input);
    expect(status).toBe(0);
    expect(stderr).toContain('missing finding_id');
  });

  it('exits 0 on malformed/empty stdin', () => {
    const { status } = runScript(script, '');
    expect(status).toBe(0);
  });

  it('exits 0 on malformed JSON stdin', () => {
    const { status } = runScript(script, '{not json');
    expect(status).toBe(0);
  });
});

describe('posttool-collect-reminder.sh', () => {
  const script = scriptPath('posttool-collect-reminder.sh');

  it('exits 0 always', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_collect',
      tool_input: { consensus: true },
      tool_response: {},
    });
    const { status } = runScript(script, input);
    expect(status).toBe(0);
  });

  it('outputs signal-recording reminder when consensus === true', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_collect',
      tool_input: { consensus: true },
    });
    const { stdout } = runScript(script, input);
    expect(stdout).toContain('EXECUTE NOW');
    expect(stdout).toContain('gossip_signals');
    expect(stdout).toContain('verify → signal → synthesize');
  });

  it('produces no output when consensus !== true', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_collect',
      tool_input: { consensus: false },
    });
    const { stdout } = runScript(script, input);
    expect(stdout.trim()).toBe('');
  });

  it('produces no output when consensus field is absent', () => {
    const input = JSON.stringify({
      tool_name: 'mcp__gossipcat__gossip_collect',
      tool_input: {},
    });
    const { stdout } = runScript(script, input);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 on malformed/empty stdin', () => {
    const { status } = runScript(script, '');
    expect(status).toBe(0);
  });

  it('exits 0 on malformed JSON stdin', () => {
    const { status } = runScript(script, '{not json');
    expect(status).toBe(0);
  });
});
