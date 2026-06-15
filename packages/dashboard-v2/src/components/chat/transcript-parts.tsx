import { renderFindingMarkdown } from '@/lib/utils';
import type { BridgeMessage } from '@/lib/useBridge';

/**
 * transcript-parts — render atoms for the activity-mirror v2 "CC-transcript"
 * view (spec 2026-06-14-dashboard-cc-activity-mirror-v2.md §6, mockup
 * docs/specs/mockups/chat-transcript-dark.html).
 *
 * SECURITY: mirror `text` is untrusted (spec P2 / security §). It is ALWAYS
 * routed through renderFindingMarkdown (HTML-escapes first, then re-applies a
 * fixed safe-tag allowlist) — never injected as raw HTML. Code fences render via
 * that renderer's existing plain `<pre class="md-code-block">` path; syntax
 * highlighting is intentionally OUT OF SCOPE for this PR (no tokenizer dep).
 */

/** A user turn: `›` gutter glyph in --accent + Geist body, no bubble chrome. */
export function UserTurn({ msg }: { msg: BridgeMessage }) {
  return (
    <div className="cx-turn user">
      <div className="cx-gutter" aria-hidden>
        &rsaquo;
      </div>
      <div className="cx-body whitespace-pre-wrap break-words">{msg.text}</div>
    </div>
  );
}

/**
 * ProseBody — assistant / mirrored prose rendered through the markdown renderer.
 * Untrusted text is escaped by renderFindingMarkdown before any tag is re-applied.
 */
export function ProseBody({ text }: { text: string }) {
  return (
    <div
      className="cx-prose finding-md"
      // eslint-disable-next-line react/no-danger -- renderFindingMarkdown escapes
      // all HTML first, then re-applies a fixed safe-tag allowlist (no raw passthrough).
      dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(text) }}
    />
  );
}

/**
 * Parsed shape of a curated activity one-liner from the PostToolUse hook, e.g.
 *   "🔧 Bash · npm run build:dashboard"  → { icon, label:'bash ·', cmd:'npm run …' }
 *   "📡 dispatch → sonnet-reviewer"       → { icon, label:'dispatch →', agent:'sonnet-…' }
 * Falls back to the raw text in `cmd` when it doesn't match either shape.
 */
export interface ParsedActivity {
  icon: string;
  label: string;
  cmd?: string;
  agent?: string;
}

const LEADING_ICON = /^([\p{Emoji_Presentation}\p{Extended_Pictographic}🔧📡🗒]+)\s*/u;

export function parseActivity(text: string): ParsedActivity {
  let icon = '';
  let rest = text.trim();
  const iconMatch = rest.match(LEADING_ICON);
  if (iconMatch) {
    icon = iconMatch[1];
    rest = rest.slice(iconMatch[0].length).trim();
  }

  // dispatch / relay form: "<label> → <agent>"
  const arrowIdx = rest.indexOf('→');
  if (arrowIdx >= 0) {
    const label = rest.slice(0, arrowIdx + 1).trim(); // keep the arrow in the label
    const agent = rest.slice(arrowIdx + 1).trim();
    return { icon, label, agent };
  }

  // tool form: "<label> · <command>"
  const dotIdx = rest.indexOf('·');
  if (dotIdx >= 0) {
    const label = rest.slice(0, dotIdx + 1).trim(); // keep the middot in the label
    const cmd = rest.slice(dotIdx + 1).trim();
    return { icon, label, cmd };
  }

  // Unstructured fallback — show the whole thing as a command.
  return { icon, label: '', cmd: rest };
}

/**
 * ActivityRow — muted system row. The LABEL (`bash ·`, `dispatch →`) is
 * small-caps --idle; the command (--ink-2) and agent (--info) stay normal-case
 * JetBrains Mono per the design-review correction (small-caps the label only).
 */
export function ActivityRow({ text }: { text: string }) {
  const { icon, label, cmd, agent } = parseActivity(text);
  return (
    <div className="cx-activity">
      {icon && (
        <span className="cx-ic" aria-hidden>
          {icon}
        </span>
      )}
      {label && <span className="cx-label">{label}</span>}
      {agent && <span className="cx-agent">{agent}</span>}
      {cmd && <span className={!label && !agent ? 'cx-cmd cx-cmd-bare' : 'cx-cmd'}>{cmd}</span>}
    </div>
  );
}

/** AckRow — dashboard "received — working…" status, muted. The row already
 * sits under an empty gutter, so it carries no label glyph (small-caps is for
 * labels only, not a bare separator). */
export function AckRow({ text }: { text: string }) {
  return (
    <div className="cx-activity">
      <span className="cx-cmd cx-cmd-bare">{text}</span>
    </div>
  );
}

/** ErrorRow — session error, --bad chip + message. */
export function ErrorRow({ text }: { text: string }) {
  return (
    <div className="cx-state err" role="alert">
      <span className="cx-chip-bad">session error</span>
      <span>{text}</span>
    </div>
  );
}
