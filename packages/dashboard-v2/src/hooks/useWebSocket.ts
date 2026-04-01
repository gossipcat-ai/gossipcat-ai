import { useEffect } from 'react';
import { connectWs, onEvent } from '@/lib/ws';
import type { DashboardEvent } from '@/lib/types';

export function useWebSocket(handler: (event: DashboardEvent) => void) {
  useEffect(() => {
    connectWs();
    return onEvent(handler);
  }, [handler]);
}
