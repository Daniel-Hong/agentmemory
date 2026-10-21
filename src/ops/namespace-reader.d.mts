export interface NamespaceReadInfo {
  fileBytes:number|null;
  bytesRead:number;
  entries:number;
  complete:boolean;
}
export interface NamespaceReadOptions {
  keys?:Set<string>;
  onEntry?:(key:string,value:unknown)=>unknown;
  chunkSize?:number;
  signal?:AbortSignal;
  onRead?:(info:NamespaceReadInfo)=>unknown;
  checkIntervalBytes?:number;
  maxSelectedBytes?:number;
  maxFileBytes?:number;
  allowProjectionOverflow?:()=>unknown;
}
export function readNamespaceEntries(path:string,options?:NamespaceReadOptions):Promise<{
  values:Map<string,unknown>;
  entries:number;
  bytesRead:number;
  maxEntryChars:number;
  signature:string;
}>;
