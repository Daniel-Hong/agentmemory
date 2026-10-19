import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedShutdown } from "../src/ops/verified-shutdown.js";
import { writeShutdownReceipt } from "../src/ops/background-lifecycle.mjs";

vi.mock("../src/ops/background-lifecycle.mjs", async importOriginal => {
  const actual = await importOriginal<any>(); let writes = 0;
  return { ...actual, writeShutdownReceipt: vi.fn(async (...args: unknown[]) => {
    await actual.writeShutdownReceipt(...args);
    if (++writes === 1) throw Object.assign(Error("fixture post-publication sync failure"), { code: "EIO" });
  }) };
});

it("replaces a published success receipt with failure after publication reports an I/O error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-shutdown-receipt-"));
  try {
    expect(await verifiedShutdown({ receiptDir: dir, engineAlive: () => true, work: async () => ({ synced: true, mutationFailures: 0 }), timeoutMs: 100, pollMs: 5 })).toMatchObject({ verified: false, errorCode: "SHUTDOWN_RECEIPT_FAILED" });
    expect(writeShutdownReceipt).toHaveBeenCalledTimes(2);
    const disk = JSON.parse(await readFile(join(dir, "shutdown-receipt.json"), "utf8"));
    expect(disk).toMatchObject({ pid: process.pid, verified: false, errorCode: "SHUTDOWN_RECEIPT_FAILED" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
