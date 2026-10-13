/**
 * native-agent-mail.ts — agent mail for NATIVE dispatches, which build their
 * prompt in handlers/dispatch.ts (not dispatch-pipeline's assemblePrompt call).
 * Same store and rendering as the relay path (relay dashboard/agent-mail.ts).
 *
 * Cache rule: the mail block is per-dispatch content, so it must never enter
 * the warm prompt cache. Callers pass it only to the post-cache assemble (cold
 * path) or composeWarmBody (warm path), exactly like the lesson block.
 */
import { createInboxAgentMail, type AgentMailBatch } from '@gossip/relay/dashboard/agent-mail';

/** Queued mail for `agentId`, rendered (nothing marked yet). Never throws. */
export function prepareNativeAgentMail(agentId: string, projectRoot: string = process.cwd()): AgentMailBatch | null {
  return createInboxAgentMail(projectRoot).prepare(agentId);
}

/** Join the optional blocks that sit right before `Task:` (lessons, then mail). */
export function joinPreTaskBlocks(lessonBlock: string | undefined, mail: AgentMailBatch | null): string | undefined {
  const parts = [lessonBlock, mail?.block].filter((b): b is string => !!b);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Mark the mail delivered via `dispatch:<taskId>` iff its block made it into
 * the final prompt (it can be dropped by the size cap). Never throws.
 */
export function commitNativeAgentMail(mail: AgentMailBatch | null, prompt: string, taskId: string, projectRoot: string = process.cwd()): void {
  if (!mail || !prompt.includes(mail.block)) return;
  createInboxAgentMail(projectRoot).markDelivered(mail.ids, taskId);
}

/** Write `<agent_message>` tags from a validated native result. Never throws. */
export function acceptNativeAgentMail(agentId: string, taskId: string, result: string, projectRoot: string = process.cwd()): string[] {
  return createInboxAgentMail(projectRoot).acceptResult(agentId, taskId, result);
}
