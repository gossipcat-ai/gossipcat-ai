/**
 * apps/cli/src/commands/eval.ts — thin shim for `gossipcat eval`.
 *
 * The actual handler lives in `eval/cli-handler.ts` at the repo root, so the
 * harness/match/score modules can sit under `eval/` without violating the
 * CLI tsconfig's `rootDir: src` constraint. We dynamic-import via a path
 * resolved at runtime — this keeps tsc happy and ts-node/JIT-runtime works
 * because the eval/ directory is reachable from the project working dir.
 */

import { resolve } from 'path';

export async function runEvalCommand(argv: string[]): Promise<void> {
  // Resolve the handler from the project working dir so this shim works
  // whether the CLI is launched via `npm start`, `npx ts-node`, or a packed
  // binary that ships with eval/ on disk.
  const handlerPath = resolve(process.cwd(), 'eval', 'cli-handler');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(handlerPath) as { runEvalCommand: (argv: string[]) => Promise<void> };
  await mod.runEvalCommand(argv);
}
