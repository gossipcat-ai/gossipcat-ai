/**
 * api-mirror-events.ts — per-chat_id mirror ring buffers (spec v2 §3/§5,
 * 2026-06-14-dashboard-cc-activity-mirror-v2.md).
 *
 * Why a NEW module rather than reusing api-events.ts (haiku:f3/f8): api-events
 * owns a SINGLE global ring + a SINGLE monotonic counter shared across all SSE
 * clients. Mirror frames are partitioned PER chat_id — each session needs its
 * own id sequence so a client's `?last_id` cursor is meaningful within its
 * stream, and one chat's frames must never evict another's. So this module
 * keeps a `Map<chatId, MirrorRing>` where each ring has its own FIFO bound, its
 * own id counter, and its own last-touched timestamp for TTL eviction.
 *
 * Eviction is BOTH bounded-FIFO (MIRROR_RING_MAX per chat) AND TTL with a
 * PROACTIVE periodic sweep (sonnet:f9 / deepseek:f6): knownChatIds' lazy
 * (touch-time-only) eviction is not enough because a chat_id that goes silent
 * forever would otherwise retain its ring indefinitely with no future call to
 * trigger a lazy purge. The sweep timer is unref'd so it never holds the
 * process open.
 */

import type { MirrorFrame } from './api-bridge';

/** Max frames retained per chat_id ring (bounded FIFO). Start conservative. */
export const MIRROR_RING_MAX = 100;
/** A chat_id ring idle longer than this is swept. Mirrors the 2h chat TTL. */
export const MIRROR_RING_TTL_MS = 2 * 60 * 60 * 1000;
/** How often the proactive sweep runs. */
export const MIRROR_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface MirrorRing {
  /** Bounded FIFO of frames for this chat_id, in id order. */
  frames: MirrorFrame[];
  /** Per-chat_id monotonic id counter. Starts at 0; first frame gets id 1. */
  nextId: number;
  /** Last push/replay timestamp (ms) — drives TTL eviction. */
  touchedAt: number;
}

/**
 * MirrorEventStore — owns the per-chat_id rings. One instance per BridgeHub.
 * Process-local; a cold restart clears everything and resets every counter to
 * 0 (handled by the restart sentinel in api-bridge.handleStream).
 */
export class MirrorEventStore {
  private rings = new Map<string, MirrorRing>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ringMax: number = MIRROR_RING_MAX,
    private readonly ttlMs: number = MIRROR_RING_TTL_MS,
    sweepIntervalMs: number = MIRROR_SWEEP_INTERVAL_MS,
  ) {
    // Proactive sweep. unref so the timer never keeps node alive (tests, clean
    // shutdown). A sweepIntervalMs<=0 disables the timer (test injection).
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(Date.now()), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Allocate the next id for a chat_id WITHOUT pushing a frame. The hub stamps
   * id + ts server-side, so it asks the store to mint the id, builds the frame,
   * then pushes it. Keeping mint+push as one call (push) avoids a torn counter,
   * so this is internal — callers use push().
   */
  private ensureRing(chatId: string, now: number): MirrorRing {
    let ring = this.rings.get(chatId);
    if (!ring) {
      ring = { frames: [], nextId: 0, touchedAt: now };
      this.rings.set(chatId, ring);
    }
    return ring;
  }

  /**
   * Push a frame for chat_id, stamping its per-chat_id id + ts server-side. The
   * caller supplies role + text (already validated); id/ts/type/chat_id are set
   * here so a hook clock or forged id can never leak in. Returns the stamped
   * frame so the hub can broadcast the exact object that was retained.
   */
  push(chatId: string, role: MirrorFrame['role'], text: string, now: number = Date.now()): MirrorFrame {
    const ring = this.ensureRing(chatId, now);
    const id = ++ring.nextId;
    const frame: MirrorFrame = {
      type: 'mirror',
      chat_id: chatId,
      role,
      text,
      ts: new Date(now).toISOString(),
      id,
    };
    ring.frames.push(frame);
    // Bounded FIFO: drop oldest beyond the cap. Distinct from TTL eviction.
    while (ring.frames.length > this.ringMax) ring.frames.shift();
    ring.touchedAt = now;
    return frame;
  }

  /**
   * Replay slice: every retained frame for chat_id with `id > lastId`, in id
   * order. Returns [] for an unknown chat_id (no ring yet) — a fresh observer
   * with last_id=0 on a brand-new stream just goes live. Touches the ring so an
   * actively-observed stream isn't swept out from under a reconnecting client.
   */
  replaySlice(chatId: string, lastId: number, now: number = Date.now()): MirrorFrame[] {
    const ring = this.rings.get(chatId);
    if (!ring) return [];
    ring.touchedAt = now;
    if (lastId <= 0) return ring.frames.slice();
    return ring.frames.filter((f) => f.id > lastId);
  }

  /**
   * The current highest id retained for chat_id (0 if none). Lets handleStream
   * detect the restart-discontinuity case: a client requesting `id > last_id`
   * where last_id exceeds our highest id means our counter was reset by a
   * restart, so the client must drop last_id and refetch (see the restart
   * sentinel in api-bridge.handleStream).
   */
  highestId(chatId: string): number {
    const ring = this.rings.get(chatId);
    if (!ring || ring.frames.length === 0) return 0;
    return ring.frames[ring.frames.length - 1].id;
  }

  /**
   * Proactive TTL sweep — evict every ring untouched for longer than ttlMs.
   * Called by the periodic timer; also callable directly in tests.
   */
  sweep(now: number = Date.now()): void {
    for (const [chatId, ring] of this.rings) {
      if (now - ring.touchedAt > this.ttlMs) this.rings.delete(chatId);
    }
  }

  /** Test/introspection: number of live rings. */
  ringCount(): number {
    return this.rings.size;
  }

  /** Stop the sweep timer (clean shutdown / tests). */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
