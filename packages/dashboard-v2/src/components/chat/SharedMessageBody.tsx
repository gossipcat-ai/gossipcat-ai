import {useState} from 'react';
import {ProseBody} from './transcript-parts';

/** Convert only known agent protocol tags; HTML still passes through the escaped renderer. */
export function readableAgentText(text:string):string {
 return text.split(/(```[\s\S]*?(?:```|$))/g).map((part,index)=>{
  if(index%2)return part;
  return part
   .replace(/<agent_finding\b[^>]*>/gi,'\n\n')
   .replace(/<\/agent_finding\s*>/gi,'\n\n')
   .replace(/<cite\b[^>]*>([\s\S]*?)<\/cite\s*>/gi,(_match,body:string)=>'`'+body.trim().replace(/`/g,'')+'`')
   .replace(/\n{3,}/g,'\n\n');
 }).join('').trim();
}

export function presentationText(text:string) {
 const sources:string[]=[];
 const prose=readableAgentText(text).split(/(```[\s\S]*?(?:```|$))/g).map((part,index)=>index%2?part:part.replace(/`?(\/(?:Users|home|workspace|repo)\/[^\s`<>]+?:\d+)`?/g,(_match,path:string)=>{
  let n=sources.indexOf(path);if(n<0){n=sources.push(path)-1;}return ` [${n+1}] `;
 })).join('');
 return {prose,sources};
}

function CodeBlock({lang,code}:{lang:string;code:string}) {
 const [copied,setCopied]=useState(false);const [expanded,setExpanded]=useState(false);const [error,setError]=useState(false);
 return <div className="my-4 overflow-hidden rounded-lg border" style={{borderColor:'var(--border)'}}><div className="flex items-center justify-between px-3 py-2 text-xs" style={{background:'var(--surface-2)',color:'var(--ink-3)'}}><span>{lang||'kod'}</span><button type="button" onClick={async()=>{try{await navigator.clipboard.writeText(code);setCopied(true);setError(false);}catch{setError(true);}}}>{error?'Kopyalanamadı':copied?'Kopyalandı':'Kodu kopyala'}</button></div><div style={{maxHeight:expanded?undefined:280,overflow:'auto'}}><ProseBody text={'```'+lang+'\n'+code+'\n```'}/></div>{code.split('\n').length>10&&<button type="button" className="px-3 py-2 text-xs underline" onClick={()=>setExpanded(!expanded)}>{expanded?'Daralt':'Kodun tamamını göster'}</button>}</div>;
}
function MessageProse({text}:{text:string}) {
 return <>{text.split(/(```[^\n]*\n[\s\S]*?^```)/gm).map((part,i)=>{const fence=part.match(/^```([^\n]*)\n([\s\S]*?)\n?```$/);return fence?<CodeBlock key={i} lang={fence[1].trim()} code={fence[2]}/>:part.split(/\n\s*\n/).filter(Boolean).map((paragraph,j)=><div key={i+'-'+j} className="mb-5 last:mb-0"><ProseBody text={paragraph}/></div>);})}</>;
}

export function SharedMessageBody({text,agent}:{text:string;agent:boolean}) {
 const {prose,sources}=agent?presentationText(text):{prose:text,sources:[]};
 if(!agent&&text.length>400)return <details className="shared-request"><summary className="cursor-pointer"><span className="block leading-7">{text.slice(0,200).trim()}…</span><span className="mt-2 block text-xs" style={{color:'var(--ink-3)'}}>Görevin tamamını göster</span></summary><div className="mt-4"><ProseBody text={text}/></div></details>;
 return <div className="shared-message-prose"><MessageProse text={prose}/>
  {sources.length>0&&<details className="mt-5 text-xs" style={{color:'var(--ink-3)'}}><summary className="cursor-pointer">Kaynaklar ({sources.length})</summary><ol className="mt-3 space-y-2">{sources.map((path,i)=><li key={path} className="break-all"><span>[{i+1}] </span><code title={path}>{path.replace(/^\/Users\/[^/]+\/Desktop\/gossip\//,'')}</code></li>)}</ol></details>}
  {prose!==text&&<details className="mt-3 text-xs" style={{color:'var(--ink-3)'}}><summary className="cursor-pointer">Ham mesajı göster</summary><pre className="mt-2 whitespace-pre-wrap break-words font-mono">{text}</pre></details>}
 </div>;
}
