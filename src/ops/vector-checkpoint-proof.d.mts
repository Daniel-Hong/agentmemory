type Evidence = {storePath:string; pendingRows:readonly unknown[]; admitted:()=>boolean};
export function verifyVectorCheckpointFiles(options: Evidence & {
  waitForCaptureMeta?:boolean; meta:unknown; buckets:readonly {bucket:number; ids:readonly string[]}[];
}):Promise<()=>Promise<void>>;
export function verifyRemainingVectorPending(options: Evidence):Promise<void>;
export function verifyVectorRetentionReceipts(options: {
  storePath:string; receipts:Readonly<Record<string,unknown>>; admitted:()=>boolean;
}):Promise<void>;
