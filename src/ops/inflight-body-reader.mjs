import {setImmediate as yieldTurn} from 'node:timers/promises';

export function createInflightBodyReader(){
 const flights=new Map();let admittedBytes=0,reservations=0;
 function retire(key,flight){if(flights.get(key)===flight)flights.delete(key);flight.accepting=false;}
 return async function read({key,fileBytes,signal,load}){
  signal?.throwIfAborted();
  let flight=flights.get(key);
  if(!flight?.accepting||flight.consumers.length>=2){
   if(flight||reservations>=8||!Number.isSafeInteger(fileBytes)||fileBytes<0||fileBytes+admittedBytes>512*1024*1024)return load(signal);
   flight={bytes:fileBytes,accepting:true,consumers:[],controller:new AbortController()};flights.set(key,flight);admittedBytes+=fileBytes;reservations++;
  }
  const current=flight;
  const result=new Promise((resolve,reject)=>{
   const consumer={resolve,reject,signal,active:true,abort:null};
   consumer.abort=()=>{
    if(!consumer.active)return;consumer.active=false;reject(signal.reason??new DOMException('Aborted','AbortError'));
    if(!current.consumers.some(item=>item.active)){retire(key,current);current.controller.abort();}
   };
   current.consumers.push(consumer);signal?.addEventListener('abort',consumer.abort,{once:true});
   if(signal?.aborted)consumer.abort();
  });
  if(current.consumers.length===1){
   void Promise.resolve().then(async()=>{
    try{
     const rows=await load(current.controller.signal);current.accepting=false;
     const active=current.consumers.filter(item=>item.active),copies=new Map();
     for(const consumer of active.slice(1)){
      const copy=new Map();let yieldedAt=performance.now();
      for(const [id,row]of rows){
       if(!consumer.active)break;
       current.controller.signal.throwIfAborted();copy.set(id,structuredClone(row));
       if(performance.now()-yieldedAt>=4){await yieldTurn();yieldedAt=performance.now();}
      }
      if(consumer.active)copies.set(consumer,copy);
     }
     for(let i=0;i<active.length;i++)if(active[i].active){active[i].active=false;active[i].resolve(i===0?rows:copies.get(active[i]));}
    }catch(error){for(const consumer of current.consumers)if(consumer.active){consumer.active=false;consumer.reject(error);}}
    finally{retire(key,current);admittedBytes-=current.bytes;reservations--;for(const consumer of current.consumers)consumer.signal?.removeEventListener('abort',consumer.abort);current.consumers.length=0;}
   });
  }
  return result;
 };
}
