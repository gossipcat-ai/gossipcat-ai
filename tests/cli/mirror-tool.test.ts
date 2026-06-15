/**
 * End-to-end unit tests for the PostToolUse mirror hook
 * (apps/cli/src/hooks/mirror-tool.ts → runMirrorToolHook). Spec §Component 1 +
 * consensus 4a4b2087 HIGH (mirror-tool untested).
 *
 * Seam: we mock `mirror-shared`'s `postMirror` so we can assert WHAT frame the
 * hook would POST without any real network/spawn — the same injection seam the
 * sibling mirror tests use (capture-the-call, no I/O). `readStdin` etc. are
 * irrelevant here because the hook accepts an injected `rawStdin` argument.
 */

const postMirrorMock = jest.fn<boolean, [unknown]>(() => true);

jest.mock('../../apps/cli/src/hooks/mirror-shared', () => {
  const actual = jest.requireActual('../../apps/cli/src/hooks/mirror-shared');
  return {
    ...actual,
    // Only override the network-facing primitive; keep resolveCwd/parsePayload real.
    postMirror: (opts: unknown) => postMirrorMock(opts),
  };
});

import { runMirrorToolHook } from '../../apps/cli/src/hooks/mirror-tool';

/** The shape postMirror receives. */
interface PostArg {
  cwd: string;
  sessionId?: string;
  frames: Array<{ role: string; text: string }>;
}

function lastFrame(): { role: string; text: string } {
  const arg = postMirrorMock.mock.calls.at(-1)![0] as PostArg;
  return arg.frames[0];
}

describe('runMirrorToolHook — PostToolUse mirror', () => {
  beforeEach(() => { postMirrorMock.mockClear(); });

  it('(a) allowlisted Bash → ONE activity frame with a scrubbed one-liner', async () => {
    await runMirrorToolHook(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
      cwd: '/proj',
      session_id: 'sid-1',
    }));
    expect(postMirrorMock).toHaveBeenCalledTimes(1);
    const arg = postMirrorMock.mock.calls[0][0] as PostArg;
    expect(arg.frames).toHaveLength(1);
    expect(arg.frames[0].role).toBe('activity');
    expect(arg.frames[0].text).toBe('🔧 Bash · ls -la /tmp');
    expect(arg.sessionId).toBe('sid-1');
    expect(arg.cwd).toBe('/proj');
  });

  it('(b) tool_response in stdin is NEVER present in the posted frame', async () => {
    await runMirrorToolHook(JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'cat /etc/hosts' },
      tool_response: 'SENSITIVE-RESPONSE-CONTENTS-LEAK',
      cwd: '/proj',
    }));
    expect(postMirrorMock).toHaveBeenCalledTimes(1);
    expect(lastFrame().text).not.toContain('SENSITIVE-RESPONSE-CONTENTS-LEAK');
    expect(lastFrame().text).toBe('🔧 Bash · cat /etc/hosts');
  });

  it('(c) non-allowlisted tools (Read / Grep) → no POST', async () => {
    await runMirrorToolHook(JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: '/secret' },
      cwd: '/proj',
    }));
    await runMirrorToolHook(JSON.stringify({
      tool_name: 'Grep',
      tool_input: { pattern: 'token' },
      cwd: '/proj',
    }));
    expect(postMirrorMock).not.toHaveBeenCalled();
  });

  it('(d) malformed / empty stdin → no POST, no throw', async () => {
    await expect(runMirrorToolHook('{ not json')).resolves.toBeUndefined();
    await expect(runMirrorToolHook('')).resolves.toBeUndefined();
    await expect(runMirrorToolHook('[]')).resolves.toBeUndefined(); // array → parsePayload null
    expect(postMirrorMock).not.toHaveBeenCalled();
  });

  it('(e) secrets in tool_input (Bearer / api_key / JWT) are redacted in the posted text', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    await runMirrorToolHook(JSON.stringify({
      tool_name: 'Bash',
      tool_input: {
        command: `curl -H "Authorization: Bearer sk-abc123secret" --data api_key=topsecretvalue ${jwt}`,
      },
      cwd: '/proj',
    }));
    expect(postMirrorMock).toHaveBeenCalledTimes(1);
    const text = lastFrame().text;
    expect(text).not.toContain('sk-abc123secret');
    expect(text).not.toContain('topsecretvalue');
    expect(text).not.toContain(jwt);
    // The redaction marker is present.
    expect(text).toContain('«redacted»');
  });
});
