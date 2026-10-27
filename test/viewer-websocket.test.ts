import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { LiveEventsHub, onLiveEvent, type LiveEventWriter } from "../src/viewer/live-events.js";
import { sendViewerEvent } from "../src/triggers/events.js";

// Transport coverage moved to viewer-sse (auth, framing), viewer-sse-proxy
// (disconnect/backpressure), viewer-security/viewer-host (Host/origin/bearer),
// and live-events (heartbeat, slow readers, 32 subscribers). These preserve the
// former custom publisher's nonfatal delivery and oversized-frame guarantees.
class Writer extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  frames: string[] = [];
  write(frame: string) { this.frames.push(frame); return true; }
  destroy() { this.destroyed = true; this.emit("close"); return this; }
}

describe("Viewer SSE semantic guarantees after replacing WebSocket", () => {
  it("receives new Viewer events without accessing engine history", async () => {
    const events: unknown[] = [];
    let engineCalls = 0;
    const unsubscribe = onLiveEvent(event => events.push(event));
    try {
      await sendViewerEvent({ trigger: async () => { engineCalls++; } } as never,
        "fixture", "health.changed", { report: { status: "ok" } });
      expect(events).toEqual([{ id: "fixture", type: "health.changed", data: { report: { status: "ok" } } }]);
      expect(engineCalls).toBe(0);
    } finally { unsubscribe(); }
  });

  it("isolates broken event observers from accepted state changes", async () => {
    const unsubscribe = onLiveEvent(() => { throw new Error("fixture observer failure"); });
    try {
      await expect(sendViewerEvent({} as never, "fixture", "health.changed", {})).resolves.toBeUndefined();
    } finally { unsubscribe(); }
  });

  it("drops an oversized event before sending its first frame without failing the publisher", () => {
    const hub = new LiveEventsHub();
    const writer = new Writer();
    const unsubscribe = hub.subscribe(writer as unknown as LiveEventWriter);
    try {
      expect(() => hub.emit({ id: "large", type: "fixture", data: { value: "x".repeat(1024 * 1024) } })).not.toThrow();
      expect(writer.frames.length).toBe(0);
      expect(writer.destroyed).toBe(true);
      expect(hub.stats()).toMatchObject({ subscribers: 0, dropped: 1, eventsSent: 0 });
    } finally { unsubscribe(); }
  });

  it("keeps unserializable display notifications nonfatal", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(sendViewerEvent({} as never, "cyclic", "fixture", circular)).resolves.toBeUndefined();
  });

  it("isolates a failed writer and delivers the event to healthy readers", () => {
    const hub = new LiveEventsHub();
    const broken = new Writer();
    broken.write = () => { throw new Error("fixture writer failure"); };
    const healthy = new Writer();
    const cleanup = [hub.subscribe(broken as unknown as LiveEventWriter), hub.subscribe(healthy as unknown as LiveEventWriter)];
    try {
      expect(() => hub.emit({ id: "healthy", type: "health.changed", data: {} })).not.toThrow();
      expect(broken.destroyed).toBe(true);
      expect(healthy.frames).toHaveLength(1);
      expect(hub.stats()).toMatchObject({ subscribers: 1, dropped: 1, eventsSent: 1 });
    } finally { cleanup.forEach(unsubscribe => unsubscribe()); }
  });

  it("routes compressed SSE observations into the fresh-observation update", async () => {
    const html = readFileSync("src/viewer/index.html", "utf8");
    const start = html.indexOf("    function parseSseFrame(");
    const end = html.indexOf("    var resyncing = null;", start);
    const routed: unknown[] = [];
    const controller = new AbortController();
    const observation = { id: "fixture", sessionId: "fixture-session" };
    const bytes = new TextEncoder().encode("event: compressed_observation\ndata: " + JSON.stringify({ data: { observation } }) + "\n\n");
    let read = false;
    const connect = runInNewContext(html.slice(start, end) + "\nconnectWs;", {
      autoRefresh: { enabled: true }, wsReconnectTimer: null, conn: {}, liveAbortController: null,
      AbortController: function () { return controller; }, LIVE_EVENTS_URL: "http://fixture/agentmemory/viewer/events",
      getViewerToken: () => "", fetch: async () => ({ ok: true, body: { getReader: () => ({ read: async () => {
        if (!read) { read = true; return { done: false, value: bytes }; }
        controller.abort(); return { done: true };
      } }) } }),
      hideViewerAuthPrompt() {}, wsRetries: 0, wsHasConnected: false, wsOpenedAt: null,
      setConnection() {}, updateFooter() {}, resyncAfterConnect: async () => {},
      TextDecoder, store: {}, looksLikeObservation: () => true,
      routeWsMessage: (event: unknown) => routed.push(event), handleLiveEvent() {}, console,
    });
    await connect();
    expect(routed).toEqual([{ observation, fresh: true }]);
  });
});
