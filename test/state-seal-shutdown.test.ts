import {it,expect} from 'vitest';
it('does not promote SDK completion into a disk-clean proof',async()=>{
 const {stateSealDiskProof}=await import('../src/ops/state-seal-shutdown.mjs');
 expect(()=>stateSealDiskProof({completed:true,synced:false},{instanceId:'x',storePath:'/tmp/test'},0)).toThrow();
});
it.each([{sealed:false,synced:true},{sealed:true,synced:false},{sealed:true,synced:true,instanceId:'wrong'},{sealed:true,synced:true,storePath:'/wrong'}])('rejects invalid seal %j',async(change)=>{
 const {stateSealDiskProof}=await import('../src/ops/state-seal-shutdown.mjs'),identity={instanceId:'test-instance',storePath:'/tmp'};
 expect(()=>stateSealDiskProof({version:1,...identity,sealed:true,synced:true,...change},identity,0)).toThrow();
});
it('accepts only matching immutable sealed fsync identity and zero app failures',async()=>{
 const {stateSealDiskProof}=await import('../src/ops/state-seal-shutdown.mjs'),identity={instanceId:'test-instance',storePath:'/tmp'},receipt={version:1,...identity,sealed:true,synced:true};
 expect(stateSealDiskProof(receipt,identity,0)).toMatchObject({completion:'disk',completed:true,synced:true,mutationFailures:0});
 expect(()=>stateSealDiskProof(receipt,identity,1)).toThrow();
});
