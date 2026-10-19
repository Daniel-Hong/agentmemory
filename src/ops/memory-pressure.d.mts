import type { IIIClient } from "iii-sdk";
import type { HttpRequest } from "@iii-dev/helpers/http";
import type { BackgroundControl } from "./background-control.mjs";
export function readHostMemory():Promise<{total:number;available:number}|null>;
export function createMemoryPressureGuard(options:{control:BackgroundControl;readSample?:typeof readHostMemory;schedule?:boolean;clock?:()=>number}):{
 refresh():Promise<void>;snapshot():{level:string;[key:string]:unknown};
 install(sdk:IIIClient,auth:(req:HttpRequest)=>unknown):void;
 start():void;stop():Promise<void>;drain():Promise<void>;
};
