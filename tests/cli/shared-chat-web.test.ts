import {createServer,Server} from 'http';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {startSharedChatWeb} from '../../apps/cli/src/shared-chat-web';
import {codexChatHistory,sendCodexChat} from '../../packages/relay/src/dashboard/api-codex-chat';
jest.mock('../../packages/relay/src/dashboard/api-codex-chat',()=>({codexChatHistory:jest.fn(),sendCodexChat:jest.fn()}));
let root:string,web:Server,upstream:Server,url:string;
beforeEach(async()=>{
 root=mkdtempSync(join(tmpdir(),'shared-web-'));mkdirSync(join(root,'.gossip/codex-bridge'),{recursive:true});mkdirSync(join(root,'dist-dashboard'));writeFileSync(join(root,'dist-dashboard/index.html'),'<h1>Shared UI</h1>');jest.clearAllMocks();
 upstream=createServer((req,res)=>{if(req.url==='/dashboard/api/auth/check'){res.writeHead(req.headers.authorization==='Bearer test-token'?200:401);res.end('{}');}else if(req.url==='/dashboard/api/bridge'){res.writeHead(202,{'Content-Type':'application/json'});res.end('{"ok":true,"chat_id":"test-chat"}');}else{res.writeHead(404);res.end();}});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));const address=upstream.address() as {port:number};writeFileSync(join(root,'.gossip/relay.port'),String(address.port));
 web=startSharedChatWeb(root);await new Promise<void>(r=>web.once('listening',()=>r()));url='http://127.0.0.1:'+readFileSync(join(root,'.gossip/codex-bridge/web.port'),'utf8');
});
afterEach(async()=>{await new Promise<void>(r=>web.close(()=>r()));await new Promise<void>(r=>upstream.close(()=>r()));rmSync(root,{recursive:true,force:true});});
test('uses existing Gossipcat auth before exposing Codex history',async()=>{
 expect((await fetch(url+'/dashboard/api/codex-chat')).status).toBe(401);expect(codexChatHistory).not.toHaveBeenCalled();(codexChatHistory as jest.Mock).mockResolvedValue({online:true,jobs:[]});const response=await fetch(url+'/dashboard/api/codex-chat',{headers:{authorization:'Bearer test-token'}});expect(response.status).toBe(200);expect(codexChatHistory).toHaveBeenCalledWith(root);
});
test('rejects cross-origin message submission and permits the same-origin request',async()=>{
 const options={method:'POST',headers:{authorization:'Bearer test-token','Content-Type':'application/json',origin:'https://untrusted.example'},body:'{"request_id":"chat-test","message":"hello"}'};
 expect((await fetch(url+'/dashboard/api/codex-chat',options)).status).toBe(403);expect(sendCodexChat).not.toHaveBeenCalled();(sendCodexChat as jest.Mock).mockResolvedValue({id:'chat-test'});expect((await fetch(url+'/dashboard/api/codex-chat',{...options,headers:{...options.headers,origin:url}})).status).toBe(202);
});
test('serves the shared screen and forwards the existing Claude bridge',async()=>{
 expect(await (await fetch(url+'/dashboard/shared-chat')).text()).toContain('Shared UI');const response=await fetch(url+'/dashboard/api/bridge',{method:'POST',body:'{"message":"test"}'});expect(response.status).toBe(202);expect(await response.json()).toMatchObject({chat_id:'test-chat'});
});
