import { resolve } from 'path';
import { ArchetypeCatalog } from '../../packages/orchestrator/src/archetype-catalog';
import type { ProjectSignals } from '../../packages/orchestrator/src/types';

const CATALOG_PATH = resolve(__dirname, '..', '..', 'data', 'archetypes.json');

function emptySignals(): ProjectSignals {
  return { dependencies: [], directories: [], files: [] };
}

describe('ArchetypeCatalog', () => {
  let catalog: ArchetypeCatalog;

  beforeAll(() => {
    catalog = new ArchetypeCatalog(CATALOG_PATH);
  });

  it('loads all 17 archetypes', () => {
    expect(catalog.ids()).toHaveLength(17);
  });

  it('gets archetype by id', () => {
    const arch = catalog.get('game');
    expect(arch).toBeDefined();
    expect(arch!.roles.length).toBeGreaterThan(0);
  });

  it('scores game highest for game signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['phaser'],
      directories: ['assets/'],
      files: [],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('game');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('scores api-service highest for API signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['express'],
      directories: [],
      files: ['Dockerfile'],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('api-service');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('scores blockchain for solidity signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['hardhat'],
      directories: ['contracts/'],
      files: [],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('blockchain');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('returns zero scores for no signals', () => {
    const scored = catalog.scoreSignals(emptySignals());
    expect(scored.every((s) => s.score === 0)).toBe(true);
  });

  it('boosts scores based on user message keywords', () => {
    const scored = catalog.scoreWithMessage(emptySignals(), 'build a game with sprites');
    expect(scored[0].id).toBe('game');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('user message overrides directory signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['express'],
      directories: [],
      files: [],
    };
    const scored = catalog.scoreWithMessage(signals, 'build a game with sprites and levels');
    expect(scored[0].id).toBe('game');
  });

  it('returns top 3 candidates when scores exist', () => {
    const signals: ProjectSignals = {
      dependencies: ['express'],
      directories: ['components/'],
      files: [],
    };
    const candidates = catalog.getTopCandidates(signals);
    expect(candidates).toHaveLength(3);
    expect(candidates[0].score).toBeGreaterThan(0);
  });

  it('returns all 17 when all scores are zero', () => {
    const candidates = catalog.getTopCandidates(emptySignals());
    expect(candidates).toHaveLength(17);
  });
});
