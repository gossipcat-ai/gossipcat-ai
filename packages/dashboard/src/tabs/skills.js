// packages/dashboard/src/tabs/skills.js

async function renderSkills() {
  const container = document.getElementById('tab-skills');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const [skillsData, agents] = await Promise.all([
      window._dash.api('skills'),
      window._dash.api('agents'),
    ]);

    const index = skillsData.index;
    const agentIds = agents.map(a => a.id);

    // Collect all unique skill names across all agents
    const allSkills = new Set();
    for (const agentId of Object.keys(index)) {
      for (const skill of Object.keys(index[agentId])) {
        allSkills.add(skill);
      }
    }
    const skillNames = [...allSkills].sort();

    if (agentIds.length === 0) {
      container.innerHTML = '<div class="empty-state">No agents configured. Run gossip_setup to create your team.</div>';
      return;
    }

    if (skillNames.length === 0) {
      container.innerHTML = '<div class="empty-state">No skills bound yet. Skills are assigned when agents run tasks.</div>';
      return;
    }

    container.innerHTML = `
      <div class="panels">
        <div class="panel" style="grid-column:1/-1">
          <div class="panel-title">Skill Index</div>
          <div class="skills-grid-wrap">
            <table class="skills-grid">
              <thead>
                <tr>
                  <th class="skills-grid-corner"></th>
                  ${agentIds.map(id => `<th class="skills-grid-agent">${escapeHtml(id)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${skillNames.map(skill => `
                  <tr>
                    <td class="skills-grid-skill">${escapeHtml(skill)}</td>
                    ${agentIds.map(agentId => {
                      const slot = index[agentId]?.[skill];
                      if (!slot) return '<td class="skills-grid-cell unbound"></td>';
                      const cls = slot.enabled ? 'enabled' : 'disabled';
                      return `<td class="skills-grid-cell ${cls}" data-agent="${escapeHtml(agentId)}" data-skill="${escapeHtml(skill)}" data-enabled="${slot.enabled}">${slot.enabled ? '&#10003;' : '&#10005;'}</td>`;
                    }).join('')}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Click handlers for toggle cells
    container.querySelectorAll('.skills-grid-cell[data-agent]').forEach(cell => {
      cell.addEventListener('click', async () => {
        const agentId = cell.dataset.agent;
        const skill = cell.dataset.skill;
        const currentlyEnabled = cell.dataset.enabled === 'true';
        const newEnabled = !currentlyEnabled;

        cell.classList.add('toggling');
        try {
          const res = await fetch('/dashboard/api/skills/bind', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: agentId, skill, enabled: newEnabled }),
            credentials: 'include',
          });
          const result = await res.json();
          if (result.success) {
            cell.dataset.enabled = String(newEnabled);
            cell.className = `skills-grid-cell ${newEnabled ? 'enabled' : 'disabled'}`;
            cell.innerHTML = newEnabled ? '&#10003;' : '&#10005;';
          } else {
            cell.title = result.error || 'Toggle failed';
            cell.style.outline = '2px solid var(--status-disputed)';
            setTimeout(() => { cell.style.outline = ''; cell.title = ''; }, 2000);
          }
        } catch {
          cell.style.outline = '2px solid var(--status-disputed)';
          setTimeout(() => { cell.style.outline = ''; }, 2000);
        }
        cell.classList.remove('toggling');
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}
