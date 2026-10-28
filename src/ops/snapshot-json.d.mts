export function snapshotJsonChunks(archive:Record<string,unknown>):Generator<string>;
export function readSnapshotJson(source:AsyncIterable<Uint8Array>,options?:{signal?:AbortSignal}):Promise<Record<string,any>>;
export function readGitSnapshot(dir:string,commitHash:string,options?:{signal?:AbortSignal}):Promise<Record<string,any>>;
export function validateSnapshotArchive(archive:Record<string,any>):void;
