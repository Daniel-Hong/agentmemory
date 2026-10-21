import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KV } from '../state/schema.js';
import { readNamespaceEntries } from '../ops/namespace-reader.mjs';
import { isCaptureKey } from './event-record.js';
import { isValidEventId } from './event-id.js';

export function createCaptureReceiptPage(storePath: string) {
  let active = 0;
  return async ({shard, offset, limit}: {shard:string; offset:number; limit:number}) => {
    if (!/^[a-f0-9]{2}$/.test(shard) || !Number.isSafeInteger(offset) || offset < 0 || offset > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error('INVALID_RECEIPT_QUERY');
    if (active >= 2) throw Error('CAPTURE_RECEIPT_PAGE_BUSY');
    active++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    try {
      const path = join(storePath, encodeURIComponent(KV.captureEvents(shard)) + '.bin');
      let info;
      try { info = await stat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {items:[],nextOffset:null}; throw error; }
      if (info.size > 4 * 1024 * 1024) throw Error('CAPTURE_RECEIPT_PAGE_LIMIT');
      const rows: Array<{key:string; eventId:string; state:string; completedAt:string}> = [];
      let entries = 0;
      await readNamespaceEntries(path, {keys:new Set(), maxFileBytes:4*1024*1024, signal:controller.signal, checkIntervalBytes:64*1024, onEntry:(key:string, value:unknown) => {
        const item=value as Record<string,unknown>|null;
        if (++entries > 2000) throw Error('CAPTURE_RECEIPT_PAGE_LIMIT');
        if (!isCaptureKey(key) || key.slice(4,6) !== shard || item?.key !== key || !isValidEventId(item.eventId) || typeof item.completedAt !== 'string' || !Number.isFinite(Date.parse(item.completedAt))) throw Error('CAPTURE_RECEIPT_METADATA_INVALID');
        rows.push({key,eventId:item.eventId as string,state:item.state==='deleted'?'deleted':'completed',completedAt:new Date(item.completedAt).toISOString()});
      }});
      rows.sort((a,b) => a.key.localeCompare(b.key));
      return {items:rows.slice(offset,offset+limit),nextOffset:offset+limit<rows.length?offset+limit:null};
    } finally { clearTimeout(timer);active--; }
  };
}
