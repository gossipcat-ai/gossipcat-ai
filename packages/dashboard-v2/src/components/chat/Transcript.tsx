import type { BridgeMessage, BridgeStatus } from '@/lib/useBridge';
import { UserTurn, ProseBody, ActivityRow, AckRow, ErrorRow } from './transcript-parts';

/**
 * Transcript — the activity-mirror v2 "CC-transcript" render: a flowing,
 * chronological thread (NOT chat bubbles) of user / assistant / activity / reply
 * turns under one session chat_id (spec 2026-06-14-dashboard-cc-activity-mirror-v2.md
 * §6, mockup docs/specs/mockups/chat-transcript-dark.html).
 *
 * Ordering: messages arrive pre-interleaved by server-stamped `ts` from
 * useBridge.insertByTs, so this just maps them to turn rows.
 *
 * Look (scoped dark warm-charcoal — applied by the `.chat-surface` wrapper the
 * caller renders this inside):
 *   - user        → `›` --accent gutter + Geist body
 *   - assistant   → `●` --ink-3 bullet + markdown prose (untrusted → renderer)
 *   - activity    → muted system row, small-caps LABEL only
 *   - ack/error   → status rows
 * The `●` anchor is suppressed for assistant turns whose only body is an
 * activity row (the row carries its own glyph) — design-review dedup.
 *
 * States (DESIGN.md State Coverage): loading=skeleton rows (no spinner);
 * empty="No activity yet — terminal session idle"; error=chip-bad + last frames
 * dimmed. `state` is derived by the caller from connection status + message count.
 */

interface TranscriptProps {
  messages: readonly BridgeMessage[];
  status: BridgeStatus;
}

/** Render one message as its transcript turn. */
function Turn({ msg }: { msg: BridgeMessage }) {
  switch (msg.role) {
    case 'user':
      return <UserTurn msg={msg} />;
    case 'activity':
      // Activity rows carry their own glyph → suppress the gutter ● anchor.
      return (
        <div className="cx-turn assistant">
          <div className="cx-row">
            <div className="cx-bullet" aria-hidden />
            <div className="cx-body">
              <ActivityRow text={msg.text} />
            </div>
          </div>
        </div>
      );
    case 'ack':
      return (
        <div className="cx-turn assistant">
          <div className="cx-row">
            <div className="cx-bullet" aria-hidden />
            <div className="cx-body">
              <AckRow text={msg.text} />
            </div>
          </div>
        </div>
      );
    case 'error':
      return (
        <div className="cx-turn assistant">
          <div className="cx-row">
            <div className="cx-bullet" aria-hidden />
            <div className="cx-body">
              <ErrorRow text={msg.text} />
            </div>
          </div>
        </div>
      );
    case 'assistant':
    default:
      return (
        <div className="cx-turn assistant">
          <div className="cx-row">
            <div className="cx-bullet" aria-hidden>
              ●
            </div>
            <div className="cx-body">
              <ProseBody text={msg.text} />
            </div>
          </div>
        </div>
      );
  }
}

/** Loading skeleton — three shimmer rows, no spinner (DESIGN.md). */
function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Loading transcript">
      <div className="cx-skel" style={{ width: '46%' }} />
      <div className="cx-skel" style={{ width: '72%' }} />
      <div className="cx-skel" style={{ width: '38%' }} />
    </div>
  );
}

/** Empty state — keep the frame, idle copy. */
function EmptyState() {
  return (
    <div className="cx-state">
      <span aria-hidden>○</span>
      <span>No activity yet — terminal session idle</span>
    </div>
  );
}

export function Transcript({ messages, status }: TranscriptProps) {
  const hasMessages = messages.length > 0;

  // Loading: connecting with nothing to show yet → skeleton (no spinner).
  if (!hasMessages && status === 'connecting') {
    return <LoadingState />;
  }

  // Empty: connected/closed with no frames → idle copy, keep the frame.
  if (!hasMessages) {
    return <EmptyState />;
  }

  // Error: relay down → dim the last-known frames + a disconnect chip.
  const dimmed = status === 'error';

  return (
    <div>
      {dimmed && (
        <div className="cx-state err" role="status">
          <span className="cx-chip-bad">relay disconnected</span>
          <span className="cx-dimmed">showing last-known frames</span>
        </div>
      )}
      <div className={dimmed ? 'cx-dimmed' : undefined}>
        {messages.map((m) => (
          <Turn key={m.id} msg={m} />
        ))}
      </div>
    </div>
  );
}
