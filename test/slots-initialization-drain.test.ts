import { expect, it } from 'vitest';
import { registerSlotsFunctions, DEFAULT_SLOTS } from '../src/functions/slots.js';
import { mockKV, mockSdk } from './helpers/mocks.js';
it('lets worker initialization await every default slot write', async () => {
 const kv=mockKV(); let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const get=kv.get; kv.get=async (...args:Parameters<typeof get>)=>{await gate;return get(...args);};
 let initialized=false;
 const pending=Promise.resolve(registerSlotsFunctions(mockSdk() as never,kv as never)).then(()=>{initialized=true;});
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(initialized).toBe(false);
 release(); await pending;
 expect([...kv.store.values()].reduce((n,rows)=>n+rows.size,0)).toBe(DEFAULT_SLOTS.length);
});
