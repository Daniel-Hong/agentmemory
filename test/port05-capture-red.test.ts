import {afterEach,it,expect,vi} from 'vitest';
import {mockKV,mockSdk} from './helpers/mocks.js';
import {registerObserveFunction} from '../src/functions/observe.js';
import {VectorIndex} from '../src/state/vector-index.js';
import * as search from '../src/functions/search.js';
vi.mock('../src/logger.js',()=>({logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
afterEach(()=>{search.setEmbeddingRecovery(null);search.setVectorIndex(null);search.setEmbeddingProvider(null);vi.unstubAllEnvs();});
it('does not perform embedding on the capture request path',async()=>{
 vi.stubEnv('AGENTMEMORY_AUTO_COMPRESS','false');
 const embed=vi.fn(async()=>new Float32Array([1,0]));search.setVectorIndex(new VectorIndex());search.setEmbeddingProvider({name:'fixture',dimensions:2,embed});
 const enqueue=vi.fn(async()=>{});search.setEmbeddingRecovery({add:async()=>false,enqueue});
 const sdk=mockSdk({looseTrigger:true});registerObserveFunction(sdk as never,mockKV() as never);
 const result=await sdk.trigger('mem::observe',{sessionId:'fixture',project:'fixture',cwd:'/tmp/fixture',hookType:'post_tool_use',timestamp:new Date().toISOString(),data:{tool_output:'preserved raw'}});
 expect(result).toHaveProperty('observationId');expect(enqueue).toHaveBeenCalledOnce();
 expect(embed).not.toHaveBeenCalled();
});
