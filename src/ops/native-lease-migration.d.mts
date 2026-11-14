import type {EngineEpoch,EngineEpochEvidence} from './engine-epoch.mjs';
export interface NativeMigrationProof {
 version:1;kind:'verified-native-v3';store:string;sourceMarker:string;sourceSha256:string;epoch:EngineEpoch;
 native:{executable:string;executableSha256:string;configPath:string;configSha256:string;argvSha256:string;persistence?:{path:string;sha256:string;cwd:string}};
}
export interface NativeMigrationProvenance {version:1;sourceSha256:string;receiptSha256:string;kind:'verified-native-v3'}
export function prepareNativeMigration(options:{storePath:string;runtimeDir:string;expectedExecutable:string;engineEvidence:EngineEpochEvidence;procRoot?:string}):NativeMigrationProof;
export function saveNativeMigrationProof(proof:NativeMigrationProof,path:string):void;
export function finalizeNativeMigration(options:{storePath:string;proof:NativeMigrationProof;procRoot?:string;pidAlive?:(pid:number)=>boolean;publish?:(path:string,bytes:string)=>void}): {path:string;sourceSha256:string;preparedSourceSha256:string;reconciledCleanShutdown:boolean};
export function nativeMigrationForMarker(store:string,original:string,epoch:EngineEpoch,evidence:EngineEpochEvidence):NativeMigrationProvenance|null;

export function resolveNativeStoreConfig(options:{workers:unknown;store:string;exeSha256:string;procRoot:string;pid:number}):{path:string;sha256:string;cwd:string}|undefined;
