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

  it('loads all 19 archetypes', () => {
    expect(catalog.ids()).toHaveLength(19);
  });

  it('gets archetype by id', () => {
    const arch = catalog.get('game-dev');
    expect(arch).toBeDefined();
    expect(arch!.name).toBe('Game Dev');
    expect(arch!.roles.length).toBeGreaterThan(0);
  });

  it('scores game-dev highest for game signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['phaser'],
      directories: ['assets/'],
      files: [],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('game-dev');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('scores api-backend highest for API signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['express'],
      directories: [],
      files: ['Dockerfile'],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('api-backend');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('scores blockchain-web3 for solidity signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['hardhat'],
      directories: ['contracts/'],
      files: [],
    };
    const scored = catalog.scoreSignals(signals);
    expect(scored[0].id).toBe('blockchain-web3');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('returns zero scores for no signals', () => {
    const scored = catalog.scoreSignals(emptySignals());
    expect(scored.every((s) => s.score === 0)).toBe(true);
  });

  it('boosts scores based on user message keywords', () => {
    const scored = catalog.scoreWithMessage(emptySignals(), 'build a game with sprites');
    expect(scored[0].id).toBe('game-dev');
    expect(scored[0].score).toBeGreaterThan(0);
  });

  it('user message overrides directory signals', () => {
    const signals: ProjectSignals = {
      dependencies: ['express'],
      directories: [],
      files: [],
    };
    const scored = catalog.scoreWithMessage(signals, 'build a game with sprites and levels');
    // "game", "sprite", "level" = 9 keyword boost for game-dev vs 3 for express in api-backend
    expect(scored[0].id).toBe('game-dev');
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

  it('returns all 19 when all scores are zero', () => {
    const candidates = catalog.getTopCandidates(emptySignals());
    expect(candidates).toHaveLength(19);
  });
});
