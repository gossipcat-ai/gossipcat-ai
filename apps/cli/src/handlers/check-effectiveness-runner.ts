/**
 * Standalone helper: walk .gossip/agents/<agentId>/skills/*.md and call
 * SkillGenerator.checkEffectiveness on each (agentId, category) pair.
 *
 * Called by collect.ts AFTER consensus signals are written, so the
 * per-category accuracy counters reflect the current consensus round.
 */
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { SkillGenerator } from '@gossip/orchestrator';

export interface RunnerOptions {
  skillGenerator: SkillGenerator;
  registryGet: (agentId: string) => { role?: string } | undefined;
  projectRoot: string;
}

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
    const skillsDir = join(baseDir, agentId, 'skills');
    if (!existsSync(skillsDir)) continue;

    const role = opts.registryGet(agentId)?.role;
    // Implementers never get per-category accuracy checks
    if (role === 'implementer') continue;

    const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const category = file.replace(/\.md$/, '');
      try {
        const verdict = await opts.skillGenerator.checkEffectiveness(agentId, category, { role });
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
