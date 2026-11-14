import {expect,it} from 'vitest';
import {createStateDurabilityFence} from '../src/ops/state-durability.mjs';

const selected=[{scope:'mem:obs:synthetic',key:'selected'}];
const fixture=()=>createStateDurabilityFence({storePath:'/tmp/synthetic-key-watch',completion:'sdk'});

it('ignores unrelated keys and dirty-key pruning while observing the selected key',async()=>{
 const fence=fixture();await fence.mutate(selected[0].scope,selected[0].key,async()=>{});
 const watch=fence.watchKeys(selected);
 await fence.mutate(selected[0].scope,'other',async()=>{});fence.forgetKeys(fence.keysFor(selected));
 expect(watch.unchanged()).toBe(true);watch.release();expect(watch.unchanged()).toBe(false);watch.release();
});
it('rejects selected mutations that begin before or after watch registration including ABA',async()=>{
 for(const startBefore of [false,true]){
  const fence=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const before=startBefore?fence.mutate(selected[0].scope,selected[0].key,()=>gate):null;
  const watch=fence.watchKeys(selected),pending=before??fence.mutate(selected[0].scope,selected[0].key,()=>gate);
  expect(watch.unchanged()).toBe(false);release();await pending;
  await fence.mutate(selected[0].scope,selected[0].key,async()=>{});expect(watch.unchanged()).toBe(false);watch.release();
 }
});
it('ignores an unrelated pending key without hiding its uncertain SDK outcome',async()=>{
 const fence=fixture();let reject!:(error:Error)=>void;
 const pending=fence.mutate(selected[0].scope,'other',()=>new Promise((_,no)=>reject=no));void pending.catch(()=>{});
 const watch=fence.watchKeys(selected);expect(watch.unchanged()).toBe(true);await Promise.resolve();reject(Error('lost response'));await expect(pending).rejects.toThrow('lost response');
 expect(watch.unchanged()).toBe(true);await expect(fence.waitForKeys({get:async()=>({id:'selected'})},selected)).rejects.toMatchObject({code:'SDK_MUTATION_UNCERTAIN'});watch.release();
});
