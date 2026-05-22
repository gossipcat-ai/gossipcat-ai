import { useEffect, useState } from 'react';
import { getWsState } from '@/lib/ws';
import { href, navigate, useRoute } from '@/lib/router';
import { useExpert } from '@/lib/useExpert';
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
  const expert = useExpert();
  const { theme, toggle: toggleTheme } = useTheme();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const themeStr = theme as any as string;

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
        <button
          onClick={() => navigate(expert ? '/' : '/?expert=1')}
          aria-label={expert ? 'Return to overview' : 'Switch to expert view'}
          className="font-mono text-[10px] uppercase tracking-widest border border-border/40 rounded-sm px-2.5 py-1 transition"
          style={{ color: expert ? 'var(--text)' : 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}
        >
          {expert ? '← Overview' : 'Expert view →'}
        </button>
        <button
          onClick={toggleTheme}
          aria-label={theme === 'editorial' ? 'Switch to default theme' : 'Switch to editorial theme'}
          title={theme === 'editorial' ? 'Switch to default theme' : 'Switch to editorial theme'}
          className={`font-mono text-[10px] uppercase tracking-widest border rounded-sm px-2.5 py-1 transition ${
            theme === 'editorial' ? 'border-border' : 'border-border/40'
          }`}
          style={{ color: themeStr === 'editorial' ? 'var(--text)' : 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}
        >
          {themeStr === 'editorial' ? 'Default' : 'Editorial'}
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
