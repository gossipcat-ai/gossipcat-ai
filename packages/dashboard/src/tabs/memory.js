// packages/dashboard/src/tabs/memory.js

async function renderMemory() {
  const container = document.getElementById('tab-memory');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const agents = await window._dash.api('agents');

    if (agents.length === 0) {
      container.innerHTML = '<div class="empty-state">No agents configured.</div>';
      return;
    }

    container.innerHTML = `
      <div class="memory-agent-pills">
        <button class="memory-agent-pill" data-agent="_project">
          _project <span class="agent-badge">shared</span>
        </button>
        ${agents.map(a => `<button class="memory-agent-pill" data-agent="${escapeHtml(a.id)}">
          ${escapeHtml(a.id)}
          ${a.native ? '<span class="agent-badge">native</span>' : ''}
        </button>`).join('')}
      </div>
      <div id="memory-content"><div class="empty-state">Select an agent above</div></div>
    `;

    container.querySelectorAll('.memory-agent-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        container.querySelectorAll('.memory-agent-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        loadAgentMemory(pill.dataset.agent);
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadAgentMemory(agentId) {
  const content = document.getElementById('memory-content');
  content.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const data = await window._dash.api(`memory/${encodeURIComponent(agentId)}`);

    const sections = [];

    // Build knowledge lookup for inline expansion
    const knowledgeMap = {};
    for (const k of data.knowledge) {
      knowledgeMap[k.filename] = k;
    }

    // MEMORY.md index
    if (data.index) {
      sections.push(`
        <div class="panel">
          <div class="panel-title">MEMORY.md</div>
          <div class="memory-md" id="memory-md-content">${renderMarkdown(data.index)}</div>
        </div>
      `);
    }

    // Knowledge files
    if (data.knowledge.length > 0) {
      const files = data.knowledge.map(k => {
        const desc = k.frontmatter.description || k.frontmatter.name || k.filename;
        const isCognitive = k.content.includes('You reviewed') || k.content.includes('cognitive');
        return `
          <div class="memory-file ${isCognitive ? 'cognitive' : ''}">
            <div class="memory-file-header" onclick="this.nextElementSibling.hidden = !this.nextElementSibling.hidden">
              <span class="expand-icon">+</span>
              <span class="memory-filename">${escapeHtml(k.filename)}</span>
              <span class="memory-desc">${escapeHtml(desc)}</span>
              ${isCognitive ? '<span class="agent-badge">cognitive</span>' : ''}
            </div>
            <pre class="memory-file-content" hidden>${escapeHtml(k.content)}</pre>
          </div>
        `;
      }).join('');

      sections.push(`
        <div class="panel">
          <div class="panel-title">Knowledge Files (${data.knowledge.length})</div>
          ${files}
        </div>
      `);
    }

    // Tasks
    if (data.tasks.length > 0) {
      const rows = data.tasks.slice(-50).reverse().map(t => `
        <tr>
          <td class="memory-task-date">${t.timestamp ? new Date(t.timestamp).toLocaleDateString() : '-'}</td>
          <td>${escapeHtml(String(t.task || t.result || '-').slice(0, 120))}</td>
          <td>${t.importance != null ? t.importance : '-'}</td>
        </tr>
      `).join('');

      sections.push(`
        <div class="panel">
          <div class="panel-title">Recent Tasks (${data.tasks.length})</div>
          <div class="skills-grid-wrap">
            <table class="skills-grid">
              <thead><tr><th>Date</th><th>Summary</th><th>Imp.</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      `);
    }

    if (sections.length === 0) {
      content.innerHTML = '<div class="empty-state">No memory data for this agent.</div>';
    } else {
      content.innerHTML = `<div class="memory-panels">${sections.join('')}</div>`;

      // Wire up knowledge/ links in MEMORY.md to expand inline
      const mdContent = document.getElementById('memory-md-content');
      if (mdContent) {
        mdContent.querySelectorAll('a').forEach(link => {
          const href = link.getAttribute('href');
          // Prevent all local links from navigating
          if (href && !href.startsWith('http')) {
            link.href = '#';
          }
          if (!href || !href.startsWith('knowledge/')) return;
          const filename = href.replace('knowledge/', '');
          const entry = knowledgeMap[filename];
          if (!entry) { link.style.opacity = '0.5'; return; }
          link.style.cursor = 'pointer';
          link.addEventListener('click', (e) => {
            e.preventDefault();
            let detail = link.nextElementSibling;
            if (detail && detail.classList.contains('memory-inline-detail')) {
              detail.hidden = !detail.hidden;
              return;
            }
            detail = document.createElement('pre');
            detail.className = 'memory-file-content memory-inline-detail';
            detail.textContent = entry.content;
            link.parentNode.insertBefore(detail, link.nextSibling);
          });
        });
      }
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMarkdown(md) {
  // Extract code blocks BEFORE escaping to prevent double-encoding
  const codeBlocks = [];
  let processed = md.replace(/```[\s\S]*?```/g, (m) => {
    const content = m.slice(3, -3).replace(/^[^\n]*\n/, ''); // strip language hint
    const placeholder = `\x00CODE${codeBlocks.length}\x00`;
    codeBlocks.push('<pre class="memory-code">' + escapeHtml(content) + '</pre>');
    return placeholder;
  });

  const inlineCodes = [];
  processed = processed.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `\x00INLINE${inlineCodes.length}\x00`;
    inlineCodes.push('<code>' + escapeHtml(code) + '</code>');
    return placeholder;
  });

  // Now escape the rest
  let html = escapeHtml(processed);

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links: [text](url) — only allow safe schemes
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (/^(https?:\/\/|knowledge\/|#)/.test(url)) return `<a href="${url}">${text}</a>`;
    return text; // strip unsafe links (javascript:, data:, etc.)
  });

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Paragraphs: double newlines
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs around block elements
  html = html.replace(/<p>\s*(<(?:h[1-4]|ul|pre|li)[^>]*>)/g, '$1');
  html = html.replace(/(<\/(?:h[1-4]|ul|pre|li)>)\s*<\/p>/g, '$1');
  html = html.replace(/<p>\s*<\/p>/g, '');

  // Restore code blocks and inline code from placeholders
  codeBlocks.forEach((block, i) => { html = html.replace(`\x00CODE${i}\x00`, block); });
  inlineCodes.forEach((code, i) => { html = html.replace(`\x00INLINE${i}\x00`, code); });

  return html;
}
