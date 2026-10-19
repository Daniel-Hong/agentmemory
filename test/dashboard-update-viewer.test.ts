import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/viewer/update-viewer.js', 'utf8');
class Node {
  tagName: string; children: Node[] = []; parentNode: Node | null = null;
  attributes: Record<string, string> = {}; handlers: Record<string, Function[]> = {};
  textContent = ''; value = ''; disabled = false; open = false; style = { cssText: '' }; id = '';
  document: any;
  constructor(tag: string, document: any) { this.tagName = tag; this.document = document; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'id') this.id = value; }
  append(...nodes: Node[]) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  appendChild(node: Node) { this.append(node); return node; }
  replaceChildren(...nodes: Node[]) { this.children = []; this.append(...nodes); }
  addEventListener(type: string, fn: Function) { (this.handlers[type] ||= []).push(fn); }
  focus() { this.document.activeElement = this; }
  async trigger(type = 'click', detail: any = {}) { if (this.disabled && type === 'click') return; for (const fn of this.handlers[type] || []) await fn({ preventDefault() {}, ...detail }); await settle(); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const fn of this.handlers.close || []) fn(); }
  querySelectorAll() { return this.flat().filter(n => ['button', 'select'].includes(n.tagName) && !n.disabled); }
  flat(): Node[] { return [this, ...this.children.flatMap(n => n.flat())]; }
  text(): string { return this.textContent + this.children.map(n => n.text()).join(' '); }
}
const candidate = { id: 'release-1', version: 'test.1', sourceCommit: 'a'.repeat(40), packageSha256: 'b'.repeat(64), changeSummary: '<img src=x>before → after', tests: ['real synthetic test passed'], approved: true };
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function fixture(store = new Map<string, string>()) {
  const document: any = { activeElement: null };
  document.body = new Node('body', document);
  document.createElement = (tag: string) => new Node(tag, document);
  document.getElementById = (id: string) => document.body.flat().find((n: Node) => n.id === id);
  const anchor = new Node('span', document); anchor.id = 'footer-feedback'; document.body.append(anchor);
  const timers: Function[] = [];
  let catalog: any = { available: true, currentVersion: 'test.0', candidates: [candidate], jobs: [] };
  let offline = false, missing = false, status = 'queued';
  const requests: any[] = [];
  let failStorage = false;
  const fetch = vi.fn(async (url: string, opts: any) => {
    requests.push({ url, ...opts });
    if (offline) throw Error('offline');
    const post = opts.method === 'POST';
    const data = url.endsWith('/updates') ? catalog : { jobId: JSON.parse(store.get('agentmemory-update-pending') || '{}').requestId, candidateId: 'release-1', status, phase: 'applying', verificationComplete: false };
    return { ok: !missing || post || url.endsWith('/updates'), status: missing && !post && !url.endsWith('/updates') ? 404 : 200, json: async () => data };
  });
  const context = { document, fetch, REST: 'https://viewer.test', getViewerToken: () => 'viewer-token', crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789012' }, AbortController, localStorage: { getItem: (k: string) => store.get(k) || null, setItem: (k: string, v: string) => { if (failStorage) throw Error('blocked'); store.set(k, v); }, removeItem: (k: string) => store.delete(k) }, setTimeout: (fn: Function, ms: number) => { if (ms === 4000) timers.push(fn); return 1; }, clearTimeout: vi.fn(), console };
  vm.runInNewContext(source, context);
  const byId = (id: string): Node => document.getElementById(id);
  return { document, store, requests, context, failStorage: () => failStorage = true, timers, byId, setOffline: (v: boolean) => offline = v, setMissing: (v: boolean) => missing = v, setStatus: (v: string) => status = v, setCatalog: (v: any) => catalog = v, open: async () => { byId('update-launch').focus(); await byId('update-launch').trigger(); } };
}

describe('dashboard update viewer', () => {
  it('renders full hashes/tests as text, sends authenticated fixed request once and waits for acceptance', async () => {
    const f = fixture(); await f.open();
    expect(f.byId('update-dialog').text()).toContain(candidate.sourceCommit);
    expect(f.byId('update-dialog').text()).toContain(candidate.packageSha256);
    expect(f.byId('update-dialog').text()).toContain(candidate.changeSummary);
    expect(f.byId('update-dialog').text()).toContain(candidate.tests[0]);
    expect(f.byId('update-dialog').flat().some(n => n.tagName === 'img')).toBe(false);
    const applying = f.byId('update-apply').trigger(); await f.byId('update-apply').trigger(); await applying;
    const posts = f.requests.filter(r => r.method === 'POST'); expect(posts).toHaveLength(1);
    expect(posts[0].headers.Authorization).toBe('Bearer viewer-token'); expect(posts[0].headers['x-agentmemory-update']).toBe('1');
    expect(JSON.parse(posts[0].body)).toEqual({ requestId: '12345678-1234-4234-8234-123456789012', candidateId: candidate.id });
    f.setStatus('applied_pending_acceptance'); await f.byId('update-refresh').trigger();
    expect(f.byId('update-message').text()).toContain('적용됨 · 최종 확인 대기');
    expect(f.store.has('agentmemory-update-pending')).toBe(false);
  });
  it('persists before network failure and restores the same ID after page reopening without automatic POST', async () => {
    const f = fixture(); await f.open(); f.setOffline(true); await f.byId('update-apply').trigger();
    expect(f.byId('update-message').text()).toContain('업데이트 중·서버 재시작 대기');
    const persisted = JSON.parse(f.store.get('agentmemory-update-pending')!); expect(Object.keys(persisted).sort()).toEqual(['candidateId', 'requestId']);
    const next = fixture(f.store); next.setMissing(true); await next.open();
    expect(next.requests.filter(r => r.method === 'POST')).toHaveLength(0);
    expect(next.byId('update-retry').disabled).toBe(false);
    await next.byId('update-retry').trigger();
    expect(JSON.parse(next.requests.find(r => r.method === 'POST').body)).toEqual(persisted);
  });
  it('traps keyboard focus, avoids POST when persistence fails, and cancels polling on close', async () => {
    const f = fixture(); await f.open();
    const items = f.byId('update-dialog').querySelectorAll(); items[items.length - 1].focus();
    await f.byId('update-dialog').trigger('keydown', { key: 'Tab', shiftKey: false });
    expect(f.document.activeElement).toBe(items[0]);
    await f.byId('update-dialog').trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(f.document.activeElement).toBe(items[items.length - 1]);
    f.failStorage(); await f.byId('update-apply').trigger();
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(0);
    expect(f.byId('update-message').text()).toContain('적용을 요청하지 않았습니다');
    await f.byId('update-close').trigger();
    expect(f.context.clearTimeout).toHaveBeenCalled();
  });
  it('shows failed history and exact safe code without labeling failure complete', async () => {
    const f = fixture(); f.setCatalog({ available: true, currentVersion: 'old', candidates: [candidate], jobs: [{ jobId: 'old-job', candidateId: candidate.id, status: 'failed', errorCode: 'PROGRAM_FAILED' }] }); await f.open();
    expect(f.byId('update-dialog').text()).toContain('업데이트 실패');
    expect(f.byId('update-dialog').text()).toContain('PROGRAM_FAILED');
    expect(f.byId('update-dialog').text()).not.toContain('완료');
  });
  it('keeps offline polling bounded and uses a version 4 UUID on HTTP without randomUUID', async () => {
    const f = fixture();
    const crypto = f.context.crypto as any; delete crypto.randomUUID;
    crypto.getRandomValues = (bytes: Uint8Array) => bytes.fill(7);
    await f.open(); f.setOffline(true); await f.byId('update-apply').trigger();
    expect(JSON.parse(f.store.get('agentmemory-update-pending')!).requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    let polls = 0; while (f.timers.length && polls < 40) { polls++; await f.timers.shift()!(); }
    expect(polls).toBe(30); expect(f.timers).toHaveLength(0);
    expect(f.requests.filter(r => r.method === 'POST')).toHaveLength(1);
    expect(f.store.has('agentmemory-update-pending')).toBe(true);
  });
  it('handles unavailable and empty catalogs and restores opener focus on Escape', async () => {
    const f = fixture(); f.setCatalog({ available: false, candidates: [], jobs: [] }); await f.open();
    expect(f.byId('update-dialog').text()).toContain('관리자 최초 설정 필요'); expect(f.byId('update-apply').disabled).toBe(true);
    f.setCatalog({ available: true, candidates: [], jobs: [] }); await f.byId('update-refresh').trigger();
    expect(f.byId('update-dialog').text()).toContain('등록된 후보 없음');
    await f.byId('update-dialog').trigger('keydown', { key: 'Escape' });
    expect(f.byId('update-dialog').open).toBe(false); expect(f.document.activeElement).toBe(f.byId('update-launch'));
  });
});

it('allows explicit same-ID queued redispatch and blocks interrupted work without forgetting it',async()=>{
 const f=fixture();await f.open();await f.byId('update-apply').trigger();
 expect(f.byId('update-retry').disabled).toBe(false);
 const first=JSON.parse(f.requests.find(r=>r.method==='POST').body);await f.byId('update-retry').trigger();
 expect(JSON.parse(f.requests.filter(r=>r.method==='POST')[1].body)).toEqual(first);
 f.setStatus('interrupted');await f.byId('update-refresh').trigger();
 expect(f.byId('update-message').text()).toContain('관리자 점검 필요');expect(f.byId('update-retry').disabled).toBe(true);
 expect(f.store.has('agentmemory-update-pending')).toBe(true);
});
