export interface ProcTcpRow {local:string;remote:string;state:string;inode:string}
export function readOwnedTcpRows(path:string,owned:ReadonlySet<string>,includeRow?:(row:ProcTcpRow)=>boolean):ProcTcpRow[];
