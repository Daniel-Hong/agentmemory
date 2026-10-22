import {afterEach,expect,it,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {KV} from '../src/state/schema.js';
import {registerCompressFunction} from '../src/functions/compress.js';
import {observationBudgetEntry} from '../src/functions/observation-source-budget.js';
const hooks=vi.hoisted(()=>({embed:vi.fn(async()=>true)}));
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('../src/functions/search.js',()=>({getSearchIndex:()=>({add:()=>{}}),scheduleIndexSave:()=>{},vectorIndexAddGuarded:hooks.embed}));
afterEach(()=>vi.clearAllMocks());
const xml='<type>command_run</type><title>Synthetic result</title><facts><fact>fixture</fact></facts><narrative>Synthetic fixture narrative.</narrative><concepts></concepts><files></files><importance>5</importance>';
async function fixture(){
 const kv=mockKV(),sdk=mockSdk({looseTrigger:true});
 const raw={id:'obs_fixture',sessionId:'fixture',hookType:'post_tool_use',timestamp:'2026-10-22T00:00:00Z',toolOutput:'input'};
 const previous={...raw,title:'previous',sourceRaw:{...raw,toolOutput:'original retained'}};
 await kv.set(KV.observations('fixture'),raw.id,previous);
 const other={id:'obs_other',sessionId:'fixture',title:'other'};await kv.set(KV.observations('fixture'),other.id,other);
 const meta=observationBudgetEntry(other as never);
 const captureSummary=vi.fn(async()=>({count:2,summaryCount:1,summaryBytes:meta.summaryBytes,sourceBytes:meta.sourceBytes}));
 Object.assign(kv,{observationReader:{captureSummary}});
 registerCompressFunction(sdk as never,kv as never,{name:'synthetic',compress:async()=>xml} as never);
 return {kv,raw,previous,captureSummary,run:()=>sdk.trigger('mem::compress',{observationId:raw.id,sessionId:raw.sessionId,raw}) as Promise<any>};
}
it('reuses the maintained source-budget metadata and a point read instead of scanning whole observations',async()=>{
 const f=await fixture();f.kv.list=vi.fn(async()=>{throw Error('whole_namespace_list_should_not_run');});
 const result=await f.run();expect(result.success).toBe(true);expect(f.kv.list).not.toHaveBeenCalled();expect(f.captureSummary).toHaveBeenCalledWith(KV.observations('fixture'),'obs_fixture');
 expect((await f.kv.get<any>(KV.observations('fixture'),'obs_fixture')).sourceRaw).toEqual(f.previous.sourceRaw);expect(hooks.embed).toHaveBeenCalledTimes(1);
});
it('fails closed without replacing source when the maintained budget is uncertain',async()=>{
 const f=await fixture();f.captureSummary.mockRejectedValueOnce(Error('observation_budget_mutation_uncertain'));
 expect((await f.run()).success).toBe(false);expect(f.captureSummary).toHaveBeenCalled();expect(await f.kv.get(KV.observations('fixture'),'obs_fixture')).toEqual(f.previous);expect(hooks.embed).not.toHaveBeenCalled();
});
