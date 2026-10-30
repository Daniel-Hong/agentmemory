import { describe, expect, it } from "vitest";
import { setImmediate as turn } from "node:timers/promises";
import { StateKV } from "../src/state/kv.js";
import { KV } from "../src/state/schema.js";
import { GraphIndexMigrationController } from "../src/state/graph-index-migration.js";
import { createGraphIndexReader, getGraphIndexStatus, initializeGraphIndex, reconcileGraphIndexRecord, recoverGraphIndex } from "../src/state/graph-retrieval-index.js";
import type { GraphNode } from "../src/types.js";

const node = (id: string): GraphNode => ({ id, name: "Alpha", type: "concept", properties: {}, sourceObservationIds: ["observation"], createdAt: "2026-10-30T00:00:00Z" });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const rows = new Map<string, Map<string, unknown>>();
  let intercept: ((fn: string, payload: any) => Promise<void> | void) | undefined;
  let after: typeof intercept;
  const sdk = { trigger: async ({ function_id: fn, payload: p }: any) => {
    await intercept?.(fn, p);
    const scope = rows.get(p.scope) ?? new Map<string, unknown>();
    if (fn === "state::get") return structuredClone(scope.get(p.key) ?? null);
    if (fn === "state::list") return structuredClone([...scope.values()]);
    if (fn === "state::set") { scope.set(p.key, structuredClone(p.value)); rows.set(p.scope, scope); await after?.(fn, p); return p.value; }
    if (fn === "state::delete") { scope.delete(p.key); await after?.(fn, p); return; }
    throw Error(`Unexpected external operation: ${fn}`);
  } };
  const kv = new StateKV(sdk as never, { backend: "redis" });
  return { rows, kv, sdk, intercept: (f?: typeof intercept) => { intercept = f; }, after: (f?: typeof after) => { after = f; } };
}

  it("keeps an interrupted sealed job unchanged during held boot", async () => {
    const f = fixture(); f.rows.set(KV.graphNodes, new Map([["a", node("a")], ["b", node("b")]]));
    const controller = new GraphIndexMigrationController(f.kv), entered = deferred(), release = deferred();
    f.intercept(async (fn, p) => {
      if (fn === "state::set" && p.scope === KV.graphRetrievalData) { entered.resolve(); await release.promise; }
    });
    await controller.start({ allowLegacyScan: true }); await entered.promise;
    const stopped = controller.stop(); release.resolve(); await stopped; f.intercept();
    expect(await controller.status()).toMatchObject({ state: "paused", sealed: true, processed: 1, total: 2 });
    const before = structuredClone(f.rows), saved = await controller.status(), restarted = new GraphIndexMigrationController(f.kv);
    try {
      await restarted.resumeOnBoot({ held: true });
      expect(f.rows).toEqual(before);
      await restarted.start({ resume: true }); await restarted.waitForIdle();
      expect(await restarted.status()).toMatchObject({ state: "ready", processed: 2, total: 2, jobId: saved.jobId, buildId: saved.buildId, generation: saved.generation });
      const reader = (await createGraphIndexReader(f.kv))!;
      expect((await reader.posting("name", "alpha")).ids.sort()).toEqual(["a", "b"]);
      expect(f.rows.get(KV.graphNodes)).toEqual(before.get(KV.graphNodes));
    } finally { await restarted.stop(); }
  });

