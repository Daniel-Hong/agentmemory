import {readFileSync} from 'node:fs';

export async function waitForDevToolsPort(path:string,deadline:number,alive:()=>boolean,options:{read?:()=>string;clock?:()=>number;pause?:()=>Promise<void>}={}):Promise<number>{
  const read=options.read??(()=>readFileSync(path,'utf8'));
  const clock=options.clock??Date.now;
  const pause=options.pause??(()=>new Promise(resolve=>setTimeout(resolve,25)));
  while(clock()<deadline){
    if(!alive())throw Error('Chrome exited before DevTools endpoint was ready');
    let text='';
    try{text=read();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const match=/^([1-9][0-9]{0,4})\r?\n\/devtools\/browser\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\r?\n?$/.exec(text);
    if(match&&Number(match[1])<=65535)return Number(match[1]);
    await pause();
  }
  throw Error('Chrome DevTools endpoint file did not become complete before deadline');
}
