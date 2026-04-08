/**
 * @gossip/orchestrator — Archetype catalog with hybrid scoring.
 *
 * Loads archetype definitions from archetypes.json and scores them against
 * detected project signals + optional user message keywords.
 *
 * Path resolution follows the same multi-candidate pattern as rules-loader.ts
 * because esbuild bundles this module into dist-mcp/mcp-server.js, which
 * changes `__dirname` semantics relative to the source layout. Candidates
 * (in order): bundled prod (dist-mcp/data/), dev ts-node, repo-root dev.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { Archetype, ProjectSignals } from './types';

function findArchetypeCatalog(): string | null {
  const candidates = [
    resolve(__dirname, 'data', 'archetypes.json'),                    // bundled prod: dist-mcp/data/archetypes.json
    resolve(__dirname, '..', '..', '..', 'data', 'archetypes.json'), // dev ts-node: packages/orchestrator/src → repo/data
    resolve(process.cwd(), 'data', 'archetypes.json'),                // last-resort dev fallback
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export class ArchetypeCatalog {
  private archetypes: Record<string, Archetype>;

  constructor(catalogPath?: string) {
    const path = catalogPath ?? findArchetypeCatalog();
    if (!path) {
      throw new Error('archetypes.json not found — tried bundled dist-mcp/data/, dev ts-node path, and cwd/data/. Reinstall gossipcat.');
    }
    const raw = readFileSync(path, 'utf-8');
    this.archetypes = JSON.parse(raw) as Record<string, Archetype>;
  }

  /** Return all archetype IDs */
  ids(): string[] {
    return Object.keys(this.archetypes);
  }

  /** Get a single archetype by ID */
  get(id: string): Archetype | undefined {
    return this.archetypes[id];
  }

  /** Score archetypes against directory signals only (no user message). */
  scoreSignals(signals: ProjectSignals): Array<{ id: string; score: number }> {
    return this.ids().map((id) => {
      const arch = this.archetypes[id];
      let score = 0;
      for (const pkg of arch.signals.packages) {
        if (signals.dependencies.includes(pkg)) score += 3;
      }
      for (const dir of arch.signals.files) {
        if (signals.directories.some((d) => d === dir || d.startsWith(dir))) score += 2;
        if (signals.files.some((f) => f === dir || f.match(dir.replace('*', '.*')))) score += 1;
      }
      return { id, score };
    }).sort((a, b) => b.score - a.score);
  }

  /** Score with keyword boost from user message. */
  scoreWithMessage(signals: ProjectSignals, userMessage: string): Array<{ id: string; score: number }> {
    const base = this.scoreSignals(signals);
    const lower = userMessage.toLowerCase();
    return base.map(({ id, score }) => {
      const arch = this.archetypes[id];
      let boost = 0;
      for (const kw of arch.signals.keywords) {
        if (lower.includes(kw)) boost += 3;
      }
      return { id, score: score + boost };
    }).sort((a, b) => b.score - a.score);
  }

  /** Return top 3 candidates if any score > 0, otherwise all 19. */
  getTopCandidates(signals: ProjectSignals, userMessage?: string): Array<{ id: string; score: number }> {
    const scored = userMessage
      ? this.scoreWithMessage(signals, userMessage)
      : this.scoreSignals(signals);
    const hasNonZero = scored.some((s) => s.score > 0);
    return hasNonZero ? scored.slice(0, 3) : scored;
  }
}
