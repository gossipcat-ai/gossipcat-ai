/**
 * Argv parser for `gossipcat hook <sub>`.
 *
 * Returns `'run'` only when the user typed `--run` or `run` explicitly.
 * Bare `gossipcat hook` (sub === undefined) and any unknown subcommand
 * return `'usage'` — fix MEDIUM f2 from consensus d88f27db-c0454640
 * (previously, undefined fell through and silently fired the hook).
 *
 * Activity-mirror v2 (spec §Component 1) adds three mirror subcommands:
 *   - `mirror-prompt` → UserPromptSubmit mirror hook
 *   - `mirror-stop`   → Stop mirror hook
 *   - `mirror-tool`   → PostToolUse mirror hook
 * These are fail-open + non-blocking; unknown subcommands still map to `'usage'`.
 *
 * Extracted from index.ts so the guard can be unit-tested without
 * spawning the full CLI (importing index.ts runs `main()` on load).
 */
export type HookSubcommand =
  | 'run'
  | 'mirror-prompt'
  | 'mirror-stop'
  | 'mirror-tool'
  | 'usage';

export function parseHookSubcommand(sub: string | undefined): HookSubcommand {
  if (sub === '--run' || sub === 'run') return 'run';
  if (sub === 'mirror-prompt') return 'mirror-prompt';
  if (sub === 'mirror-stop') return 'mirror-stop';
  if (sub === 'mirror-tool') return 'mirror-tool';
  return 'usage';
}
