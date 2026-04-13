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

const AGENT_COLORS = [
  '#8b5cf6', '#06b6d4', '#f97316', '#34d399',
  '#f43f5e', '#fbbf24', '#60a5fa', '#e879f9',
];

export function agentColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}
