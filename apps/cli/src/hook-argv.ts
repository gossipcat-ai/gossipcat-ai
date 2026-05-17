/**
 * Argv parser for `gossipcat hook <sub>`.
 *
 * Returns `'run'` only when the user typed `--run` or `run` explicitly.
 * Bare `gossipcat hook` (sub === undefined) and any unknown subcommand
 * return `'usage'` — fix MEDIUM f2 from consensus d88f27db-c0454640
 * (previously, undefined fell through and silently fired the hook).
 *
 * Extracted from index.ts so the guard can be unit-tested without
 * spawning the full CLI (importing index.ts runs `main()` on load).
 */
export function parseHookSubcommand(sub: string | undefined): 'run' | 'usage' {
  if (sub === '--run' || sub === 'run') return 'run';
  return 'usage';
}
