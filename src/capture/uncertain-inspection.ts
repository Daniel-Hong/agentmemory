import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {StateKV} from '../state/kv.js';
import type {InboxRecord} from '../functions/capture.js';
import type {CompressedObservation} from '../types.js';
import {KV} from '../state/schema.js';
import {isValidEventId} from './event-id.js';
import {isCaptureKey} from './event-record.js';
import {capturePayloadDigest} from './receipt-digest.js';
import {sdkObservationMatches} from './sdk-source-restore.js';
export type UncertainInspection={key:string;eventId:string;sourceDigest:string;project:string;sessionId:string;cwd:string;hookType:string;timestamp:string};
export function validUncertainInspection(input:unknown):input is UncertainInspection{
 if(!input||typeof input!=='object'||Array.isArray(input))return false;
 const x=input as Record<string,unknown>,keys=['key','eventId','sourceDigest','project','sessionId','cwd','hookType','timestamp'];
 return Object.keys(x).length===keys.length&&Object.keys(x).every(k=>keys.includes(k))&&isCaptureKey(x.key)&&typeof x.eventId==='string'&&isValidEventId(x.eventId)&&typeof x.sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(x.sourceDigest)&&['project','sessionId','cwd','hookType','timestamp'].every(k=>typeof x[k]==='string'&&(x[k] as string).length>0&&(x[k] as string).length<=2048)&&Number.isFinite(Date.parse(x.timestamp as string));
}
export async function inspectUncertainCapture(kv:StateKV,input:UncertainInspection){
 if(!validUncertainInspection(input))throw Error('INVALID_UNCERTAIN_INSPECTION');
 const result=(outcome:string)=>({outcome,readOnly:true,diskVerified:false,synced:false,originalReplay:false,retryAuthorized:false,atomicSnapshot:false});
 const rec=structuredClone(await kv.get<InboxRecord>(KV.captureInbox,input.key));
 if(!rec)return result('source_not_found');
 const derived='cap_'+createHash('sha256').update(`${rec.project}\0${rec.sessionId}\0${rec.eventId}`).digest('hex').slice(0,40);
 if(rec.eventSource!=='client'||rec.key!==input.key||derived!==input.key||rec.eventId!==input.eventId||!rec.payload||rec.project!==input.project||rec.sessionId!==input.sessionId||rec.hookType!==input.hookType||rec.payload.project!==input.project||rec.payload.sessionId!==input.sessionId||rec.payload.cwd!==input.cwd||rec.payload.hookType!==input.hookType||rec.payload.timestamp!==input.timestamp||capturePayloadDigest(rec.payload)!==input.sourceDigest)return result('source_conflict');
 const read=()=>kv.get<CompressedObservation>(KV.observations(rec.sessionId),rec.observationId);
 const first=structuredClone(await read()),again=structuredClone(await read()),recAgain=structuredClone(await kv.get<InboxRecord>(KV.captureInbox,input.key));
 if(!isDeepStrictEqual(rec,recAgain)||!isDeepStrictEqual(first,again))return result('changed_during_inspection');
 if(!first)return result('observation_not_found');
 return result(sdkObservationMatches(first,rec.payload,rec.key,rec.observationId,rec.eventId)?'observation_matches':'observation_conflict');
}
