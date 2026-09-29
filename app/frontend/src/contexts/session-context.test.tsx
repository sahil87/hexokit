import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import {
  SessionProvider,
  useSessionContext,
  useHostMetrics,
  useHostServices,
  useCodeServer,
  useGui,
  useMetrics,
  StandaloneSessionContextProvider,
  shouldReloadOnVersion,
  deriveUpdateFeed,
} from "./session-context";
import { ChromeProvider } from "./chrome-context";
import type { MetricsSnapshot } from "@/types";
import type { GuiSignal } from "./session-context";

// Keep the real module (so pure helpers like `compareServers` — exercised by
// the infra-sort test below — run for real); only `listServers` is stubbed.
vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  listServers: vi.fn().mockResolvedValue([]),
}));

import { listServers } from "@/api/client";

// Mock TanStack Router's useMatches so the provider can compute currentServer
// without spinning up a real router. Tests can flip the matched route shape
// via `setMockMatches`.
let mockMatches: Array<{ params?: Record<string, string> }> = [];
function setMockMatches(matches: Array<{ params?: Record<string, string> }>) {
  mockMatches = matches;
}
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => mockMatches,
}));

// MockWebSocket — the state socket transport (change 260716-qf3j). The provider
// opens ONE socket to /ws/state; the mock captures the client's ops (hello /
// subscribe / unsubscribe / preview-scope) and lets tests drive server frames
// (event / ack / gone). A `Facade` mirrors the old MockEventSource API so the
// per-server test assertions read the same: `forServer(name).emit(type, data)`
// pushes a `kind:"server"` event; `forHostMetrics().emit(type, data)` pushes a
// `kind:"global"` event; `emit("server-gone")` pushes a `gone` frame.
type WSListener = (e: MessageEvent) => void;
const WS_OPEN = 1;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static current: MockWebSocket | null = null;
  // When true, newly-constructed sockets stay CONNECTING (never fire onopen) —
  // simulates a genuine outage so the provider's disconnect debounce can fire
  // instead of being masked by an instant reconnect.
  static outage = false;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  url: string;
  readyState = WS_OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: WSListener | null = null;
  sent: string[] = [];
  // Requests seen, mapped req → {kind, key} so tests can ack them (append-only).
  subs: Array<{ req: number; kind: string; key?: string }> = [];
  // Active subscription ids, add on subscribe / remove on unsubscribe — reflects
  // the CURRENT wire state (unlike `subs`, which is the full history).
  active = new Set<string>();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    MockWebSocket.current = this;
    if (MockWebSocket.outage) {
      this.readyState = MockWebSocket.CONNECTING;
      return; // never opens — simulates an unreachable server
    }
    // Open synchronously on the next microtask so the provider's onopen fires
    // and sends hello + resubscribes within the test's act().
    queueMicrotask(() => {
      this.onopen?.();
    });
  }
  send(raw: string) {
    this.sent.push(raw);
    try {
      const m = JSON.parse(raw);
      const id = m.kind === "metrics" ? "metrics" : "server:" + m.key;
      if (m.op === "subscribe") {
        this.subs.push({ req: m.req, kind: m.kind, key: m.key });
        this.active.add(id);
      } else if (m.op === "unsubscribe") {
        this.active.delete(id);
      }
    } catch {
      // ignore
    }
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
  // Deliver a raw server frame to the provider.
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  // Ack the most recent subscribe matching kind (+ key), with an optional snapshot.
  ack(kind: string, key: string | undefined, snapshot: unknown) {
    const sub = [...this.subs].reverse().find((s) => s.kind === kind && s.key === key);
    if (!sub) return;
    this.deliver({ op: "ack", req: sub.req, snapshot });
  }
  static reset() {
    MockWebSocket.instances = [];
    MockWebSocket.current = null;
  }
}

// Facade giving the old per-server / host-metrics emit API over the single WS.
class ServerFacade {
  constructor(private ws: MockWebSocket, private server: string) {}
  emit(type: string, data: unknown) {
    if (type === "sessions") {
      // The provider treats the subscribe ack's snapshot as the sessions
      // payload; deliver both an ack (so isConnected flips) and an event.
      this.ws.ack("server", this.server, data);
      this.ws.deliver({ op: "event", kind: "server", key: this.server, type: "sessions", data });
      return;
    }
    if (type === "server-gone") {
      this.ws.deliver({ op: "gone", kind: "server", key: this.server, reason: "server-exited" });
      return;
    }
    this.ws.deliver({ op: "event", kind: "server", key: this.server, type, data });
  }
  get closed() {
    // A server "closes" when the socket closes; single-socket model has no
    // per-server socket, so report the socket's state.
    return this.ws.readyState === MockWebSocket.CLOSED;
  }
  set onerror(_fn: (() => void) | null) {
    /* per-server onerror has no analog on the single socket; drop */
  }
}

class GlobalFacade {
  constructor(private ws: MockWebSocket) {}
  emit(type: string, data: unknown) {
    if (type === "metrics") this.ws.ack("metrics", undefined, undefined);
    this.ws.deliver({ op: "event", kind: "global", type, data });
  }
  // Emit a raw (possibly malformed) frame for the malformed-payload test.
  emitRaw(type: string, raw: string) {
    this.ws.onmessage?.({
      data: JSON.stringify({ op: "event", kind: "global", type, data: JSON.parse(raw || "null") }),
    } as MessageEvent);
  }
  get listeners() {
    // Back-compat shim for the malformed-services test: return a Map whose
    // `get` yields a handler that feeds a bad payload through the socket.
    return {
      get: (type: string) => (e: MessageEvent) => {
        // e.data is a bad raw string; wrap it as a global event with unparsable
        // data so the provider's tolerant parse skips it without throwing.
        this.ws.onmessage?.({
          data: `{"op":"event","kind":"global","type":"${type}","data":${
            typeof e.data === "string" ? "0" : "0"
          }}`,
        } as MessageEvent);
      },
    };
  }
}

// Helpers mirroring the old MockEventSource statics.
const WS = {
  forServer(server: string): ServerFacade | undefined {
    const ws = MockWebSocket.current;
    if (!ws) return undefined;
    // A server is "present" only while its subscription is currently active.
    if (!ws.active.has("server:" + server)) return undefined;
    return new ServerFacade(ws, server);
  },
  forHostMetrics(): GlobalFacade | undefined {
    const ws = MockWebSocket.current;
    if (!ws) return undefined;
    if (!ws.active.has("metrics")) return undefined;
    return new GlobalFacade(ws);
  },
  // Emit a host-global event regardless of a metrics subscription (globals fan
  // out to every connection; a server-only route still receives them).
  global(): GlobalFacade | undefined {
    const ws = MockWebSocket.current;
    return ws ? new GlobalFacade(ws) : undefined;
  },
};

const FAKE_METRICS: MetricsSnapshot = {
  hostname: "test-box",
  cpu: { samples: [10, 20, 30], current: 42, cores: 8 },
  memory: { used: 4 * 1024 ** 3, total: 16 * 1024 ** 3 },
  load: { avg1: 1.5, avg5: 1.0, avg15: 0.5, cpus: 8 },
  disk: { used: 100 * 1024 ** 3, total: 500 * 1024 ** 3 },
  uptime: 90000,
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ChromeProvider>
      <SessionProvider>{children}</SessionProvider>
    </ChromeProvider>
  );
}

// Flush microtasks (socket onopen is queued via queueMicrotask) + React effects.
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  MockWebSocket.reset();
  MockWebSocket.outage = false;
  vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  setMockMatches([]); // default: no route — currentServer null
  vi.mocked(listServers).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SessionProvider — single state socket, per-server subscriptions", () => {
  it("subscribes to the current server (lazy-attach for non-current)", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);

    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    // Exactly one socket, subscribed to the current server; non-current stays
    // detached until attachServer.
    expect(MockWebSocket.instances.length).toBe(1);
    expect(WS.forServer("runkit")).toBeDefined();
    expect(WS.forServer("work")).toBeUndefined();
    expect(result.current.currentServer).toBe("runkit");

    await act(async () => {
      result.current.attachServer("work");
    });
    expect(WS.forServer("work")).toBeDefined();
    // Still a single socket — attaching a second server does not open a new one.
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("isolates state per server (sessions event)", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });

    expect((result.current.sessionsByServer.get("runkit") ?? []).map((s) => s.name)).toEqual(["A"]);
    expect((result.current.sessionsByServer.get("work") ?? []).map((s) => s.name)).toEqual([]);
  });

  it("populates sessionOrderByServer for the matching server only", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("session-order", { server: "runkit", order: ["main", "dev"] });
    });

    expect(result.current.sessionOrderByServer.get("runkit")).toEqual(["main", "dev"]);
    expect(result.current.sessionOrderByServer.get("work") ?? []).toEqual([]);
  });

  it("getServerReceiptTick reads 0 for a server never seen and is ref-backed (no re-render subscription)", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    expect(result.current.getServerReceiptTick("never-seen")).toBe(0);
    // The accessor is a stable imperative read — its identity never changes.
    const first = result.current.getServerReceiptTick;
    expect(result.current.getServerReceiptTick).toBe(first);
  });

  it("bumps the receipt tick on both ack snapshots and server events (260823-ke9i)", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    // The subscribe ack snapshot alone bumps the tick.
    act(() => {
      MockWebSocket.current!.ack("server", "runkit", []);
    });
    const afterAck = result.current.getServerReceiptTick("runkit");
    expect(afterAck).toBeGreaterThan(0);

    // A server event bumps it again.
    act(() => {
      WS.forServer("runkit")!.emit("session-order", { server: "runkit", order: ["main"] });
    });
    expect(result.current.getServerReceiptTick("runkit")).toBeGreaterThan(afterAck);

    // Events for another server do not bump this server's tick.
    const before = result.current.getServerReceiptTick("runkit");
    act(() => {
      result.current.attachServer("work");
    });
    act(() => {
      WS.forServer("work")!.emit("session-order", { server: "work", order: ["x"] });
    });
    expect(result.current.getServerReceiptTick("runkit")).toBe(before);
  });

  it("re-sorts ctx.servers on a server-order event without a listServers refetch", async () => {
    vi.mocked(listServers).mockResolvedValue([
      { name: "runkit", sessionCount: 0 },
      { name: "work", sessionCount: 0 },
    ]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    expect(result.current.servers.map((s) => s.name)).toEqual(["runkit", "work"]);
    const callsBefore = vi.mocked(listServers).mock.calls.length;

    act(() => {
      WS.global()!.emit("server-order", { order: ["work", "runkit"] });
    });

    expect(result.current.servers.map((s) => s.name)).toEqual(["work", "runkit"]);
    expect(vi.mocked(listServers).mock.calls.length).toBe(callsBefore);
  });

  it("ignores session-order events whose server field doesn't match the key", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("session-order", { server: "staging", order: ["other"] });
    });

    expect(result.current.sessionOrderByServer.get("runkit") ?? []).toEqual([]);
  });

  it("reports per-server isConnected independently", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", []);
    });

    expect(result.current.isConnectedByServer.get("runkit")).toBe(true);
    expect(result.current.isConnectedByServer.get("work") ?? false).toBe(false);
  });

  it("sessionsReceived stays false on the seeded slice until a real snapshot arrives", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    // Subscribed: the empty slice exists, but it is not a payload.
    expect(result.current.sessionsByServer.has("runkit")).toBe(true);
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(false);

    // A null ack snapshot means "no snapshot yet" — still not a payload.
    act(() => {
      MockWebSocket.current!.ack("server", "runkit", null);
    });
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(false);

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(true);
  });

  it("an array ack snapshot alone marks sessionsReceived", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      MockWebSocket.current!.ack("server", "runkit", []);
    });
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(true);
  });

  it("sessionsReceived re-seeds false after gone + re-subscribe", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(true);

    // listServers keeps returning runkit, so the diff effect re-subscribes.
    await act(async () => {
      WS.forServer("runkit")!.emit("server-gone", {});
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(MockWebSocket.current!.active.has("server:runkit")).toBe(true);
    expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(false);
  });

  it("sessionsReceived survives a socket drop + reconnect whose re-ack carries a null snapshot", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
      setMockMatches([{ params: { server: "runkit" } }]);
      const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      act(() => { WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]); });
      expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(true);

      // Drop the socket (no outage): the backoff reconnect opens a fresh socket
      // and resubscribes; its ack arrives with no snapshot yet.
      const dropped = MockWebSocket.current!;
      act(() => { dropped.close(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      const reconnected = MockWebSocket.current!;
      expect(reconnected).not.toBe(dropped);
      expect(reconnected.active.has("server:runkit")).toBe(true);

      act(() => { reconnected.ack("server", "runkit", null); });
      expect(result.current.sessionsReceivedByServer.get("runkit")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles gone: clears the slice and re-queries listServers", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });
    expect(result.current.sessionsByServer.has("runkit")).toBe(true);

    const callsBefore = vi.mocked(listServers).mock.calls.length;
    vi.mocked(listServers).mockResolvedValueOnce([]);
    await act(async () => {
      WS.forServer("runkit")!.emit("server-gone", {});
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.sessionsByServer.has("runkit")).toBe(false);
    expect(result.current.isConnectedByServer.has("runkit")).toBe(false);
    expect(vi.mocked(listServers).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("gone on a still-attached server releases the subscription so the diff effect re-subscribes", async () => {
    // A transient `gone` where listServers STILL returns the server (it never
    // leaves attachedSet). onGone must release the subscription (drop it from
    // subscribedServersRef + the socket ref-count) so the diff effect — which
    // re-runs when attachedSet recomputes after fetchServers — re-subscribes.
    // Without the release the server would stay in subscribedServersRef, the
    // diff effect would skip it, and its UI would be permanently dead.
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });
    expect(WS.forServer("runkit")).toBeDefined();

    const ws = MockWebSocket.current!;
    const subscribesBefore = ws.sent.filter(
      (s) => s.includes('"op":"subscribe"') && s.includes('"key":"runkit"'),
    ).length;

    // gone arrives, but listServers keeps returning runkit (still attached).
    await act(async () => {
      WS.forServer("runkit")!.emit("server-gone", {});
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The subscription was released and then re-issued: a fresh subscribe was
    // sent and the subscription is active again (so the server is NOT dead).
    const subscribesAfter = ws.sent.filter(
      (s) => s.includes('"op":"subscribe"') && s.includes('"key":"runkit"'),
    ).length;
    expect(subscribesAfter).toBeGreaterThan(subscribesBefore);
    expect(ws.active.has("server:runkit")).toBe(true);
    expect(WS.forServer("runkit")).toBeDefined();

    // And the slice re-populates on the next sessions event (UI recovers).
    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "B", windows: [] }]);
    });
    expect((result.current.sessionsByServer.get("runkit") ?? []).map((s) => s.name)).toEqual(["B"]);
    expect(result.current.isConnectedByServer.get("runkit")).toBe(true);
  });

  it("socket drop → 3s debounce flips isConnected false and re-queries listServers", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
      setMockMatches([{ params: { server: "runkit" } }]);
      const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // Ack the subscription so it is connected.
      act(() => { WS.forServer("runkit")!.emit("sessions", []); });
      expect(result.current.isConnectedByServer.get("runkit")).toBe(true);

      const callsBefore = vi.mocked(listServers).mock.calls.length;
      // Drop the socket into a genuine outage so the auto-reconnect stays
      // CONNECTING (never re-opens) and the disconnect debounce can fire.
      MockWebSocket.outage = true;
      act(() => { MockWebSocket.current!.close(); });
      // Before the 3s debounce elapses, still connected.
      expect(result.current.isConnectedByServer.get("runkit")).toBe(true);
      expect(vi.mocked(listServers).mock.calls.length).toBe(callsBefore);

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(result.current.isConnectedByServer.get("runkit")).toBe(false);
      expect(vi.mocked(listServers).mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the subscription + slice when a server disappears from /api/servers", async () => {
    vi.mocked(listServers).mockResolvedValueOnce([{ name: "runkit", sessionCount: 0 }, { name: "work", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    await act(async () => { result.current.attachServer("work"); });
    expect(WS.forServer("work")).toBeDefined();

    vi.mocked(listServers).mockResolvedValueOnce([{ name: "runkit", sessionCount: 0 }]);
    await act(async () => {
      result.current.refreshServers();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.sessionsByServer.has("work")).toBe(false);
    expect(result.current.isConnectedByServer.has("work")).toBe(false);
  });

  it("sorts fetched servers infra-last (daemon + test sockets after regular)", async () => {
    vi.mocked(listServers).mockResolvedValue([
      { name: "alpha", sessionCount: 0 },
      { name: "rk-daemon", sessionCount: 0 },
      { name: "rk-test-e2e", sessionCount: 0 },
      { name: "zeta", sessionCount: 0 },
    ]);
    setMockMatches([{ params: { server: "alpha" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    expect(result.current.servers.map((s) => s.name)).toEqual([
      "alpha",
      "zeta",
      "rk-daemon",
      "rk-test-e2e",
    ]);
  });
});

describe("SessionProvider — currentServer follows route", () => {
  it("derives currentServer from the matched route's server param", async () => {
    setMockMatches([{ params: { server: "alpha" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    expect(result.current.currentServer).toBe("alpha");
  });

  it("returns null when no matched route has a server param", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    expect(result.current.currentServer).toBe(null);
  });
});

describe("SessionProvider — pendingServer marker", () => {
  it("markServerPending sets pendingServer; appearing in the refreshed list clears it", async () => {
    vi.mocked(listServers).mockResolvedValueOnce([]);
    setMockMatches([{ params: { server: "newsrv" } }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    expect(result.current.pendingServer).toBe(null);

    act(() => { result.current.markServerPending("newsrv"); });
    expect(result.current.pendingServer).toBe("newsrv");

    vi.mocked(listServers).mockResolvedValueOnce([{ name: "newsrv", sessionCount: 0 }]);
    await act(async () => {
      result.current.refreshServers();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.servers.some((s) => s.name === "newsrv")).toBe(true);
    expect(result.current.pendingServer).toBe(null);
  });

  it("markServerPending('') clears the marker (failed-create rollback path)", async () => {
    vi.mocked(listServers).mockResolvedValue([]);
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => { result.current.markServerPending("ghost"); });
    expect(result.current.pendingServer).toBe("ghost");

    act(() => { result.current.markServerPending(""); });
    expect(result.current.pendingServer).toBe(null);
  });
});

describe("SessionProvider — serversLoaded flag", () => {
  it("flips false → true after the first fetch resolves (even to an empty list)", async () => {
    vi.mocked(listServers).mockResolvedValue([]);
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });

    expect(result.current.serversLoaded).toBe(false);
    await settle();
    expect(result.current.serversLoaded).toBe(true);
    expect(result.current.servers).toEqual([]);
  });
});

describe("SessionProvider — server-independent host metrics", () => {
  it("subscribes to metrics on / with no currentServer", async () => {
    setMockMatches([{ params: {} }]);
    renderHook(() => useHostMetrics(), { wrapper: Wrapper });
    await settle();

    // The metrics subscription is open with zero servers attached.
    expect(WS.forHostMetrics()).toBeDefined();
  });

  it("useHostMetrics() returns the broadcast snapshot; useMetrics() stays null on /", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(
      () => ({ host: useHostMetrics(), current: useMetrics() }),
      { wrapper: Wrapper },
    );
    await settle();

    expect(result.current.host).toBeNull();
    expect(result.current.current).toBeNull();

    act(() => {
      WS.forHostMetrics()!.emit("metrics", FAKE_METRICS);
    });

    expect(result.current.host?.hostname).toBe("test-box");
    expect(result.current.host?.cpu.current).toBe(42);
    expect(result.current.current).toBeNull();
  });

  it("does not open a metrics subscription while a server is attached; host metrics come from the per-server fan-out", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useHostMetrics(), { wrapper: Wrapper });
    await settle();

    // With a server attached, the metrics subscription is redundant and NOT open.
    expect(WS.forHostMetrics()).toBeUndefined();
    expect(WS.forServer("runkit")).toBeDefined();

    // Host metrics still flow — as a host-global event over the socket.
    act(() => {
      WS.global()!.emit("metrics", FAKE_METRICS);
    });
    expect(result.current?.hostname).toBe("test-box");
  });

  it("dedupes identical host-metrics payloads (idempotent on the raw payload)", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    let hostRenders = 0;
    const host: { latest: MetricsSnapshot | null } = { latest: null };
    function HostProbe() {
      hostRenders += 1;
      host.latest = useHostMetrics();
      return null;
    }
    // Per-server slice probe: useMetrics() reads the current server's slice,
    // which the host-global metrics event fans out into.
    let sliceRenders = 0;
    const slice: { latest: MetricsSnapshot | null } = { latest: null };
    function SliceProbe() {
      sliceRenders += 1;
      slice.latest = useMetrics();
      return null;
    }
    renderHook(() => useSessionContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Wrapper>
          <HostProbe />
          <SliceProbe />
          {children}
        </Wrapper>
      ),
    });
    await settle();

    act(() => { WS.global()!.emit("metrics", FAKE_METRICS); });
    expect(host.latest?.hostname).toBe("test-box");
    expect(slice.latest?.hostname).toBe("test-box");
    const rendersAfterFirst = hostRenders;
    const sliceRendersAfterFirst = sliceRenders;

    // The SAME payload again — deduped on the raw string: no extra render,
    // and the per-server slice fan-out is skipped too (it would re-render the
    // whole tree on identical data).
    act(() => { WS.global()!.emit("metrics", FAKE_METRICS); });
    expect(hostRenders).toBe(rendersAfterFirst);
    expect(sliceRenders).toBe(sliceRendersAfterFirst);
    expect(host.latest?.hostname).toBe("test-box");
    expect(slice.latest?.hostname).toBe("test-box");

    // A genuinely different payload DOES update — both the host snapshot and
    // the per-server slice.
    act(() => { WS.global()!.emit("metrics", { ...FAKE_METRICS, hostname: "other-box" }); });
    expect(host.latest?.hostname).toBe("other-box");
    expect(slice.latest?.hostname).toBe("other-box");
    expect(hostRenders).toBeGreaterThan(rendersAfterFirst);
    expect(sliceRenders).toBeGreaterThan(sliceRendersAfterFirst);
  });

  it("seeds a server attached after the last metrics frame from the retained host snapshot", async () => {
    // On `/` the cached metrics replay lands before any server is attached.
    // The hub suppresses identical `metrics` frames, so the later server
    // subscription must be seeded from the retained snapshot — its ack carries
    // only sessions and no metrics event follows until the host snapshot moves.
    vi.mocked(listServers).mockResolvedValue([{ name: "work", sessionCount: 0 }]);
    setMockMatches([]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => { WS.forHostMetrics()!.emit("metrics", FAKE_METRICS); });
    expect(result.current.metricsByServer.get("work")).toBeUndefined();

    await act(async () => {
      result.current.attachServer("work");
    });
    act(() => { WS.forServer("work")!.emit("sessions", []); });

    expect(result.current.metricsByServer.get("work")?.hostname).toBe("test-box");
  });

  it("opens the metrics subscription on / then drops it once a server attaches", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    expect(WS.forHostMetrics()).toBeDefined();

    await act(async () => { result.current.attachServer("runkit"); });
    // Metrics subscription released; per-server fan-out takes over.
    expect(WS.forServer("runkit")).toBeDefined();
    // The most recent op should include an unsubscribe of metrics.
    const ws = MockWebSocket.current!;
    expect(ws.sent.some((s) => s.includes('"op":"unsubscribe"') && s.includes('"kind":"metrics"'))).toBe(true);
  });
});

describe("SessionProvider — StrictMode double-mount re-subscribes on the new socket", () => {
  // <StrictMode> intentionally mounts → unmounts → remounts the provider (dev +
  // e2e run under it). The socket-construction effect destroys+recreates the
  // StateSocket across that remount; the subscription guard refs must reset in
  // its cleanup so the metrics/diff effects re-subscribe on the NEW socket. The
  // pre-fix bug: the guards survived the remount and the effects saw them already
  // true, so the metrics subscription was NEVER opened on the live socket —
  // permanently dead host metrics / poll loop on `/`.
  //
  // NOTE: this uses render(<StrictMode>…) with a context-capturing probe, NOT
  // renderHook({ wrapper: <StrictMode> }). Testing Library's renderHook does NOT
  // simulate the StrictMode mount→unmount→remount for a wrapper — only a direct
  // render() of a <StrictMode> root double-invokes the effects (verified). The
  // probe writes the live context into `captured` on every render.

  it("re-establishes the metrics subscription on the live socket after remount (/ host case)", async () => {
    setMockMatches([{ params: {} }]); // `/` — no server, metrics subscription is the source
    const captured: {
      ctx: ReturnType<typeof useSessionContext> | null;
      host: MetricsSnapshot | null;
    } = { ctx: null, host: null };
    function Probe() {
      captured.ctx = useSessionContext();
      captured.host = useHostMetrics();
      return null;
    }
    render(
      <StrictMode>
        <ChromeProvider>
          <SessionProvider>
            <Probe />
          </SessionProvider>
        </ChromeProvider>
      </StrictMode>,
    );
    await settle();

    // StrictMode double-mounted: more than one socket was constructed, but the
    // CURRENT (live) one must carry the metrics subscription. Pre-fix this failed
    // (the guard ref survived the remount and blocked re-subscription): the live
    // socket's `active` set never gained "metrics".
    expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    const live = MockWebSocket.current!;
    expect(live.readyState).not.toBe(MockWebSocket.CLOSED);
    expect(live.active.has("metrics")).toBe(true);
    expect(WS.forHostMetrics()).toBeDefined();

    // And it functions end-to-end: a metrics event on the live socket reaches
    // the useHostMetrics() consumer seam.
    expect(captured.host).toBeNull();
    act(() => {
      WS.forHostMetrics()!.emit("metrics", FAKE_METRICS);
    });
    expect(captured.host).toEqual(FAKE_METRICS);
  });

  it("re-subscribes the current server on the live socket after remount", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const captured: { ctx: ReturnType<typeof useSessionContext> | null } = { ctx: null };
    function Probe() {
      captured.ctx = useSessionContext();
      return null;
    }
    render(
      <StrictMode>
        <ChromeProvider>
          <SessionProvider>
            <Probe />
          </SessionProvider>
        </ChromeProvider>
      </StrictMode>,
    );
    await settle();

    const live = MockWebSocket.current!;
    expect(live.readyState).not.toBe(MockWebSocket.CLOSED);
    // The server subscription rode the remount onto the live socket.
    expect(live.active.has("server:runkit")).toBe(true);
    expect(WS.forServer("runkit")).toBeDefined();

    act(() => {
      WS.forServer("runkit")!.emit("sessions", [{ name: "A", windows: [] }]);
    });
    expect((captured.ctx!.sessionsByServer.get("runkit") ?? []).map((s) => s.name)).toEqual(["A"]);
    expect(captured.ctx!.isConnectedByServer.get("runkit")).toBe(true);
  });
});

describe("SessionProvider — server-independent host services", () => {
  const FAKE_SERVICES = { services: [{ port: 5173 }, { port: 8080, process: "api" }] };

  it("returns [] before the first services tick", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useHostServices(), { wrapper: Wrapper });
    await settle();
    expect(result.current).toEqual([]);
  });

  it("populates from the metrics subscription on /", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useHostServices(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("services", FAKE_SERVICES);
    });

    expect(result.current.map((s) => s.port)).toEqual([5173, 8080]);
    expect(result.current[1].process).toBe("api");
  });

  it("populates from the per-server fan-out when a server is attached", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    const { result } = renderHook(() => useHostServices(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.global()!.emit("services", FAKE_SERVICES);
    });

    expect(result.current.map((s) => s.port)).toEqual([5173, 8080]);
  });

  it("dedupes identical services payloads", async () => {
    vi.mocked(listServers).mockResolvedValue([{ name: "runkit", sessionCount: 0 }]);
    setMockMatches([{ params: { server: "runkit" } }]);
    let renders = 0;
    let latest: ReturnType<typeof useHostServices> = [];
    function Probe() {
      renders += 1;
      latest = useHostServices();
      return null;
    }
    renderHook(() => useSessionContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Wrapper>
          <Probe />
          {children}
        </Wrapper>
      ),
    });
    await settle();

    act(() => { WS.global()!.emit("services", FAKE_SERVICES); });
    expect(latest.map((s) => s.port)).toEqual([5173, 8080]);
    const rendersAfterFirst = renders;

    act(() => { WS.global()!.emit("services", FAKE_SERVICES); });
    expect(renders).toBe(rendersAfterFirst);

    act(() => { WS.global()!.emit("services", { services: [{ port: 3000 }] }); });
    expect(latest.map((s) => s.port)).toEqual([3000]);
    expect(renders).toBeGreaterThan(rendersAfterFirst);
  });

  it("skips a malformed services event without throwing", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useHostServices(), { wrapper: Wrapper });
    await settle();

    act(() => {
      // Deliver a services event whose data is not a services object; the
      // provider's tolerant guard treats a missing services array as [].
      MockWebSocket.current!.onmessage?.({
        data: '{"op":"event","kind":"global","type":"services","data":{"nope":true}}',
      } as MessageEvent);
    });

    expect(result.current).toEqual([]);
  });
});

describe("SessionProvider — code-server signal (260811-k3vp; portless payload since 260811-a2bo)", () => {
  it("returns null before the first code-server event", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useCodeServer(), { wrapper: Wrapper });
    await settle();
    expect(result.current).toBeNull();
  });

  it("populates reachable from the global event", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useCodeServer(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("code-server", { reachable: true });
    });
    expect(result.current).toEqual({ reachable: true });

    // A reachability flip is a new payload — it lands.
    act(() => {
      WS.forHostMetrics()!.emit("code-server", { reachable: false });
    });
    expect(result.current).toEqual({ reachable: false });
  });

  it("treats a missing reachable field as not-running", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useCodeServer(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("code-server", { nope: true });
    });
    expect(result.current).toEqual({ reachable: false });
  });
});

describe("SessionProvider — gui signal (the host-global `gui` event list)", () => {
  const GUI_ON = [
    {
      id: "host",
      enabled: true,
      backend: "Xtigervnc",
      reachable: true,
      display: ":10",
      width: 1920,
      height: 1080,
      viewers: 1,
      wm: "icewm-session",
      locked: false,
      geometry: "1600x900",
    },
  ];

  it("returns null before the first gui event (reads as disabled)", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();
    expect(result.current).toBeNull();
  });

  it("narrows the list payload to the id:\"host\" entry", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("gui", [
        { id: "other", enabled: false },
        ...GUI_ON,
      ]);
    });
    expect(result.current).toEqual(GUI_ON[0]);
  });

  it("falls back to the first entry when no id:\"host\" exists", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ id: "only", enabled: true }]);
    });
    expect(result.current).toEqual({
      id: "only",
      enabled: true,
      backend: "",
      reachable: false,
      display: "",
      width: 0,
      height: 0,
      viewers: 0,
      wm: "",
      locked: false,
      geometry: "",
    });
  });

  it("dedupes identical raw payloads (no consumer re-render)", async () => {
    setMockMatches([{ params: {} }]);
    let renders = 0;
    // Boxed so TS control flow does not narrow the closure-assigned value.
    const latest: { current: GuiSignal | null } = { current: null };
    function Probe() {
      renders += 1;
      latest.current = useGui();
      return null;
    }
    renderHook(() => useSessionContext(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <Wrapper>
          <Probe />
          {children}
        </Wrapper>
      ),
    });
    await settle();

    act(() => { WS.forHostMetrics()!.emit("gui", GUI_ON); });
    expect(latest.current).toEqual(GUI_ON[0]);
    const rendersAfterFirst = renders;

    act(() => { WS.forHostMetrics()!.emit("gui", GUI_ON); });
    expect(renders).toBe(rendersAfterFirst);

    act(() => { WS.forHostMetrics()!.emit("gui", [{ ...GUI_ON[0], viewers: 2 }]); });
    expect(latest.current?.viewers).toBe(2);
    expect(renders).toBeGreaterThan(rendersAfterFirst);
  });

  it("narrows a malformed payload to safe defaults and never throws", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.forHostMetrics()!.emit("gui", { not: "a list" });
    });
    expect(result.current).toBeNull();

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ enabled: "yes", width: "wide", viewers: null }]);
    });
    expect(result.current).toEqual({
      id: "",
      enabled: false,
      backend: "",
      reachable: false,
      display: "",
      width: 0,
      height: 0,
      viewers: 0,
      wm: "",
      locked: false,
      geometry: "",
    });
  });

  it("wm passes through as a string and narrows to \"\" when absent or non-string", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();

    act(() => { WS.forHostMetrics()!.emit("gui", GUI_ON); });
    expect(result.current?.wm).toBe("icewm-session");

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ id: "host", enabled: true }]);
    });
    expect(result.current?.wm).toBe("");

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ id: "host", enabled: true, wm: 42 }]);
    });
    expect(result.current?.wm).toBe("");
  });

  it("geometry passes through as a string and narrows to \"\" when absent or non-string", async () => {
    setMockMatches([{ params: {} }]);
    const { result } = renderHook(() => useGui(), { wrapper: Wrapper });
    await settle();

    act(() => { WS.forHostMetrics()!.emit("gui", GUI_ON); });
    expect(result.current?.geometry).toBe("1600x900");

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ id: "host", enabled: true }]);
    });
    expect(result.current?.geometry).toBe("");

    act(() => {
      WS.forHostMetrics()!.emit("gui", [{ id: "host", enabled: true, geometry: 42 }]);
    });
    expect(result.current?.geometry).toBe("");
  });
});

describe("StandaloneSessionContextProvider — pending-server fallbacks", () => {
  it("supplies safe no-op/default values for the new fields", () => {
    function Probe() {
      const ctx = useSessionContext();
      ctx.markServerPending("x");
      return (
        <div>
          <span data-testid="pending">{String(ctx.pendingServer)}</span>
          <span data-testid="loaded">{String(ctx.serversLoaded)}</span>
        </div>
      );
    }
    render(
      <StandaloneSessionContextProvider value={{}}>
        <Probe />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getByTestId("pending").textContent).toBe("null");
    expect(screen.getByTestId("loaded").textContent).toBe("false");
  });
});

describe("StandaloneSessionContextProvider — sessionsReceived default", () => {
  it("defaults sessionsReceivedByServer to true for every supplied sessionsByServer key", () => {
    function Probe() {
      const ctx = useSessionContext();
      return (
        <span data-testid="received">
          {String(ctx.sessionsReceivedByServer.get("runkit"))}/{String(ctx.sessionsReceivedByServer.get("other"))}
        </span>
      );
    }
    render(
      <StandaloneSessionContextProvider value={{ sessionsByServer: new Map([["runkit", []]]) }}>
        <Probe />
      </StandaloneSessionContextProvider>,
    );
    expect(screen.getByTestId("received").textContent).toBe("true/undefined");
  });
});

describe("shouldReloadOnVersion — boot-aware reload guard", () => {
  it("never reloads on the first connect (first-seen unset), regardless of boot", () => {
    expect(shouldReloadOnVersion(null, null, "0.5.3", "b1")).toBe(false);
    expect(shouldReloadOnVersion(null, "b0", "0.5.3", "b1")).toBe(false);
  });

  it("does not reload when both version and boot are unchanged", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.5.3", "b1")).toBe(false);
  });

  it("reloads when the version changes (regression), even if boot is unchanged", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.6.0", "b1")).toBe(true);
  });

  it("reloads on a same-version boot change (plain daemon restart)", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.5.3", "b2")).toBe(true);
  });

  it("suppresses the boot-based reload on the dev version (air recompile storm guard)", () => {
    expect(shouldReloadOnVersion("dev", "b1", "dev", "b2")).toBe(false);
  });

  it("tolerates a boot-less payload (older daemon): a null next boot never reloads at the same version", () => {
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.5.3", null)).toBe(false);
    expect(shouldReloadOnVersion("0.5.3", "b1", "0.6.0", null)).toBe(true);
  });

  it("tolerates a null first boot (first payload was boot-less), reloading when a boot later appears", () => {
    expect(shouldReloadOnVersion("0.5.3", null, "0.5.3", "b2")).toBe(true);
  });
});

describe("SessionProvider — version-slot started/port fields", () => {
  it("parses started/port from a new-daemon version payload", async () => {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.global()?.emit("version", { version: "0.6.0", boot: "b1", brew: false, started: 1700000000, port: 3000 });
    });

    expect(result.current.daemonVersion).toBe("0.6.0");
    expect(result.current.daemonStarted).toBe(1700000000);
    expect(result.current.daemonPort).toBe(3000);
  });

  it("yields null daemonStarted/daemonPort on an older daemon's field-less payload (no throw, no NaN/0)", async () => {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.global()?.emit("version", { version: "0.5.3", boot: "b1", brew: true });
    });

    expect(result.current.daemonVersion).toBe("0.5.3");
    expect(result.current.daemonStarted).toBeNull();
    expect(result.current.daemonPort).toBeNull();
  });

  it("yields null for malformed field values (non-finite numbers)", async () => {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();

    act(() => {
      WS.global()?.emit("version", { version: "0.6.0", boot: "b1", brew: false, started: "soon", port: NaN });
    });

    expect(result.current.daemonStarted).toBeNull();
    expect(result.current.daemonPort).toBeNull();
  });
});

describe("SessionProvider — tab-local manual-check feed (260807-s6zs)", () => {
  const runKitRow = { tool: "run-kit", current: "3.8.7", latest: "3.9.1" };
  const tuRow = { tool: "tu", current: "0.9.1", latest: "0.9.2" };

  // A manual result is stored by useUpdateCheck after a check resolves; here we
  // drive the seam directly (the hook's own wiring is covered in
  // use-update-check.test.tsx).
  async function renderWithManual() {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    return result;
  }

  it("holds no manual result until one is applied", async () => {
    const result = await renderWithManual();
    expect(result.current.manualCheck).toBeNull();
  });

  it("stores the applied tool set + echoed source", async () => {
    const result = await renderWithManual();
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    expect(result.current.manualCheck).toEqual({ tools: [runKitRow], source: "github" });
  });

  it("supersedes a held result with a newer one", async () => {
    const result = await renderWithManual();
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    await act(async () => {
      result.current.applyManualCheckResult([tuRow], "released");
    });
    expect(result.current.manualCheck).toEqual({ tools: [tuRow], source: "released" });
  });

  it("CLEARS the held result when a fresh check reports nothing updatable", async () => {
    const result = await renderWithManual();
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    await act(async () => {
      result.current.applyManualCheckResult([], "github");
    });
    expect(result.current.manualCheck).toBeNull();
  });

  it("never persists the manual result (tab-local by design)", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const result = await renderWithManual();
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    expect(
      setItem.mock.calls.some(([k]) => typeof k === "string" && k.includes("manual")),
    ).toBe(false);
    // The only update-related key the surface writes is the shared dismissal one,
    // and dismissal was not invoked here.
    expect(setItem).not.toHaveBeenCalledWith("hexokit-update-dismissed", expect.anything());
    setItem.mockRestore();
  });

  it("clears the manual result when the AMBIENT composite key changes (update consumed)", async () => {
    const result = await renderWithManual();
    // An ambient verdict is live when the manual check runs.
    await act(async () => {
      WS.global()?.emit("update-available", {
        tools: [{ tool: "run-kit", current: "3.8.0", latest: "3.9.0" }],
        key: "run-kit@3.9.0",
        current: "3.8.0",
        latest: "3.9.0",
      });
    });
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    expect(result.current.manualCheck).not.toBeNull();

    // The ambient feed moves on — the manual snapshot is superseded.
    await act(async () => {
      WS.global()?.emit("update-available", {
        tools: [],
        key: "",
        current: "",
        latest: "",
      });
    });
    expect(result.current.manualCheck).toBeNull();
  });

  it("RETAINS the manual result while the ambient key is unchanged (idempotent replay)", async () => {
    const result = await renderWithManual();
    const ambient = {
      tools: [{ tool: "run-kit", current: "3.8.0", latest: "3.9.0" }],
      key: "run-kit@3.9.0",
      current: "3.8.0",
      latest: "3.9.0",
    };
    await act(async () => {
      WS.global()?.emit("update-available", ambient);
    });
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    // A reconnect replays the cached slot — same key, so nothing is consumed.
    await act(async () => {
      WS.global()?.emit("update-available", ambient);
    });
    expect(result.current.manualCheck).toEqual({ tools: [runKitRow], source: "github" });
  });

  it("retains the manual result when NO ambient verdict ever arrives", async () => {
    const result = await renderWithManual();
    await act(async () => {
      result.current.applyManualCheckResult([runKitRow], "github");
    });
    await settle();
    expect(result.current.manualCheck).toEqual({ tools: [runKitRow], source: "github" });
  });
});

describe("SessionProvider — notify event seam", () => {
  it("forwards global notify payloads to registered consumers and unregisters cleanly", async () => {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    const received: unknown[] = [];
    const unsubscribe = result.current.subscribeNotify((payload) => received.push(payload));

    const payload = { id: "event-1", title: "RunKit", body: "waiting" };
    await act(async () => {
      WS.global()?.emit("notify", payload);
    });
    expect(received).toEqual([payload]);

    unsubscribe();
    await act(async () => {
      WS.global()?.emit("notify", { id: "event-2" });
    });
    expect(received).toEqual([payload]);
  });

  it("drops non-object notify payloads (arrays, primitives, null) before they reach consumers", async () => {
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    const received: unknown[] = [];
    const unsubscribe = result.current.subscribeNotify((payload) => received.push(payload));

    await act(async () => {
      WS.global()?.emit("notify", [{ id: "array-1" }]);
      WS.global()?.emit("notify", "a string");
      WS.global()?.emit("notify", null);
    });
    expect(received).toEqual([]);

    const payload = { id: "event-3", body: "ok" };
    await act(async () => {
      WS.global()?.emit("notify", payload);
    });
    expect(received).toEqual([payload]);
    unsubscribe();
  });
});

describe("deriveUpdateFeed — ambient-first two-feed merge (260807-s6zs)", () => {
  const ambient = [{ tool: "run-kit", current: "3.8.0", latest: "3.9.0" }];
  const manual = [{ tool: "tu", current: "0.9.1", latest: "0.9.2" }];

  it("surfaces the ambient feed when it shows, even with a manual result held", () => {
    expect(deriveUpdateFeed(ambient, "run-kit@3.9.0", manual, "tu@0.9.2", false, null)).toEqual({
      tools: ambient,
      key: "run-kit@3.9.0",
      manualOnly: false,
    });
  });

  it("falls back to the manual feed when the ambient feed has nothing", () => {
    expect(deriveUpdateFeed([], null, manual, "tu@0.9.2", false, null)).toEqual({
      tools: manual,
      key: "tu@0.9.2",
      manualOnly: true,
    });
  });

  it("falls back to the manual feed when the ambient key is DISMISSED", () => {
    expect(
      deriveUpdateFeed(ambient, "run-kit@3.9.0", manual, "tu@0.9.2", false, "run-kit@3.9.0"),
    ).toEqual({ tools: manual, key: "tu@0.9.2", manualOnly: true });
  });

  it("falls back to the manual feed on a dev daemon (the caller's !isDev gate still hides it)", () => {
    // The dev sentinel stops the AMBIENT feed from showing; the manual feed is
    // then selected, but the hook's own `qualifies = !isDev && …` gate keeps the
    // chip dark — the dev suppression is not re-implemented here.
    expect(deriveUpdateFeed(ambient, "run-kit@3.9.0", manual, "tu@0.9.2", true, null)).toEqual({
      tools: manual,
      key: "tu@0.9.2",
      manualOnly: true,
    });
  });

  it("returns the ambient (empty) shape when neither feed has anything", () => {
    const empty: never[] = [];
    const feed = deriveUpdateFeed(empty, null, [], null, false, null);
    expect(feed).toEqual({ tools: empty, key: null, manualOnly: false });
    // Identity is preserved so a no-update render keeps the frozen EMPTY_TOOLS.
    expect(feed.tools).toBe(empty);
  });
});

describe("SessionProvider — dismissUpdate writes the EFFECTIVE key (260807-s6zs)", () => {
  it("writes the client-computed MANUAL key when the manual feed is the lit one", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    await act(async () => {
      result.current.applyManualCheckResult(
        [{ tool: "run-kit", current: "3.8.7", latest: "3.9.1" }],
        "github",
      );
    });
    await act(async () => {
      result.current.dismissUpdate();
    });
    expect(setItem).toHaveBeenCalledWith("hexokit-update-dismissed", "run-kit@3.9.1");
    expect(result.current.updateDismissedKey).toBe("run-kit@3.9.1");
    setItem.mockRestore();
  });

  it("still writes the AMBIENT key when the ambient feed is the lit one", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    await act(async () => {
      WS.global()?.emit("update-available", {
        tools: [{ tool: "run-kit", current: "3.8.0", latest: "3.9.0" }],
        key: "run-kit@3.9.0",
        current: "3.8.0",
        latest: "3.9.0",
      });
    });
    await act(async () => {
      result.current.applyManualCheckResult(
        [{ tool: "tu", current: "0.9.1", latest: "0.9.2" }],
        "github",
      );
    });
    await act(async () => {
      result.current.dismissUpdate();
    });
    expect(setItem).toHaveBeenCalledWith("hexokit-update-dismissed", "run-kit@3.9.0");
    setItem.mockRestore();
  });

  it("is a no-op when neither feed has anything to dismiss", async () => {
    // The dismissal key is localStorage-backed and read lazily on mount, so a
    // prior test's write would otherwise seed this provider.
    localStorage.removeItem("hexokit-update-dismissed");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useSessionContext(), { wrapper: Wrapper });
    await settle();
    await act(async () => {
      result.current.dismissUpdate();
    });
    expect(setItem).not.toHaveBeenCalledWith("hexokit-update-dismissed", expect.anything());
    expect(result.current.updateDismissedKey).toBeNull();
    setItem.mockRestore();
  });
});
