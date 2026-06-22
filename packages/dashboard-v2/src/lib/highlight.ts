/**
 * Curated, tree-shakeable highlight.js wrapper for the dashboard markdown renderer.
 *
 * We import ONLY the core engine plus a fixed allowlist of languages (instead of
 * the full `highlight.js` build) to keep the bundle small. The exported
 * `highlightToHtml` is the single integration point for renderFindingMarkdown:
 * its output is always HTML-safe — hljs escapes its own output, and the
 * unknown-language fallback escapes manually with the SAME four replacements
 * renderFindingMarkdown's step-1 uses.
 */
import hljs from 'highlight.js/lib/core';

import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml); // covers html
hljs.registerLanguage('python', python);
hljs.registerLanguage('go', go);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);

/** Common short aliases → canonical registered language name. */
const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  sh: 'bash',
  shell: 'bash',
  html: 'xml',
  yml: 'yaml',
};

/** Same 4 replacements as renderFindingMarkdown step-1 — keeps escaping identical. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalize a raw fence language token to a canonical, registered name.
 * Lowercases, strips to a conservative charset, and resolves aliases.
 * Returns '' for an empty/unusable token.
 */
export function normalizeLang(lang?: string): string {
  if (!lang) return '';
  // Strip to a safe token charset BEFORE alias lookup so a hostile opener like
  // `ts"><img onerror=x>` collapses to `tsimgonerrorx` (unknown → plain fallback)
  // and can never survive into an attribute value.
  const cleaned = lang.toLowerCase().replace(/[^a-z0-9+-]/g, '');
  return LANG_ALIASES[cleaned] ?? cleaned;
}

/**
 * Highlight `code` for `lang`, returning HTML-safe markup.
 *
 * - Registered language → hljs.highlight(...).value (hljs escapes its output).
 * - Unknown/missing language → manually HTML-escaped plain text (no auto-detect,
 *   which is heavy and frequently mis-detects).
 *
 * The returned string is always safe to splice into innerHTML: every codepath
 * either passes through hljs's escaping or escapeHtml() above.
 */
export function highlightToHtml(code: string, lang?: string): string {
  const language = normalizeLang(lang);
  if (language && hljs.getLanguage(language)) {
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      // Defensive: never let a highlighter throw bubble into the renderer.
      return escapeHtml(code);
    }
  }
  return escapeHtml(code);
}
