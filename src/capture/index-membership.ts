import{createHash,randomUUID}from'node:crypto';

type Keyword={sessionOf(id:string):string|undefined};
type Vector={get(id:string):{sessionId:string}|undefined};
type Query={ids:string[]};
export function validIndexMembershipQuery(input:unknown):input is Query{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='ids'))return false;
 const ids=(input as Query).ids;
 return Array.isArray(ids)&&ids.length>=1&&ids.length<=32&&ids.every(id=>typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(id))&&new Set(ids).size===ids.length;
}
const sessionRef=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=256?createHash('sha256').update(value).digest('hex'):null;

export function createCaptureIndexMembership(options:{keyword:()=>Keyword|null;vector:()=>Vector|null}){
 const processEpoch=randomUUID();
 return(input:unknown)=>{
  if(!validIndexMembershipQuery(input))throw Object.assign(Error('INVALID_INDEX_MEMBERSHIP_QUERY'),{code:'INVALID_INDEX_MEMBERSHIP_QUERY'});
  const keyword=options.keyword(),vector=options.vector();
  const items=input.ids.map(id=>{
   let keywordPresent:boolean|null=null,vectorPresent:boolean|null=null,keywordSessionRef:string|null=null,vectorSessionRef:string|null=null;
   try{if(keyword){const session=keyword.sessionOf(id);keywordSessionRef=sessionRef(session);keywordPresent=session===undefined?false:keywordSessionRef?true:null;}}catch{}
   try{if(vector){const entry=vector.get(id);vectorSessionRef=sessionRef(entry?.sessionId);vectorPresent=entry===undefined?false:vectorSessionRef?true:null;}}catch{}
   return{id,keywordPresent,vectorPresent,keywordSessionRef,vectorSessionRef};
  });
  return{version:1,evidenceScope:'current_process_index_membership',processEpoch,observedAt:new Date().toISOString(),readOnly:true,sourceVerified:false,diskVerified:false,items};
 };
}
