import {DashboardRouter} from '@gossip/relay/dashboard/routes';
import {DashboardAuth} from '@gossip/relay/dashboard/auth';
import {codexChatHistory,sendCodexChat} from '../../packages/relay/src/dashboard/api-codex-chat';
import {EventEmitter} from 'events';
import {mkdtempSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
jest.mock('../../packages/relay/src/dashboard/api-codex-chat',()=>({codexChatHistory:jest.fn(),sendCodexChat:jest.fn()}));
let root:string,auth:DashboardAuth,router:DashboardRouter;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'chat-auth-'));auth=new DashboardAuth();auth.init();router=new DashboardRouter(auth,root,{agentConfigs:[],relayConnections:0,connectedAgentIds:[]});jest.clearAllMocks();});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
async function invoke(method:string,authorized:boolean,body?:string){
 const req:any=new EventEmitter();req.method=method;req.url='/dashboard/api/codex-chat';req.headers=authorized?{authorization:'Bearer '+auth.getKey()}:{};req.socket={remoteAddress:'127.0.0.1'};
 const res:any=new EventEmitter();res.writeHead=(status:number)=>{res.status=status;return res;};res.end=(text:string)=>{res.body=text;};res.setHeader=()=>{};
 const done=router.handle(req,res);if(body!==undefined){req.emit('data',Buffer.from(body));req.emit('end');}await done;return res;
}
test('GET and POST cannot expose history or queue work without dashboard authentication',async()=>{
 expect((await invoke('GET',false)).status).toBe(401);expect((await invoke('POST',false,'{}')).status).toBe(401);expect(codexChatHistory).not.toHaveBeenCalled();expect(sendCodexChat).not.toHaveBeenCalled();
});
test('authenticated history retains existing dashboard auth boundary',async()=>{
 (codexChatHistory as jest.Mock).mockResolvedValue({online:true,jobs:[]});const res=await invoke('GET',true);expect(res.status).toBe(200);expect(codexChatHistory).toHaveBeenCalledWith(root);
});
test('authenticated message is queued and malformed JSON fails without dispatch',async()=>{
 (sendCodexChat as jest.Mock).mockResolvedValue({id:'chat-one',status:'queued'});const res=await invoke('POST',true,JSON.stringify({request_id:'chat-one',message:'hello'}));expect(res.status).toBe(202);expect(sendCodexChat).toHaveBeenCalledTimes(1);
});
test('malformed JSON and unavailable bridge produce visible errors',async()=>{
 expect((await invoke('POST',true,'{')).status).toBe(400);expect(sendCodexChat).not.toHaveBeenCalled();(codexChatHistory as jest.Mock).mockRejectedValue(new Error('unavailable'));expect((await invoke('GET',true)).status).toBe(503);
});
