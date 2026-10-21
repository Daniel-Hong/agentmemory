import type { IIIClient } from "iii-sdk";
import type { HttpRequest } from "@iii-dev/helpers/http";
import type { StateKV } from "../state/kv.js";
export interface BackgroundControl {
 init(store:StateKV,finish?:()=>Promise<void>):Promise<void>;
 snapshot():{holds:string[];recovery:{attempts:number;nextAttemptAt:number;maxAttempts:number};status:string;pausedRequested:boolean;activeOperations:number;error:string|null;diagnostics:unknown;transition:unknown};
 isPaused():boolean;
 run<T>(fn:()=>Promise<T>):Promise<T|{success:false;deferred:true;retained:true;reason:string}>;
 infer<T>(fn:()=>Promise<T>):Promise<T>;
 change(action:"pause"|"resume",options?:{source?:"manual"|"deployment"|"memory";canResume?:()=>Promise<boolean>}):Promise<ReturnType<BackgroundControl["snapshot"]>>;
 commitCleanShutdown():Promise<{success:boolean;paused:boolean}>;
 settled():Promise<void>;
}
export const MEMORY_RECOVERY_MAX_ATTEMPTS:number;
export let backgroundControl:BackgroundControl|null;
export function createBackgroundControl(options?:{clock?:()=>number}):BackgroundControl;
export function installBackgroundControl(control:BackgroundControl):void;
export function backgroundPaused():boolean;
export function backgroundTask<T extends (...args:never[])=>unknown>(fn:T):T;
export function controlBackgroundFunctions(sdk:IIIClient):void;
export function backgroundViewerRequestAllowed(req:HttpRequest):boolean;
export function registerBackgroundControlApi(sdk:IIIClient,secret:string,control:BackgroundControl):void;
