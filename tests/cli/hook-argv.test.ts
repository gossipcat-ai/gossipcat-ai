/**
 * Unit tests for the `gossipcat hook` argv guard — MEDIUM f2 from consensus
 * d88f27db-c0454640. Bare `gossipcat hook` must NOT silently fire the hook.
 */
import { parseHookSubcommand } from '../../apps/cli/src/hook-argv';

describe('parseHookSubcommand', () => {
  it('returns "run" for the canonical --run flag', () => {
    expect(parseHookSubcommand('--run')).toBe('run');
  });

  it('returns "run" for the bare-word `run` form', () => {
    expect(parseHookSubcommand('run')).toBe('run');
  });

  it('returns "usage" for bare `gossipcat hook` (sub === undefined)', () => {
    expect(parseHookSubcommand(undefined)).toBe('usage');
  });

  it('returns "usage" for an unknown subcommand', () => {
    expect(parseHookSubcommand('install')).toBe('usage');
  });

  it('returns "usage" for the empty string', () => {
    expect(parseHookSubcommand('')).toBe('usage');
  });
});
