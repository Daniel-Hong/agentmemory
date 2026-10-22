const STAGES = new Set(['request','finish_session','session_lock_wait','session_read','session_write','feature_enqueue','feature_lock_wait','feature_session_read','feature_observations_read','feature_state_read','feature_state_write','ack_ready']);
type Outcome='acknowledged'|'failed';
const noop={enter(_stage:string){},finish(_outcome:Outcome){}};
export function createSessionEndDiagnostics({emit,clock=Date.now,slowMs=4000,intervalMs=60000,maxActive=8}:{emit:(fields:Record<string,unknown>)=>unknown;clock?:()=>number;slowMs?:number;intervalMs?:number;maxActive?:number}){
 let active=0,sequence=0,windowAt=-Infinity,lines=0,suppressed=0;
 const now=()=>{try{const n=clock();return Number.isFinite(n)?n:0;}catch{return 0;}};
 function write(fields:Record<string,unknown>){
  const at=now();if(at<windowAt||at-windowAt>=intervalMs){windowAt=at;lines=0;}
  if(lines>=2){suppressed++;return;}
  lines++;const omitted=suppressed;suppressed=0;
  try{void Promise.resolve(emit({requestKind:'session_end',...fields,suppressed:omitted})).catch(()=>{});}catch{}
 }
 return{begin(){
  if(active>=maxActive){suppressed++;return noop;}
  active++;const span=++sequence,began=now();let stage='request',mark=began,closed=false;
  const fields=(outcome:string)=>({span,stage,outcome,elapsedMs:Math.max(0,now()-began),stageElapsedMs:Math.max(0,now()-mark)});
  const timer=setTimeout(()=>write(fields('pending')),slowMs);timer.unref?.();
  return{enter(next:string){if(!closed){stage=STAGES.has(next)?next:'unknown';mark=now();}},finish(outcome:Outcome){if(closed)return;closed=true;clearTimeout(timer);active--;if(outcome==='failed'||now()-began>=slowMs)write(fields(outcome));}};
 },snapshot:()=>({active,suppressed})};
}
