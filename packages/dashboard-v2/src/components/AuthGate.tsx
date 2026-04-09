import { useState, useEffect, useRef, type FormEvent } from 'react';

interface AuthGateProps {
  onLogin: (key: string) => void;
  error: boolean;
}

export function AuthGate({ onLogin, error }: AuthGateProps) {
  const [key, setKey] = useState('');
  const [glitching, setGlitching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const schedule = () => {
      if (!mountedRef.current) return;
      // Wait 3–12 seconds between random glitch bursts
      const delay = 3000 + Math.random() * 9000;
      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setGlitching(true);
        // Stay glitched for 150–600ms
        const duration = 150 + Math.random() * 450;
        timerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          setGlitching(false);
          schedule();
        }, duration);
      }, delay);
    };
    schedule();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) onLogin(key.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-2xl">
        {/* Logo with CRT hover effect */}
        <div className={`crt-logo mx-auto mb-4${glitching ? ' crt-logo--glitch' : ''}`} style={{ width: 'fit-content' }}>
          <img
            src="/dashboard/assets/gossip-mini.png"
            alt="gossipcat"
            className="crt-logo-img h-56 w-56 object-contain drop-shadow-[0_0_28px_rgba(117,221,221,0.45)]"
          />
        </div>

        {/* Wordmark */}
        <p
          className="mb-1 text-[30px] font-bold tracking-tight text-foreground"
          style={{
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
            letterSpacing: '-0.02em',
            textShadow: '0 0 24px rgba(117,221,221,0.4)',
          }}
        >
          Gossipcat
        </p>

        <p className="mb-6 text-sm text-muted-foreground">
          Authenticate to access the dashboard
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Dashboard key"
            autoFocus
            className="w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button
            type="submit"
            className="mt-4 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
          >
            Unlock
          </button>
        </form>

        {error && (
          <p className="mt-3 text-sm text-destructive">
            Invalid key. Check your terminal for the correct key.
          </p>
        )}
      </div>
    </div>
  );
}
