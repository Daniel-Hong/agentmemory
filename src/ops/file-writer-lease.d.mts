export interface FileWriterLease {close():void}
export function acquireFileWriterLease(storePath:string,options?:{engineUrl?:string}):FileWriterLease;
export function ownsFileWriterLease(lease:unknown,storePath:string):boolean;

export function fileWriterRecoveryAdmitted(lease:FileWriterLease):boolean;
export function markFileWriterClean(lease:FileWriterLease):void;
