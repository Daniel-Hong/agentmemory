export function createSummaryCount(options:{storePath:string;kv?:unknown}):{
  record(key:string,present:boolean):void;
  invalidate():void;
  count():Promise<number>;
};
