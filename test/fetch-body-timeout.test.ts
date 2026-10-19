import { afterEach, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { fetchWithTimeout } from '../src/providers/_fetch.js';

let server: Server | undefined;
const sockets = new Set<Socket>();
const timers: ReturnType<typeof setTimeout>[] = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});
async function endpoint(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

it.each(['json', 'text'] as const)('bounds a %s body that never finishes after successful headers', async method => {
  const url = await endpoint((_request, response) => { response.writeHead(200); response.flushHeaders(); response.write('{"synthetic":'); });
  const rescue = new AbortController();
  timers.push(setTimeout(() => rescue.abort(), 600));
  const began = Date.now();
  await expect(fetchWithTimeout(url, { signal: rescue.signal }, 100).then(response => response[method]())).rejects.toMatchObject({ name: 'AbortError' });
  expect(Date.now() - began).toBeLessThan(450);
});

it('uses one total deadline even while body chunks keep arriving', async () => {
  const url = await endpoint((_request, response) => {
    response.writeHead(200); response.write('"');
    const write = () => { if (!response.destroyed) { response.write('x'); timers.push(setTimeout(write, 20)); } };
    write();
  });
  const rescue = new AbortController(); timers.push(setTimeout(() => rescue.abort(), 600));
  const began = Date.now();
  await expect(fetchWithTimeout(url, { signal: rescue.signal }, 100).then(response => response.text())).rejects.toMatchObject({ name: 'AbortError' });
  expect(Date.now() - began).toBeLessThan(450);
});

it('honors explicit caller cancellation while reading the body', async () => {
  const controller = new AbortController();
  const url = await endpoint((_request, response) => {
    response.writeHead(200); response.write('{');
    timers.push(setTimeout(() => controller.abort(), 30));
  });
  await expect(fetchWithTimeout(url, { signal: controller.signal }, 1000).then(response => response.json())).rejects.toMatchObject({ name: 'AbortError' });
});

it('returns readable JSON and HTTP metadata after a complete response', async () => {
  const url = await endpoint((_request, response) => {
    response.writeHead(201, { 'Content-Type': 'application/json', 'X-Synthetic': 'retained' });
    response.end('{"ok":true}');
  });
  const response = await fetchWithTimeout(url, {}, 1000);
  expect(response.status).toBe(201); expect(response.ok).toBe(true);
  expect(response.headers.get('X-Synthetic')).toBe('retained');
  expect(await response.json()).toEqual({ ok: true });
});

it('cancels an unfinished retry response and bounds the final body by the original budget', async () => {
  let calls = 0;
  const url = await endpoint((_request, response) => {
    calls++;
    response.writeHead(calls === 1 ? 503 : 200, { 'Retry-After': '0' });
    response.write('{');
  });
  const rescue = new AbortController(); timers.push(setTimeout(() => rescue.abort(), 800));
  const began = Date.now();
  await expect(fetchWithTimeout(url, { signal: rescue.signal }, 250).then(response => response.json())).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(2); expect(Date.now() - began).toBeLessThan(650);
});
