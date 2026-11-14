import {realpathSync} from 'node:fs';
export function stateSealDiskProof(receipt,identity,mutationFailures){
 if(receipt?.version!==1||receipt.sealed!==true||receipt.synced!==true||receipt.instanceId!==identity?.instanceId||typeof receipt.storePath!=='string'||typeof identity.storePath!=='string'||realpathSync(receipt.storePath)!==realpathSync(identity.storePath)||mutationFailures!==0)throw Error('STATE_SEAL_UNVERIFIED');
 return {completion:'disk',completed:true,synced:true,mutationFailures:0,keys:0,scopes:0,waitMs:0,stateSeal:receipt};
}
