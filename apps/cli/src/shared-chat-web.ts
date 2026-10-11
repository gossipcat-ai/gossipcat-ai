import {createServer,request,IncomingMessage,ServerResponse} from 'http';
import {readFileSync,writeFileSync,existsSync,statSync} from 'fs';
import {join,resolve,extname} from 'path';
import {codexChatHistory,sendCodexChat} from '../../../packages/relay/src/dashboard/api-codex-chat';

/** Auth and Claude channels remain owned by the existing Gossipcat MCP server. */
export function startSharedChatWeb(root:string){
 const dir=join(root,'.gossip','codex-bridge');const portFile=join(dir,'web.port');
 const targetPort=()=>{const port=Number(readFileSync(join(root,'.gossip','relay.port'),'utf8'));if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Gossipcat relay port unavailable');return port;};
 const json=(res:ServerResponse,status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 const credentials=(req:IncomingMessage)=>({...(req.headers.cookie?{cookie:req.headers.cookie}:{}),...(req.headers.authorization?{authorization:req.headers.authorization}: {})});
 const authorized=(req:IncomingMessage)=>new Promise<boolean>((resolve,reject)=>{const upstream=request({hostname:'127.0.0.1',port:targetPort(),path:'/dashboard/api/auth/check',headers:credentials(req)},res=>{res.resume();resolve(res.statusCode===200);});upstream.setTimeout(5000,()=>upstream.destroy(new Error('Gossipcat authentication unavailable')));upstream.on('error',reject);upstream.end();});
 const server=createServer(async(req,res)=>{
  try {
   const url=new URL(req.url||'/','http://localhost');
   if(url.pathname==='/dashboard/api/codex-chat'){
    if(!await authorized(req)){json(res,401,{error:'Gossipcat authentication required'});return;}
    if(req.method==='GET'){json(res,200,await codexChatHistory(root));return;}
    if(req.method==='POST'){
     const origin=req.headers.origin; if(origin&&origin!==`http://${req.headers.host}`){json(res,403,{error:'Cross-origin messages are not allowed'});return;}
     let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>64000){json(res,413,{error:'Message too large'});return;}}
     json(res,202,await sendCodexChat(root,JSON.parse(text)));return;
    }
    json(res,405,{error:'Method not allowed'});return;
   }
   if(url.pathname.startsWith('/dashboard/api/')||url.pathname==='/dashboard/ws'){
    const headers={...req.headers,host:'127.0.0.1:'+targetPort()};
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
  try {const upstream=request({hostname:'127.0.0.1',port:targetPort(),path:req.url,method:'GET',headers:{...req.headers,host:'127.0.0.1:'+targetPort()}});
   upstream.on('upgrade',(reply,peer,upstreamHead)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(reply.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');if(head.length)peer.write(head);if(upstreamHead.length)socket.write(upstreamHead);socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());});
   upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.end();
  }catch{socket.destroy();}
 });
 server.listen(port,'127.0.0.1',()=>{const address=server.address();if(address&&typeof address!=='string'){writeFileSync(portFile,String(address.port),{mode:0o600});console.log('Shared chat: http://localhost:'+address.port+'/dashboard/shared-chat');}});
 return server;
}
