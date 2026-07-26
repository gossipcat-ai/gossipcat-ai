// tests/orchestrator/prompt-retrieved-lessons.test.ts
//
// Issue #669 — assemblePrompt wiring for the auto-injected RECALLED LESSONS block.
import { assemblePrompt } from '../../packages/orchestrator/src/prompt-assembler';
import {
  renderLessonBlock,
  LESSON_CLAMP_LINE,
  type SelectedLesson,
} from '../../packages/orchestrator/src/lesson-injector';

const card = (overrides: Partial<SelectedLesson> = {}): SelectedLesson => ({
  source: 'lesson-hallucination-caught-abc.md',
  surface: '_project',
  originAgent: 'orchestrator',
  findingId: 'aa11bb22-cc33dd44:orchestrator:f1',
  score: 12,
  excerpt: 'Never build dist-mcp inside a git worktree — nested zod is unreachable.',
  truncated: false,
  ...overrides,
});

describe('assemblePrompt retrievedLessons', () => {
  it('renders the block with its clamp when lessons are supplied', () => {
    const out = assemblePrompt({
      task: 'rebuild dist-mcp',
      retrievedLessons: renderLessonBlock([card()]),
    });
    expect(out).toContain('--- RECALLED LESSONS ---');
    expect(out).toContain(LESSON_CLAMP_LINE);
    expect(out).toContain('nested zod is unreachable');
  });

  it('emits no section at all for an empty block', () => {
    const out = assemblePrompt({
      task: 'rebuild dist-mcp',
      retrievedLessons: renderLessonBlock([]) || undefined,
    });
    expect(out).not.toContain('RECALLED LESSONS');
    expect(out).not.toContain('retrieved_knowledge');
  });

  it('places lessons before the TASK segment so the task stays last', () => {
    const out = assemblePrompt({
      task: 'rebuild dist-mcp',
      retrievedLessons: renderLessonBlock([card()]),
    });
    expect(out.indexOf('--- RECALLED LESSONS ---')).toBeLessThan(out.indexOf('Task: rebuild dist-mcp'));
  });

  it('coexists with MEMORY without merging into it', () => {
    const out = assemblePrompt({
      task: 'rebuild dist-mcp',
      memory: 'my own knowledge file contents',
      retrievedLessons: renderLessonBlock([card()]),
    });
    expect(out).toContain('--- MEMORY ---');
    expect(out).toContain('--- RECALLED LESSONS ---');
    expect(out.indexOf('--- END RECALLED LESSONS ---')).toBeLessThan(out.indexOf('--- MEMORY ---'));
  });
});
