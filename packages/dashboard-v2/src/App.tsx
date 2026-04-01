import { useCallback } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { TopBar } from '@/components/TopBar';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { DashboardEvent } from '@/lib/types';

export function App() {
  const { authed, login, error } = useAuth();

  const handleWsEvent = useCallback((_event: DashboardEvent) => {
    // Will be connected to section refresh in later tasks
  }, []);

  useWebSocket(handleWsEvent);

  if (authed === null) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!authed) {
    return <AuthGate onLogin={login} error={error} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <main className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <p className="text-muted-foreground">Dashboard sections coming next.</p>
      </main>
    </div>
  );
}
