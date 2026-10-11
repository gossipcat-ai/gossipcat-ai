import { request } from 'http';
import { realpathSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

export function codexBridgeSocket(root:string):string {return join('/tmp','gossipcat-codex-'+process.getuid?.(),createHash('sha256').update(realpathSync(root)).digest('hex').slice(0,16)+'.sock');}

export function codexBridgeRequest(root: string, method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({socketPath:codexBridgeSocket(root),method,path,
      headers: data ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} : {}}, res => {
      let text=''; res.setEncoding('utf8');
      res.on('data', chunk => { text+=chunk; if(Buffer.byteLength(text)>8*1024*1024) req.destroy(new Error('Bridge response too large')); });
      res.on('end', () => { try { const value=JSON.parse(text); if((res.statusCode || 500)>=400)reject(new Error(value.error || `Bridge HTTP ${res.statusCode}`)); else resolve(value); } catch(e) {reject(e);} });
      res.on('error',reject);
    });
    req.setTimeout(10_000,()=>req.destroy(new Error('Bridge request timeout')));req.on('error',reject);req.end(data);
  });
}
