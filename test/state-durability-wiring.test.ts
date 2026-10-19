import { expect, it } from "vitest";
import { StateKV } from "../src/state/kv.js";
it("routes every file mutation through its fence", async () => {
 const touched:string[]=[];const sdk={trigger:async ({function_id}:any)=>function_id==='state::get'?{kept:true}:null};
 const durability={mutate:async (scope:string,key:string,fn:()=>Promise<unknown>)=>{touched.push(scope+'/'+key);return fn();}};
 const kv=new StateKV(sdk as never,{durability} as any);
 await kv.set('fixture','set',{});await kv.update('fixture','update',[]);await kv.delete('fixture','delete');
 expect(touched).toEqual(['fixture/set','fixture/update','fixture/delete']);
 expect(await kv.get('fixture','set')).toEqual({kept:true});
});
it("rejects writes when the file fence refuses admission",async()=>{
 let writes=0;const sdk={trigger:async()=>{writes++;}};
 const durability={mutate:async()=>{throw Object.assign(Error('frozen'),{code:'STATE_FROZEN'});}};
 const kv=new StateKV(sdk as never,{durability} as any);
 await expect(kv.set('fixture','raw',{sourceRaw:{toolOutput:'preserve'}})).rejects.toMatchObject({code:'STATE_FROZEN'});expect(writes).toBe(0);
});
