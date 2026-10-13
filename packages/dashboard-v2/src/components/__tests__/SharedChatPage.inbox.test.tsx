import {describe,it,expect,vi,afterEach} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {SharedChatPage} from '../SharedChatPage';

/** SharedChatPage renders the real Claude link state + per-message delivery status. */
const {store}=vi.hoisted(()=>({store:{active:{chatId:'chat-1',messages:[
 {id:1,role:'user',text:'İlk soru',ts:'2026-10-11T00:00:00Z',inboxId:'1760000000000-aaaaaaaaaaaa',delivery:'queued'},
 {id:2,role:'user',text:'İkinci soru',ts:'2026-10-11T00:00:01Z',inboxId:'1760000000001-bbbbbbbbbbbb',delivery:'queued'},
],status:'open',awaitingReply:true,pendingQuestion:null},send:vi.fn(),sendError:null,submitAnswer:vi.fn()}}));
vi.mock('@/lib/BridgeContext',()=>({useBridgeStore:()=>store}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

function stubFetch(link:string){vi.stubGlobal('fetch',vi.fn(async(url:string)=>String(url).startsWith('/dashboard/api/bridge/inbox')
 ?{ok:true,json:async()=>({link:{state:link},messages:[{id:'1760000000000-aaaaaaaaaaaa',status:'answered'},{id:'1760000000001-bbbbbbbbbbbb',status:'delivered'}]})}
 :{ok:true,json:async()=>({online:true,jobs:[]})}));}

describe('SharedChatPage — Claude inbox status',()=>{
 it('shows per-message delivery chips from the inbox snapshot',async()=>{stubFetch('listening');render(<SharedChatPage/>);
  expect(await screen.findByText('yanıtlandı')).toBeTruthy();expect(screen.getByText('iletildi')).toBeTruthy();
  expect(screen.getByTestId('claude-link').getAttribute('data-state')).toBe('listening');
  expect(screen.getByText('Claude yanıtı bekleniyor…')).toBeTruthy();});
 it('does not claim Claude is connected just because the SSE stream is open',async()=>{stubFetch('offline');render(<SharedChatPage/>);
  expect(await screen.findByText('Claude çevrimdışı — mesajlar sırada')).toBeTruthy();
  expect(screen.queryByText(/Claude kanalı açık/)).toBeNull();
  expect(screen.getByText(/Mesaj sırada/)).toBeTruthy();});
});
