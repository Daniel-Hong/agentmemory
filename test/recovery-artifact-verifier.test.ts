import {expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {verifyRecoveryBundle} from '../scripts/personal-release/verify-recovery-artifact.mjs';
const manifest={version:'0.9.30-daniel.12',agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:false}};
const policy=await readFile(new URL('../src/ops/memory-pressure.mjs',import.meta.url),'utf8');
const fallback=policy.replace('export const MEMORY_RECOVERY_ENABLED = true;','export const MEMORY_RECOVERY_ENABLED = false;');
it('executes only the selected fallback guard and keeps critical rejection and shutdown waits',async()=>{
 const bundle=fallback+'\nthrow Error("whole bundle bootstrap must never execute");';
 await expect(verifyRecoveryBundle({bundle,manifest,expectedVersion:manifest.version})).resolves.toMatchObject({verified:true,automaticResumeCalls:0,criticalStatus:503,drainWaited:true,stopWaited:true});
});
it('rejects a false manifest when the actual guard still enables recovery',async()=>{
 await expect(verifyRecoveryBundle({bundle:policy,manifest})).rejects.toThrow('compiled_recovery_not_disabled');
});
it.each(['',fallback+'\nfunction createMemoryPressureGuard() {}'])('fails closed on missing or ambiguous compiled guard',async bundle=>{
 await expect(verifyRecoveryBundle({bundle,manifest})).rejects.toThrow('compiled_guard_shape_unsupported');
});
it('rejects malformed profile and version before executing selected code',async()=>{
 await expect(verifyRecoveryBundle({bundle:'throw Error("not executed")',manifest:{...manifest,agentmemoryCompatibility:{backgroundControlVersion:2,automaticMemoryRecovery:true}}})).rejects.toThrow('recovery_manifest_invalid');
 await expect(verifyRecoveryBundle({bundle:fallback,manifest,expectedVersion:'0.9.30-daniel.13'})).rejects.toThrow('recovery_manifest_invalid');
});

it('rejects a disabled flag if the actual compiled automatic resume path remains active',async()=>{
 const active=fallback.replace("   if(!MEMORY_RECOVERY_ENABLED){state.recoveryStatus='disabled';return;}\n",'');
 expect(active).not.toBe(fallback);
 await expect(verifyRecoveryBundle({bundle:active,manifest})).rejects.toThrow('compiled_recovery_not_disabled');
});
