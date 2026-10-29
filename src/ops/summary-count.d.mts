export function createSummaryCount(options:{storePath:string;kv?:unknown}):{
  prepare(value:unknown):unknown;
  record(key:string,present:boolean,snapshot?:unknown):void;
  invalidate():void;
  count():Promise<number>;
  inputs():Promise<{total:number;recent:Pick<import('../types.js').SessionSummary,'sessionId'|'createdAt'|'title'|'narrative'|'concepts'>[]}>;
  sessionIds():Promise<Set<unknown>>;
};
