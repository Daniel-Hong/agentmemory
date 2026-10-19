import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startViewerServer } from "../src/viewer/server.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function setup(stalledBody = false) {
  const upstream = createServer((req,res) => {
    let body=''; req.on('data',chunk=> {body+=chunk;}); req.on('end',()=> {
      if (stalledBody) { res.writeHead(200, {'Content-Type':'application/json'}); res.flushHeaders(); res.write('{'); return; }
      const needed = req.url?.includes('background/control') ? 'x-agentmemory-background' : 'x-agentmemory-inspection';
      const allowed = req.headers.authorization==='Bearer synthetic-secret' && req.headers[needed]==='1';
      res.writeHead(allowed?202:403, {'Content-Type':'application/json'});
      res.end(JSON.stringify({allowed,headers:req.headers,body:JSON.parse(body||'{}')}));
    });
  });
  servers.push(upstream); await new Promise<void>(resolve=> upstream.listen(0,'127.0.0.1',resolve));
  const viewer = startViewerServer(0,{}, {}, 'synthetic-secret', (upstream.address() as AddressInfo).port);
  servers.push(viewer); await new Promise<void>(resolve=>viewer.once('listening',resolve));
  return `http://127.0.0.1:${(viewer.address() as AddressInfo).port}`;
}
describe('custom operations through the real viewer proxy',()=> {
  it.each([['background/control','X-AgentMemory-Background',{action:'pause'}],['diagnostics/codex-inspection','X-AgentMemory-Inspection',{requestId:'fixture'}]])('passes only %s marker to its handler',async(path,marker,body)=> {
    const base = await setup();
    const response=await fetch(`${base}/agentmemory/${path}`,{method:'POST',headers:{'Content-Type':'application/json',[marker]:'1','X-AgentMemory-Unknown':'1'},body:JSON.stringify(body)});
    expect(response.status).toBe(202); const result=await response.json();
    expect(result.body).toEqual(body); expect(result.headers['x-agentmemory-unknown']).toBeUndefined();
  });
  it('does not forward a control marker to an unrelated route',async()=> {
    const base=await setup();
    const response=await fetch(`${base}/agentmemory/remember`,{method:'POST',headers:{'Content-Type':'application/json','X-AgentMemory-Inspection':'1'},body:'{}'});
    const result=await response.json(); expect(result.headers['x-agentmemory-inspection']).toBeUndefined();
  });
  it('rejects cross-origin control writes before reaching the upstream handler',async()=> {
    const base=await setup();
    const response=await fetch(`${base}/agentmemory/background/control`,{method:'POST',headers:{'Content-Type':'application/json','X-AgentMemory-Background':'1',Origin:'https://attacker.invalid'},body:'{"action":"pause"}'});
    expect(response.status).toBe(403);
  });
  it('times out a body which stalls after successful response headers',async()=> {
    const base=await setup(true);
    const response=await fetch(`${base}/agentmemory/health`);
    expect(response.status).toBe(504);expect(await response.json()).toEqual({error:'upstream timeout'});
  },13000);
});
