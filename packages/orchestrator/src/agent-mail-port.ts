/**
 * agent-mail-port.ts — injected agent-mail hooks for the dispatch pipeline
 * (docs/specs/2026-10-13-agent-inbox-addressing.md, steps 3 + 4).
 *
 * The inbox store lives in @gossip/relay, which depends on this package, so
 * the pipeline cannot import it. The CLI layer injects an implementation
 * (relay `dashboard/agent-mail.ts#createInboxAgentMail`). Implementations must
 * never throw.
 */
export interface AgentMailBatch {
  /** Rendered, self-delimited prompt block. */
  block: string;
  /** Inbox ids rendered in `block`. */
  ids: readonly string[];
}

export interface AgentMailPort {
  /** Queued mail addressed to `agentId`, rendered; does not mark anything. */
  prepare(agentId: string): AgentMailBatch | null;
  /** Mark mail delivered once its block is in the prompt for `taskId`. */
  markDelivered(ids: readonly string[], taskId: string): unknown;
  /** Write the `<agent_message>` tags of a validated task result as mail from `agentId`. */
  acceptResult(agentId: string, taskId: string, result: string): unknown;
}
