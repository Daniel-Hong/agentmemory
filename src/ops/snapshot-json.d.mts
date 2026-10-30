export function snapshotJsonChunks(archive:Record<string,unknown>):Generator<string>;
export function snapshotSessionJsonChunks(archive:Record<string,unknown>,sessionIds:Iterable<string>,readObservations:(sessionId:string)=>Promise<unknown[]>):AsyncGenerator<string>;
export function readSnapshotJson(source:AsyncIterable<Uint8Array>,options?:{signal?:AbortSignal}):Promise<Record<string,any>>;
export function readGitSnapshot(dir:string,commitHash:string,options?:{signal?:AbortSignal}):Promise<Record<string,any>>;
export function validateSnapshotArchive(archive:Record<string,any>):void;
