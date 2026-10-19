import type { EmbeddingRecovery } from "./embedding-recovery.mjs";
import type { OllamaReadiness } from "./provider-readiness.mjs";
import type { BackgroundControl } from "./background-control.mjs";
import type { FeatureLifecycle } from "./feature-lifecycle.mjs";
import type { createSnapshotRecovery } from "./snapshot-recovery.mjs";
interface OperationalSnapshot { snapshot(): object | Promise<object> }
export const operationalState: {providerReadiness?:OllamaReadiness|null;embeddingRecovery?:EmbeddingRecovery|null;backgroundControl?:BackgroundControl;featureLifecycle?:FeatureLifecycle;snapshotRecovery?:ReturnType<typeof createSnapshotRecovery>} & Record<string,OperationalSnapshot|null|undefined> = {};
export async function operationalHealth():Promise<Record<string,Record<string,unknown>|null>> {
 const keys=["backgroundControl","providerReadiness","embeddingRecovery","featureLifecycle","memoryPressure","snapshotRecovery","storageDurability","captureProgress"];
 const values=await Promise.all(keys.map(async key=>({...await operationalState[key]?.snapshot?.()})));
 return Object.fromEntries(keys.map((key,index)=>[key,values[index]]));
}
