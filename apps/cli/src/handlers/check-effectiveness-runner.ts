/**
 * Standalone helper: walk .gossip/agents/<agentId>/skills/*.md and call
 * SkillEngine.checkEffectiveness on each (agentId, category) pair.
 *
 * Called by collect.ts AFTER consensus signals are written, so the
 * per-category accuracy counters reflect the current consensus round.
 *
 * Observability (consensus 4bd62d6c-46fd4e55):
 *   - entry/exit log lines tag each runner invocation with skill counts
 *     and total duration so operators can see graduation activity in stderr
 *   - atomic write of `.gossip/skill-runner-health.json` records the last
 *     run timestamp + transition counts; surfaced by gossip_status() so
 *     "did this ever run?" is observable without log scraping
 */
import { existsSync, readdirSync, realpathSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
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

interface TransitionCounts {
  passed: number;
  failed: number;
  flagged_for_manual_review: number;
  inconclusive: number;
  pending: number;
}

interface HealthRecord {
  last_run_at: string;
  last_run_duration_ms: number;
  skills_evaluated: number;
  transitions: TransitionCounts;
  last_error: string | null;
}

function writeHealthAtomic(projectRoot: string, record: HealthRecord): void {
  const dir = join(projectRoot, '.gossip');
  const finalPath = join(dir, 'skill-runner-health.json');
  const tmpPath = finalPath + '.tmp';
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    renameSync(tmpPath, finalPath);
  } catch (e) {
    process.stderr.write(`[gossipcat] checkEffectiveness: health write failed: ${(e as Error).message}\n`);
    // Clean up the .tmp so a future operator audit doesn't see stale partials.
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort */ }
  }
}

/**
 * Walk .gossip/agents/<agentId>/skills/*.md and call checkEffectiveness
 * on each (agentId, category) pair. Errors per skill are swallowed so one
 * bad file never breaks the whole loop.
 */
export async function runCheckEffectivenessForAllSkills(opts: RunnerOptions): Promise<void> {
  const startedAt = Date.now();
  const baseDir = join(opts.projectRoot, '.gossip', 'agents');

  // Count agents *before* counting skills so the entry log is meaningful even
  // when no agents/skills are present.
  let agentDirs: string[] = [];
  let canonicalBaseDir: string | undefined;
  if (existsSync(baseDir)) {
    try {
      canonicalBaseDir = realpathSync(baseDir);
      agentDirs = readdirSync(canonicalBaseDir);
    } catch { /* fall through — entry log + early-exit path still valid */ }
  }

  process.stderr.write(`[gossipcat] checkEffectiveness: scanning across ${agentDirs.length} agents\n`);

  let skillsChecked = 0;
  const transitions: TransitionCounts = {
    passed: 0,
    failed: 0,
    flagged_for_manual_review: 0,
    inconclusive: 0,
    pending: 0,
  };
  let lastError: string | null = null;

  if (canonicalBaseDir && agentDirs.length > 0) {
    for (const agentId of agentDirs) {
      // Skip synthetic/system dirs (e.g. `_project`) — they are not agents.
      if (agentId.startsWith('_')) continue;
      if (!SAFE_NAME.test(agentId)) continue;
      const skillsDir = join(canonicalBaseDir, agentId, 'skills');
      if (!existsSync(skillsDir)) continue;
      let canonicalSkillsDir: string;
      try {
        canonicalSkillsDir = realpathSync(skillsDir);
      } catch { continue; }
      // canonicalBaseDir is already absolute from realpathSync; trailing '/' prevents prefix collisions like '/agents-evil/'
      if (!canonicalSkillsDir.startsWith(canonicalBaseDir + '/')) {
        process.stderr.write(`[gossipcat] checkEffectiveness: skipping ${agentId} — skillsDir resolved outside agents tree (canonical=${canonicalSkillsDir})\n`);
        continue;
      }

      const role = opts.registryGet(agentId)?.role;
      // Implementers never get per-category accuracy checks
      if (role === 'implementer') continue;

      const files = readdirSync(canonicalSkillsDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const category = file.replace(/\.md$/, '');
        if (!SAFE_NAME.test(category)) continue;
        skillsChecked++;
        try {
          const verdict = await opts.skillEngine.checkEffectiveness(agentId, category, { role });
          if (verdict.shouldUpdate) {
            // Suppress phantom transitions: if the verdict writeback aborted
            // on version drift, skill-engine sets verdict.persisted=false. The
            // new status never landed on disk (skill-loader.ts will keep
            // reading stale frontmatter), so we must NOT log a transition or
            // increment health-file counters — both would lie to operators.
            // Consensus c491f76c-14e545b1.
            if (verdict.persisted !== false) {
              // Log every transition that changes operator-visible status: passed/failed/flagged
              const loggedStates = new Set(['passed', 'failed', 'flagged_for_manual_review']);
              if (loggedStates.has(verdict.status)) {
                process.stderr.write(
                  `[gossipcat] checkEffectiveness ${agentId}/${category}: ${verdict.status}` +
                  (verdict.effectiveness !== undefined ? ` (Δ=${verdict.effectiveness.toFixed(3)})` : '') +
                  `\n`,
                );
              }
              // Tally only verdict-bearing transitions; pending/inconclusive
              // states without shouldUpdate aren't operator-relevant.
              if ((transitions as any)[verdict.status] != null) {
                (transitions as any)[verdict.status]++;
              }
            }
          }
        } catch (e) {
          lastError = (e as Error).message;
          process.stderr.write(`[gossipcat] checkEffectiveness ${agentId}/${category} threw: ${lastError}\n`);
        }
      }
    }
  }

  const totalTransitions =
    transitions.passed +
    transitions.failed +
    transitions.flagged_for_manual_review +
    transitions.inconclusive +
    transitions.pending;
  const durationMs = Date.now() - startedAt;
  process.stderr.write(
    `[gossipcat] checkEffectiveness: done in ${durationMs}ms ` +
    `(skills: ${skillsChecked}, transitions: ${totalTransitions})\n`,
  );

  writeHealthAtomic(opts.projectRoot, {
    last_run_at: new Date(startedAt).toISOString(),
    last_run_duration_ms: durationMs,
    skills_evaluated: skillsChecked,
    transitions,
    last_error: lastError,
  });
}
