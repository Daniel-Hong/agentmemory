export type RetainedVectorRevision = {id:string;revision:{release():void}};
// Never lose ownership when a superseded watch cannot be released. The caller
// must not promote/rebuild over a partially released selection.
export function releaseSupersededVectorJobs(jobs: Array<{id:string;revision?:{release():void}}>, retained: RetainedVectorRevision[]): boolean {
  let complete = true;
  for(const job of jobs){
    if(!job.revision)continue;
    try{job.revision.release();}
    catch{complete=false;retained.push({id:job.id,revision:job.revision});}
  }
  return complete;
}
export function retryRetainedVectorRevisions(retained:RetainedVectorRevision[]):void {
  while(retained.length){retained[0]!.revision.release();retained.shift();}
}
