// packages/dashboard/src/lib/markdown.js — Simple markdown renderer (extracted from Phase 1)

function renderMarkdown(md) {
  const esc = window._dash.escapeHtml;

  // Extract code blocks BEFORE escaping
  const codeBlocks = [];
  let processed = md.replace(/```[\s\S]*?```/g, (m) => {
    const content = m.slice(3, -3).replace(/^[^\n]*\n/, '');
    const placeholder = '\x00CODE' + codeBlocks.length + '\x00';
    codeBlocks.push('<pre class="memory-code">' + esc(content) + '</pre>');
    return placeholder;
  });

  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = '\x00INLINE' + inlineCodes.length + '\x00';
    inlineCodes.push('<code>' + esc(code) + '</code>');
    return placeholder;
  });

  let html = esc(processed);

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links: safe schemes only, escape URL
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^(https?:\/\/|knowledge\/|#)/.test(url)) return '<a href="' + esc(url) + '">' + text + '</a>';
    return text;
  });

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*(<(?:h[1-4]|ul|pre|li)[^>]*>)/g, '$1');
  html = html.replace(/(<\/(?:h[1-4]|ul|pre|li)>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*<\/p>/g, '');

  // Restore placeholders
  codeBlocks.forEach((block, i) => { html = html.replace('\x00CODE' + i + '\x00', block); });
  inlineCodes.forEach((code, i) => { html = html.replace('\x00INLINE' + i + '\x00', code); });

  return html;
}
