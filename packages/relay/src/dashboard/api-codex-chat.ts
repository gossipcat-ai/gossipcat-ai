import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { codexBridgeRequest } from '@gossip/orchestrator';

/** Dashboard-authenticated facade; never exposes worker context or credentials. */
export async function codexChatHistory(root:string):Promise<unknown> {
  const [health,jobs]=await Promise.all([codexBridgeRequest(root,'GET','/health'),codexBridgeRequest(root,'GET','/conversation')]);
  return {online:health.ok,model:health.model,jobs};
}
export async function sendCodexChat(root:string,raw:unknown):Promise<unknown> {
  const body=raw as {message?:unknown;request_id?:unknown;action?:unknown;task_id?:unknown};
  if(body?.action==='cancel'){if(typeof body.task_id!=='string'||!/^chat-[a-zA-Z0-9_-]{1,100}$/.test(body.task_id))throw new Error('Invalid chat task ID');return codexBridgeRequest(root,'POST','/jobs/'+body.task_id+'/cancel',{reason:'Cancelled by user'});}
  if(!body||typeof body.message!=='string'||!body.message.trim()||body.message.length>16000||typeof body.request_id!=='string'||!/^chat-[a-zA-Z0-9_-]{1,100}$/.test(body.request_id))throw new Error('Invalid Codex message or request ID');
  const config=JSON.parse(readFileSync(join(root,'.gossip','config.json'),'utf8'));
  const agent=config.agents?.['codex-sol'];
  if(!agent?.codexCli||agent.native||agent.model!=='gpt-6.1-sol')throw new Error('codex-sol is not configured as a local GPT-6.1 Sol worker');
  const path=join(root,'.gossip','agents','codex-sol','instructions.md');
  const job=await codexBridgeRequest(root,'POST','/jobs',{id:body.request_id,agentId:'codex-sol',task:body.message.trim(),instructions:existsSync(path)?readFileSync(path,'utf8'):'Read-only researcher. Follow project instructions and cite sources.'});
  return {...job,task:body.message.trim(),source:'user'};
}
