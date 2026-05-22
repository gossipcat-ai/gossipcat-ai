import { useState, type FormEvent } from 'react';

interface AuthGateProps {
  onLogin: (key: string) => void;
  error: boolean;
}

// The CRT glitch effect used to fire on a random 3-12s interval — but on an
// idle login screen, surprise flicker reads as "something is broken, can I
// even trust this?" First-touch users don't know the glitch is intentional.
// The `crt-logo:hover` rules in globals.css already animate on hover, so the
// effect survives; we just stop triggering it unprompted.

export function AuthGate({ onLogin, error }: AuthGateProps) {
  const [key, setKey] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) onLogin(key.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--surface)' }}>
      <div className="w-full max-w-sm rounded-xl border border-border p-8 text-center shadow-2xl" style={{ background: 'var(--surface-elev)' }}>
        {/* Logo with CRT hover effect */}
        <div className="crt-logo mx-auto mb-4" style={{ width: 'fit-content' }}>
          <img
            src="/dashboard/assets/gossip-mini.png"
            alt="gossipcat"
            className="crt-logo-img h-56 w-56 object-contain"
            style={{ filter: 'drop-shadow(0 0 28px var(--accent))' }}
          />
        </div>

        {/* Wordmark */}
        <p
          className="mb-1 text-[30px] font-bold tracking-tight"
          style={{
            color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
            letterSpacing: '-0.02em',
            textShadow: '0 0 24px var(--accent)',
          }}
        >
          Gossipcat
        </p>

        <p className="mb-6 text-sm" style={{ color: 'var(--text-dim)' }}>
          Authenticate to access the dashboard
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Dashboard key"
            autoFocus
            className="w-full rounded-lg border border-border px-4 py-3 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            style={{ background: 'var(--surface)', color: 'var(--text)' }}
          />
          <button
            type="submit"
            className="mt-4 w-full rounded-lg px-4 py-3 text-sm font-semibold transition hover:opacity-90"
            style={{ background: 'var(--accent)', color: '#fff' }}
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
