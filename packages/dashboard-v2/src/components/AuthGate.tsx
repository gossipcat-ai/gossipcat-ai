import { useState, type FormEvent } from 'react';
import type { AuthError } from '@/hooks/useAuth';

interface AuthGateProps {
  onLogin: (key: string) => Promise<void>;
  error: AuthError;
}

// The CRT glitch effect used to fire on a random 3-12s interval — but on an
// idle login screen, surprise flicker reads as "something is broken, can I
// even trust this?" First-touch users don't know the glitch is intentional.
// The `crt-logo:hover` rules in globals.css already animate on hover, so the
// effect survives; we just stop triggering it unprompted.

export function AuthGate({ onLogin, error }: AuthGateProps) {
  const [key, setKey] = useState('');
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim() || pending) return;
    setPending(true);
    try {
      await onLogin(key.trim());
    } finally {
      setPending(false);
    }
  };

  const errorMessage =
    error === 'bad_key'
      ? 'Invalid key. Check your terminal for the correct key.'
      : error === 'network'
      ? 'Connection error — relay may be offline.'
      : null;

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--surface)' }}>
      <div className="w-full max-w-sm rounded-xl border [border-color:var(--border)] p-8 text-center" style={{ background: 'var(--surface-elev)' }}>
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
          className="h-route mb-1"
          style={{
            letterSpacing: '-0.02em',
            textShadow: '0 0 24px var(--accent)',
          }}
        >
          Gossipcat
        </p>

        <p className="mb-6 text-[13px]" style={{ color: 'var(--ink-3)' }}>
          Authenticate to access the dashboard
        </p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Dashboard key"
            autoFocus
            disabled={pending}
            className="w-full rounded-lg border [border-color:var(--border)] px-4 py-3 font-mono text-sm outline-none focus:[border-color:var(--ink-3)] focus:ring-2 focus:[--tw-ring-color:color-mix(in_oklch,var(--ink-3)_20%,transparent)] disabled:opacity-50"
            style={{ background: 'var(--surface)', color: 'var(--ink)' }}
          />
          <button
            type="submit"
            disabled={pending}
            className="mt-4 w-full rounded-lg px-4 py-3 text-sm font-semibold transition hover:opacity-90 disabled:opacity-60"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {pending ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        {errorMessage && (
          <p className="mt-3 text-sm" style={{ color: 'var(--bad)' }}>
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}
