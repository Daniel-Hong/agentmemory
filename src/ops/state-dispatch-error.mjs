// Only locally created errors prove that State RPC dispatch never began.
// Remote error codes/properties cannot manufacture this process-local evidence.
const undispatched=new WeakSet();
export function stateDispatchRejected(diagnostic){
 const error=Object.assign(Error('STATE_WRITER_IDENTITY_CHANGED:before_dispatch:'+diagnostic),{code:'STATE_WRITER_IDENTITY_CHANGED',phase:'before_dispatch',diagnostic});
 undispatched.add(error);return error;
}
export function isStateDispatchRejected(error){return error!==null&&typeof error==='object'&&undispatched.has(error);}

export function localMutationRejected(code){
 if(!['FILE_WRITER_LOST','WRITER_EPOCH_UNVERIFIED'].includes(code))throw Error('invalid_local_mutation_rejection');
 const error=Object.assign(Error(code),{code,phase:'before_dispatch',diagnostic:code});undispatched.add(error);return error;
}
