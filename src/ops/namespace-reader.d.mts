export interface NamespaceReadInfo {
  fileBytes:number|null;
  bytesRead:number;
  entries:number;
  complete:boolean;
}
export interface NamespaceReadOptions {
  consistency?:'current-path'|'opened-generation';
  keys?:Set<string>;
  onEntry?:(key:string,value:unknown,serializedBytes?:number)=>unknown;
  measureValueBytes?:boolean;
  onValueBytes?:(key:string,bytes:number)=>void;
  maxEntryBytes?:number;
  chunkSize?:number;
  signal?:AbortSignal;
  onOpen?:(info:{fileBytes:number})=>unknown;
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
