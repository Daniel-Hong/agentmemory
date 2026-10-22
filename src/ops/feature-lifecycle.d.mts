import type { IIIClient } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import type { OllamaReadiness } from "./provider-readiness.mjs";
import type { MemoryProvider } from "../types.js";
import type { MetricsStore } from "../eval/metrics-store.js";
export const FEATURE_NAMESPACE:string;
export const CONSERVATIVE_REFLECTION_SYSTEM:string;
export function buildConservativeReflectionFormat(prompt:string):Record<string,unknown>;
export function listProjectPinnedSlots(kv:StateKV,KV:typeof import("../state/schema.js").KV,project:string):Promise<import("../types.js").MemorySlot[]>;
export function registerScopedSlotFunctions(options:{sdk:IIIClient;kv:StateKV;KV:typeof import("../state/schema.js").KV;withKeyedLock:typeof import("../state/keyed-mutex.js").withKeyedLock;defaults:readonly unknown[];clock?:()=>number;recordAudit:typeof import("../functions/audit.js").recordAudit}):Promise<void>;
export interface FeatureLifecycle {
 snapshot():Promise<{enabled:boolean;pendingCount:number|null;running:number;status:string}>;
 enqueue(sessionId:string,onStage?:(stage:string)=>void):Promise<unknown>;
 slotReflect(data:{sessionId:string}):Promise<unknown>;
 reflect(data:{project?:string;maxClusters?:number}):Promise<unknown>;
 pump():Promise<void>;drain():Promise<void>;stop():Promise<void>;
}
export function createFeatureLifecycle(options:{sdk:IIIClient;kv:StateKV;KV:typeof import("../state/schema.js").KV;withKeyedLock:typeof import("../state/keyed-mutex.js").withKeyedLock;provider:MemoryProvider;readiness?:OllamaReadiness|null;isSlotsEnabled:()=>boolean;isReflectEnabled:()=>boolean;logger:Pick<typeof import("../logger.js").logger,"warn">;schedule?:boolean;clock?:()=>number;intervalMs?:number;cooldownMs?:number}):FeatureLifecycle;
