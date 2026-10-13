/**
 * native-agent-mail.ts — agent mail for NATIVE dispatches, which build their
 * prompt in handlers/dispatch.ts (not dispatch-pipeline's assemblePrompt call).
 * Same store and rendering as the relay path (relay dashboard/agent-mail.ts).
 *
 * Cache rule: the mail block is per-dispatch content, so it must never enter
 * the warm prompt cache. Callers pass it only to the post-cache assemble (cold
 * path) or composeWarmBody (warm path), exactly like the lesson block.
 *
 * Delivery: the ids embedded in the final prompt are recorded on the native
 * task (NativeTaskInfo.agentMailIds) and marked delivered only when
 * handleNativeRelay accepts a successful, token-validated result for THAT task.
 */
import { createInboxAgentMail, type AgentMailBatch } from '@gossip/relay/dashboard/agent-mail';
import { ctx } from '../mcp-context';

/** Queued mail for `agentId`, rendered (nothing marked yet). Never throws. */
export function prepareNativeAgentMail(agentId: string, projectRoot: string = process.cwd()): AgentMailBatch | null {
  return createInboxAgentMail(projectRoot).prepare(agentId);
}

/**
 * Record on native task `taskId` the mail ids whose block made it into the
 * final prompt (it can be dropped by the size cap). Returns true when ids were
 * recorded, so the caller can persist the task map. Marks nothing.
 */
export function attachNativeAgentMail(mail: AgentMailBatch | null, prompt: string, taskId: string): boolean {
  if (!mail || !prompt.includes(mail.block)) return false;
  const info = ctx.nativeTaskMap.get(taskId);
  if (!info) return false;
  info.agentMailIds = [...mail.ids];
  return true;
}

/**
 * Mark mail recorded on a native task delivered (and close orchestrator mail)
 * after a successful relay. `ids` may come from a persisted task record, so
 * anything but a string array is ignored; the store re-validates each id and
 * only touches mail addressed to `agentId`. Never throws.
 */
export function markNativeAgentMailDelivered(agentId: string, ids: unknown, taskId: string, projectRoot: string = process.cwd()): number {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const valid = ids.filter((id): id is string => typeof id === 'string');
  return createInboxAgentMail(projectRoot).markDelivered(agentId, valid, taskId);
}

/** Write `<agent_message>` tags from a validated native result. Never throws. */
export function acceptNativeAgentMail(agentId: string, taskId: string, result: string, projectRoot: string = process.cwd()): string[] {
  return createInboxAgentMail(projectRoot).acceptResult(agentId, taskId, result);
}
