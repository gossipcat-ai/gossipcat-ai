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

function raw(opts:{method?:string;path:string;headers:Record<string,string>;body?:string;chunked?:boolean}):Promise<{status:number}>{
 const {request}=require('http');const port=Number(new URL(url).port);
 return new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port,method:opts.method||'GET',path:opts.path,headers:opts.headers},(res:any)=>{res.resume();resolve({status:res.statusCode});});req.on('error',reject);if(opts.body!==undefined){if(opts.chunked)for(let i=0;i<opts.body.length;i+=8000)req.write(opts.body.slice(i,i+8000));else req.write(opts.body);}req.end();});
}
const auth={authorization:'Bearer test-token','Content-Type':'application/json'};
test('rejects DNS-rebinding Host headers on HTTP and WebSocket upgrade',async()=>{
 const port=new URL(url).port;
 expect((await raw({path:'/dashboard/shared-chat',headers:{host:'evil.example:'+port}})).status).toBe(421);
 expect((await raw({path:'/dashboard/api/codex-chat',headers:{...auth,host:'evil.example'}})).status).toBe(421);
 expect((await raw({path:'/dashboard/shared-chat',headers:{host:'localhost:'+port}})).status).toBe(200);
 const upgrade=(path:string,host:string)=>new Promise<string>(resolve=>{const s=require('net').connect(Number(port),'127.0.0.1',()=>s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));let out='';s.on('data',(d:Buffer)=>out+=d);s.on('close',()=>resolve(out));s.on('error',()=>resolve(out));});
 expect(await upgrade('/dashboard/api/codex-chat','127.0.0.1:'+port)).toContain('403');
 expect(await upgrade('/dashboard/ws','evil.example:'+port)).toContain('403');
});
test('POST origin is checked against loopback origins, not the request Host',async()=>{
 const port=new URL(url).port;(sendCodexChat as jest.Mock).mockResolvedValue({id:'chat-test'});const body='{"request_id":"chat-test","message":"hello"}';
 expect((await raw({method:'POST',path:'/dashboard/api/codex-chat',headers:{...auth,host:'127.0.0.1:'+port,origin:'http://127.0.0.1:1'},body})).status).toBe(403);
 expect((await raw({method:'POST',path:'/dashboard/api/codex-chat',headers:{...auth,host:'127.0.0.1:'+port,origin:'http://localhost:'+port},body})).status).toBe(202);
});
test('rate limits chat submissions per IP',async()=>{
 (sendCodexChat as jest.Mock).mockResolvedValue({id:'chat-test'});const options={method:'POST',headers:auth,body:'{"request_id":"chat-test","message":"hello"}'};
 expect((await fetch(url+'/dashboard/api/codex-chat',options)).status).toBe(202);expect((await fetch(url+'/dashboard/api/codex-chat',options)).status).toBe(429);expect(sendCodexChat).toHaveBeenCalledTimes(1);
});
test('enforces the body cap for declared and chunked bodies before parsing',async()=>{
 const big='{"message":"'+'x'.repeat(70_000)+'"}';const host='127.0.0.1:'+new URL(url).port;
 expect((await raw({method:'POST',path:'/dashboard/api/codex-chat',headers:{...auth,host,'content-length':String(big.length)},body:big})).status).toBe(413);
 await new Promise(r=>setTimeout(r,1050)); // each attempt consumes the per-IP rate-limit slot
 expect((await raw({method:'POST',path:'/dashboard/api/codex-chat',headers:{...auth,host,'transfer-encoding':'chunked'},body:big,chunked:true})).status).toBe(413);
 expect(sendCodexChat).not.toHaveBeenCalled();
});
test('chat limiter keeps per-IP state bounded',()=>{
 const {createChatRateLimiter}=require('../../apps/cli/src/shared-chat-web');const allow=createChatRateLimiter(1000);
 expect(allow('a',0)).toBe(true);expect(allow('a',500)).toBe(false);expect(allow('b',500)).toBe(true);expect(allow('a',1500)).toBe(true);
});
