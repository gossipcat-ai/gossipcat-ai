import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {sendCodexChat,codexChatHistory} from '../../packages/relay/src/dashboard/api-codex-chat';
import {codexBridgeRequest} from '@gossip/orchestrator';
jest.mock('@gossip/orchestrator',()=>({codexBridgeRequest:jest.fn()}));
let root:string;const call=codexBridgeRequest as jest.Mock;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'codex-chat-'));mkdirSync(join(root,'.gossip'));writeFileSync(join(root,'.gossip/config.json'),JSON.stringify({agents:{'codex-sol':{codexCli:true,model:'gpt-6.1-sol'}}}));call.mockReset();});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
test('retains stable message ID and trims human input without passing arbitrary context',async()=>{
 call.mockResolvedValue({id:'chat-one',status:'queued'});
 const result=await sendCodexChat(root,{request_id:'chat-one',message:'  inspect source  ',instructions:'override',model:'wrong'});
 expect(call).toHaveBeenCalledWith(root,'POST','/jobs',expect.objectContaining({id:'chat-one',agentId:'codex-sol',task:'inspect source'}));
 expect(call.mock.calls[0][3].instructions).not.toBe('override');expect(result).toMatchObject({task:'inspect source',source:'user'});
});
test('rejects traversal IDs, empty messages, non-string fields and oversized input',async()=>{
 for(const input of [{request_id:'../escape',message:'hello'},{request_id:'chat-id',message:''},{request_id:'chat-id',message:{}},{request_id:'chat-id',message:'a'.repeat(16001)}])await expect(sendCodexChat(root,input)).rejects.toThrow('Invalid');
 expect(call).not.toHaveBeenCalled();
});
test('rejects model substitution or missing local-worker configuration',async()=>{
 writeFileSync(join(root,'.gossip/config.json'),JSON.stringify({agents:{'codex-sol':{codexCli:true,model:'gpt-6-sol'}}}));await expect(sendCodexChat(root,{request_id:'chat-id',message:'hello'})).rejects.toThrow('GPT-6.1 Sol');expect(call).not.toHaveBeenCalled();
});
test('retrieves only conversation facade and reports unavailable bridge',async()=>{
 call.mockImplementation((_r:string,_m:string,path:string)=>path==='/health'?Promise.resolve({ok:true,model:'gpt-6.1-sol'}):Promise.resolve([{id:'one'}]));await expect(codexChatHistory(root)).resolves.toMatchObject({online:true,jobs:[{id:'one'}]});
 call.mockRejectedValue(new Error('socket unavailable'));await expect(codexChatHistory(root)).rejects.toThrow('socket unavailable');
});
test('cancels user chat jobs and rejects orchestrator task IDs',async()=>{
 await sendCodexChat(root,{action:'cancel',task_id:'chat-one'});
 expect(call).toHaveBeenCalledWith(root,'POST','/jobs/chat-one/cancel',{reason:'Cancelled by user'});
 call.mockClear();await expect(sendCodexChat(root,{action:'cancel',task_id:'orchestrator-job'})).rejects.toThrow('Invalid');expect(call).not.toHaveBeenCalled();
});
