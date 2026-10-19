import {describe,it,expect} from 'vitest';
import {MetricsStore} from '../src/eval/metrics-store.js';
import {evaluateHealth} from '../src/health/thresholds.js';
import type {StateKV} from '../src/state/kv.js';
import type {HealthSnapshot} from '../src/types.js';
describe('approved operational metrics',()=>{
 it('persistent quality samples survive restart and concurrent calls retain totals',async()=>{
  const rows=new Map();const kv={get:async(_s:string,k:string)=>structuredClone(rows.get(k)??null),set:async(_s:string,k:string,v:unknown)=>{rows.set(k,structuredClone(v));},list:async()=>[...rows.values()]} as unknown as StateKV;
  const first=new MetricsStore(kv);await first.record('synthetic',10,true,0);await first.record('synthetic',10,true,100);
  const restarted=new MetricsStore(kv);await Promise.all(Array.from({length:20},()=>restarted.record('synthetic',10,true,50)));
  const m=await restarted.get('synthetic');expect(m?.totalCalls).toBe(22);expect(m?.qualitySampleCount).toBe(22);expect(m?.avgQualityScore).toBe(50);
 });
 it('CPU pressure uses effective capacity while preserving raw one-core percentage',()=>{
  const s={connectionState:'connected',cpu:{percent:140,capacityPercent:14,capacityCores:10},memory:{heapUsed:10,heapTotal:100,heapLimit:1000,rss:10},eventLoopLagMs:0} as unknown as HealthSnapshot;
  expect(evaluateHealth(s).status).toBe('healthy');
 });
});
