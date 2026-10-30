import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { registerViewerStreamTriggers } from "../src/triggers/viewer-streams.js";
import { KV } from "../src/state/schema.js";
import { resetViewerCounts, setViewerCountsEmitter } from "../src/state/viewer-counts.js";
import { setAuditRecordedListener } from "../src/functions/audit.js";
import { setGraphGenerationListener } from "../src/state/graph-generation.js";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

beforeEach(() => resetViewerCounts());
afterEach(() => {
  resetViewerCounts();
  setViewerCountsEmitter(null);
  setAuditRecordedListener(null);
  setGraphGenerationListener(null);
});

function viewerSource(name: string) {
  const viewer = readFileSync("src/viewer/index.html", "utf8");
    let start = viewer.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing viewer function ${name}`);
    if (viewer.slice(start - 6, start) === "async ") start -= 6;
    let depth = 0;
    for (let i = viewer.indexOf("{", start); i < viewer.length; i++) {
      if (viewer[i] === "{") depth++;
      if (viewer[i] === "}" && --depth === 0) return viewer.slice(start, i + 1);
    }
    throw new Error(`Unbalanced viewer function ${name}`);
}

it.each(["dashboard", "health"])("loads %s consolidation detail after a null bootstrap and retains it across refreshes", async (tab) => {
  const detail = { summaries: 8, tiers: [{ id: "semantic", count: 2 }] };
  const fetched: string[] = [];
  const dirty: string[][] = [];
  const rendered: string[] = [];
  const store = { consolidationStatus: null } as Record<string, unknown>;
  const context: Record<string, any> = {
    store, consolidationStatusRequest: null, tabRendered: {}, tabDirty: {},
    operations: { checkedAt: 1 }, state: { activeTab: tab }, autoRefresh: { enabled: false },
    tabNeeds: () => [], renderTab: (name: string) => rendered.push(name),
    markDirty: (tabs: string[]) => dirty.push(tabs),
    apiGet: async (path: string) => { fetched.push(path); return detail; },
  };
  runInNewContext(["applySnapshot", "ensureConsolidationStatus", "showTab"].map(viewerSource).join("\n"), context);
  const lastRun = { at: "2026-10-29T12:00:00.000Z", tier: "all", results: {} };
  context.applySnapshot(store, { consolidation: { lastRun, status: null } });
  expect(store.consolidationStatus).toBeNull();
  await context.showTab(tab);
  expect(fetched).toEqual(["consolidation/status"]);
  expect(store.consolidationStatus).toEqual(detail);
  expect(dirty).toEqual([["dashboard", "health"]]);
  expect(rendered).toEqual([tab, tab]);
  context.applySnapshot(store, { consolidation: { lastRun, status: null } });
  expect(store.consolidationStatus).toEqual(detail);
  expect(store.consolidation).toEqual({ lastRun, status: null });
  await context.showTab(tab);
  expect(fetched).toEqual(["consolidation/status"]);
});

it("refreshes detail through the actual manual refresh action while automatic refresh is off", async () => {
  const viewer = readFileSync("src/viewer/index.html", "utf8");
  const start = viewer.indexOf("document.addEventListener('click', function(e)");
  const end = viewer.indexOf("document.getElementById('modal-overlay').addEventListener", start);
  let click!: (event: unknown) => void;
  const fetched: string[] = [];
  const rendered: string[] = [];
  class Target {
    closest(selector: string) { return selector === "[data-action]" ? this : null; }
    getAttribute() { return "refresh-operations"; }
    disabled = false;
  }
  const context: Record<string, any> = {
    document: { addEventListener: (_type: string, handler: typeof click) => { click = handler; } },
    Element: Target, hideHelpPop() {}, closeNav() {},
    store: { snapshot: {}, consolidationStatus: { tiers: [{ id: "semantic", count: 1 }] } },
    autoRefresh: { enabled: false }, state: { activeTab: "health" }, consolidationStatusRequest: null,
    markDirty() {}, renderTab: (tab: string) => rendered.push(tab), loadOperations() {},
    loadSnapshot: () => { throw new Error("healthy snapshot must not add a snapshot query"); },
    apiGet: async (path: string) => { fetched.push(path); return { tiers: [{ id: "semantic", count: 2 }] }; },
  };
  runInNewContext(viewerSource("ensureConsolidationStatus") + "\n" + viewer.slice(start, end), context);
  click({ target: new Target() });
  expect(fetched).toEqual(["consolidation/status"]);
  await context.consolidationStatusRequest;
  expect(context.store.consolidationStatus.tiers[0].count).toBe(2);
  expect(rendered).toEqual(["health"]);
});

it.each(["dashboard", "health"])("refreshes %s detail after successful snapshots without blocking bootstrap or duplicating inflight work", async (tab) => {
  const old = { summaries: 3, tiers: [{ id: "semantic", count: 1 }] };
  const fresh = { summaries: 8, tiers: [{ id: "semantic", count: 2 }] };
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetched: string[] = [];
  const store: Record<string, any> = { consolidationStatus: old, graph: null };
  const context: Record<string, any> = {
    store, consolidationStatusRequest: null, tabRendered: {}, state: { activeTab: tab, graph: { resetSeq: 0 } },
    renderConnection() {}, updateFooter() {}, markDirty() {}, renderTab() {}, noteGraphGeneration() {},
    renderFlagsChip() {}, renderFlagsPanel() {}, updateCountBadges() {},
    apiGet: async (path: string) => { fetched.push(path); return path === "viewer/snapshot" ? { consolidation: { lastRun: null, status: null } } : pending; },
  };
  runInNewContext(["applySnapshot", "ensureConsolidationStatus", "loadSnapshot"].map(viewerSource).join("\n"), context);
  expect(await context.loadSnapshot()).toBe(true);
  expect(store.consolidationStatus).toBe(old);
  expect(fetched).toEqual(["viewer/snapshot", "consolidation/status"]);
  await context.loadSnapshot();
  context.ensureConsolidationStatus(true);
  expect(fetched).toEqual(["viewer/snapshot", "consolidation/status", "viewer/snapshot"]);
  release(fresh);
  await context.consolidationStatusRequest;
  expect(store.consolidationStatus).toEqual(fresh);
  expect(context.consolidationStatusRequest).toBeNull();
  context.apiGet = async () => null;
  await context.ensureConsolidationStatus(true);
  expect(store.consolidationStatus).toEqual(fresh);
  expect(context.consolidationStatusRequest).toBeNull();
  context.apiGet = async () => { throw new Error("detail unavailable"); };
  await context.ensureConsolidationStatus(true);
  expect(store.consolidationStatus).toEqual(fresh);
  expect(context.consolidationStatusRequest).toBeNull();
});

it("does not refresh detail after a failed snapshot or from a background refresh with automatic refresh off", async () => {
  const fetched: string[] = [];
  const context: Record<string, any> = {
    store: {}, state: { activeTab: "health", graph: { resetSeq: 0 } }, tabRendered: {},
    renderConnection() {}, updateFooter() {}, markDirty() {}, renderTab() {},
    apiGet: async (path: string) => { fetched.push(path); return null; },
    autoRefresh: { enabled: false, seconds: 30 }, operations: {}, clearTimeout,
    setTimeout: vi.fn(),
  };
  runInNewContext(["loadSnapshot", "scheduleOperationsRefresh"].map(viewerSource).join("\n"), context);
  expect(await context.loadSnapshot()).toBe(false);
  expect(fetched).toEqual(["viewer/snapshot"]);
  context.scheduleOperationsRefresh();
  expect(context.setTimeout).not.toHaveBeenCalled();
});

it("serves bootstrap data while optional consolidation counting is pending, preserving the detailed endpoint", async () => {
  // Regression: awaiting detailed consolidation analysis makes bootstrap depend on a full summary count.
  let finishCount!: (count: number) => void;
  let countStarted!: () => void;
  const counting = new Promise<number>((resolve) => { finishCount = resolve; });
  const started = new Promise<void>((resolve) => { countStarted = resolve; });
  const lastRun = { at: "2026-10-29T12:00:00.000Z", tier: "all", results: { semantic: { newFacts: 2 } } };
  const health = { status: "degraded", alerts: ["test health alert"], notes: [] };
  const rows: Record<string, Record<string, unknown>> = {
    [KV.health]: { latest: health },
    [KV.config]: { "consolidation:lastPipelineRun": lastRun },
    [KV.sessions]: { s1: { id: "s1", status: "active", observationCount: 7 } },
    [KV.memories]: { m1: { id: "m1", isLatest: true, type: "pattern", sessionIds: ["s1", "s2"] } },
    [KV.semantic]: { f1: { id: "f1" }, f2: { id: "f2" } },
    [KV.procedural]: { p1: { id: "p1" } },
    [KV.relations]: { r1: { id: "r1" } },
    [KV.graphRetrievalControl]: { current: { schema: 2, buildId: "test", status: "ready", revision: 0,
      nodes: 12, edges: 7, historyEdges: 0, incompleteRecords: 0,
      nodesByType: { file: 12 }, edgesByType: { related_to: 7 }, otherTypes: 0, updatedAt: "graph-time" } },
  };
  const kv = {
    get: async (scope: string, key: string) => rows[scope]?.[key] ?? null,
    list: async (scope: string) => Object.values(rows[scope] ?? {}),
    countSummaries: async () => { countStarted(); return counting; },
  };
  const handlers = new Map<string, (request: unknown) => Promise<any>>();
  const sdk = {
    registerFunction: (id: string, handler: (request: unknown) => Promise<any>) => handlers.set(id, handler),
    registerTrigger: () => {},
    trigger: async () => ({ totalNodes: 12, totalEdges: 7, nodesByType: { file: 12 }, edgesByType: { related_to: 7 } }),
  };
  registerApiTriggers(sdk as never, kv as never);
  registerViewerStreamTriggers(sdk as never, kv as never);
  const request = { headers: {}, query_params: {} };
  const details = handlers.get("api::consolidation-status")!(request);
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      handlers.get("api::viewer-snapshot")!(request),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); }),
    ]);
    expect(snapshot, "bootstrap must complete before the optional summary count is released").not.toBeNull();
    expect(snapshot).toMatchObject({ status_code: 200, body: {
      service: "agentmemory", status: "degraded", health,
      consolidation: { lastRun, status: null },
      counts: { sessions: 1, activeSessions: 1, observations: 7, memories: 1, latestMemories: 1,
        semantic: 2, procedural: 1, graphNodes: 12, graphEdges: 7 },
      graph: { stats: { totalNodes: 12, totalEdges: 7 }, graphIndex: { status: "ready", incomplete: false } },
      indexes: { bm25Documents: expect.any(Number), vectorDocuments: expect.any(Number) },
      report: { status: expect.any(String), problems: expect.arrayContaining([expect.objectContaining({ code: "health-alert" })]) },
    } });
  } finally {
    clearTimeout(timer);
    finishCount(8);
  }
  expect(await details).toMatchObject({ status_code: 200, body: {
    summaries: 8, recurringPatterns: 1, lastRun,
    tiers: expect.arrayContaining([
      expect.objectContaining({ id: "semantic", count: 2 }),
      expect.objectContaining({ id: "procedural", count: 1 }),
      expect.objectContaining({ id: "relations", count: 1 }),
    ]),
  } });
});
