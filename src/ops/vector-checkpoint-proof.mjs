import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const META = 'mem:index:bm25', PENDING = 'mem:index:vec-pending';
const MiB = 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function requireProof(ok) {
  if (!ok) throw Object.assign(new Error('VECTOR_CHECKPOINT_UNVERIFIED'), {code:'VECTOR_CHECKPOINT_UNVERIFIED'});
}
const signature = s => [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');

// Native iii 0.22.1 stores KeyStorage(String) as a little-endian rkyv 0.8 archive.
// Accept only its canonical encoding. A valid JSON prefix alone cannot certify an archive.
function namespaceRows(bytes) {
  requireProof(bytes.length >= 8 && bytes.length % 4 === 0);
  const root = bytes.length - 8;
  let length;
  if (root === 0) {
    length = bytes.indexOf(0xff);
    if (length < 0) length = 8;
    requireProof(bytes.subarray(length).every(b=>b===0xff));
  } else {
    const size = bytes.readUInt32LE(root);
    length = (size & 63) + Math.floor(size / 256) * 64;
    requireProof((size & 192) === 128 && bytes.readInt32LE(root+4) === -root &&
      length > 8 && Math.ceil(length/4)*4 === root && bytes.subarray(length,root).every(b=>b===0));
  }
  const json = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length));
  const rows = JSON.parse(json);
  // This narrow repair refuses duplicate keys, rounded numbers and noncanonical serializations.
  requireProof(rows !== null && typeof rows === 'object' && !Array.isArray(rows) && JSON.stringify(rows) === json);
  return rows;
}

function pendingMap(rows) {
  requireProof(Array.isArray(rows) && rows.length <= 16);
  const byId = new Map(), sequences = new Set();
  for (const row of rows) {
    requireProof(row && Object.keys(row).every(k=>['id','s','e','q','k'].includes(k)) &&
      typeof row.id === 'string' && row.id.length > 0 && row.id.length <= 1024 && row.id !== '~clear' &&
      typeof row.s === 'string' && row.s.length > 0 && row.s.length <= 1024 &&
      Number.isSafeInteger(row.q) && row.q > 0 && !sequences.has(row.q) && !byId.has(row.id) &&
      (row.k === undefined || row.k === 'memory' || row.k === 'observation') &&
      typeof row.e === 'string' && row.e.length > 0 && row.e.length <= 256*1024);
    const embedding = Buffer.from(row.e,'base64');
    requireProof(embedding.length > 0 && embedding.length % 4 === 0 && embedding.toString('base64') === row.e);
    for (let offset=0; offset<embedding.length; offset+=4) requireProof(Number.isFinite(embedding.readFloatLE(offset)));
    sequences.add(row.q);
    byId.set(row.id,{...row});
  }
  return byId;
}

function pendingFile(byId) {
  const expected = Object.fromEntries(byId);
  return {scope:PENDING, limit:6*MiB, allowMissing:byId.size===0,
    verify(rows) { requireProof(isDeepStrictEqual(rows,expected)); }};
}

async function prove(storePath, admitted, files) {
  requireProof(typeof admitted === 'function' && admitted() === true && isAbsolute(storePath) && await realpath(storePath) === storePath);
  const deadline = performance.now()+30000, pins = new Map();
  const directory = await open(storePath,READ_FLAGS|constants.O_DIRECTORY);
  const dirId = await directory.stat({bigint:true});
  const prefix = '/proc/self/fd/'+directory.fd;
  async function current() {
    const live = await lstat(storePath,{bigint:true});
    requireProof(performance.now()<deadline && live.isDirectory() && live.dev===dirId.dev && live.ino===dirId.ino && admitted()===true);
  }
  async function verifyNames(base, rehash=false) {
    for (const [name,pin] of pins) {
      let st;
      try { st=await lstat(join(base,name),{bigint:true}); } catch (e) { if(e.code!=='ENOENT')throw e; }
      requireProof(pin===null ? !st : st?.isFile() && signature(st)===pin.signature);
      if (pin && rehash) {
        const handle=await open(join(base,name),READ_FLAGS);
        try {
          requireProof(signature(await handle.stat({bigint:true}))===pin.signature);
          const digest=createHash('sha256'), chunk=Buffer.allocUnsafe(Math.min(MiB,Number(st.size)));
          for (let offset=0; offset<Number(st.size);) {
            const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,Number(st.size)-offset),offset);
            requireProof(bytesRead>0 && performance.now()<deadline);
            digest.update(chunk.subarray(0,bytesRead));offset+=bytesRead;
          }
          requireProof(digest.digest('hex')===pin.sha256 && signature(await handle.stat({bigint:true}))===pin.signature);
        } finally { await handle.close(); }
      }
    }
  }
  try {
    let total = 0;
    for (const file of files) {
      await current();
      const name=encodeURIComponent(file.scope)+'.bin', path=join(prefix,name);
      let handle;
      try { handle=await open(path,READ_FLAGS); } catch (e) {
        if(e.code!=='ENOENT'||!file.allowMissing)throw e;
        pins.set(name,null);
        continue;
      }
      try {
        const st=await handle.stat({bigint:true}), size=Number(st.size);
        total+=size;
        requireProof(st.isFile() && st.nlink===1n && size>=8 && size<=file.limit && total<=64*MiB);
        const data=Buffer.allocUnsafe(size);
        for(let offset=0;offset<size;) {
          const {bytesRead}=await handle.read(data,offset,Math.min(MiB,size-offset),offset);
          requireProof(bytesRead>0 && performance.now()<deadline);offset+=bytesRead;
        }
        file.verify(namespaceRows(data),size);
        await handle.sync();
        const verified=signature(st);
        requireProof(verified===signature(await handle.stat({bigint:true})));
        pins.set(name,{signature:verified,sha256:createHash('sha256').update(data).digest('hex')});
      } finally { await handle.close(); }
    }
    await directory.sync();await verifyNames(prefix);await current();
  } finally { await directory.close(); }
  // Same inode, size, nanosecond mtime/ctime and writer admission must still cover the verified bytes.
  return async () => {await current();await verifyNames(storePath,true);await verifyNames(storePath);await current();};
}

export async function verifyVectorCheckpointFiles({storePath,pendingRows,meta,buckets,admitted,waitForCaptureMeta=false}) {
  const byId=pendingMap(pendingRows), selected=new Map();
  requireProof(byId.size>0 && meta?.v===3 && Number.isSafeInteger(meta.bucketCount) && meta.bucketCount>0 &&
    Number.isSafeInteger(meta.count) && meta.count>=byId.size && Array.isArray(buckets) && buckets.length>0 && buckets.length<=byId.size);
  const expectedMeta=structuredClone(meta);
  const laggingTimestamp = Symbol('laggingCheckpointTimestamp');
  const deadline = performance.now() + 1500;
  // Check metadata first. Retrying a small, older timestamp must never reread buckets.
  const files=[{scope:META,limit:4*MiB,verify(rows,size){
    const current = rows['vectors:meta'];
    if (isDeepStrictEqual(current,expectedMeta)) return;
    if (waitForCaptureMeta && size <= 64*1024 && current &&
        typeof current.savedAt === 'string' && typeof expectedMeta.savedAt === 'string' &&
        Date.parse(current.savedAt) < Date.parse(expectedMeta.savedAt) &&
        isDeepStrictEqual({...current,savedAt:expectedMeta.savedAt},expectedMeta)) throw laggingTimestamp;
    requireProof(false);
  }}, pendingFile(byId)];
  const seenBuckets=new Set();
  for (const {bucket,ids} of buckets) {
    requireProof(Number.isSafeInteger(bucket)&&bucket>=0&&bucket<meta.bucketCount&&!seenBuckets.has(bucket)&&Array.isArray(ids)&&ids.length>0&&ids.length<=byId.size);
    seenBuckets.add(bucket);
    for(const id of ids){requireProof(byId.has(id)&&!selected.has(id));selected.set(id,bucket);}
    files.push({scope:META+':vec:'+String(bucket).padStart(4,'0'), limit:16*MiB, verify(rows) {
      for (const [key,value] of Object.entries(rows)) {
        if (!byId.has(key)&&!byId.has(value?.id))continue;
        const row=byId.get(key);
        requireProof(row && selected.get(key)===bucket && isDeepStrictEqual(value,{id:key,s:row.s,e:row.e}));
      }
      for(const [id,location] of selected)if(location===bucket)requireProof(Object.hasOwn(rows,id));
    }});
  }
  requireProof(selected.size===byId.size);
  for (;;) {
    try { return await prove(storePath,admitted,files); }
    catch (error) {
      if (error !== laggingTimestamp) throw error;
      requireProof(admitted() === true && performance.now() < deadline);
      await new Promise(resolve=>setTimeout(resolve,Math.min(125,deadline-performance.now())));
    }
  }
}

export async function verifyRemainingVectorPending({storePath,pendingRows,admitted}) {
  const verify=await prove(storePath,admitted,[pendingFile(pendingMap(pendingRows))]);
  await verify();
}

export async function verifyVectorRetentionReceipts({storePath,receipts,admitted}) {
  requireProof(receipts && typeof receipts === 'object' &&
    (Object.getPrototypeOf(receipts) === Object.prototype || Object.getPrototypeOf(receipts) === null));
  const entries = Object.entries(receipts);
  requireProof(entries.length <= 16 && entries.length === Reflect.ownKeys(receipts).length);
  const ids = new Set(), sequences = new Set();
  const expected = {};
  for (const [key, row] of entries) {
    requireProof(key.length === 64 && /^[a-f0-9]+$/.test(key) &&
      row && typeof row === 'object' && Reflect.ownKeys(row).length === 5 && Object.keys(row).length === 5 &&
      ['v','id','q','bucket','digest'].every(field => Object.hasOwn(row,field)) &&
      row.v === 1 && row.digest === key && typeof row.id === 'string' &&
      row.id.length > 0 && row.id.length <= 512 && row.id !== '~clear' && !ids.has(row.id) &&
      Number.isSafeInteger(row.q) && row.q > 0 && !sequences.has(row.q) &&
      Number.isSafeInteger(row.bucket) && row.bucket >= 0);
    ids.add(row.id);
    sequences.add(row.q);
    expected[key] = {...row};
  }
  const recheck = await prove(storePath,admitted,[{
    scope:'mem:index:vec-retained:v1', limit:128*1024, allowMissing:entries.length === 0,
    verify(rows) { requireProof(isDeepStrictEqual(rows,expected)); }
  }]);
  await recheck();
}
