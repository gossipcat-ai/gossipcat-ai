// tests/orchestrator/prompt-corrections-render.test.ts
import { assemblePrompt } from '../../packages/orchestrator/src/prompt-assembler';

describe('assemblePrompt agentCorrections', () => {
  it('renders a Your Prior Corrections subsection under MEMORY', () => {
    const out = assemblePrompt({ task: 'do X', agentCorrections: ['read worktree path before claiming absence'] });
    expect(out).toContain('--- MEMORY ---');
    expect(out).toContain('### Your Prior Corrections');
    expect(out).toContain('1. read worktree path before claiming absence');
  });

  it('keeps corrections distinct from consensus findings', () => {
    const out = assemblePrompt({
      task: 'do X',
      consensusFindings: ['project-wide finding'],
      agentCorrections: ['my own prior miss'],
    });
    expect(out).toContain('### Recent Consensus Findings');
    expect(out).toContain('### Your Prior Corrections');
    expect(out.indexOf('### Recent Consensus Findings')).toBeLessThan(out.indexOf('### Your Prior Corrections'));
  });

  it('omits the subsection when there are no corrections', () => {
    const out = assemblePrompt({ task: 'do X' });
    expect(out).not.toContain('### Your Prior Corrections');
  });
});
