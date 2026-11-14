export interface ProcessEpoch {pid:number;start:string}
export interface EngineEpoch {host:string;bootId:string;endpoint:string;pidNamespace:string;netNamespace:string;workerUid:number;worker:ProcessEpoch;engine:ProcessEpoch;state?:ProcessEpoch&{instanceId:string;store:string;executableSha256:string}}
export interface EngineEpochEvidence {diagnostic?():string|null;bootIdentity():string|null;capture():EngineEpoch|null;current(expected:EngineEpoch):boolean;gone(previous:ProcessEpoch):boolean}
export function createEngineEpochEvidence(options:{engineUrl:string;enginePidPath:string;engineStatePath?:string;peer:()=>{remoteAddress?:string;remotePort?:number;localAddress?:string;localPort?:number}|null;procRoot?:string;machineIdPath?:string;workerPid?:number;workerUid?:number;pidAlive?:(pid:number)=>boolean}):EngineEpochEvidence;

export function readEnginePid(options:{enginePidPath:string;engineStatePath?:string;engineUrl:string}):number;
export function waitForEngineEpoch(evidence:Pick<EngineEpochEvidence,'capture'>,options?:{timeoutMs?:number;pollMs?:number}):Promise<EngineEpoch>;
