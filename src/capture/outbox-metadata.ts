import { opendir } from 'node:fs/promises';

export interface OutboxMetadata {
  records:number|null;
  complete:boolean;
  available:boolean;
  inspectedAt:string;
}

export function createOutboxMetadata(path:string):()=>Promise<OutboxMetadata> {
  let cached:OutboxMetadata|undefined,expires=0,pending:Promise<OutboxMetadata>|undefined;
  async function scan():Promise<OutboxMetadata> {
    const inspectedAt=new Date().toISOString();let records=0,entries=0;
    try {
      const directory=await opendir(path);
      for await(const entry of directory){
        if(entry.isFile()&&(entry.name.endsWith('.json')||entry.name.endsWith('.json.corrupt')))records++;
        if(++entries>=10_000)return {records,complete:false,available:true,inspectedAt};
      }
      return {records,complete:true,available:true,inspectedAt};
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return {records:0,complete:true,available:true,inspectedAt};
      return {records:null,complete:false,available:false,inspectedAt};
    }
  }
  return ()=>{
    if(cached&&Date.now()<expires)return Promise.resolve(cached);
    if(!pending)pending=scan().then(value=>{cached=value;expires=Date.now()+60_000;return value;}).finally(()=>{pending=undefined;});
    return pending;
  };
}
