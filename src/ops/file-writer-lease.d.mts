import type {EngineEpochEvidence} from './engine-epoch.mjs';
export interface FileWriterLease {close():void}
export function acquireFileWriterLease(storePath:string,options?:{evidence?:EngineEpochEvidence}):FileWriterLease;
export function ownsFileWriterLease(lease:unknown,storePath:string):boolean;
export function fileWriterRecoveryAdmitted(lease:FileWriterLease):boolean;
export function fileWriterRecoveryReason(lease:FileWriterLease):string|null;
export function markFileWriterClean(lease:FileWriterLease):void;
