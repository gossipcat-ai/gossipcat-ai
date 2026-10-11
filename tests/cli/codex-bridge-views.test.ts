import {conversationJob,jobSummary,parsePage,CONVERSATION_FIELD_MAX,JOBS_PAGE_MAX} from '../../apps/cli/src/codex-bridge-views';
const job:any={id:'one',agentId:'codex-sol',task:'t'.repeat(50_000),instructions:'secret instructions',context:'ctx',digest:'d',status:'completed',createdAt:'2026-01-01T00:00:00.000Z',progress:'p',terminal:{type:'final_result',payload:{result:'r'.repeat(100_000),evidence:{cwd:'/x'}},timestamp:0}};
test('summaries carry no task, progress or result text',()=>{
 const s:any=jobSummary(job);expect(s).toMatchObject({id:'one',status:'completed',hasResult:true,source:'claude'});
 expect(JSON.stringify(s).length).toBeLessThan(500);expect(s.task).toBeUndefined();expect(s.terminal).toBeUndefined();
});
test('conversation entries clip large fields and drop private inputs',()=>{
 const c:any=conversationJob(job);expect(c.instructions).toBeUndefined();expect(c.context).toBeUndefined();expect(c.digest).toBeUndefined();
 expect(c.task.length).toBeLessThan(CONVERSATION_FIELD_MAX+200);expect(c.terminal.payload.result).toContain('truncated');expect(c.terminal.payload.result.length).toBeLessThan(CONVERSATION_FIELD_MAX+200);
});
test('page parameters are validated and capped',()=>{
 expect(parsePage(new URLSearchParams(''))).toEqual({limit:50,offset:0});expect(parsePage(new URLSearchParams('limit=9999&offset=3'))).toEqual({limit:JOBS_PAGE_MAX,offset:3});
 expect(()=>parsePage(new URLSearchParams('offset=-1'))).toThrow('Invalid offset');
});
