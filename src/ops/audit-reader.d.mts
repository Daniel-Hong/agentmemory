import type { StateKV } from "../state/kv.js";
import type { AuditEntry } from "../types.js";
export const AUDIT_PAGE_BYTES: number;
export type AuditMetadata = Pick<AuditEntry,"id"|"timestamp"|"operation"|"functionId"|"targetIds"> & {targetCount:number};
export function projectAuditMetadata(value:AuditEntry):AuditMetadata;
export function createAuditReader(options:{storePath:string;kv:StateKV}):{
 record(scope:string,key:string,value:unknown):void;
 query(filter?:{limit?:number;dateFrom?:string;dateTo?:string;operation?:string;query?:string;metadata?:boolean},options?:{scopes?:string[]}):Promise<(AuditEntry|AuditMetadata)[]>;
};
