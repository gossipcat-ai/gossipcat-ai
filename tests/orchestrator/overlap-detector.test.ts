import { OverlapDetector } from '../../packages/orchestrator/src/overlap-detector';
import type { AgentConfig } from '../../packages/orchestrator/src/types';

function agent(id: string, preset: string, skills: string[]): AgentConfig {
  return { id, provider: 'google', model: 'gemini-2.5-pro', preset, skills };
}

describe('OverlapDetector', () => {
  const detector = new OverlapDetector();

  it('detects redundant overlap (same preset, shared skills)', () => {
    const agents = [
      agent('gemini-rev', 'reviewer', ['code_review', 'security_audit']),
      agent('gpt-rev', 'reviewer', ['code_review', 'typescript']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.sharedSkills).toContain('code_review');
    expect(result.pairs[0].type).toBe('redundant');
  });

  it('detects complementary overlap (different presets, shared skills)', () => {
    const agents = [
      agent('rev', 'reviewer', ['code_review', 'security_audit']),
      agent('dbg', 'debugger', ['code_review', 'debugging']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs[0].type).toBe('complementary');
  });

  it('returns no overlaps when skills are disjoint', () => {
    const agents = [
      agent('rev', 'reviewer', ['code_review']),
      agent('impl', 'implementer', ['typescript']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(false);
    expect(result.pairs).toHaveLength(0);
  });

  it('returns no overlaps for a single agent', () => {
    const result = detector.detect([agent('rev', 'reviewer', ['code_review'])]);
    expect(result.hasOverlaps).toBe(false);
  });

  it('handles multiple pairs of overlaps', () => {
    const agents = [
      agent('a', 'reviewer', ['code_review', 'debugging']),
      agent('b', 'reviewer', ['code_review', 'typescript']),
      agent('c', 'tester', ['debugging', 'testing']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs.length).toBeGreaterThanOrEqual(2);
  });

  // Additional edge cases from tester review:
  it('handles agents with undefined preset (defaults to custom)', () => {
    const a1: AgentConfig = { id: 'a', provider: 'google', model: 'x', skills: ['code_review'] };
    const a2: AgentConfig = { id: 'b', provider: 'google', model: 'x', skills: ['code_review'] };
    const result = detector.detect([a1, a2]);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs[0].type).toBe('redundant'); // both "custom"
  });

  it('handles agents with empty skills array', () => {
    const agents = [
      agent('a', 'reviewer', []),
      agent('b', 'reviewer', []),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(false);
  });

  it('formatWarning returns null when no redundant pairs', () => {
    const agents = [
      agent('rev', 'reviewer', ['code_review']),
      agent('dbg', 'debugger', ['code_review']),
    ];
    const result = detector.detect(agents);
    expect(detector.formatWarning(result)).toBeNull(); // complementary, not redundant
  });

  it('formatWarning returns warning string for redundant pairs', () => {
    const agents = [
      agent('gemini-rev', 'reviewer', ['code_review']),
      agent('gpt-rev', 'reviewer', ['code_review']),
    ];
    const result = detector.detect(agents);
    const warning = detector.formatWarning(result);
    expect(warning).toContain('gemini-rev');
    expect(warning).toContain('gpt-rev');
    expect(warning).toContain('code_review');
  });

  it('detects three-way overlaps as separate pairs', () => {
    const agents = [
      agent('a', 'reviewer', ['code_review', 'security']),
      agent('b', 'reviewer', ['code_review', 'typescript']),
      agent('c', 'tester', ['code_review', 'testing']),
    ];
    const result = detector.detect(agents);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs).toHaveLength(3); // (a,b), (a,c), (b,c)
  });

  it('handles empty agent list', () => {
    const result = detector.detect([]);
    expect(result.hasOverlaps).toBe(false);
    expect(result.pairs).toHaveLength(0);
  });

  it('native agents participate in overlap detection', () => {
    const nativeAgent: AgentConfig = { id: 'claude-rev', provider: 'anthropic', model: 'claude-sonnet-4-6', preset: 'reviewer', skills: ['code_review'], native: true };
    const customAgent = agent('gemini-rev', 'reviewer', ['code_review']);
    const result = detector.detect([nativeAgent, customAgent]);
    expect(result.hasOverlaps).toBe(true);
    expect(result.pairs[0].type).toBe('redundant');
  });
});
