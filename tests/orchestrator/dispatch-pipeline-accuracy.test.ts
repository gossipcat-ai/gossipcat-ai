
import { DispatchPipeline } from '@gossip/orchestrator';

/**
 * The weakness side of the skill-gap recommender is driven by categoryAccuracy
 * (correct/(correct+hallucinated)), not by categoryStrengths (additive, volume-
 * weighted). These tests lock in that split plus the two-factor gate:
 *   1. signal count ≥ MIN_CATEGORY_SIGNALS (5)
 *   2. accuracy below WEAKNESS_ACCURACY_THRESHOLD (0.3)
 * and that the peer median is computed on categoryStrengths (volume-aware
 * "is the team strong here?").
 */
describe('DispatchPipeline.getSkillGapSuggestions with categoryAccuracy', () => {
  let pipeline: DispatchPipeline;

  function setupPipeline(scores: Map<string, any>) {
    pipeline = new DispatchPipeline({
      projectRoot: '/tmp/gossip-test-' + Date.now(),
      workers: new Map(),
      registryGet: () => undefined,
    });
    // Stub the perfReader — we only need getScores for this test surface.
    (pipeline as any).perfReader = {
      getScores: () => scores,
    };
  }

  it('suggests a skill gap based on low categoryAccuracy, not categoryStrengths', () => {
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.7 },   // volume-strong on paper…
        categoryAccuracy: { 'testing': 0.2 },    // …but often wrong
        categoryCorrect: { 'testing': 1 },
        categoryHallucinated: { 'testing': 4 },
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.9 },
        categoryAccuracy: { 'testing': 0.9 },
        categoryCorrect: { 'testing': 9 },
        categoryHallucinated: { 'testing': 1 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].agentId).toBe('agent-a');
    expect(suggestions[0].category).toBe('testing');
    // score is accuracy, not strength — that's the whole point of this change
    expect(suggestions[0].score).toBe(0.2);
  });

  it('does NOT suggest a gap when signal count is below the threshold, even with very low accuracy', () => {
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.8 },
        categoryAccuracy: { 'testing': 0.0 },
        categoryCorrect: { 'testing': 0 },
        categoryHallucinated: { 'testing': 2 }, // only 2 signals, below the gate
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.9 },
        categoryAccuracy: { 'testing': 0.9 },
        categoryCorrect: { 'testing': 9 },
        categoryHallucinated: { 'testing': 1 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(0);
  });

  it('suggests a gap when signal count meets threshold and accuracy is low', () => {
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.8 },
        categoryAccuracy: { 'testing': 0.2 },
        categoryCorrect: { 'testing': 1 },
        categoryHallucinated: { 'testing': 4 }, // 5 signals total — meets threshold
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.9 },
        categoryAccuracy: { 'testing': 0.9 },
        categoryCorrect: { 'testing': 9 },
        categoryHallucinated: { 'testing': 1 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].agentId).toBe('agent-a');
  });

  it('uses categoryStrengths for the peer-median benchmark and categoryAccuracy for the weakness score', () => {
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.7 },  // contributes to median
        categoryAccuracy: { 'testing': 0.2 },   // weakness signal
        categoryCorrect: { 'testing': 1 },
        categoryHallucinated: { 'testing': 4 },
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.9 },  // contributes to median
        categoryAccuracy: { 'testing': 0.9 },
        categoryCorrect: { 'testing': 9 },
        categoryHallucinated: { 'testing': 1 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].agentId).toBe('agent-a');
    expect(suggestions[0].score).toBe(0.2);              // accuracy
    expect(suggestions[0].median).toBeCloseTo(0.8);      // median of strengths [0.7, 0.9]
  });

  it('does NOT suggest a gap when peer median on strengths is below the threshold', () => {
    // Even though agent-a has low accuracy, if the team is not collectively strong
    // in this category there is no peer benchmark to justify the suggestion.
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.1 },
        categoryAccuracy: { 'testing': 0.2 },
        categoryCorrect: { 'testing': 1 },
        categoryHallucinated: { 'testing': 4 },
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.2 },  // median = 0.15, below 0.6
        categoryAccuracy: { 'testing': 0.5 },
        categoryCorrect: { 'testing': 5 },
        categoryHallucinated: { 'testing': 5 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(0);
  });

  it('skips categories with missing categoryAccuracy (insufficient data signal from reader)', () => {
    // The PerformanceReader only populates categoryAccuracy when N ≥ 5. A missing
    // entry should be read as "not enough data" and NOT silently default to 0 —
    // otherwise every under-sampled category would light up as a weakness.
    const scores = new Map([
      ['agent-a', {
        agentId: 'agent-a',
        categoryStrengths: { 'testing': 0.7 },
        categoryAccuracy: {}, // reader withheld this category
        categoryCorrect: { 'testing': 1 },
        categoryHallucinated: { 'testing': 4 },
      }],
      ['agent-b', {
        agentId: 'agent-b',
        categoryStrengths: { 'testing': 0.9 },
        categoryAccuracy: { 'testing': 0.9 },
        categoryCorrect: { 'testing': 9 },
        categoryHallucinated: { 'testing': 1 },
      }],
    ]);
    setupPipeline(scores);

    const suggestions = pipeline.getSkillGapSuggestions();

    expect(suggestions).toHaveLength(0);
  });
});
