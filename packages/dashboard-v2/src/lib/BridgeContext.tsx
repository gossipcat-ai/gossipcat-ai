import { createContext, useContext, type ReactNode } from 'react';
import { useBridge, type UseBridgeResult } from '@/lib/useBridge';

/**
 * BridgeContext — wraps the ONE useBridge() instance so both the launcher
 * popover (ChatDock) and the full ChatPage share the same SSE stream, the same
 * chat_id, and the same message history.
 *
 * Architecture rule: useBridge() opens its OWN EventSource + its OWN
 * messages/chatId state per call-site. If the popover and ChatPage each called
 * useBridge() independently they would become two separate streams with
 * diverging messages and two different chat_ids (each first-send mints its
 * own). This provider calls useBridge() EXACTLY ONCE; both consumers call
 * useBridgeContext() to read from the shared result.
 */

const BridgeContext = createContext<UseBridgeResult | null>(null);

export function BridgeProvider({ children }: { children: ReactNode }) {
  // The single source-of-truth bridge instance.
  const bridge = useBridge();
  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

/**
 * useBridgeContext — consume the shared bridge state.
 * Throws if called outside <BridgeProvider>.
 */
export function useBridgeContext(): UseBridgeResult {
  const ctx = useContext(BridgeContext);
  if (ctx === null) {
    throw new Error('useBridgeContext must be used inside <BridgeProvider>');
  }
  return ctx;
}
