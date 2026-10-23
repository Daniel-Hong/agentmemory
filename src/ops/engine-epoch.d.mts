export interface ProcessEpoch {pid:number;start:string}
export interface EngineEpoch {host:string;bootId:string;endpoint:string;pidNamespace:string;netNamespace:string;workerUid:number;worker:ProcessEpoch;engine:ProcessEpoch}
export interface EngineEpochEvidence {bootIdentity():string|null;capture():EngineEpoch|null;current(expected:EngineEpoch):boolean;gone(previous:ProcessEpoch):boolean}
export function createEngineEpochEvidence(options:{engineUrl:string;enginePidPath:string;peer:()=>{remoteAddress?:string;remotePort?:number;localAddress?:string;localPort?:number}|null;procRoot?:string;machineIdPath?:string;workerPid?:number;workerUid?:number;pidAlive?:(pid:number)=>boolean}):EngineEpochEvidence;
