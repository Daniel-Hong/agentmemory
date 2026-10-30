import {createHash,randomUUID} from 'node:crypto';
import type {StateKV} from '../state/kv.js';
import {KV} from '../state/schema.js';

export interface CaptureIndexEvidenceQuery {keys:string[]}
export function validCaptureIndexEvidenceQuery(input:unknown):input is CaptureIndexEvidenceQuery {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='keys'))return false;
  const keys=(input as CaptureIndexEvidenceQuery).keys;
  return Array.isArray(keys)&&keys.length>=1&&keys.length<=10&&[...keys].every(k=>typeof k==='string'&&/^cap_[a-f0-9]{40}$/.test(k))&&new Set(keys).size===keys.length;
}

const fail=(code:string)=>Object.assign(new Error(code),{code});
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const ref=(value:string)=>createHash('sha256').update(value).digest('hex');
const ownerRef=(value:unknown)=>validId(value)?ref(value):null;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const statuses=new Set(['pending','retrying','dead','completed']);

export function captureIndexEvidenceInvocationQuery(input:unknown):CaptureIndexEvidenceQuery {
  if(!record(input))throw fail('INVALID_CAPTURE_INDEX_EVIDENCE_QUERY');
  const {_caller_worker_id,...query}=input;
  if(_caller_worker_id!==undefined&&typeof _caller_worker_id!=='string'||!validCaptureIndexEvidenceQuery(query))throw fail('INVALID_CAPTURE_INDEX_EVIDENCE_QUERY');
  return query;
}

type Keyword={has(id:string):boolean;sessionOf(id:string):string|undefined};
type Vector={get(id:string):{sessionId?:string}|undefined};
interface Options {
  keyword:()=>Keyword|null;
  vector:()=>Vector|null;
  indexEpoch:()=>number;
  indexRebuilding:()=>boolean;
  budgetMs?:number;
}
interface IndexValues {
  keywordPresent:boolean|null;
  keywordSessionRef:string|null;
  vectorPresent:boolean|null;
  vectorSessionRef:string|null;
}
interface Item extends IndexValues {
  keyRef:string;
  historyStatus:string;
  historyMetadataValid:boolean;
  expectedSessionRef:string|null;
  observationRef:string|null;
  canonicalLookupAttempted:boolean;
  canonicalRecordRead:boolean|null;
  canonicalPresent:boolean|null;
  canonicalIdMatch:boolean|null;
  canonicalSessionMatch:boolean|null;
  canonicalCaptureKeyMatch:boolean|null;
  sourceRecordPresent:boolean|null;
  sourceMetadataValid:boolean|null;
  titleIsString:boolean|null;
  titleNonempty:boolean|null;
  narrativeIsString:boolean|null;
  narrativeNonempty:boolean|null;
  sessionPresent:boolean|null;
  sessionIdMatch:boolean|null;
  evidenceStatus:'observed'|'changed'|'unavailable';
  unavailableCode:string|null;
}
function emptyItem(key:string):Item {
  return {keyRef:ref(key),historyStatus:'unknown',historyMetadataValid:false,expectedSessionRef:null,observationRef:null,canonicalLookupAttempted:false,canonicalRecordRead:false,canonicalPresent:null,canonicalIdMatch:null,canonicalSessionMatch:null,canonicalCaptureKeyMatch:null,sourceRecordPresent:null,sourceMetadataValid:null,titleIsString:null,titleNonempty:null,narrativeIsString:null,narrativeNonempty:null,sessionPresent:null,sessionIdMatch:null,keywordPresent:null,keywordSessionRef:null,vectorPresent:null,vectorSessionRef:null,evidenceStatus:'unavailable',unavailableCode:null};
}

export function createCaptureIndexEvidence(kv:StateKV,options:Options) {
  const budgetMs=options.budgetMs??2000;
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>5000)throw fail('INVALID_CAPTURE_INDEX_EVIDENCE_BUDGET');
  const processEpoch=randomUUID();let active=false;
  function indexState(){
    let epoch:number|null=null,rebuilding:boolean|null=null;
    try{const value=options.indexEpoch();if(Number.isSafeInteger(value)&&value>=0)epoch=value;}catch{}
    try{const value=options.indexRebuilding();if(typeof value==='boolean')rebuilding=value;}catch{}
    return {epoch,rebuilding};
  }
  function indexValues(id:string){
    const values:IndexValues={keywordPresent:null,keywordSessionRef:null,vectorPresent:null,vectorSessionRef:null};
    let keyword:Keyword|null=null,vector:Vector|null=null,available=true;
    try{
      keyword=options.keyword();
      if(!keyword)available=false;
      else{
        try{const present=keyword.has(id);if(typeof present==='boolean')values.keywordPresent=present;else available=false;}catch{available=false;}
        try{const session=keyword.sessionOf(id);if(session!==undefined&&!validId(session))available=false;else values.keywordSessionRef=ownerRef(session);}catch{available=false;}
      }
    }catch{available=false;}
    try{
      vector=options.vector();
      if(!vector)available=false;
      else{
        const entry=vector.get(id);
        if(entry!==undefined&&!record(entry))available=false;
        else{
          values.vectorPresent=entry!==undefined;
          const owner=entry?.sessionId;
          if(entry!==undefined&&!validId(owner))available=false;
          else values.vectorSessionRef=ownerRef(owner);
        }
      }
    }catch{available=false;}
    return {values,keyword,vector,available};
  }
  type Sample=ReturnType<typeof indexValues>;
  const changed=(a:Sample,b:Sample)=>a.keyword!==b.keyword||a.vector!==b.vector||Object.keys(a.values).some(k=>a.values[k as keyof IndexValues]!==b.values[k as keyof IndexValues]);
  return async(input:unknown)=>{
    if(!validCaptureIndexEvidenceQuery(input))throw fail('INVALID_CAPTURE_INDEX_EVIDENCE_QUERY');
    if(active)throw fail('CAPTURE_INDEX_EVIDENCE_BUSY');
    const keys=[...input.keys];
    active=true;
    const deadline=Date.now()+budgetMs,outstanding=new Set<Promise<unknown>>(),indexBefore=indexState();
    const samples:Array<{item:Item;id:string;before:Sample}>=[];
    let expired=false,closed=false;
    async function bounded<T>(read:()=>Promise<T>):Promise<T>{
      const remaining=deadline-Date.now();
      if(closed||remaining<=0){expired=true;throw fail('CAPTURE_INDEX_EVIDENCE_TIMEOUT');}
      const work=Promise.resolve().then(read);outstanding.add(work);
      work.then(()=>outstanding.delete(work),()=>outstanding.delete(work));
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(fail('CAPTURE_INDEX_EVIDENCE_TIMEOUT'));},remaining);})]);}
      finally{clearTimeout(timer);}
    }
    async function inspect(key:string):Promise<Item>{
      const item=emptyItem(key);
      try{
        const history=await bounded(()=>kv.get<unknown>(KV.captureReview,key));
        item.historyStatus=history===null||history===undefined?'absent':record(history)&&typeof history.status==='string'&&statuses.has(history.status)?history.status:'unknown';
        if(!record(history)||history.key!==key||!validId(history.sessionId)||!validId(history.observationId)||!statuses.has(item.historyStatus)){
          item.unavailableCode='CAPTURE_INDEX_EVIDENCE_HISTORY_UNAVAILABLE';return item;
        }
        const sessionId=history.sessionId,id=history.observationId;
        item.historyMetadataValid=true;item.expectedSessionRef=ref(sessionId);item.observationRef=ref(id);
        const before=indexValues(id);Object.assign(item,before.values);samples.push({item,id,before});
        const canonical=await bounded(()=>{item.canonicalLookupAttempted=true;item.canonicalRecordRead=null;return kv.get<unknown>(KV.observations(sessionId),id);});
        item.canonicalPresent=canonical!==null&&canonical!==undefined;item.canonicalRecordRead=item.canonicalPresent;
        if(item.canonicalPresent){
          item.canonicalIdMatch=record(canonical)&&canonical.id===id;
          item.canonicalSessionMatch=record(canonical)&&canonical.sessionId===sessionId;
          item.canonicalCaptureKeyMatch=record(canonical)&&canonical.captureKey===key;
          const source=record(canonical)?canonical.sourceRaw:undefined;
          item.sourceRecordPresent=source!==null&&source!==undefined;
          item.sourceMetadataValid=record(source)&&source.id===id&&source.sessionId===sessionId&&source.captureKey===key&&typeof source.hookType==='string'&&source.hookType.length>0&&source.hookType.length<=64&&typeof source.timestamp==='string'&&source.timestamp.length<=64&&Number.isFinite(Date.parse(source.timestamp));
          const title=record(canonical)?canonical.title:undefined,narrative=record(canonical)?canonical.narrative:undefined;
          item.titleIsString=typeof title==='string';item.titleNonempty=typeof title==='string'&&title.trim().length>0;
          item.narrativeIsString=typeof narrative==='string';item.narrativeNonempty=typeof narrative==='string'&&narrative.trim().length>0;
        }
        const session=await bounded(()=>kv.get<unknown>(KV.sessions,sessionId));
        item.sessionPresent=session!==null&&session!==undefined;
        item.sessionIdMatch=item.sessionPresent?record(session)&&session.id===sessionId:null;
        const after=indexValues(id);
        if(!before.available||!after.available){item.unavailableCode='CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE';}
        else if(changed(before,after)){item.evidenceStatus='changed';item.unavailableCode='CAPTURE_INDEX_EVIDENCE_INDEX_CHANGED';}
        else item.evidenceStatus='observed';
      }catch{item.unavailableCode=expired?'CAPTURE_INDEX_EVIDENCE_TIMEOUT':'CAPTURE_INDEX_EVIDENCE_READ_UNAVAILABLE';}
      return item;
    }
    try{
      const items:Item[]=[];
      for(const key of keys)items.push(await inspect(key));
      const indexAfter=indexState();
      const stateUnavailable=indexBefore.epoch===null||indexBefore.rebuilding===null||indexAfter.epoch===null||indexAfter.rebuilding===null;
      const stateChanged=indexBefore.epoch!==indexAfter.epoch||indexBefore.rebuilding===true||indexAfter.rebuilding===true;
      for(const {item,id,before} of samples){
        if(item.evidenceStatus!=='observed')continue;
        const after=indexValues(id);
        if(stateUnavailable||!after.available){item.evidenceStatus='unavailable';item.unavailableCode='CAPTURE_INDEX_EVIDENCE_INDEX_UNAVAILABLE';}
        else if(stateChanged||changed(before,after)){item.evidenceStatus='changed';item.unavailableCode='CAPTURE_INDEX_EVIDENCE_INDEX_CHANGED';}
      }
      const canonicalRecordRead=items.some(item=>item.canonicalRecordRead===true)?true:items.some(item=>item.canonicalRecordRead===null)?null:false;
      const consistency=stateChanged||items.some(item=>item.evidenceStatus==='changed')?'changed':stateUnavailable||items.some(item=>item.evidenceStatus==='unavailable')?'unavailable':'non_atomic_observed_stable';
      return {version:1,evidenceScope:'selected_capture_canonical_current_index',processEpoch,observedAt:new Date().toISOString(),readOnly:true,rawOutput:false,canonicalRecordRead,consistency,indexBefore,indexAfter,items};
    }finally{closed=true;void Promise.allSettled([...outstanding]).then(()=>{active=false;});}
  };
}
