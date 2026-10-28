export function isStorageWorkCompleted(result){
 if(result?.mutationFailures!==0)return false;
 if(result.completion==='sdk')return result.completed===true&&result.synced===false;
 return (result.completion===undefined||result.completion==='disk')&&result.synced===true;
}
