/**
 * cc-bridge.ts — MCP-server-side host for the dashboard ⇄ live Claude Code
 * bridge (P1 backend, spec 2026-06-14-dashboard-cc-channel-bridge.md).
 *
 * NAMING (consensus f4): identifiers are bridge-* / ccBridge, NOT "channel" —
 * packages/relay/src/channels.ts already owns `ChannelManager` (agent pub-sub).
 * The ONLY literal `claude/channel` string is the Claude Code protocol
 * capability key + notification method, used verbatim per the CC contract.
 *
 * Responsibilities:
 *   - INBOUND (dashboard → CC): `deliverBridgeMessage(chatId, content)` emits a
 *     `notifications/claude/channel` notification over the stdio transport. The
 *     live CC orchestrator receives it as a `<channel source="gossipcat"
 *     chat_id="…">` event and is instructed to respond via the `reply` tool.
 *     stdio CAN push server→client notifications (spec "#1 unknown RESOLVED",
 *     verified against fakechat).
 *   - The relay registers `deliverBridgeMessage` as its in-process sink (no wire
 *     protocol — same Node process). See RelayServer.registerBridgeSink.
 *
 * Bounded inbound buffer (consensus f3): a message can arrive (relay POST →
 * sink) before the MCP transport is connected, or while a notification send is
 * transiently failing. Rather than drop or grow unbounded, buffer up to
 * MAX_BUFFERED entries with a TTL (mirroring chat-session-store.ts constants)
 * and flush on the next successful send / connect. This is NOT the CC-side
 * mid-tool-call queue (CC owns that); it bounds OUR transient-failure window.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** The Claude Code channel notification method — protocol name, verbatim. */
export const CC_CHANNEL_NOTIFICATION = 'notifications/claude/channel';

// Bounded inbound buffer, mirroring chat-session-store.ts posture.
const MAX_BUFFERED = 20;
const BUFFER_TTL_MS = 2 * 60 * 60 * 1000; // 2h idle, same as chat-session-store

interface BufferedMessage {
  chatId: string;
  content: string;
  queuedAt: number;
}

export interface BridgeHost {
  /**
   * Deliver a dashboard message to the live CC session. Returns true when the
   * notification was sent (or buffered for imminent retry), false when it could
   * be neither sent nor buffered (buffer full of fresh entries). Synchronous
   * return so the relay sink can answer the dashboard POST immediately; the
   * actual stdio send is fire-and-forget.
   */
  deliverBridgeMessage(chatId: string, content: string): boolean;
  /** Flush any buffered messages — call after the transport connects. */
  flush(): void;
  /** Test/introspection helper. */
  bufferedCount(): number;
}

/**
 * Build the bridge host bound to a constructed McpServer. The notification is
 * emitted via `server.server.notification` (the underlying Protocol instance —
 * McpServer exposes it as `.server`). The method name is not in the SDK's
 * notification schema, so we cast at the boundary.
 */
export function createBridgeHost(server: McpServer): BridgeHost {
  const buffer: BufferedMessage[] = [];

  function evictExpired(now: number): void {
    // Drop from the front while the oldest entry has aged out. Entries are
    // appended in arrival order, so once one is fresh enough the rest are too.
    while (buffer.length > 0 && now - buffer[0].queuedAt > BUFFER_TTL_MS) {
      buffer.shift();
    }
  }

  function send(msg: BufferedMessage): boolean {
    try {
      // The underlying Protocol.notification is the documented seam for
      // server-initiated notifications (McpServer.server). `claude/channel` is a
      // CC research-preview method outside the SDK schema → cast.
      void (server.server as unknown as {
        notification: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
      }).notification({
        method: CC_CHANNEL_NOTIFICATION,
        params: { content: msg.content, meta: { chat_id: msg.chatId } },
      }).catch(() => {
        // Send rejected after we optimistically returned — re-buffer so a flush
        // can retry, unless the buffer is already full of fresh entries.
        bufferMessage(msg);
      });
      return true;
    } catch {
      return bufferMessage(msg);
    }
  }

  function bufferMessage(msg: BufferedMessage): boolean {
    const now = Date.now();
    evictExpired(now);
    if (buffer.length >= MAX_BUFFERED) {
      // Buffer saturated with fresh entries — drop the OLDEST to bound memory,
      // preferring the most recent steering message (consensus f3: bounded, not
      // unbounded; recency matters for steering).
      buffer.shift();
    }
    buffer.push(msg);
    return true;
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const now = Date.now();
    evictExpired(now);
    const pending = buffer.splice(0, buffer.length);
    for (const msg of pending) {
      send(msg);
    }
  }

  function deliverBridgeMessage(chatId: string, content: string): boolean {
    const msg: BufferedMessage = { chatId, content, queuedAt: Date.now() };
    return send(msg);
  }

  return {
    deliverBridgeMessage,
    flush,
    bufferedCount: () => buffer.length,
  };
}
