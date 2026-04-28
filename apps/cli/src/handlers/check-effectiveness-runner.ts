/**
 * Standalone helper: walk .gossip/agents/<agentId>/skills/*.md and call
 * SkillEngine.checkEffectiveness on each (agentId, category) pair.
 *
 * Called by collect.ts AFTER consensus signals are written, so the
 * per-category accuracy counters reflect the current consensus round.
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { SkillEngine } from '@gossip/orchestrator';

export interface RunnerOptions {
  skillEngine: SkillEngine;
  registryGet: (agentId: string) => { role?: string } | undefined;
  projectRoot: string;
}

// Defense-in-depth: directory and skill-file names must be safe identifiers.
// readdirSync entries are filesystem-controlled; reject anything that could
// escape via `..`, `/`, or shell metacharacters before passing to join() or
// downstream tools (consensus 059e4ec4, gemini:f1 + sonnet:f3).
//
// Allows dots so model-version-style agent IDs work (gemini-1.5-pro,
// claude-3.5-sonnet — consensus 1a93ddd0:gemini:f1) but the negative
// lookahead `(?!.*\.\.)` rejects any `..` substring to keep traversal closed.
const SAFE_NAME = /^(?!.*\.\.)[a-zA-Z0-9._-]+$/;

/**
 * Walk .gossip/agents/<agentId>/skills/*.md and call checkEffectiveness
 * on each (agentId, category) pair. Errors per skill are swallowed so one
 * bad file never breaks the whole loop.
 */
export async function runCheckEffectivenessForAllSkills(opts: RunnerOptions): Promise<void> {
  const baseDir = join(opts.projectRoot, '.gossip', 'agents');
  if (!existsSync(baseDir)) return;

  const agentDirs = readdirSync(baseDir);
  for (const agentId of agentDirs) {
    // Skip synthetic/system dirs (e.g. `_project`) — they are not agents.
    if (agentId.startsWith('_')) continue;
    if (!SAFE_NAME.test(agentId)) continue;
    const skillsDir = join(baseDir, agentId, 'skills');
    if (!existsSync(skillsDir)) continue;

    const role = opts.registryGet(agentId)?.role;
    // Implementers never get per-category accuracy checks
    if (role === 'implementer') continue;

    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const category = file.replace(/\.md$/, '');
      if (!SAFE_NAME.test(category)) continue;
      try {
        const verdict = await opts.skillEngine.checkEffectiveness(agentId, category, { role });
        if (verdict.shouldUpdate) {
          // Log every transition that changes operator-visible status: passed/failed/flagged
          const loggedStates = new Set(['passed', 'failed', 'flagged_for_manual_review']);
          if (loggedStates.has(verdict.status)) {
            process.stderr.write(
              `[gossipcat] checkEffectiveness ${agentId}/${category}: ${verdict.status}` +
              (verdict.effectiveness !== undefined ? ` (Δ=${verdict.effectiveness.toFixed(3)})` : '') +
              `\n`,
            );
          }
        }
      } catch (e) {
        process.stderr.write(`[gossipcat] checkEffectiveness ${agentId}/${category} threw: ${(e as Error).message}\n`);
      }
    }
  }
}
