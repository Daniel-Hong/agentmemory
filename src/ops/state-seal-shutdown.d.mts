export interface StateSealReceipt {version:1;instanceId:string;storePath:string;sealed:true;synced:true}
export function stateSealDiskProof(receipt:unknown,identity:{instanceId:string;storePath:string|null},mutationFailures:number):{completion:'disk';completed:true;synced:true;mutationFailures:0;keys:number;scopes:number;waitMs:number;stateSeal:StateSealReceipt};
