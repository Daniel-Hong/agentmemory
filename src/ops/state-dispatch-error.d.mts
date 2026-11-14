export function stateDispatchRejected(diagnostic:string):Error & {code:string;phase:string;diagnostic:string};
export function isStateDispatchRejected(error:unknown):boolean;
export function localMutationRejected(code:'FILE_WRITER_LOST'|'WRITER_EPOCH_UNVERIFIED'):Error;
