import { useEffect, useState } from 'react';
import { getWsState } from '@/lib/ws';

export function TopBar() {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setOnline(getWsState() === WebSocket.OPEN);
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <nav className="flex items-center justify-between border-b border-border px-6 py-3">
      <div className="flex items-center gap-3">
        <img src="/dashboard/assets/gossipcat.png" alt="" className="h-8 w-8" />
        <span className="font-semibold text-primary">gossipcat</span>
      </div>
      <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${online ? 'bg-confirmed shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-destructive'}`} />
        {online ? 'Connected' : 'Disconnected'}
      </div>
    </nav>
  );
}
