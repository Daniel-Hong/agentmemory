import {openSync,readSync,closeSync} from 'node:fs';
// /proc/<pid>/net/tcp is the entire network namespace, not that PID's sockets.
// Stream it with bounded scratch space; retain only rows for explicitly owned
// socket inodes plus caller-selected endpoint conflicts. Host TIME_WAIT churn
// must not invalidate unrelated identities.
export function readOwnedTcpRows(path,owned,includeRow=()=>false){
 const fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(64*1024),rows=[];
 let pending='';
 const line=value=>{
  if(value.length>4096)throw Object.assign(Error('PROC_TCP_LINE_LIMIT'),{code:'PROC_TCP_LINE_LIMIT'});
  const p=value.trim().split(/\s+/);
  if(!['01','0A'].includes(p[3]))return;
  const row={local:p[1]?.toUpperCase(),remote:p[2]?.toUpperCase(),state:p[3],inode:p[9]};
  if(!owned.has(p[9])&&!includeRow(row))return;
  if(!/^[A-Fa-f0-9]{8}(?:[A-Fa-f0-9]{24})?:[A-Fa-f0-9]{4}$/.test(p[1]??'')||!/^[A-Fa-f0-9]{8}(?:[A-Fa-f0-9]{24})?:[A-Fa-f0-9]{4}$/.test(p[2]??''))throw Object.assign(Error('PROC_TCP_OWNED_ROW_INVALID'),{code:'PROC_TCP_OWNED_ROW_INVALID'});
  rows.push(row);
  if(rows.length>owned.size*2+2)throw Object.assign(Error('PROC_TCP_OWNED_ROW_LIMIT'),{code:'PROC_TCP_OWNED_ROW_LIMIT'});
 };
 try{
  let count;
  while((count=readSync(fd,chunk,0,chunk.length,null))>0){
   const text=chunk.toString('ascii',0,count);let start=0,next;
   while((next=text.indexOf('\n',start))!==-1){line(pending+text.slice(start,next));pending='';start=next+1;}
   pending+=text.slice(start);if(pending.length>4096)throw Object.assign(Error('PROC_TCP_LINE_LIMIT'),{code:'PROC_TCP_LINE_LIMIT'});
  }
  if(pending)line(pending);return rows;
 }finally{closeSync(fd);}
}
