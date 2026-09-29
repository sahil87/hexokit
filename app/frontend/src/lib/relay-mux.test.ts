import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RelayMux,
  HEARTBEAT_INTERVAL_MS,
  LIVENESS_TIMEOUT_MS,
  WAKE_PROBE_TIMEOUT_MS,
  HIDDEN_RELEASE_GRACE_MS,
  SERVER_LIVENESS_TIMEOUT_MS,
} from "./relay-mux";

// MockWebSocket — the terminals-mux transport. Captures the client's frames
// (JSON control text + binary `[u32 BE id][payload]` data) and lets tests drive
// server frames (opened / closed control, binary data). Opens synchronously on
// the next microtask so the mux's onopen (which issues the queued `open` ops)
// fires within the test's await.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  url: string;
  binaryType = "";
  readyState: number = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null;
  sentText: string[] = [];
  sentBinary: Uint8Array[] = [];
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }
  send(data: string | Uint8Array) {
    if (typeof data === "string") this.sentText.push(data);
    else this.sentBinary.push(data);
  }
  close() {
    // A local close() fires the close event (as real browsers do — even when
    // the TCP peer is gone). Callers that must suppress the reconnect path
    // (mux.close()) null onclose before calling close(), same as production.
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  // Test drivers ---------------------------------------------------------
  /** Push a JSON control frame server→client. */
  emitControl(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** Push a binary data frame `[u32 BE id][payload]` server→client. */
  emitData(id: number, payload: Uint8Array) {
    const buf = new Uint8Array(4 + payload.length);
    new DataView(buf.buffer).setUint32(0, id, false);
    buf.set(payload, 4);
    this.onmessage?.({ data: buf.buffer });
  }
  /** Drive a socket-level drop (server dies). */
  drop() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

function parseControls(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.sentText.map((s) => JSON.parse(s));
}
function controlsOfOp(ws: MockWebSocket, op: string): Array<Record<string, unknown>> {
  return parseControls(ws).filter((c) => c.op === op);
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("RelayMux framing + control ops", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens one socket for multiple streams and issues an open op per stream with client-allocated ids", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    mux.openStream({ server: "default", windowId: "@2", cols: 100, rows: 40 });
    await flush();

    expect(MockWebSocket.instances).toHaveLength(1); // ONE socket for both streams
    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe("ws://localhost:3000/ws/terminals");
    expect(ws.binaryType).toBe("arraybuffer");

    const opens = controlsOfOp(ws, "open");
    expect(opens).toHaveLength(2);
    expect(opens[0]).toMatchObject({ op: "open", id: 1, server: "default", windowId: "@1", cols: 80, rows: 24 });
    expect(opens[1]).toMatchObject({ op: "open", id: 2, windowId: "@2", cols: 100, rows: 40 });
    // ids are distinct u32s
    expect(opens[0].id).not.toBe(opens[1].id);
    mux.close();
  });

  it("send() emits a binary [u32 BE id][payload] data frame; resize() and close() emit control ops", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@7", cols: 80, rows: 24 });
    await flush();
    const ws = MockWebSocket.instances[0];

    s.send("hi");
    expect(ws.sentBinary).toHaveLength(1);
    const frame = ws.sentBinary[0];
    expect(new DataView(frame.buffer, frame.byteOffset).getUint32(0, false)).toBe(1); // stream id
    expect(new TextDecoder().decode(frame.slice(4))).toBe("hi");

    s.resize(120, 30);
    expect(controlsOfOp(ws, "resize")).toEqual([{ op: "resize", id: 1, cols: 120, rows: 30 }]);

    s.close();
    expect(controlsOfOp(ws, "close")).toEqual([{ op: "close", id: 1 }]);
    mux.close();
  });

  it("setWindowId() sends NO wire op — it only updates the reconnect target (M1)", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await flush();
    const ws = MockWebSocket.instances[0];
    const textFramesBefore = ws.sentText.length;
    const binaryFramesBefore = ws.sentBinary.length;

    s.setWindowId("@9");

    // A same-session ride mutates only the in-memory re-open target — no `open`,
    // `resize`, `close`, or data frame crosses the wire (the live PTY already
    // tracks the new active window).
    expect(ws.sentText.length).toBe(textFramesBefore);
    expect(ws.sentBinary.length).toBe(binaryFramesBefore);
    mux.close();
  });

  it("demuxes inbound binary frames to the addressed stream's onData", async () => {
    const mux = new RelayMux();
    const s1 = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    const s2 = mux.openStream({ server: "default", windowId: "@2", cols: 80, rows: 24 });
    await flush();
    const ws = MockWebSocket.instances[0];

    const got1: Uint8Array[] = [];
    const got2: Uint8Array[] = [];
    s1.onData((d) => got1.push(d));
    s2.onData((d) => got2.push(d));

    ws.emitData(1, new TextEncoder().encode("for-one"));
    ws.emitData(2, new TextEncoder().encode("for-two"));

    expect(got1).toHaveLength(1);
    expect(got2).toHaveLength(1);
    expect(new TextDecoder().decode(got1[0])).toBe("for-one");
    expect(new TextDecoder().decode(got2[0])).toBe("for-two");
    mux.close();
  });

  it("dispatches a `closed` control event to the right stream's onClosed with code + reason", async () => {
    const mux = new RelayMux();
    const s1 = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    const s2 = mux.openStream({ server: "default", windowId: "@2", cols: 80, rows: 24 });
    await flush();
    const ws = MockWebSocket.instances[0];

    const closed1: Array<{ code: number; reason: string }> = [];
    const closed2: Array<{ code: number; reason: string }> = [];
    s1.onClosed((code, reason) => closed1.push({ code, reason }));
    s2.onClosed((code, reason) => closed2.push({ code, reason }));

    ws.emitControl({ op: "closed", id: 1, code: 4004, reason: "Window not found" });

    expect(closed1).toEqual([{ code: 4004, reason: "Window not found" }]);
    expect(closed2).toHaveLength(0); // not this stream

    // A closed stream is retired: its onData no longer fires.
    const late: Uint8Array[] = [];
    s1.onData((d) => late.push(d));
    ws.emitData(1, new TextEncoder().encode("too-late"));
    expect(late).toHaveLength(0);
    mux.close();
  });

  it("the open op carries isolate only when the stream opts set it", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    mux.openStream({ server: "default", windowId: "@3", cols: 80, rows: 24, isolate: true });
    mux.openStream({ server: "default", windowId: "@4", cols: 80, rows: 24, isolate: false });
    await flush();
    const ws = MockWebSocket.instances[0];

    const opens = controlsOfOp(ws, "open");
    expect(opens).toHaveLength(3);
    // Bare tty streams omit the key entirely (the backend's omitempty).
    expect("isolate" in opens[0]).toBe(false);
    expect(opens[1]).toMatchObject({ id: 2, windowId: "@3", isolate: true });
    expect("isolate" in opens[2]).toBe(false);
    mux.close();
  });
});

describe("RelayMux reconnect", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reconnects with backoff and re-issues open for every live stream", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    mux.openStream({ server: "default", windowId: "@2", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];
    expect(controlsOfOp(ws1, "open")).toHaveLength(2);

    // Socket-level drop → schedule reconnect (streams are still live).
    ws1.drop();
    expect(MockWebSocket.instances).toHaveLength(1); // not yet reconnected

    vi.advanceTimersByTime(1000); // backoff base
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(2);
    const ws2 = MockWebSocket.instances[1];

    // Both live streams re-issue their open op on the new socket (same ids).
    const opens2 = controlsOfOp(ws2, "open");
    expect(opens2).toHaveLength(2);
    expect(opens2.map((o) => o.id).sort()).toEqual([1, 2]);
    mux.close();
  });

  it("re-issues the reconnect open with the stream's LATEST windowId after a same-session ride (M1)", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@0", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];
    expect(controlsOfOp(ws1, "open")[0]).toMatchObject({ id: 1, windowId: "@0" });

    // Same-session window switch rides the live stream (no wire op) but updates
    // the re-open target — the regression M1 caught was reconnect re-opening the
    // STALE @0 (which SelectWindowInSession would yank the pane back to).
    s.setWindowId("@5");

    // Socket-level drop → reconnect must re-open @5, not @0.
    ws1.drop();
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();
    const ws2 = MockWebSocket.instances[1];
    const reopen = controlsOfOp(ws2, "open");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ id: 1, windowId: "@5" });
    mux.close();
  });

  it("a reconnect re-issues the open with isolate intact", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@3", cols: 80, rows: 24, isolate: true });
    await vi.runAllTicks();
    MockWebSocket.instances[0].drop();
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();

    const reopen = controlsOfOp(MockWebSocket.instances[1], "open");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ id: 1, windowId: "@3", isolate: true });
    mux.close();
  });

  it("does not reconnect when no streams remain (idle tab drops its socket)", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];

    s.close(); // last stream gone
    ws1.drop();
    vi.advanceTimersByTime(30000);
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect
    mux.close();
  });
});

// Liveness: heartbeat + wake probes (260723-rma2). The heartbeat is stream-
// gated (socket OPEN and ≥1 live stream). This block stubs a window that DOES
// carry addEventListener (unlike the minimal stub above, which proves the
// environment guard) so the wake-probe listeners register and events can be
// dispatched. visibilitychange rides jsdom's real document.
describe("RelayMux liveness + wake probes", () => {
  // An EventTarget-backed window stub so the mux's window listeners
  // (online/pageshow) register and can be dispatched.
  let windowTarget: EventTarget;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    windowTarget = new EventTarget();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the liveness ladder holds: heartbeat < client give-up < server deadline (a live client always disconnects itself first)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(LIVENESS_TIMEOUT_MS);
    expect(LIVENESS_TIMEOUT_MS).toBeLessThan(SERVER_LIVENESS_TIMEOUT_MS);
  });

  it("heartbeats {op:\"ping\"} while a stream is live and stops when the last stream closes", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks(); // onopen → stream-gated heartbeat starts
    const ws = MockWebSocket.instances[0];

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(controlsOfOp(ws, "ping")).toHaveLength(1);

    // Closing the last stream stops the heartbeat — the idle socket is never
    // pinged (and never reconnected by liveness).
    s.close();
    vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
    expect(controlsOfOp(ws, "ping")).toHaveLength(1); // no further pings
    mux.close();
  });

  it("binary data frames count as liveness — a busy terminal with unanswered pings never force-closes", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.emitData(1, new TextEncoder().encode("output")); // data, never a pong
    }
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect
    mux.close();
  });

  it("silence past LIVENESS_TIMEOUT_MS force-closes and the reconnect re-issues open for live streams", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@3", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    // Tick 1 pings (outstanding clock starts); tick 2 within timeout; tick 3
    // sees outstanding ≥ LIVENESS_TIMEOUT_MS → force-close.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);

    // forceClose did NOT set `closed` — the existing reconnect path re-opens
    // the live stream on a fresh socket.
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(2);
    const reopen = controlsOfOp(MockWebSocket.instances[1], "open");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ id: 1, windowId: "@3" });
    mux.close();
  });

  it("an id-less {op:\"pong\"} is swallowed before the stream-id guard (no stream callback)", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    const closed: number[] = [];
    let opened = 0;
    s.onClosed((code) => closed.push(code));
    s.onOpened(() => opened++);

    ws.emitControl({ op: "pong" }); // no id — must not throw or hit a stream
    expect(closed).toHaveLength(0);
    expect(opened).toBe(0);

    // And it counts as liveness: an outstanding ping answered only by pongs
    // never force-closes.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.emitControl({ op: "pong" });
    }
    expect(ws.readyState).toBe(MockWebSocket.OPEN);
    mux.close();
  });

  it("wake probes no-op for an idle mux (zero streams, no socket) — never resurrects the socket", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    // Idle: last stream closed, then the socket drops → scheduleReconnect's
    // zero-stream branch deliberately leaves it closed.
    s.close();
    ws.drop();
    expect(MockWebSocket.instances).toHaveLength(1);

    windowTarget.dispatchEvent(new Event("online"));
    windowTarget.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(LIVENESS_TIMEOUT_MS);

    expect(MockWebSocket.instances).toHaveLength(1); // still no socket
    mux.close();
  });

  it("wake probe pings an OPEN socket and force-closes on deadline silence; inbound data cancels it", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    // Probe answered by a data frame → alive, no close.
    windowTarget.dispatchEvent(new Event("online"));
    expect(controlsOfOp(ws, "ping")).toHaveLength(1);
    ws.emitData(1, new TextEncoder().encode("x"));
    vi.advanceTimersByTime(WAKE_PROBE_TIMEOUT_MS + 1000);
    expect(ws.readyState).toBe(MockWebSocket.OPEN);

    // Probe with dead silence → force-close → reconnect re-opens the stream.
    windowTarget.dispatchEvent(new Event("pageshow"));
    expect(controlsOfOp(ws, "ping")).toHaveLength(2);
    vi.advanceTimersByTime(WAKE_PROBE_TIMEOUT_MS);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(2);
    mux.close();
  });

  it("wake probe fires a pending reconnect timer immediately with backoff reset to base", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();

    // Two drops grow the backoff (1s spent; next delay 2s).
    MockWebSocket.instances[0].drop();
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].drop();

    // Mid-backoff wake: reconnects NOW (no timer advance) with backoff reset.
    windowTarget.dispatchEvent(new Event("online"));
    expect(MockWebSocket.instances).toHaveLength(3);
    await vi.runAllTicks();

    // Backoff was reset: the next drop reconnects after the 1s base, not 4s.
    MockWebSocket.instances[2].drop();
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(4);
    mux.close();
  });

  it("close() tears down the heartbeat and wake-probe listeners permanently", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    mux.close();
    vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
    expect(controlsOfOp(ws, "ping")).toHaveLength(0);

    windowTarget.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(LIVENESS_TIMEOUT_MS);
    expect(MockWebSocket.instances).toHaveLength(1); // no reconnect, no probe socket
  });
});

// Hidden-page stream suspension (change 260903-xj0w). A hidden page's streams
// are sized tmux attach clients that tmux's narrowest-viewer sizing
// (`window-size smallest`) would count, so after HIDDEN_RELEASE_GRACE_MS
// hidden the mux closes every live stream server-side (keeping it
// client-side, suspended) and re-opens it only on the `visible` transition.
// This block stubs an EventTarget window (like the liveness block) and
// overrides jsdom's document.visibilityState so tests can drive
// hidden/visible transitions.
describe("RelayMux hidden-page suspension", () => {
  let windowTarget: EventTarget;

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    windowTarget = new EventTarget();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3000" },
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    });
  });
  afterEach(() => {
    // Drop the per-test visibilityState override; jsdom's prototype getter
    // ("visible") shows through again.
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("suspends every live stream after the grace period hidden: close ops sent, streams kept, onClosed never fired, heartbeat stopped", async () => {
    const mux = new RelayMux();
    const s1 = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    const s2 = mux.openStream({ server: "default", windowId: "@2", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];
    const closedCodes: number[] = [];
    s1.onClosed((code) => closedCodes.push(code));
    s2.onClosed((code) => closedCodes.push(code));

    setVisibility("hidden");
    // Inside the grace window nothing happens.
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS - 1);
    expect(controlsOfOp(ws, "close")).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(controlsOfOp(ws, "close").map((c) => c.id).sort()).toEqual([1, 2]);

    // The server echoes `closed` 1000 for each client close op — the suspended
    // streams swallow it (no retire, no onClosed → no TerminalClient probe).
    ws.emitControl({ op: "closed", id: 1, code: 1000, reason: "closed" });
    ws.emitControl({ op: "closed", id: 2, code: 1000, reason: "closed" });
    expect(closedCodes).toHaveLength(0);

    // A racing 4004 (window killed as the tab hid) is swallowed too — it
    // surfaces on resume as a fresh 4004 instead.
    ws.emitControl({ op: "closed", id: 1, code: 4004, reason: "window not found" });
    expect(closedCodes).toHaveLength(0);

    // Zero live streams ⇒ the stream-gated heartbeat stops. (Pings from
    // INSIDE the grace window are legitimate — the streams were still live —
    // so assert no FURTHER pings after suspension.)
    const pingsAtSuspend = controlsOfOp(ws, "ping").length;
    vi.advanceTimersByTime(3 * HEARTBEAT_INTERVAL_MS);
    expect(controlsOfOp(ws, "ping")).toHaveLength(pingsAtSuspend);
    mux.close();
  });

  it("a quick app-switch (visible again inside the grace window) cancels the timer — nothing is closed or re-opened", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS / 2);
    setVisibility("visible");
    vi.advanceTimersByTime(2 * HIDDEN_RELEASE_GRACE_MS);

    expect(controlsOfOp(ws, "close")).toHaveLength(0);
    expect(controlsOfOp(ws, "open")).toHaveLength(1); // only the initial open
    mux.close();
  });

  it("resumes on visible: re-issues open with CURRENT opts (ridden windowId + resized grid), onOpened fires on the server's opened", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];
    let opened = 0;
    s.onOpened(() => opened++);

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    expect(controlsOfOp(ws, "close")).toHaveLength(1);

    // Opts stay current while suspended — a later reconnect target must be the
    // window the user will come back to.
    s.setWindowId("@9");
    s.resize(120, 40);

    setVisibility("visible");
    const opens = controlsOfOp(ws, "open");
    expect(opens).toHaveLength(2);
    expect(opens[1]).toMatchObject({ op: "open", id: 1, windowId: "@9", cols: 120, rows: 40 });

    ws.emitControl({ op: "opened", id: 1 });
    expect(opened).toBe(1);
    mux.close();
  });

  it("a socket reconnect while hidden does NOT re-open suspended streams; a drop while fully suspended (e.g. the server's liveness deadline closing the silent socket) stays closed until visible", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    expect(controlsOfOp(ws1, "close")).toHaveLength(1);

    // Fully suspended tab: a socket drop schedules NO reconnect (zero live
    // streams — the idle-socket rule).
    ws1.drop();
    vi.advanceTimersByTime(60000);
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(1);

    // Only the visible transition resumes: a fresh socket connects and its
    // onopen re-issues open for the resumed stream.
    setVisibility("visible");
    await vi.runAllTicks();
    expect(MockWebSocket.instances).toHaveLength(2);
    const opens2 = controlsOfOp(MockWebSocket.instances[1], "open");
    expect(opens2).toHaveLength(1);
    expect(opens2[0]).toMatchObject({ id: 1, windowId: "@1" });
    mux.close();
  });

  it("a stream opened while hidden opens normally, starts a fresh grace timer, and suspends on expiry; reconnect re-opens only live streams", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];

    // First suspension consumes the grace timer.
    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    expect(controlsOfOp(ws1, "close")).toHaveLength(1);

    // A stream opened while still hidden (background-tab route change) opens
    // normally…
    mux.openStream({ server: "default", windowId: "@7", cols: 80, rows: 24 });
    expect(controlsOfOp(ws1, "open").map((o) => o.id)).toContain(2);

    // …and a reconnect while hidden re-opens ONLY it (stream 1 stays
    // suspended).
    ws1.drop();
    vi.advanceTimersByTime(1000);
    await vi.runAllTicks();
    const ws2 = MockWebSocket.instances[1];
    expect(controlsOfOp(ws2, "open").map((o) => o.id)).toEqual([2]);

    // …then the restarted grace timer suspends it like any other.
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    expect(controlsOfOp(ws2, "close").map((c) => c.id)).toEqual([2]);
    mux.close();
  });

  it("closing a suspended stream removes it without a close op, and resume does not re-open it", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    expect(controlsOfOp(ws, "close")).toHaveLength(1); // the suspension's

    s.close(); // component unmount while hidden — already closed server-side
    expect(controlsOfOp(ws, "close")).toHaveLength(1); // no second close op

    setVisibility("visible");
    expect(controlsOfOp(ws, "open")).toHaveLength(1); // only the initial open
    mux.close();
  });

  it("pagehide and freeze release immediately — no grace", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    windowTarget.dispatchEvent(new Event("pagehide"));
    expect(controlsOfOp(ws, "close")).toHaveLength(1);

    // Resume (bfcache restore fires visibilitychange→visible), then freeze.
    setVisibility("visible");
    expect(controlsOfOp(ws, "open")).toHaveLength(2);
    document.dispatchEvent(new Event("freeze"));
    expect(controlsOfOp(ws, "close")).toHaveLength(2);
    mux.close();
  });

  it("a window killed while suspended surfaces on resume: the re-open's fresh 4004 retires the stream and fires onClosed", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];
    const closedCodes: number[] = [];
    s.onClosed((code) => closedCodes.push(code));

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    ws.emitControl({ op: "closed", id: 1, code: 1000, reason: "closed" }); // echo: swallowed

    setVisibility("visible");
    expect(controlsOfOp(ws, "open")).toHaveLength(2); // re-open attempted

    // The window died while hidden — the re-open is answered 4004, which now
    // retires the stream and fires onClosed (the existing recovery path).
    ws.emitControl({ op: "closed", id: 1, code: 4004, reason: "window not found" });
    expect(closedCodes).toEqual([4004]);
    mux.close();
  });

  it("a late closed-1000 echo racing a fast resume is swallowed exactly once: the resumed stream stays live, a later genuine 1000 retires", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];
    const closedCodes: number[] = [];
    let opened = 0;
    s.onClosed((code) => closedCodes.push(code));
    s.onOpened(() => opened++);

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS); // suspension close sent, echo in flight

    // Fast resume: visible again before the echo arrives — the re-open goes
    // out with the echo still owed.
    setVisibility("visible");
    expect(controlsOfOp(ws, "open")).toHaveLength(2);

    // The echo lands AFTER resume: it must be swallowed (retiring here would
    // orphan the re-open's server-side attach client and fire TerminalClient's
    // probe re-open).
    ws.emitControl({ op: "closed", id: 1, code: 1000, reason: "closed" });
    expect(closedCodes).toHaveLength(0);

    // The re-open's `opened` follows (wire FIFO) and the stream is fully live:
    // data still demuxes to it.
    ws.emitControl({ op: "opened", id: 1 });
    expect(opened).toBe(1);
    const got: Uint8Array[] = [];
    s.onData((d) => got.push(d));
    ws.emitData(1, new TextEncoder().encode("alive"));
    expect(got).toHaveLength(1);

    // The shield is one-shot: a LATER genuine graceful close (PTY EOF 1000)
    // retires the stream normally.
    ws.emitControl({ op: "closed", id: 1, code: 1000, reason: "closed" });
    expect(closedCodes).toEqual([1000]);
    mux.close();
  });

  it("a 4004 after a fast resume retires immediately — the echo shield covers only the 1000 echo", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];
    const closedCodes: number[] = [];
    s.onClosed((code) => closedCodes.push(code));

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);
    setVisibility("visible"); // re-open in flight, echo still owed

    // The window died while hidden: the re-open is answered 4004. It is never
    // the suspension close's echo (that echoes 1000), so it must retire — the
    // resume-time dead-window recovery path depends on it.
    ws.emitControl({ op: "closed", id: 1, code: 4004, reason: "window not found" });
    expect(closedCodes).toEqual([4004]);
    mux.close();
  });

  it("an echo lost to a socket death cannot swallow a later genuine 1000 — `opened` retires the pending shield", async () => {
    const mux = new RelayMux();
    const s = mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws1 = MockWebSocket.instances[0];
    const closedCodes: number[] = [];
    s.onClosed((code) => closedCodes.push(code));

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS); // close sent on ws1, echo owed

    // The socket dies before the echo arrives (fully suspended ⇒ no reconnect).
    ws1.drop();

    // Resume: fresh socket, re-open, and its `opened` clears the stale shield.
    setVisibility("visible");
    await vi.runAllTicks();
    const ws2 = MockWebSocket.instances[1];
    expect(controlsOfOp(ws2, "open")).toHaveLength(1);
    ws2.emitControl({ op: "opened", id: 1 });

    // A genuine PTY-EOF 1000 on the new connection retires normally.
    ws2.emitControl({ op: "closed", id: 1, code: 1000, reason: "closed" });
    expect(closedCodes).toEqual([1000]);
    mux.close();
  });

  it("resume runs before the wake probe: on visible, the re-open precedes the probe ping on an OPEN socket", async () => {
    const mux = new RelayMux();
    mux.openStream({ server: "default", windowId: "@1", cols: 80, rows: 24 });
    await vi.runAllTicks();
    const ws = MockWebSocket.instances[0];

    setVisibility("hidden");
    vi.advanceTimersByTime(HIDDEN_RELEASE_GRACE_MS);

    setVisibility("visible");
    const ops = parseControls(ws).map((c) => c.op);
    const reopenIdx = ops.lastIndexOf("open");
    expect(reopenIdx).toBeGreaterThan(-1);
    // The wake probe's ping follows the re-open (heartbeat pings from inside
    // the grace window precede it — the streams were live then) — resume ran
    // first, so the probe judged the resumed live set.
    const probePingIdx = ops.lastIndexOf("ping");
    expect(probePingIdx).toBeGreaterThan(reopenIdx);
    mux.close();
  });
});
