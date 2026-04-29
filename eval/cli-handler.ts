/**
 * eval/cli-handler.ts — `gossipcat eval` implementation.
 *
 * Lives at repo root rather than apps/cli/src because the harness/match/score
 * modules also live under eval/ and the CLI tsconfig's rootDir would forbid
 * cross-tree imports. The CLI shim at apps/cli/src/commands/eval.ts dynamic-
 * loads this module at runtime.
 *
 * Flags:
 *   --cases <glob>           Repeatable. Defaults to eval/cases/*.yaml + eval/cases-private/*.yaml
 *   --agents <id,id,...>     Comma-separated. Defaults to all native:true agents in .gossip/config.json.
 *   --out <path>             Output dir. Defaults to eval/.runs/.
 *   --against <runDir>       Compute McNemar paired against the named baseline run dir.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { loadCases, runSuite } from './harness';
import { formatLeaderboard, formatMcNemar, PairedOutcome } from './report';
import { findConfigPath, loadConfig } from '../apps/cli/src/config';

interface EvalArgs {
  cases?: string[];
  agents?: string[];
  out?: string;
  against?: string;
}

function parseArgs(argv: string[]): EvalArgs {
  const out: EvalArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cases' && i + 1 < argv.length) {
      out.cases = (out.cases || []).concat(argv[++i]);
    } else if (a === '--agents' && i + 1 < argv.length) {
      out.agents = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--out' && i + 1 < argv.length) {
      out.out = argv[++i];
    } else if (a === '--against' && i + 1 < argv.length) {
      out.against = argv[++i];
    }
  }
  return out;
}

function defaultAgents(): string[] {
  const cfgPath = findConfigPath();
  if (!cfgPath) return [];
  try {
    const cfg = loadConfig(cfgPath);
    if (!cfg.agents) return [];
    return Object.entries(cfg.agents)
      .filter(([_id, a]) => a.native === true)
      .map(([id]) => id);
  } catch {
    return [];
  }
}

export async function runEvalCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const root = process.cwd();
  const casePatterns = args.cases && args.cases.length > 0
    ? args.cases
    : ['eval/cases/*.yaml', 'eval/cases-private/*.yaml'];
  const agents = args.agents && args.agents.length > 0 ? args.agents : defaultAgents();

  const cases = casePatterns.flatMap(p => loadCases(p, root));
  if (cases.length === 0) {
    process.stdout.write('# Eval Suite\n\n_No cases found._\n');
    return;
  }

  const outDir = args.out ? resolve(args.out) : join(root, 'eval', '.runs');
  const { scores } = await runSuite(cases, agents, { outDir, worktreeRoot: root });

  const leaderboard = formatLeaderboard(scores);
  process.stdout.write(leaderboard);

  const summaryPath = join(outDir, scores.runId, 'leaderboard.md');
  writeFileSync(summaryPath, leaderboard);

  if (args.against) {
    const baselineDir = resolve(args.against);
    const after: PairedOutcome[] = scores.perCase.map(sc => ({
      caseId: sc.caseId,
      pass: sc.f1 >= 0.5,
    }));
    const before = loadBaselineOutcomes(baselineDir);
    if (before.length === 0) {
      process.stdout.write(`\n_No baseline outcomes found at ${baselineDir}._\n`);
      return;
    }
    const mc = formatMcNemar(before, after);
    process.stdout.write('\n' + mc);
    writeFileSync(join(outDir, scores.runId, 'mcnemar.md'), mc);
  }
}

function loadBaselineOutcomes(baselineDir: string): PairedOutcome[] {
  if (!existsSync(baselineDir)) return [];
  const files = readdirSync(baselineDir).filter(f => f.endsWith('.json'));
  const outcomes: PairedOutcome[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(baselineDir, f), 'utf-8')) as {
        caseId?: unknown;
        byAgent?: Record<string, unknown[]>;
      };
      // Coarse pass proxy: any non-empty per-agent finding list ⇒ pass.
      // Operators wanting sharper pairing should rerun runSuite() over the
      // archived cases and use the per-case F1 directly.
      const byAgent = raw.byAgent || {};
      let any = false;
      for (const aid of Object.keys(byAgent)) {
        const list = byAgent[aid];
        if (Array.isArray(list) && list.length > 0) { any = true; break; }
      }
      outcomes.push({ caseId: String(raw.caseId), pass: any });
    } catch {
      // skip unreadable
    }
  }
  return outcomes;
}
