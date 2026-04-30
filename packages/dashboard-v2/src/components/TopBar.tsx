import { useEffect, useState } from 'react';
import { getWsState } from '@/lib/ws';
import { href, useRoute } from '@/lib/router';
import { GlossaryModal } from './GlossaryModal';

const TABS = [
  { to: '/', label: 'Dashboard', match: (r: string) => r === '/' },
  { to: '/team', label: 'Team', match: (r: string) => r === '/team' || r.startsWith('/agent/') },
  { to: '/debates', label: 'Debates', match: (r: string) => r === '/debates' },
  { to: '/tasks', label: 'Tasks', match: (r: string) => r === '/tasks' },
  { to: '/signals', label: 'Signals', match: (r: string) => r === '/signals' },
  { to: '/logs', label: 'Logs', match: (r: string) => r === '/logs' },
];

export function TopBar() {
  const [online, setOnline] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const route = useRoute();

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
          <span className="text-[17px] font-bold text-primary">gossipcat</span>
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
                    ? 'bg-primary/10 font-semibold text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                {tab.label}
              </a>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setGlossaryOpen(true)}
          aria-label="Open glossary"
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card font-mono text-xs font-semibold text-muted-foreground transition hover:border-border hover:text-foreground"
        >
          ?
        </button>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3.5 py-1.5 font-mono text-xs text-muted-foreground">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-confirmed shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-destructive'}`} />
          {online ? 'Connected' : 'Disconnected'}
        </div>
      </div>
      <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
    </nav>
  );
}
