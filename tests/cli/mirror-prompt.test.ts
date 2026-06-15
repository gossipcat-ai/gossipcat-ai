/**
 * Unit tests for the UserPromptSubmit mirror hook channel-tag dedup
 * (apps/cli/src/hooks/mirror-prompt.ts). Spec §Component 1 + sonnet:f10
 * (structural match, NOT loose substring).
 */
import { inspectPrompt } from '../../apps/cli/src/hooks/mirror-prompt';

describe('inspectPrompt — channel-wrapper dedup', () => {
  it('detects a dashboard-origin wrapper at the start of the prompt', () => {
    const r = inspectPrompt('<channel source="gossipcat" chat_id="abc123">do X</channel>');
    expect(r.isDashboardOrigin).toBe(true);
    // chat_id is intentionally NOT parsed (f13) — the relay seeds mirrorChatIds
    // from its own validated POST, never from this hook. PromptChannelMatch no
    // longer carries a chatId field (type-enforced).
    expect(Object.keys(r)).toEqual(['isDashboardOrigin']);
  });

  it('tolerates leading whitespace and reordered attributes', () => {
    const r = inspectPrompt('  \n<channel chat_id="zz" source="gossipcat">y</channel>');
    expect(r.isDashboardOrigin).toBe(true);
  });

  it('does NOT match a prompt that merely mentions the tag in prose (substring guard)', () => {
    const r = inspectPrompt('Please explain what <channel source="gossipcat"> means in our code.');
    // The tag is mid-sentence, not the structural opening — must be mirrored.
    expect(r.isDashboardOrigin).toBe(false);
  });

  it('does NOT match a different-source channel tag', () => {
    const r = inspectPrompt('<channel source="other" chat_id="x">hi</channel>');
    expect(r.isDashboardOrigin).toBe(false);
  });

  it('reports no wrapper for a plain prompt', () => {
    const r = inspectPrompt('just a normal terminal prompt');
    expect(r.isDashboardOrigin).toBe(false);
  });

  it('handles non-string input fail-open', () => {
    expect(inspectPrompt(undefined).isDashboardOrigin).toBe(false);
    expect(inspectPrompt(42).isDashboardOrigin).toBe(false);
  });
});
