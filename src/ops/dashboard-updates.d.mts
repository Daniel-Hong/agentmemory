import type {IIIClient} from 'iii-sdk';
export interface UpdateCandidate {id:string;version:string;sourceCommit:string;packageSha256:string;changeSummary:string;tests:string[];approved:true}
export interface UpdateEvent {status?:string;phase?:string;at?:string;errorCode?:string}
export interface UpdateJob {jobId:string;candidateId:string;status:'queued'|'running'|'applied_pending_acceptance'|'failed'|'interrupted';phase:string;createdAt?:string;updatedAt?:string;errorCode?:string;verificationComplete:boolean;events?:UpdateEvent[]}
export interface UpdateCatalog {available:boolean;reason?:string;currentVersion:string;candidates:UpdateCandidate[];jobs:UpdateJob[]}
export function createDashboardUpdates(options:{publicRoot?:string;requestRoot:string;version:string;dispatch?:(id:string)=>Promise<void>}):{
 list():Promise<UpdateCatalog>;
 job(id:string):Promise<UpdateJob>;
 start(body:unknown):Promise<UpdateJob>;
};
export function registerDashboardUpdateApi(sdk:IIIClient,secret:string,updates:ReturnType<typeof createDashboardUpdates>):void;
