import type {IIIClient} from 'iii-sdk';
import type {EngineEpochEvidence} from './engine-epoch.mjs';
export interface StateBootIdentity {version:1;pid:number;start:string;instanceId:string;bootId:string;adapter:string;storePath:string|null}
export function createStateBoundEvidence(options:{engineEvidence:EngineEpochEvidence;identity:StateBootIdentity;expectedExecutable:{path:string;sha256:string};storePath:string;procRoot?:string}):EngineEpochEvidence;
export function pinStateClient(sdk:IIIClient,prefix:string,current?:()=>boolean,diagnostic?:()=>string|null):IIIClient;
