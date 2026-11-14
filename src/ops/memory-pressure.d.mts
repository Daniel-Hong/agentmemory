import type { IIIClient } from "iii-sdk";
import type { HttpRequest } from "@iii-dev/helpers/http";
import type { BackgroundControl } from "./background-control.mjs";
export interface MemoryPressureSample {some:{avg10:number;avg60:number;total:number};full:{avg10:number;avg60:number;total:number};}
export function parseMemoryPressure(text:string):MemoryPressureSample|null;
export function readHostMemory():Promise<{total:number;available:number;pressure?:MemoryPressureSample|null}|null>;
export function createMemoryPressureGuard(options:{control:BackgroundControl;readSample?:typeof readHostMemory;schedule?:boolean;clock?:()=>number;monotonicClock?:()=>number}):{
 refresh():Promise<void>;snapshot():{level:string;[key:string]:unknown};
 install(sdk:IIIClient,auth:(req:HttpRequest)=>unknown):void;
 start():void;stop():Promise<void>;drain():Promise<void>;
};
