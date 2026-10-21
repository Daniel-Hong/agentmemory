import {open,stat} from 'node:fs/promises';
import {StringDecoder} from 'node:string_decoder';

const fail=code=>Object.assign(Error(code),{code});
const white=char=>char===' '||char==='\n'||char==='\r'||char==='\t';
const signature=value=>[value.dev,value.ino,value.size,value.mtimeNs,value.ctimeNs].join(':');

// iii namespaces contain one JSON object followed by an opaque rkyv archive trailer.
// Keep at most one entry's JSON text; selected values and caller projections are optional.
export async function readNamespaceEntries(path,{keys,onEntry,chunkSize=64*1024,signal,onRead,checkIntervalBytes=0,maxSelectedBytes=Infinity}={}){
  if(!Number.isSafeInteger(chunkSize)||chunkSize<1)throw fail('state_namespace_chunk_invalid');
  if(!Number.isSafeInteger(checkIntervalBytes)||checkIntervalBytes<0)throw fail('state_namespace_check_interval_invalid');
  if(maxSelectedBytes!==Infinity&&(!Number.isSafeInteger(maxSelectedBytes)||maxSelectedBytes<0))throw fail('state_namespace_projection_limit_invalid');
  const handle=await open(path,'r'),decoder=new StringDecoder('utf8'),utf8=new TextDecoder('utf-8',{fatal:true});
  const values=new Map(),seen=new Set();let stream,fileBytes=null,complete=false;
  let state='start',key='',keyText='',keyQuoted=false,keyEscape=false,valueParts=[],valueStart=null,valueQuoted=false,valueEscape=false,valueDepth=0,valueKind='';
  let rawStarted=false,rawQuoted=false,rawEscape=false,rawDepth=0,prefixComplete=false,entries=0,bytesRead=0,maxEntryChars=0,lastSignatureCheck=0,selectedBytes=0;
  async function consume(text){
    const delimiter=/["\\]/g;
    if(state==='value')valueStart=0;
    async function finish(end){
      if(valueStart!==null)valueParts.push(text.slice(valueStart,end));
      const json=valueParts.join('');maxEntryChars=Math.max(maxEntryChars,json.length);
      if(keys?.has(key)&&maxSelectedBytes!==Infinity){
        selectedBytes+=Buffer.byteLength(json,'utf8')+Buffer.byteLength(key,'utf8');
        if(selectedBytes>maxSelectedBytes)throw fail('state_namespace_projection_limit');
      }
      let value;try{value=JSON.parse(json);}catch{throw fail('state_namespace_corrupt');}
      if(keys?.has(key))values.set(key,value);
      if(onEntry){const pending=onEntry(key,value);if(pending&&typeof pending.then==='function')await pending;}
      entries++;valueParts=[];valueStart=null;state='after';
    }
    for(let i=0;i<text.length;i++){
      if(state==='value'&&valueQuoted&&!valueEscape){
        delimiter.lastIndex=i;if(!delimiter.test(text))break;i=delimiter.lastIndex-1;
      }
      const char=text[i];let again=true;
      while(again){again=false;
        if(state==='start'){if(white(char))continue;if(char!=='{')throw fail('state_namespace_shape');state='key_or_end';}
        else if(state==='key_or_end'||state==='key_required'){
          if(white(char))continue;
          if(char==='}'&&state==='key_or_end'){state='done';continue;}
          if(char!=='"')throw fail('state_namespace_corrupt');keyText='"';keyQuoted=true;keyEscape=false;state='key';
        }else if(state==='key'){
          keyText+=char;
          if(keyEscape)keyEscape=false;else if(char==='\\')keyEscape=true;else if(char==='"')keyQuoted=false;
          if(!keyQuoted){try{key=JSON.parse(keyText);}catch{throw fail('state_namespace_corrupt');}if(seen.has(key))throw fail('state_namespace_duplicate');seen.add(key);state='colon';}
        }else if(state==='colon'){if(white(char))continue;if(char!==':')throw fail('state_namespace_corrupt');state='before_value';}
        else if(state==='before_value'){
          if(white(char))continue;
          valueStart=i;valueParts=[];valueDepth=0;valueQuoted=false;valueEscape=false;
          valueKind=char==='"'?'string':char==='{'||char==='['?'compound':'primitive';state='value';again=true;
        }else if(state==='value'){
          if(valueKind==='primitive'){
            if(char===','||char==='}'||white(char)){await finish(i);again=true;}
          }else if(valueQuoted){
            if(valueEscape)valueEscape=false;else if(char==='\\')valueEscape=true;else if(char==='"'){valueQuoted=false;if(valueKind==='string')await finish(i+1);}
          }else if(char==='"')valueQuoted=true;
          else if(char==='{'||char==='[')valueDepth++;
          else if(char==='}'||char===']'){valueDepth--;if(valueDepth===0)await finish(i+1);}
        }else if(state==='after'){
          if(white(char))continue;if(char===',')state='key_required';else if(char==='}')state='done';else throw fail('state_namespace_corrupt');
        }else if(state==='done'){if(!white(char))throw fail('state_namespace_corrupt');}
      }
    }
    if(state==='value'&&valueStart!==null){valueParts.push(text.slice(valueStart));valueStart=0;}
  }
  try{
    const beforeStat=await handle.stat({bigint:true}),before=signature(beforeStat);
    fileBytes=Number(beforeStat.size);
    signal?.throwIfAborted();
    stream=handle.createReadStream({autoClose:false,autoDestroy:false,highWaterMark:chunkSize,signal});
    for await(const chunk of stream.iterator({destroyOnReturn:false})){
      if(checkIntervalBytes&&bytesRead-lastSignatureCheck>=checkIntervalBytes){
        signal?.throwIfAborted();
        const opened=signature(await handle.stat({bigint:true}));
        let current;try{current=signature(await stat(path,{bigint:true}));}catch(error){if(error.code==='ENOENT')throw fail('state_namespace_changed');throw error;}
        signal?.throwIfAborted();
        if(before!==opened||opened!==current)throw fail('state_namespace_changed');
        lastSignatureCheck=bytesRead;
      }
      const rawText=chunk.toString('latin1'),delimiter=/["\\]/g;
      let end=chunk.length;
      for(let i=0;i<chunk.length;i++){
        if(rawQuoted&&!rawEscape){
          delimiter.lastIndex=i;if(!delimiter.test(rawText))break;i=delimiter.lastIndex-1;
        }
        const byte=chunk[i];
        if(!rawStarted){if([9,10,13,32].includes(byte))continue;if(byte!==123)throw fail('state_namespace_shape');rawStarted=true;rawDepth=1;continue;}
        if(rawQuoted){if(rawEscape)rawEscape=false;else if(byte===92)rawEscape=true;else if(byte===34)rawQuoted=false;}
        else if(byte===34)rawQuoted=true;
        else if(byte===123||byte===91)rawDepth++;
        else if(byte===125||byte===93){if(--rawDepth===0){end=i+1;prefixComplete=true;break;}}
      }
      const prefix=chunk.subarray(0,end);bytesRead+=prefix.length;
      try{utf8.decode(prefix,{stream:!prefixComplete});}catch{throw fail('state_namespace_utf8');}
      await consume(decoder.write(prefix));
      if(prefixComplete){await consume(decoder.end());break;}
    }
    const after=signature(await handle.stat({bigint:true}));
    let current;try{current=signature(await stat(path,{bigint:true}));}catch(error){if(error.code==='ENOENT')throw fail('state_namespace_changed');throw error;}
    if(before!==after||after!==current)throw fail('state_namespace_changed');
    if(!prefixComplete||state!=='done')throw fail('state_namespace_incomplete');
    complete=true;
    return{values,entries,bytesRead,maxEntryChars,signature:after};
  }finally{
    try{stream?.destroy();await handle.close();}
    finally{try{const observer=onRead?.({fileBytes,bytesRead,entries,complete});if(observer&&typeof observer.then==='function')Promise.resolve(observer).catch(()=>{});}catch{}}
  }
}
