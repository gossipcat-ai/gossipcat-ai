import { useEffect, useState } from 'react';
import { getWsState } from '@/lib/ws';
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
  const [online, setOnline] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const route = useRoute();
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const interval = setInterval(() => {
      setOnline(getWsState() === WebSocket.OPEN);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

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
                  : { color: 'var(--text-dim)' }
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
            color: 'var(--text-faint)',
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
              color: 'var(--text-dim)',
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
            color: 'var(--text)',
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
          className="flex items-center justify-center rounded-md border border-border/60 px-2.5 py-1 font-mono text-xs font-semibold transition hover:border-border"
          style={{ background: 'var(--surface-elev)', color: 'var(--text)' }}
        >
          Glossary
        </button>
        <div className="flex items-center gap-2 rounded-md border border-border px-3.5 py-1.5 font-mono text-xs" style={{ background: 'var(--surface-elev)', color: 'var(--text-dim)' }}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-confirmed shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-destructive'}`} />
          {online ? 'Connected' : 'Disconnected'}
        </div>
      </div>
      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </nav>
  );
}
