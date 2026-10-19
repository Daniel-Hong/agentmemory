import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const faults = vi.hoisted(() => ({ failFile: false, failDirectory: false, synced: [] as string[] }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync(fd: number) {
    const kind = fs.fstatSync(fd).isDirectory() ? "directory" : "file";
    if (kind === "file" && faults.failFile || kind === "directory" && faults.failDirectory) throw new Error("synthetic-fsync-error");
    fs.fsyncSync(fd); faults.synced.push(kind);
  } };
});
let dir: string;
const targetUrl = "http://127.0.0.1:45677";
const body = { eventId: "compat-sync-0001", hookType: "post_tool_use", sessionId: "synthetic-sync", project: "compat", cwd: "/tmp/compat", timestamp: "2026-10-15T00:00:00Z", data: { tool_output: "synthetic" } };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "am-compat-sync-"));
  faults.failFile = false; faults.failDirectory = false; faults.synced.length = 0;
  vi.resetModules(); vi.stubEnv("AGENTMEMORY_CAPTURE_SPOOL", "true"); vi.stubEnv("AGENTMEMORY_CAPTURE_DRAIN_CHILD", "1");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ observationId: "synthetic-observation", bootId: "compatboot000001", durableAfterMs: 60_000 }), { status: 201 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("capture handoff durability proof", () => {
  it("syncs the retained file and Linux directory entries before confirming handoff", async () => {
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(body, 100, { url: targetUrl, headers: {}, dir })).toBe("delivered");
    expect(faults.synced[0]).toBe("file");
    if (process.platform !== "win32") expect(faults.synced).toEqual(["file", "directory", "directory"]);
  });
  it("does not confirm handoff when retained file fsync fails", async () => {
    faults.failFile = true;
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(body, 100, { url: targetUrl, headers: {}, dir })).toBe("pending");
  });
  it.skipIf(process.platform === "win32")("does not confirm handoff when the retained directory entry cannot sync", async () => {
    faults.failDirectory = true;
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(body, 100, { url: targetUrl, headers: {}, dir })).toBe("pending");
  });
  it("does not confirm an offline managed spool handoff when file fsync fails", async () => {
    faults.failFile = true; vi.mocked(fetch).mockRejectedValue(new Error("synthetic-offline"));
    const { handoffObservation } = await import("../src/hooks/_capture.js");
    expect(await handoffObservation(body, 100, { url: targetUrl, headers: {}, dir })).toBe("dropped");
  });
});

it.skipIf(process.platform === 'win32')('keeps the claimed managed original if retry directory fsync fails',async()=>{
 const {appendSpool,drainSpool}=await import('../src/capture/spool.js');
 expect(appendSpool(targetUrl,body.eventId,body,'fixture',{dir,requireReceipt:true}).spooled).toBe(true);
 faults.failDirectory=true;
 await expect(drainSpool(targetUrl,async()=> 'retry',{dir})).rejects.toThrow('synthetic-fsync-error');
 expect(readdirSync(dir).some(name=>name.includes('.draining-'))).toBe(true);
});
