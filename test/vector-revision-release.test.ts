import {it,expect,vi} from 'vitest';
import {releaseSupersededVectorJobs,retryRetainedVectorRevisions,type RetainedVectorRevision} from '../src/state/vector-revision-release.js';
it('retains failed releases and permits no successful promotion claim until complete',()=>{
 const retained:RetainedVectorRevision[]=[];let fail=true;const first={release:vi.fn(()=>{if(fail)throw Error('release failed');})};const second={release:vi.fn()};
 expect(releaseSupersededVectorJobs([{id:'a',revision:first},{id:'b',revision:second}],retained)).toBe(false);
 expect(second.release).toHaveBeenCalledOnce();expect(retained).toEqual([{id:'a',revision:first}]);
 expect(()=>retryRetainedVectorRevisions(retained)).toThrow('release failed');expect(retained).toHaveLength(1);
 fail=false;retryRetainedVectorRevisions(retained);expect(retained).toHaveLength(0);
});
it('successful release retains no stale job and handles jobs without watches',()=>{const retained:RetainedVectorRevision[]=[];expect(releaseSupersededVectorJobs([{id:'a'},{id:'b',revision:{release(){}}}],retained)).toBe(true);expect(retained).toEqual([]);});
