import { runInNewContext } from "node:vm";
import { Socket } from "node:net";
import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { startViewerServer } from '../src/viewer/server.js';
import { publishViewerEvent, subscribeViewerEvents } from '../src/state/viewer-stream.js';
import { sendViewerEvent } from '../src/triggers/events.js';
let server: Server; const clients: WebSocket[] = []; const rawSockets: Socket[] = [];
afterEach(async () => { for (const c of rawSockets.splice(0)) c.destroy(); for (const c of clients.splice(0)) c.terminate(); if (server?.listening) await new Promise<void>(r => server.close(() => r())); delete process.env.VIEWER_ALLOWED_HOSTS; delete process.env.AGENTMEMORY_VIEWER_HOST; });
async function start() { server = startViewerServer(0, null, null, 'fixture-secret', 49991); await once(server, 'listening'); const port = (server.address() as {port:number}).port; return {origin:`http://127.0.0.1:${port}`, url:`ws://127.0.0.1:${port}/agentmemory/viewer/stream`}; }
async function open(url:string,origin:string) { const c = new WebSocket(url,{origin,handshakeTimeout:1000}); clients.push(c); await once(c,'open'); return c; }
async function rejected(url:string,origin:string,headers?:Record<string,string>) { return await new Promise<number>((resolve,reject)=>{const c=new WebSocket(url,{origin,headers,handshakeTimeout:1000});clients.push(c);c.on('unexpected-response',(_q,r)=>{r.resume();resolve(r.statusCode!);});c.on('open',()=>reject(Error('unexpected open')));c.on('error',reject);}); }
describe('same-origin read-only Viewer WebSocket', () => {
 it('receives new existing Viewer events without engine history',async()=>{const a=await start();const c=await open(a.url,a.origin);const result=once(c,'message');await sendViewerEvent({trigger:async()=>({})} as never,'fixture','health.changed',{report:{status:'ok'}});expect(JSON.parse(String((await result)[0]))).toEqual({type:'stream',event:{type:'event',event:{type:'health.changed',data:{report:{status:'ok'}}}}});});
 it('rejects hostile and absent origins',async()=>{const a=await start();expect(await rejected(a.url,'https://attacker.invalid')).toBe(403);expect(await rejected(a.url,'')).toBe(403);});
 it('rejects rebound Host',async()=>{const a=await start();expect(await rejected(a.url,'http://attacker.invalid',{Host:'attacker.invalid'})).toBe(403);});
 it('accepts explicitly trusted reverse proxy origin',async()=>{process.env.VIEWER_ALLOWED_HOSTS='viewer.fixture';const a=await start();const c=new WebSocket(a.url,{origin:'https://viewer.fixture',headers:{Host:'viewer.fixture'}});clients.push(c);await once(c,'open');expect(c.readyState).toBe(WebSocket.OPEN);});
 it('rejects other paths and query subscriptions',async()=>{const a=await start();expect(await rejected(a.url+'?group=private',a.origin)).toBe(404);expect(await rejected(a.url.replace('/agentmemory/viewer/stream','/'),a.origin)).toBe(404);});
 it('requires inbound bearer for non-loopback binds',async()=>{process.env.AGENTMEMORY_VIEWER_HOST='0.0.0.0';process.env.VIEWER_ALLOWED_HOSTS='viewer.fixture';const a=await start();expect(await rejected(a.url,'https://viewer.fixture',{Host:'viewer.fixture'})).toBe(401);});
 it('cannot send writes or alternate stream subscriptions',async()=>{const a=await start();const c=await open(a.url,a.origin);const ended=once(c,'close');c.send(JSON.stringify({type:'join',data:{streamName:'private'}}));expect((await ended)[0]).toBe(1008);});
 it('bounds oversized events without failing the publisher',async()=>{const a=await start();const c=await open(a.url,a.origin);const ended=once(c,'close');expect(()=>publishViewerEvent('fixture',{value:'x'.repeat(1024*1024)})).not.toThrow();expect((await ended)[0]).toBe(1009);});
 it('isolates broken subscribers from stream persistence',async()=>{const off=subscribeViewerEvents(()=>{throw Error('fixture');});try{await expect(sendViewerEvent({trigger:async()=>({})} as never,'fixture','health.changed',{})).resolves.toBeUndefined();}finally{off();}});
 it('closes active sockets when the Viewer stops',async()=>{const a=await start();const c=await open(a.url,a.origin);const closed=once(c,'close');await new Promise<void>(r=>server.close(()=>r()));await closed;expect(c.readyState).toBe(WebSocket.CLOSED);});
 it('routes compressed observations into the existing fresh-observation update',()=>{
   const html=readFileSync('src/viewer/index.html','utf8');const start=html.indexOf('    function handleStreamEvent(');const end=html.indexOf('\n    function ',start+15);
   const routed:unknown[]=[];const other:unknown[]=[];
   const handle=runInNewContext('('+html.slice(start,end)+')',{looksLikeObservation:()=>true,routeWsMessage:(v:unknown)=>routed.push(v),handleLiveEvent:(...v:unknown[])=>other.push(v)});
   const observation={id:'fixture',sessionId:'fixture-session'};
   handle({event:{type:'event',event:{type:'compressed_observation',data:{observation}}}});
   expect(routed).toEqual([{observation,fresh:true}]);expect(other).toEqual([]);
 });
 it('destroys rejected Upgrade sockets even when the peer keeps its write side open',async()=>{
   const a=await start();const c=new Socket({allowHalfOpen:true});rawSockets.push(c);c.connect(Number(new URL(a.url).port),'127.0.0.1');await once(c,'connect');c.resume();
   c.write('GET /agentmemory/viewer/stream HTTP/1.1\r\nHost: attacker.invalid\r\nOrigin: http://attacker.invalid\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
   await once(c,'end');await new Promise(r=>setImmediate(r));
   expect(await new Promise<number>((r,j)=>server.getConnections((e,n)=>e?j(e):r(n)))).toBe(0);
 });
 it('uses Viewer origin without livez internal-port override',()=>{const html=readFileSync('src/viewer/index.html','utf8');expect(html.includes("WS_URL = REST.replace(/^http/, 'ws') + '/agentmemory/viewer/stream'")).toBe(true);expect(html.includes("window.location.hostname + ':' + live.streamsPort")).toBe(false);});
});
