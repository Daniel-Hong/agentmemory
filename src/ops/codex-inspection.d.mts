import type { IIIClient } from "iii-sdk";
export const COLLECTOR:string;
export function codexInspectionArgs(context:{model?:string;effort?:string},root:string):string[];
export function collectInspectionContext(secret:string,options?:{restPort?:number}):Promise<{guide:{status:string;content?:string};snapshot:Record<string,unknown>;model?:string;effort?:string}>;
export function registerCodexInspection(sdk:IIIClient,secret:string,options?:{restPort?:number;root?:string;codex?:string;storeDir?:string;collect?:()=>Promise<unknown>;onSnapshot?:(job:unknown)=>Promise<unknown>}):{stop():Promise<void>;drain():Promise<void>};
