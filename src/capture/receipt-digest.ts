import { createHash } from 'node:crypto';
import { scrubRecord, stripPrivateData } from '../functions/privacy.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
  return value;
}

export function captureSourceDigest(hookType: string, timestamp: string, raw: unknown): string {
  return createHash('sha256').update(JSON.stringify([hookType,timestamp,canonical(raw)])).digest('hex');
}

export function capturePayloadDigest(body: {hookType:string;timestamp:string;data:unknown}): string {
  const clean=scrubRecord(body.data);
  const raw=JSON.parse(stripPrivateData(JSON.stringify(clean)));
  return captureSourceDigest(body.hookType,body.timestamp,raw);
}
