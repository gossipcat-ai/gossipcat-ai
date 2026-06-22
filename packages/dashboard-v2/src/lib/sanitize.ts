/**
 * HTML-escaping helpers for dashboard strings rendered via
 * `dangerouslySetInnerHTML`.
 *
 * Context: the dashboard uses innerHTML in several places to render findings,
 * markdown, and evidence with inline styled spans. When the underlying string
 * comes from agent output — specifically from parse diagnostics like
 * `HTML_ENTITY_ENCODED_TAGS` where the message quotes `&lt;agent_finding&gt;`
 * — we MUST escape before inserting, or the entity sample becomes a live
 * `<agent_finding>` tag in the DOM. That opens XSS if an agent's output
 * contains attacker-controlled HTML.
 *
 * Use `escapeHtml` for any diagnostic field (messages, code lists, token
 * samples) that gets concatenated into an innerHTML-rendered string.
 */

/**
 * Escape the five HTML-significant characters: `&`, `<`, `>`, `"`, `'`.
 * Safe for insertion into element text or double-quoted attributes.
 */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
