/**
 * ChatConversationStore — in-memory, bounded conversation history for the
 * dashboard chatbot (MVP-0, P2). Conversation state is process-local only; a
 * cold restart clears it (spec §5).
 *
 * Bounded + TTL'd like dashboard/auth.ts: capped at MAX_CONVERSATIONS entries
 * with a CONVERSATION_TTL_MS idle window. Eviction runs opportunistically on
 * access (getOrCreate) — expired entries are dropped, and if the map is still
 * at capacity the oldest-touched conversation is evicted. There is no
 * background timer; this is a request-driven structure.
 */

import { randomUUID } from 'crypto';
import type { LLMMessage } from '@gossip/types';

const MAX_CONVERSATIONS = 20;
const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours idle
// Per-conversation history cap. Without this, a single long-lived conversation
// grows unbounded; we keep only the most-recent turns.
const MAX_MESSAGES_PER_CONVERSATION = 100;

interface ConversationEntry {
  messages: LLMMessage[];
  lastTouched: number;
}

export class ChatConversationStore {
  private conversations = new Map<string, ConversationEntry>();

  /**
   * Return the existing history for `id`, or create a fresh empty conversation.
   * A null/empty id mints a new UUID. Eviction (expired-first, then
   * oldest-touched if still over cap) runs before insertion so the map never
   * exceeds MAX_CONVERSATIONS.
   */
  getOrCreate(id: string | null | undefined): { id: string; messages: LLMMessage[] } {
    const now = Date.now();
    this.evict(now);

    const key = id && id.length > 0 ? id : randomUUID();
    const existing = this.conversations.get(key);
    if (existing) {
      existing.lastTouched = now;
      return { id: key, messages: existing.messages };
    }

    // New conversation. If we're at capacity after expiry eviction, drop the
    // oldest-touched entry to make room.
    if (this.conversations.size >= MAX_CONVERSATIONS) {
      this.evictOldest();
    }
    const entry: ConversationEntry = { messages: [], lastTouched: now };
    this.conversations.set(key, entry);
    return { id: key, messages: entry.messages };
  }

  /** Append messages (e.g. [userMsg, assistantMsg]) to a conversation's history. */
  append(id: string, msgs: LLMMessage[]): void {
    const now = Date.now();
    const entry = this.conversations.get(id);
    if (!entry) {
      // The conversation was evicted between turn start and append (rare under
      // load). Recreate it so the turn isn't silently lost, respecting the cap.
      if (this.conversations.size >= MAX_CONVERSATIONS) this.evictOldest();
      const fresh: ConversationEntry = { messages: [...msgs], lastTouched: now };
      this.trimHistory(fresh);
      this.conversations.set(id, fresh);
      return;
    }
    entry.messages.push(...msgs);
    entry.lastTouched = now;
    this.trimHistory(entry);
  }

  /**
   * Drop the oldest messages from the front so history never exceeds
   * MAX_MESSAGES_PER_CONVERSATION (keep the most-recent N).
   */
  private trimHistory(entry: ConversationEntry): void {
    const overflow = entry.messages.length - MAX_MESSAGES_PER_CONVERSATION;
    if (overflow > 0) entry.messages.splice(0, overflow);
  }

  /** Drop conversations whose idle window elapsed. */
  private evict(now: number): void {
    for (const [k, v] of this.conversations) {
      if (now - v.lastTouched > CONVERSATION_TTL_MS) this.conversations.delete(k);
    }
  }

  /** Evict the single oldest-touched conversation (capacity pressure). */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTouched = Infinity;
    for (const [k, v] of this.conversations) {
      if (v.lastTouched < oldestTouched) {
        oldestTouched = v.lastTouched;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) this.conversations.delete(oldestKey);
  }

  /** Test/introspection helper. */
  size(): number {
    return this.conversations.size;
  }
}
