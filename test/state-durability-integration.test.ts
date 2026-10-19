import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateKV, applyUpdateOps } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { IndexPersistence, vectorBucketScope } from "../src/state/index-persistence.js";
import { VectorIndex, float32ToBase64 } from "../src/state/vector-index.js";
import { mockKV } from "./helpers/mocks.js";

import { createStateDurabilityFence } from "../src/ops/state-durability.mjs";

vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fileKV() {
  const storePath = await mkdtemp(join(tmpdir(), "agentmemory-durable-kv-"));
  directories.push(storePath);
  vi.stubEnv("AGENTMEMORY_STATE_STORE_PATH", storePath);
  const store = new Map<string, Record<string, unknown>>();
  const deletes: string[] = [];
  let publishWrites = false;
  async function publish() {
    await Promise.all([...store].map(([scope, rows]) => writeFile(join(storePath, `${encodeURIComponent(scope)}.bin`), JSON.stringify(rows))));
  }
  const sdk = { trigger: async ({ function_id, payload: { scope, key, value, ops } }: any) => {
    const rows = store.get(scope) ?? {};
    const old_value = rows[key] ?? null;
    if (function_id === "state::get") return structuredClone(old_value);
    if (function_id === "state::list") return structuredClone(Object.values(rows));
    store.set(scope, rows);
    if (function_id === "state::delete") { deletes.push(`${scope}/${key}`); delete rows[key]; }
    else rows[key] = structuredClone(function_id === "state::update" ? applyUpdateOps(old_value, ops) : value);
    if (publishWrites) await publish();
    return function_id === "state::delete" ? old_value : { old_value, new_value: rows[key], errors: [] };
  } };
  const durability = createStateDurabilityFence({ storePath, timeoutMs: 70, pollIntervalMs: 5 });
  const kv = new StateKV(sdk as never, { durability } as any);
  return { kv, store, deletes, durability, publish, enablePublication: () => { publishWrites = true; } };
}

describe("StateKV disk publication", () => {
  it("tracks every file mutation and freezes new writes", async () => {
    const { kv, durability } = await fileKV();
    await kv.set("synthetic:scope", "record", { n: 1 });
    await kv.update("synthetic:scope", "record", [{ type: "set", path: "n", value: 2 }]);
    await kv.delete("synthetic:scope", "missing");
    expect(durability.keys().map((row: any) => row.key).sort()).toEqual(["missing", "record"]);
    durability.freeze();
    await expect(kv.set("synthetic:scope", "blocked", {})).rejects.toMatchObject({ code: "STATE_FROZEN" });
  });

  it("does not certify SDK acknowledgement until the namespace matches on disk", async () => {
    const { kv, durability, publish } = await fileKV();
    await kv.set("synthetic:scope", "record", { n: 1 });
    await expect(durability.wait(kv)).rejects.toMatchObject({ code: "STATE_DURABILITY_TIMEOUT" });
    expect(durability.keys()).toHaveLength(1);
    await publish();
    await expect(durability.wait(kv)).resolves.toMatchObject({ keys: 1, synced: true });
    expect(durability.keys()).toHaveLength(0);
  });

});
