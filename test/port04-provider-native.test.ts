import {afterEach,describe,it,expect,vi} from 'vitest';
import {operationalState} from '../src/ops/context.js';
import {OpenAIProvider} from '../src/providers/openai.js';
import {INCREMENTAL_SUMMARY_SYSTEM,INCREMENTAL_SUMMARY_FORMAT} from '../src/ops/long-session.mjs';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();operationalState.providerReadiness=null;});
describe('PORT04 native provider',()=>{
 it('uses opt-in native summary JSON with no OpenAI credential',async()=>{
  vi.stubEnv('AGENTMEMORY_OLLAMA_NATIVE_CHAT','true');
  const fetch=vi.fn(async()=>new Response(JSON.stringify({message:{content:'{}'},done:true,done_reason:'stop'})));vi.stubGlobal('fetch',fetch);
  const result=await new OpenAIProvider('fixture-secret','fixture-model',1200,'http://fixture.invalid:11434/v1').summarize(INCREMENTAL_SUMMARY_SYSTEM,'fixture');
  expect(result).toBe('{}');const [url,init]=fetch.mock.calls[0] as any[];
  expect(url).toBe('http://fixture.invalid:11434/api/chat');
  expect(JSON.parse(init.body)).toMatchObject({format:INCREMENTAL_SUMMARY_FORMAT,options:{num_predict:768}});
  expect(init.headers).not.toHaveProperty('Authorization');
 });
});

it.each(['<memory><title>kept</title></memory>','<facts>kept</facts>'])('preserves existing XML consumers: %s',async content=>{
 vi.stubEnv('AGENTMEMORY_OLLAMA_NATIVE_CHAT','true');const fetch=vi.fn(async()=>new Response(JSON.stringify({message:{content},done:true,done_reason:'stop'})));vi.stubGlobal('fetch',fetch);
 const system='You are a memory consolidation engine. Return '+content;
 expect(await new OpenAIProvider('fixture','model',1200,'http://fixture.invalid/v1').compress(system,'fixture')).toBe(content);
 const body=JSON.parse((fetch.mock.calls[0] as any[])[1].body);expect(body).not.toHaveProperty('format');expect(body.options.num_predict).toBe(1200);expect(body.messages[0].content).toBe(system);
});
it('defers offline and truncated output without retaining provider text',async()=>{
 vi.stubEnv('AGENTMEMORY_OLLAMA_NATIVE_CHAT','true');
 const readiness={ensureReady:vi.fn(async()=>false),snapshot:()=>({status:'waiting',errorCode:'ECONNREFUSED'}),noteResponse:vi.fn(),markUnavailable:vi.fn(),start:vi.fn(),stop:async()=>{},drain:async()=>{}};
 operationalState.providerReadiness=readiness;
 const fetch=vi.fn(async()=>new Response(JSON.stringify({message:{content:'PRIVATE'},done:true,done_reason:'length',eval_count:768})));vi.stubGlobal('fetch',fetch);
 const provider=new OpenAIProvider('fixture','model',1200,'http://fixture.invalid/v1');
 await expect(provider.summarize(INCREMENTAL_SUMMARY_SYSTEM,'fixture')).rejects.toMatchObject({providerUnavailable:true});expect(fetch).not.toHaveBeenCalled();
 readiness.ensureReady.mockResolvedValue(true);
 await expect(provider.summarize(INCREMENTAL_SUMMARY_SYSTEM,'fixture')).rejects.toMatchObject({diagnostics:{category:'output_truncated',evalCount:768}});
 expect(JSON.stringify(readiness.noteResponse.mock.calls)).not.toContain('PRIVATE');
});
it.each(['network','http'])('marks %s failure unavailable with safe diagnostics',async kind=>{
 vi.stubEnv('AGENTMEMORY_OLLAMA_NATIVE_CHAT','true');
 const readiness={ensureReady:async()=>true,snapshot:()=>({status:'waiting',errorCode:'PROVIDER_UNAVAILABLE'}),noteResponse:vi.fn(),markUnavailable:vi.fn(),start:vi.fn(),stop:async()=>{},drain:async()=>{}};operationalState.providerReadiness=readiness;
 vi.stubGlobal('fetch',vi.fn(async()=>{if(kind==='network')throw Error('PRIVATE');return new Response('PRIVATE',{status:503});}));
 await expect(new OpenAIProvider('fixture','model',1200,'http://fixture.invalid/v1').compress('fixture','fixture')).rejects.toMatchObject({providerUnavailable:true,message:'provider_unavailable'});expect(readiness.markUnavailable).toHaveBeenCalledOnce();
});
it('leaves native-disabled official auth and body unchanged',async()=>{
 vi.stubEnv('AGENTMEMORY_OLLAMA_NATIVE_CHAT','false');const fetch=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})));vi.stubGlobal('fetch',fetch);
 expect(await new OpenAIProvider('fixture-secret','model',1200,'https://fixture.invalid/v1').compress('system','user')).toBe('ok');
 const [url,init]=fetch.mock.calls[0] as any[];expect(url).toBe('https://fixture.invalid/v1/chat/completions');expect(init.headers.Authorization).toBe('Bearer fixture-secret');expect(JSON.parse(init.body)).toMatchObject({max_tokens:1200});expect(JSON.parse(init.body)).not.toHaveProperty('format');
});
