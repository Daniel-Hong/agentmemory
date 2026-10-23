import {createHash} from 'node:crypto';
import {writeFileSync,realpathSync} from 'node:fs';import {join} from 'node:path';
export function engineFixture(store:string){
 const epoch={host:'a'.repeat(64),bootId:'11111111-1111-1111-1111-111111111111',endpoint:'ws://localhost:1000',pidNamespace:'pid:[100]',netNamespace:'net:[200]',workerUid:1000,worker:{pid:100,start:'10'},engine:{pid:200,start:'20'}};
 const previous={...epoch,worker:{pid:101,start:'11'},engine:{pid:201,start:'21'}};
 const storeHash=createHash('sha256').update(realpathSync(store)).digest('hex');
 writeFileSync(join(store,'.agentmemory-writer.lock'),JSON.stringify({version:3,store:storeHash,epoch:previous,clean:false}));
 return {epoch,storeHash,evidence:{bootIdentity:()=>epoch.bootId,capture:()=>structuredClone(epoch),current:(e:any)=>JSON.stringify(e)===JSON.stringify(epoch),gone:()=>true}};
}
