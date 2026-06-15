/**
 * Unit tests for the Stop hook transcript parser
 * (apps/cli/src/hooks/mirror-stop.ts). Spec §Component 1 + Q2 + sonnet:f5/f6/f10.
 */
import { extractLastAssistantText } from '../../apps/cli/src/hooks/mirror-stop';

/** Build a JSONL transcript from entry objects. */
function jsonl(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

describe('extractLastAssistantText', () => {
  it('extracts the last assistant text block (top-level shape)', () => {
    const t = jsonl([
      { type: 'user', content: [{ type: 'text', text: 'hi' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    ]);
    expect(extractLastAssistantText(t)).toBe('hello there');
  });

  it('extracts from the nested message envelope shape', () => {
    const t = jsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'nested reply' }] } },
    ]);
    expect(extractLastAssistantText(t)).toBe('nested reply');
  });

  it('concatenates multiple text blocks in one entry', () => {
    const t = jsonl([
      { type: 'assistant', content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] },
    ]);
    expect(extractLastAssistantText(t)).toBe('line1\nline2');
  });

  it('skips thinking and tool_use blocks (allowlist text only)', () => {
    const t = jsonl([
      {
        type: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'the answer' },
        ],
      },
    ]);
    const out = extractLastAssistantText(t);
    expect(out).toBe('the answer');
    expect(out).not.toContain('secret reasoning');
    expect(out).not.toContain('ls');
  });

  it('returns null for a pure-tool-use final turn (send nothing)', () => {
    const t = jsonl([
      { type: 'assistant', content: [{ type: 'text', text: 'earlier' }] },
      { type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    ]);
    // The LAST assistant entry is tool-use only → walk backward → returns the
    // earlier text turn (an assistant text DID exist in the transcript).
    expect(extractLastAssistantText(t)).toBe('earlier');
  });

  it('returns null when no assistant text exists at all', () => {
    const t = jsonl([
      { type: 'user', content: [{ type: 'text', text: 'q' }] },
      { type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    ]);
    expect(extractLastAssistantText(t)).toBeNull();
  });

  it('returns null for a thinking-only assistant turn with no text', () => {
    const t = jsonl([
      { type: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
    ]);
    expect(extractLastAssistantText(t)).toBeNull();
  });

  it('skips a malformed JSONL line and keeps scanning backward', () => {
    const t = [
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'good' }] }),
      '{ this is not valid json',
    ].join('\n');
    expect(extractLastAssistantText(t)).toBe('good');
  });

  it('returns null for empty / missing input', () => {
    expect(extractLastAssistantText('')).toBeNull();
    expect(extractLastAssistantText(undefined as unknown as string)).toBeNull();
  });

  it('ignores tool_result that lives in user entries', () => {
    const t = jsonl([
      { type: 'user', content: [{ type: 'tool_result', content: 'OUTPUT LEAK' }] },
      { type: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ]);
    const out = extractLastAssistantText(t);
    expect(out).toBe('done');
    expect(out).not.toContain('OUTPUT LEAK');
  });
});
