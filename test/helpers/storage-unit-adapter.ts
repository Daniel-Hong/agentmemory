import {createHash} from 'node:crypto';
import type {StateKV} from '../../src/state/kv.js';

export const storageUnitFor=(key:string)=>createHash('sha256').update(key).digest()[0]!&15;

// Experimental fixture only. There is no logical shadow namespace or dual write.
export function createStorageUnitAdapter(physical:StateKV,logicalScopes:string[],count:1|16) {
 const routed=new Set(logicalScopes),rawFence=physical.durability!;
 const units=(scope:string)=>routed.has(scope)&&count===16?Array.from({length:16},(_,n)=>scope+':unit:'+n.toString(16).padStart(2,'0')):[scope];
 const route=(scope:string,key:string)=>routed.has(scope)&&count===16?units(scope)[storageUnitFor(key)]!:scope;
 const selections=(rows:any[])=>rows.map(row=>({...row,scope:route(row.scope,row.key)}));
 const fence=new Proxy(rawFence,{get(target,property){
  if(property==='waitForKeys')return(_kv:unknown,rows:any[],...options:any[])=>target.waitForKeys(physical,selections(rows),...options);
  if(property==='waitForKeyGroups')return(_kv:unknown,groups:any[][],...options:any[])=>target.waitForKeyGroups(physical,groups.map(selections),...options);
  if(property==='keysFor')return(rows:any[])=>target.keysFor(selections(rows));
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
 }});
 const reader=physical.observationReader;
 const observationReader=reader?new Proxy(reader,{get(target,property){
  if(property==='captureSummary')return async(scope:string,exclude:string)=>{
   const summaries=await Promise.all(units(scope).map(unit=>target.captureSummary(unit,exclude)));
   return summaries.reduce((total,row)=>({count:total.count+row.count,summaryCount:total.summaryCount+row.summaryCount,summaryBytes:total.summaryBytes+row.summaryBytes,sourceBytes:total.sourceBytes+row.sourceBytes}),{count:0,summaryCount:0,summaryBytes:0,sourceBytes:0});
  };
  if(property==='mutationRevision'||property==='pendingMutations')return(scope:string)=>units(scope).reduce((n,unit)=>n+(target as any)[property](unit),0);
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
 }}):null;
 const kv=new Proxy(physical,{get(target,property){
  if(property==='durability')return fence;
  if(property==='observationReader')return observationReader;
  if(property==='get'||property==='set'||property==='update'||property==='delete')return(scope:string,key:string,...args:any[])=>(target as any)[property](route(scope,key),key,...args);
  if(property==='list')return async(scope:string)=>(await Promise.all(units(scope).map(unit=>target.list(unit)))).flat();
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
 }})as StateKV;
 return{kv,route,units,count};
}
