import {createServer,request,IncomingMessage,ServerResponse,Server} from 'http';
import {readFileSync,writeFileSync,existsSync,statSync} from 'fs';
import {join,resolve,extname} from 'path';
import {codexChatHistory,sendCodexChat} from '@gossip/relay';

const MAX_CHAT_BODY=64_000;
// Same shape as the relay's DashboardRouter.allowChatTurn: per-IP minimum
// interval, opportunistic pruning of idle IPs, plus a hard map-size cap.
const CHAT_MIN_INTERVAL_MS=1_000;
const CHAT_LIMITER_HARD_CAP=1_000;

export function createChatRateLimiter(minIntervalMs=CHAT_MIN_INTERVAL_MS){
 const last=new Map<string,number>();
 return (ip:string,now=Date.now()):boolean=>{
  if(last.size>100){for(const [k,v] of last)if(now-v>minIntervalMs*10)last.delete(k);}
  if(last.size>CHAT_LIMITER_HARD_CAP){const oldest=[...last.entries()].sort((a,b)=>a[1]-b[1]);for(const [k] of oldest.slice(0,last.size-CHAT_LIMITER_HARD_CAP))last.delete(k);}
  const previous=last.get(ip);if(previous!==undefined&&now-previous<minIntervalMs)return false;
  last.set(ip,now);return true;
 };
}

/** Exact Host/Origin values this loopback server answers to (DNS-rebinding guard). */
function loopbackAuthorities(server:Server):Set<string>{
 const address=server.address();if(!address||typeof address==='string')return new Set();
 return new Set(['localhost','127.0.0.1','[::1]'].map(host=>host+':'+address.port));
}

async function readCappedBody(req:IncomingMessage,max:number):Promise<string|undefined>{
 const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>max)return undefined;
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){const buf=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=buf.length;if(size>max)return undefined;chunks.push(buf);}
 return Buffer.concat(chunks).toString('utf8');
}

/** Auth and Claude channels remain owned by the existing Gossipcat MCP server. */
export function startSharedChatWeb(root:string){
 const dir=join(root,'.gossip','codex-bridge');const portFile=join(dir,'web.port');
 const targetPort=()=>{const port=Number(readFileSync(join(root,'.gossip','relay.port'),'utf8'));if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Gossipcat relay port unavailable');return port;};
 const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 const credentials=(req:IncomingMessage)=>({...(req.headers.cookie?{cookie:req.headers.cookie}:{}),...(req.headers.authorization?{authorization:req.headers.authorization}: {})});
 const authorized=(req:IncomingMessage)=>new Promise<boolean>((resolve,reject)=>{const upstream=request({hostname:'127.0.0.1',port:targetPort(),path:'/dashboard/api/auth/check',headers:credentials(req)},res=>{res.resume();resolve(res.statusCode===200);});upstream.setTimeout(5000,()=>upstream.destroy(new Error('Gossipcat authentication unavailable')));upstream.on('error',reject);upstream.end();});
 const allowChat=createChatRateLimiter();
 const hostAllowed=(req:IncomingMessage)=>typeof req.headers.host==='string'&&loopbackAuthorities(server).has(req.headers.host.toLowerCase());
 // Absent Origin = non-browser client (still needs Gossipcat auth); present Origin must be ours.
 const originAllowed=(req:IncomingMessage)=>{const origin=req.headers.origin;if(!origin)return true;const allowed=loopbackAuthorities(server);return [...allowed].some(a=>origin.toLowerCase()==='http://'+a);};
 const server=createServer(async(req,res)=>{
  try {
   if(!hostAllowed(req)){json(res,421,{error:'Unrecognised Host header'});return;}
   const url=new URL(req.url||'/','http://localhost');
   if(url.pathname==='/dashboard/api/codex-chat'){
    if(!await authorized(req)){json(res,401,{error:'Gossipcat authentication required'});return;}
    if(req.method==='GET'){json(res,200,await codexChatHistory(root));return;}
    if(req.method==='POST'){
     if(!originAllowed(req)){json(res,403,{error:'Cross-origin messages are not allowed'});return;}
     if((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'Content-Type must be application/json'});return;}
     // Throttle accepted submissions (each one queues a Codex run) per client IP.
     if(!allowChat(req.socket.remoteAddress||'unknown')){json(res,429,{error:'Too many chat requests'});return;}
     const text=await readCappedBody(req,MAX_CHAT_BODY);
     if(text===undefined){res.setHeader('Connection','close');json(res,413,{error:'Message too large'});return;}
     json(res,202,await sendCodexChat(root,JSON.parse(text)));return;
    }
    json(res,405,{error:'Method not allowed'});return;
   }
   if(url.pathname.startsWith('/dashboard/api/')||url.pathname==='/dashboard/ws'){
    const relayAuthority='127.0.0.1:'+targetPort();
    const headers:Record<string,string|string[]|undefined>={...req.headers,host:relayAuthority};
    // The relay accepts cookie-authenticated writes only from its own origin
    // (packages/relay/src/dashboard/csrf-guard.ts). This page is a different
    // origin, so verify the browser Origin is OURS here, then forward it as the
    // relay origin. A foreign Origin is refused before it reaches the relay.
    if(req.headers.origin!==undefined){
     if(!originAllowed(req)){json(res,403,{error:'Cross-origin request rejected'});return;}
     headers.origin='http://'+relayAuthority;
    }
    const upstream=request({hostname:'127.0.0.1',port:targetPort(),path:req.url,method:req.method,headers},reply=>{res.writeHead(reply.statusCode||502,reply.headers);reply.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Gossipcat relay unavailable'});else res.end();});req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);return;
   }
   const assets=resolve(root,'dist-dashboard');const path=resolve(assets,decodeURIComponent(url.pathname.replace(/^\/dashboard\/?/,'')));
   if(path!==assets&&!path.startsWith(assets+'/')){res.writeHead(404);res.end();return;}
   const file=existsSync(path)&&statSync(path).isFile()?path:join(assets,'index.html');
   const types:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'};
   res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(readFileSync(file));
  }catch(e){if(!res.headersSent)json(res,503,{error:(e as Error).message});else res.end();}
 });
 server.requestTimeout=15000;
 const saved=existsSync(portFile)?Number(readFileSync(portFile,'utf8')):0;const port=Number.isInteger(saved)&&saved>0&&saved<65536?saved:0;
 let retried=false;
 server.on('error',error=>{if((error as NodeJS.ErrnoException).code==='EADDRINUSE'&&!retried){retried=true;server.listen(0,'127.0.0.1');}else console.error('Shared chat web server: '+error.message);});
 server.on('upgrade',(req,socket,head)=>{
  try {
   const path=new URL(req.url||'/','http://localhost').pathname;
   if(path!=='/dashboard/ws'||!hostAllowed(req)||!originAllowed(req)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
   const upstream=request({hostname:'127.0.0.1',port:targetPort(),path:req.url,method:'GET',headers:{...req.headers,host:'127.0.0.1:'+targetPort()}});
   upstream.on('upgrade',(reply,peer,upstreamHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');if(head.length)peer.write(head);if(upstreamHead.length)socket.write(upstreamHead);socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());});
   upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.end();
  }catch{socket.destroy();}
 });
 server.listen(port,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string'){writeFileSync(portFile,String(address.port),{mode:0o600});console.log('Shared chat: http://localhost:'+address.port+'/dashboard/shared-chat');}});
 return server;
}
