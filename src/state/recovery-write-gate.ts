import {AsyncLocalStorage} from 'node:async_hooks';
export function createRecoveryWriteGate(){
 const context=new AsyncLocalStorage<{active:boolean;exclusive:boolean}>();
 const queue:Array<{exclusive:boolean;start:()=>void}>=[];let readers=0,writer=false;
 function pump(){
  if(writer||!queue.length)return;
  if(queue[0].exclusive){if(readers)return;writer=true;queue.shift()!.start();}
  else while(queue.length&&!queue[0].exclusive){readers++;queue.shift()!.start();}
 }
 function run<T>(exclusive:boolean,fn:()=>Promise<T>):Promise<T>{
  const held=context.getStore();if(held?.active&&held.exclusive)return Promise.resolve().then(fn);
  if(held?.active&&exclusive)return Promise.reject(Error('RECOVERY_LOCK_ORDER'));
  return new Promise<T>((resolve,reject)=>{
   queue.push({exclusive,start(){const token={active:true,exclusive};context.run(token,async()=>{try{resolve(await fn());}catch(error){reject(error);}finally{token.active=false;if(exclusive)writer=false;else readers--;pump();}});}});pump();
  });
 }
 return {read:<T>(fn:()=>Promise<T>)=>run(false,fn),exclusive:<T>(fn:()=>Promise<T>)=>run(true,fn)};
}

export function createRecordRecoveryGate(){
 type Entry={gate:ReturnType<typeof createRecoveryWriteGate>;references:number};
 const entries=new Map<string,Entry>();
 const context=new AsyncLocalStorage<{active:boolean;keys:Set<string>}>();
 const identity=(scope:string,key:string)=>JSON.stringify([scope,key]);
 async function use<T>(id:string,exclusive:boolean,fn:()=>Promise<T>):Promise<T>{
  let entry=entries.get(id);if(!entry){entry={gate:createRecoveryWriteGate(),references:0};entries.set(id,entry);}
  entry.references++;
  try{return await (exclusive?entry.gate.exclusive(fn):entry.gate.read(fn));}
  finally{if(--entry.references===0)entries.delete(id);}
 }
 return {
  read<T>(scope:string,key:string,fn:()=>Promise<T>):Promise<T>{
   const id=identity(scope,key),held=context.getStore();
   if(held?.active&&!held.keys.has(id))return Promise.reject(Error('RECOVERY_LOCK_ORDER'));
   return use(id,false,fn);
  },
  exclusive<T>(keys:Array<{scope:string;key:string}>,fn:()=>Promise<T>):Promise<T>{
   const ids=[...new Set(keys.map(p=>identity(p.scope,p.key)))].sort();
   const held=context.getStore();
   if(held?.active)return Promise.reject(Error('RECOVERY_LOCK_ORDER'));
   const acquire=(at:number):Promise<T>=>at<ids.length?use(ids[at],true,()=>acquire(at+1)):invoke();
   function invoke(){const token={active:true,keys:new Set(ids)};return context.run(token,async()=>{try{return await fn();}finally{token.active=false;}});}
   return acquire(0);
  },
  inExclusive:()=>context.getStore()?.active===true,
  size:()=>entries.size,
 };
}
