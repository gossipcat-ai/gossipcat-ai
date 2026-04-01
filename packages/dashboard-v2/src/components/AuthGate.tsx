import { useState, type FormEvent } from 'react';

interface AuthGateProps {
  onLogin: (key: string) => void;
  error: boolean;
}

export function AuthGate({ onLogin, error }: AuthGateProps) {
  const [key, setKey] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) onLogin(key.trim());
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-8 text-center shadow-2xl">
        <img
          src="/dashboard/assets/gossipcat.png"
          alt="gossipcat"
          className="mx-auto mb-2 h-48 w-48 object-contain drop-shadow-[0_0_24px_rgba(139,92,246,0.3)]"
        />
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
