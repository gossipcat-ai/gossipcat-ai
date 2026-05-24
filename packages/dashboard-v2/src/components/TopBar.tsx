import { useState } from 'react';
import { href, useRoute } from '@/lib/router';
import { useTheme } from '@/lib/useTheme';
import { GlossaryModal } from './GlossaryModal';

const TABS = [
  { to: '/', label: 'Dashboard', match: (r: string) => r === '/' || r === '/overview' },
  { to: '/team', label: 'Team', match: (r: string) => r === '/team' || r.startsWith('/agent/') },
  { to: '/debates', label: 'Consensus Rounds', match: (r: string) => r === '/debates' },
  { to: '/tasks', label: 'Tasks', match: (r: string) => r === '/tasks' },
  { to: '/signals', label: 'Signals', match: (r: string) => r === '/signals' },
  { to: '/logs', label: 'Logs', match: (r: string) => r === '/logs' },
];

export function TopBar() {
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const route = useRoute();
  const { theme, toggle } = useTheme();

  return (
    <nav className="relative flex items-center justify-between border-b border-border px-6 py-3.5">
      <div className="flex items-center gap-6">
        <a href={href('/')} className="flex items-center gap-3 leading-none">
          <img src="/dashboard/assets/gossip-mini.png" alt="" className="h-10 w-10 object-contain" />
          <span className="text-[17px] font-bold" style={{ color: 'var(--accent)' }}>gossipcat</span>
        </a>
        <div className="flex gap-1">
          {TABS.map((tab) => {
            const isActive = tab.match(route);
            return (
              <a
                key={tab.to}
                href={href(tab.to)}
                className={`rounded-md px-3.5 py-1.5 font-mono text-[13px] transition ${
                  isActive
                    ? 'font-semibold'
                    : 'hover:bg-accent/10'
                }`}
                style={isActive
                  ? { background: 'color-mix(in oklch, var(--accent) 10%, transparent)', color: 'var(--accent)' }
                  : { color: 'var(--ink-3)' }
                }
              >
                {tab.label}
              </a>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div
          role="button"
          tabIndex={-1}
          title="Search — coming soon"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            height: '32px',
            padding: '0 12px',
            minWidth: '220px',
            background: 'var(--surface-elev)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            color: 'var(--ink-3)',
            fontFamily: 'var(--font-sans)',
            fontSize: '13px',
            cursor: 'default',
          }}
        >
          <span style={{ opacity: 0.7 }}>Search…</span>
          <kbd
            style={{
              marginLeft: 'auto',
              padding: '1px 6px',
              borderRadius: '4px',
              background: 'var(--surface-sunk)',
              border: '1px solid var(--border)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              color: 'var(--ink-3)',
            }}
          >
            ⌘K
          </kbd>
        </div>
        <button
          type="button"
          onClick={toggle}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
          style={{
            width: '32px',
            height: '32px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--surface-elev)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            color: 'var(--ink)',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: 1,
          }}
        >
          {theme === 'light' ? '◐' : '◑'}
        </button>
        <button
          onClick={() => setGlossaryOpen(true)}
          aria-label="Open glossary"
          title="Glossary"
          className="flex items-center justify-center rounded-md border border-border/60 px-2 py-1 transition hover:border-border"
          style={{ background: 'var(--surface-elev)', color: 'var(--ink)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        </button>
      </div>
      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </nav>
  );
}
