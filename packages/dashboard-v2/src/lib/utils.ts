import { highlightToHtml, normalizeLang } from './highlight';

/**
 * Render markdown text to safe HTML for task descriptions and similar content.
 * Extends cleanFindingTags with heading and list support.
 * All HTML is escaped first — no raw HTML passthrough, so XSS is blocked.
 */
export function renderMarkdown(text: string): string {
  // Step 1: HTML-escape everything
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Step 2: Code fences (must run before inline backtick pass)
  out = out.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="md-code-block"><code>${code.trimEnd()}</code></pre>`;
  });

  // Step 3: Inline code
  out = out.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Step 4: Bold then italic (order matters — ** before *)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Step 5: Headings — process line by line
  const lines = out.split('\n');
  const processedLines: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ATX headings: ### → h3, ## → h2, # → h1
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);

    if (h3) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h3 class="md-h3">${h3[1]}</h3>`);
      continue;
    }
    if (h2) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h2 class="md-h2">${h2[1]}</h2>`);
      continue;
    }
    if (h1) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h1 class="md-h1">${h1[1]}</h1>`);
      continue;
    }

    // Unordered list items: "- " or "* "
    const li = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (li) {
      if (!inList) { processedLines.push('<ul class="md-list">'); inList = true; }
      processedLines.push(`<li>${li[2]}</li>`);
      continue;
    }

    // Blank line closes an open list
    if (line.trim() === '') {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push('');
      continue;
    }

    // Regular paragraph line
    if (inList) { processedLines.push('</ul>'); inList = false; }
    processedLines.push(line);
  }

  if (inList) processedLines.push('</ul>');

  return processedLines.join('\n');
}

/** Clean and sanitize finding text for safe HTML rendering */
export function cleanFindingTags(text: string): string {
  // Step 1: Escape all HTML to prevent XSS
  let cleaned = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Step 2: Strip [FINDING]/[SUGGESTION]/[INSIGHT] prefixes
  cleaned = cleaned.replace(/^\[(FINDING|SUGGESTION|INSIGHT)\]\s*/i, '');

  // Step 3: Re-apply safe styling for known tags (on the escaped text)
  // <agent_finding> → strip wrapper
  cleaned = cleaned.replace(/&lt;agent_finding[^&]*&gt;/g, '');
  cleaned = cleaned.replace(/&lt;\/agent_finding&gt;/g, '');
  // <cite tag="file"> → blue code span
  cleaned = cleaned.replace(/&lt;cite\s+tag=&quot;file&quot;&gt;([^&]+)&lt;\/cite&gt;/g, '<code class="cite-file">$1</code>');
  // <cite tag="fn"> → purple code span
  cleaned = cleaned.replace(/&lt;cite\s+tag=&quot;fn&quot;&gt;([^&]+)&lt;\/cite&gt;/g, '<code class="cite-fn">$1</code>');
  // Legacy <fn> → purple code span
  cleaned = cleaned.replace(/&lt;fn&gt;([^&]+)&lt;\/fn&gt;/g, '<code class="cite-fn">$1</code>');

  // Markdown code blocks: ```...``` → <pre><code>
  cleaned = cleaned.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="inline-code-block"><code>$2</code></pre>');
  // Inline backticks: `...` → <code>
  cleaned = cleaned.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Markdown bold: **text** → <strong> (run before italic so ** isn't eaten by *)
  cleaned = cleaned.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>');
  // Markdown italic: *text* → <em> (avoid matching ** already consumed)
  cleaned = cleaned.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  return cleaned;
}

// Sentinel marker char (U+0000 NUL). Defined via fromCharCode so NO literal NUL
// byte ever appears in this source file — that keeps the token unambiguous across
// editors/encodings while remaining a char that can never appear in legitimate
// markdown input and is NOT in the HTML-escape map (so it survives Step 1 intact).
const FENCE_NUL = String.fromCharCode(0);
const FENCE_STRIP_RE = new RegExp(FENCE_NUL, 'g');
// Matches the exact tokens we emit: NUL + "HLJS" + index + NUL.
const FENCE_TOKEN_RE = new RegExp(`${FENCE_NUL}HLJS(\\d+)${FENCE_NUL}`, 'g');

/**
 * Unified markdown renderer for agent findings, signal evidence, and task results.
 * Superset of both cleanFindingTags (cite tags, prefix strip) and renderMarkdown
 * (headings, lists). Use this for all agent-authored content.
 */
export function renderFindingMarkdown(text: string): string {
  // Step 0: Extract code fences from the RAW (un-escaped) source BEFORE any
  // escaping, because highlight.js needs the original characters. Each fence is
  // replaced with a sentinel token that is re-substituted AFTER the pipeline.
  //
  // XSS safety of the sentinel: the marker char (U+0000) is stripped from the
  // input first, so a user can never forge a sentinel. We only ever substitute
  // back the exact tokens we inserted, matched by numeric index, and the
  // replacement HTML is built from hljs-escaped (or manually-escaped) body plus a
  // charset-sanitized language class — no raw user text reaches the DOM as markup.
  const fences: Array<{ lang: string; body: string }> = [];
  // Strip any pre-existing sentinel char so it can't be used to forge a token.
  let work = text.replace(FENCE_STRIP_RE, '');
  // Known limitation: the non-greedy body stops at the FIRST ``` it sees, so a
  // fence whose body itself contains ``` (e.g. a markdown-demonstrating example)
  // is truncated. This is a rendering edge, not a security issue (all output is
  // escaped); a faithful fix needs a real block parser, out of scope here.
  work = work.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang: string, body: string) => {
    const i = fences.length;
    fences.push({ lang, body });
    return `${FENCE_NUL}HLJS${i}${FENCE_NUL}`;
  });

  // Step 1: HTML-escape everything
  let out = work
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Step 2: Strip [FINDING]/[SUGGESTION]/[INSIGHT] prefixes
  out = out.replace(/^\[(FINDING|SUGGESTION|INSIGHT)\]\s*/i, '');

  // Step 3: Strip <agent_finding> wrapper tags (escaped)
  out = out.replace(/&lt;agent_finding[^&]*&gt;/g, '');
  out = out.replace(/&lt;\/agent_finding&gt;/g, '');

  // Step 4: Re-apply safe cite tags (on the now-escaped text)
  // <cite tag="file"> → blue code span
  out = out.replace(/&lt;cite\s+tag=&quot;file&quot;&gt;([^&]+)&lt;\/cite&gt;/g, '<code class="cite-file">$1</code>');
  // <cite tag="fn"> → purple code span
  out = out.replace(/&lt;cite\s+tag=&quot;fn&quot;&gt;([^&]+)&lt;\/cite&gt;/g, '<code class="cite-fn">$1</code>');
  // Legacy <fn> → purple code span
  out = out.replace(/&lt;fn&gt;([^&]+)&lt;\/fn&gt;/g, '<code class="cite-fn">$1</code>');

  // Step 5: Code fences are handled out-of-band (extracted pre-escape in Step 0,
  // re-substituted after the line pipeline below). No regex here.

  // Step 6: Inline code
  out = out.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

  // Step 7: Bold then italic (order matters — ** before *)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // Step 8: Headings and lists — process line by line
  const lines = out.split('\n');
  const processedLines: string[] = [];
  let inList = false;

  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const h1 = line.match(/^#\s+(.+)$/);

    if (h3) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h3 class="md-h3">${h3[1]}</h3>`);
      continue;
    }
    if (h2) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h2 class="md-h2">${h2[1]}</h2>`);
      continue;
    }
    if (h1) {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push(`<h1 class="md-h1">${h1[1]}</h1>`);
      continue;
    }

    // Unordered list items: "- " or "* "
    const li = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (li) {
      if (!inList) { processedLines.push('<ul class="md-list">'); inList = true; }
      processedLines.push(`<li>${li[2]}</li>`);
      continue;
    }

    // Blank line closes an open list
    if (line.trim() === '') {
      if (inList) { processedLines.push('</ul>'); inList = false; }
      processedLines.push('');
      continue;
    }

    // Regular line — close list if open
    if (inList) { processedLines.push('</ul>'); inList = false; }
    processedLines.push(line);
  }

  if (inList) processedLines.push('</ul>');

  out = processedLines.join('\n');

  // Step 9: Re-substitute code fences extracted in Step 0. The sentinel survived
  // the escape pass verbatim (NUL is not in the escape map) and the line pipeline
  // (NUL matches no heading/list/bold/italic rule). Each token is matched by the
  // exact index we assigned, so collisions/forgery are impossible. The replacement
  // HTML is fully escape-safe: highlightToHtml returns hljs- or manually-escaped
  // markup, and the language class is normalized to /^[a-z0-9+-]*$/i so it cannot
  // break out of the attribute.
  out = out.replace(FENCE_TOKEN_RE, (_m, idxStr: string) => {
    const fence = fences[Number(idxStr)];
    if (!fence) return '';
    const safeLang = normalizeLang(fence.lang); // charset-stripped to [a-z0-9+-]*
    const classAttr = safeLang ? ` language-${safeLang}` : '';
    const body = highlightToHtml(fence.body.replace(/\n$/, ''), fence.lang);
    return `<pre class="md-code-block"><code class="hljs${classAttr}">${body}</code></pre>`;
  });

  return out;
}

export function timeAgo(ts: string | number): string {
  const now = Date.now();
  const then = typeof ts === 'string' ? new Date(ts).getTime() : ts;
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

export function formatDuration(ms?: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}

export function agentInitials(id: string): string {
  const parts = id.split('-').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || id).slice(0, 2).toUpperCase();
}

/** Fallback for agents not in AGENT_IDENTITY_TABLE — uses DESIGN.md chart palette --c1..--c7 hex values. */
const AGENT_COLORS = [
  '#3F8B86', // --c1 teal
  '#8C5E97', // --c2 plum
  '#B47A2A', // --c3 ochre
  '#2F7D5B', // --c4 sage
  '#A53A4A', // --c5 rose
  '#6B6862', // --c6 slate
  '#C8A45A', // --c7 sand
];

/** Per-agent identity color table — sourced from DESIGN.md §Per-agent identity */
const AGENT_IDENTITY_TABLE: Record<string, string> = {
  'sonnet-reviewer':    '#8C5E97', // plum
  'sonnet-designer':    '#C8A45A', // sand
  'sonnet-implementer': '#A53A4A', // rose
  'opus-implementer':   '#C97056', // terracotta
  'gemini-reviewer':    '#3F8B86', // teal
  'gemini-tester':      '#2F7D5B', // sage
  'haiku-researcher':   '#6B7A85', // slate
};

export function agentColor(id: string): string {
  if (AGENT_IDENTITY_TABLE[id]) return AGENT_IDENTITY_TABLE[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}
