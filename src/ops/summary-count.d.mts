export function createSummaryCount(options:{storePath:string;kv?:unknown}):{
  prepare(value:unknown,options?:{wire?:boolean}):unknown;
  record(key:string,present:boolean,snapshot?:unknown,acknowledgedValue?:unknown):void;
  invalidate():void;
  count():Promise<number>;
  inputs():Promise<{total:number;recent:Pick<import('../types.js').SessionSummary,'sessionId'|'createdAt'|'title'|'narrative'|'concepts'>[]}>;
  sessionIds():Promise<Set<unknown>>;
  metadata():Promise<Pick<import('../types.js').SessionSummary,'sessionId'|'project'|'createdAt'|'title'>[]>;
  recent(project:string,limit?:number):Promise<import('../types.js').SessionSummary[]>;
  sdkListBytes(maxBytes?:number):Promise<number>;
};
