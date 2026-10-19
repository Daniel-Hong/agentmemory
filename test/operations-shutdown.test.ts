import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedShutdown } from "../src/ops/verified-shutdown.js";
const directories: string[] = [];
async function directory() { const dir = await mkdtemp(join(tmpdir(), "am-shutdown-")); directories.push(dir); return dir; }
const receipt = async (dir: string) => JSON.parse(await readFile(join(dir, "shutdown-receipt.json"), "utf8"));
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("certifies completed durable writes in a private on-disk receipt", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, work: async () => ({ synced: true, mutationFailures: 0 }), timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: true, errorCode: null });
  expect(await receipt(dir)).toMatchObject({ pid: process.pid, verified: true, durability: { synced: true, mutationFailures: 0 } });
});
it("breaks a stuck drain when the engine is lost and persists failure", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => false, work: () => new Promise(() => {}), timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "ENGINE_LOST" });
  expect(await receipt(dir)).toMatchObject({ verified: false, errorCode: "ENGINE_LOST" });
});
it("bounds a stuck drain even when the engine remains alive", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, work: () => new Promise(() => {}), timeoutMs: 15, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "SHUTDOWN_TIMEOUT" });
  expect(await receipt(dir)).toMatchObject({ verified: false, errorCode: "SHUTDOWN_TIMEOUT" });
});
it("refuses certification when a durable mutation failed", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, work: async () => ({ synced: true, mutationFailures: 1 }), timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "SHUTDOWN_NOT_VERIFIED" });
  expect(await receipt(dir)).toMatchObject({ verified: false, durability: { mutationFailures: 1 } });
});
it("turns an engine probe exception into a bounded failure receipt", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => { throw Error("fixture engine probe failed"); }, work: () => new Promise(() => {}), timeoutMs: 30, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "ENGINE_CHECK_FAILED" });
  expect(await receipt(dir)).toMatchObject({ verified: false, errorCode: "ENGINE_CHECK_FAILED" });
});
it("rejects arbitrary or oversized error codes from work", async () => {
  const dir = await directory();
  expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, work: async () => { throw Object.assign(Error("fixture"), { code: "unsafe/code " + "X".repeat(80) }); }, timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "SHUTDOWN_STORAGE_FAILED" });
  expect(JSON.stringify(await receipt(dir))).not.toContain("unsafe/code");
});
it("returns unverified after receipt I/O failure so shutdown cleanup can continue", async () => {
  const dir = await directory(), blocked = join(dir, "file-not-directory");
  await writeFile(blocked, "fixture");
  expect(await verifiedShutdown({ receiptDir: blocked, engineAlive: () => true, work: async () => ({ synced: true, mutationFailures: 0 }), timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "SHUTDOWN_RECEIPT_FAILED" });
});

import {createBackgroundLifecycle} from '../src/ops/background-lifecycle.mjs';
it('failed producer drain still flushes data but cannot clear the restart guard',async()=>{
 const lifecycle=createBackgroundLifecycle(()=>{});lifecycle.track({stop:async()=>{},drain:async()=>{throw Error('synthetic drain failure');}});
 let flushed=false,guardCleared=false;
 await expect(lifecycle.shutdown(async({drained}:any)=>{flushed=true;if(drained)guardCleared=true;})).rejects.toThrow();
 expect(flushed).toBe(true);expect(guardCleared).toBe(false);
});
