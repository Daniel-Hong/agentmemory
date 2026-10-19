import type { StateKV } from "../state/kv.js";
import type { CompressedObservation } from "../types.js";
import type { ObservationSourceBudget } from "../functions/observation-source-budget.js";
export const PAGE_BYTES: number;
export function createObservationReader(options: {storePath:string;kv:StateKV}): {
 record(scope:string,key:string,value:unknown,deletedExisting?:boolean):void;
 snapshot(scope:string):Promise<unknown[]>;
 list<T=unknown>(scope:string):Promise<T[]>;
 response(scope:string,query:Record<string,string|string[]>,filterAgentId?:string):Promise<{observations:CompressedObservation[];total:number;limit?:number;nextCursor?:string|null;hasMore?:boolean;stats?:Record<string,unknown>}>;
 revision(scope:string):Promise<string>;
 captureSummary(scope:string,excludeId?:string):Promise<ObservationSourceBudget>;
 invalidateCaptureSummary(scope:string):void;
};
