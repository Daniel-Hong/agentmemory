export function createGraphFileList(options:{storePath:string}):{
 accepts(scope:string):boolean;
 record(scope:string,key:string,value:unknown):void;
 invalidate(scope:string):void;
 list<T=unknown>(scope:string):Promise<T[]>;
};
