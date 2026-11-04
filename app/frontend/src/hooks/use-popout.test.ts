import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePoppedSet, usePopoutPresence } from "./use-popout";
import {
  POPOUT_CHANNEL,
  POPOUT_HEARTBEAT_MS,
  POPOUT_STALE_MS,
  poppedKey,
  type PopoutMessage,
} from "@/lib/popout";

// Shell-bridge seam (lib/shell): the hooks read the popout and close
// invokers through it. The default posture is a plain browser (both gates
// false), keeping the window.open/window.close paths under test.
const shellMocks = vi.hoisted(() => ({
  canShellPopout: vi.fn(() => false),
  shellPopout: vi.fn((_route: string, _rect?: { w: number; h: number }) =>
    Promise.resolve(null as { windowId: number } | null),
  ),
  canCloseShellWindow: vi.fn(() => false),
  closeShellWindow: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@/lib/shell", () => shellMocks);

// Toast seam: capture popOut's failure toasts without a provider.
const addToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/toast", () => ({
  useOptionalToast: () => ({ addToast }),
}));

// An in-memory BroadcastChannel stand-in: one shared bus per channel name,
// message delivery to every OTHER open channel object (the real API excludes
// the sender), `close()` unsubscribing. Enough for the opener/popout
// coordination contract.
class FakeBroadcastChannel {
  static buses = new Map<string, Set<FakeBroadcastChannel>>();
  static reset() {
    FakeBroadcastChannel.buses = new Map();
  }
  private listeners = new Set<(e: { data: unknown }) => void>();
  private closed = false;
  constructor(private name: string) {
    const bus = FakeBroadcastChannel.buses.get(name) ?? new Set();
    bus.add(this);
    FakeBroadcastChannel.buses.set(name, bus);
  }
  addEventListener(_type: string, listener: (e: { data: unknown }) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (e: { data: unknown }) => void) {
    this.listeners.delete(listener);
  }
  postMessage(data: unknown) {
    if (this.closed) return;
    for (const peer of FakeBroadcastChannel.buses.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) {
        peer.listeners.forEach((l) => l({ data }));
      }
    }
  }
  close() {
    this.closed = true;
    FakeBroadcastChannel.buses.get(this.name)?.delete(this);
  }
}

const SERVER = "main";
const WINDOW = "@5";
const TREE = ["tty", "code"];

function postRaw(data: unknown) {
  // A message from outside both hooks (e.g. a second viewer's window).
  const bus = FakeBroadcastChannel.buses.get(POPOUT_CHANNEL);
  for (const peer of bus ?? []) {
    (peer as unknown as { listeners: Set<(e: { data: unknown }) => void> }).listeners.forEach(
      (l) => l({ data }),
    );
  }
}

function post(msg: PopoutMessage) {
  postRaw(msg);
}

beforeEach(() => {
  localStorage.clear();
  FakeBroadcastChannel.reset();
  vi.useFakeTimers();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  // jsdom's window.close() destroys the document — the popout's pop-in path
  // calls it, so stub it file-wide.
  vi.spyOn(window, "close").mockImplementation(() => {});
  shellMocks.canShellPopout.mockReturnValue(false);
  shellMocks.shellPopout.mockReset().mockResolvedValue(null);
  shellMocks.canCloseShellWindow.mockReturnValue(false);
  shellMocks.closeShellWindow.mockClear();
  addToast.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

describe("usePoppedSet", () => {
  it("reads persisted marks on mount and applies them immediately", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    expect(result.current.popped).toEqual(["code"]);
  });

  it("popOut marks optimistically and opens the named popup", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.popOut("code", { x: 0, y: 0, w: 640, h: 480 }));
    expect(result.current.popped).toEqual(["code"]);
    expect(readStoredMarks()).toEqual(["code"]);
    expect(openSpy).toHaveBeenCalledWith(
      "/main/5?pop=code",
      "rk-pop:main:@5:code",
      "popup,width=640,height=480",
    );
  });

  it("rolls the mark back when window.open is blocked (null)", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.popOut("code"));
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
  });

  it("popOut prefers the shell popout channel over window.open when the shell carries it", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    shellMocks.canShellPopout.mockReturnValue(true);
    shellMocks.shellPopout.mockResolvedValue({ windowId: 3 });
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.popOut("code", { x: 0, y: 0, w: 640, h: 480 }));
    expect(result.current.popped).toEqual(["code"]);
    expect(openSpy).not.toHaveBeenCalled();
    expect(shellMocks.shellPopout).toHaveBeenCalledWith("/main/5?pop=code", {
      x: 0,
      y: 0,
      w: 640,
      h: 480,
    });
    // A successful open leaves the optimistic mark in place.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.popped).toEqual(["code"]);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("rolls the mark back and toasts when the shell popout resolves null", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    shellMocks.canShellPopout.mockReturnValue(true);
    shellMocks.shellPopout.mockResolvedValue(null);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.popOut("code"));
    // The mark is optimistic: it applies before the async invoker resolves.
    expect(result.current.popped).toEqual(["code"]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
    expect(addToast).toHaveBeenCalledWith("Pop-out failed", "error");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("popIn clears the mark and posts pop-in on the channel", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.popIn("code"));
    expect(result.current.popped).toEqual([]);
    expect(
      spy.mock.calls.some(
        ([msg]) =>
          (msg as PopoutMessage).type === "pop-in" && (msg as PopoutMessage).leaf === "code",
      ),
    ).toBe(true);
  });

  it("focusPopout goes through the shell popout channel when the shell carries it", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);
    shellMocks.canShellPopout.mockReturnValue(true);
    shellMocks.shellPopout.mockResolvedValue({ windowId: 3 });
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.focusPopout("code"));
    expect(shellMocks.shellPopout).toHaveBeenCalledWith("/main/5?pop=code");
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("focusPopout opens the named popout by empty URL and focuses it, never navigating it", () => {
    const existing = {
      location: { href: "http://localhost/main/5?pop=code" },
      focus: vi.fn(),
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(existing as unknown as Window);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.focusPopout("code"));
    expect(openSpy).toHaveBeenCalledWith("", "rk-pop:main:@5:code");
    // The URL form would reload the live popout (re-attaching the terminal).
    expect(openSpy).not.toHaveBeenCalledWith(
      "/main/5?pop=code",
      expect.anything(),
      expect.anything(),
    );
    expect(existing.location.href).toBe("http://localhost/main/5?pop=code");
    expect(existing.focus).toHaveBeenCalledTimes(1);
  });

  it("focusPopout navigates an about:blank result to the popout URL (re-opening it)", () => {
    const blank = { location: { href: "about:blank" }, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(blank as unknown as Window);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.focusPopout("code"));
    expect(blank.location.href).toBe("/main/5?pop=code");
    expect(blank.focus).toHaveBeenCalledTimes(1);
  });

  it("focusPopout tolerates a blocked window.open (null)", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => result.current.focusPopout("code"));
    expect(result.current.popped).toEqual([]);
  });

  it("takes a mark a live popout announces (opened), refreshing last-seen", () => {
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => post({ type: "opened", server: SERVER, window: WINDOW, leaf: "code" }));
    expect(result.current.popped).toEqual(["code"]);
    // The mark survives the stale sweep while the popout heartbeats.
    act(() => {
      vi.advanceTimersByTime(POPOUT_STALE_MS - POPOUT_HEARTBEAT_MS);
    });
    expect(result.current.popped).toEqual(["code"]);
  });

  it("ignores an announced mark whose leaf is no longer in the tree", () => {
    // Another viewer removed the tile: the popout keeps announcing, but
    // adopting its mark would hide a tile later re-added under the same id.
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => post({ type: "opened", server: SERVER, window: WINDOW, leaf: "web" }));
    act(() => post({ type: "alive", server: SERVER, window: WINDOW, leaf: "web" }));
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
  });

  it("clears the mark when the popout posts closed", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => post({ type: "closed", server: SERVER, window: WINDOW, leaf: "code" }));
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
  });

  it("ignores messages naming another server or window", () => {
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    act(() => post({ type: "opened", server: "other", window: WINDOW, leaf: "code" }));
    act(() => post({ type: "opened", server: SERVER, window: "@9", leaf: "code" }));
    act(() => postRaw({ type: "opened", server: SERVER, window: WINDOW }));
    expect(result.current.popped).toEqual([]);
  });

  it("sweeps a mark whose popout goes silent past POPOUT_STALE_MS", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, true, TREE));
    // The mount-time seeding gives the mark one stale window; no ping reply
    // arrives (no popout mounted), so the sweep past the boundary drops it.
    act(() => {
      vi.advanceTimersByTime(POPOUT_STALE_MS + POPOUT_HEARTBEAT_MS);
    });
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
  });

  it("prunes a mark whose leaf left the shared tree", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    const { result, rerender } = renderHook(
      ({ ids }) => usePoppedSet(SERVER, WINDOW, true, ids),
      { initialProps: { ids: TREE } },
    );
    expect(result.current.popped).toEqual(["code"]);
    rerender({ ids: ["tty"] });
    expect(result.current.popped).toEqual([]);
    expect(readStoredMarks()).toEqual([]);
  });

  it("is inert while disabled", () => {
    localStorage.setItem(poppedKey(SERVER, WINDOW), JSON.stringify(["code"]));
    const { result } = renderHook(() => usePoppedSet(SERVER, WINDOW, false, TREE));
    expect(result.current.popped).toEqual([]);
  });
});

describe("usePopoutPresence", () => {
  it("posts opened on mount and alive on the heartbeat", () => {
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    const types = () => spy.mock.calls.map(([m]) => (m as PopoutMessage).type);
    expect(types()).toContain("opened");
    act(() => {
      vi.advanceTimersByTime(POPOUT_HEARTBEAT_MS);
    });
    expect(types()).toContain("alive");
  });

  it("re-announces on an opener's ping", () => {
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => postRaw({ type: "ping", server: SERVER, window: WINDOW, leaf: "" }));
    expect(spy.mock.calls.map(([m]) => (m as PopoutMessage).type)).toEqual(["opened"]);
  });

  it("ignores a ping for another window", () => {
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => postRaw({ type: "ping", server: SERVER, window: "@9", leaf: "" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("closes on pop-in for its own leaf only", () => {
    const closeSpy = window.close as unknown as ReturnType<typeof vi.fn>;
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    act(() => postRaw({ type: "pop-in", server: SERVER, window: WINDOW, leaf: "tty" }));
    expect(closeSpy).not.toHaveBeenCalled();
    act(() => postRaw({ type: "pop-in", server: SERVER, window: WINDOW, leaf: "code" }));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("pop-in closes through the shell's close invoker after posting closed", () => {
    const closeSpy = window.close as unknown as ReturnType<typeof vi.fn>;
    shellMocks.canCloseShellWindow.mockReturnValue(true);
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => postRaw({ type: "pop-in", server: SERVER, window: WINDOW, leaf: "code" }));
    expect(spy.mock.calls.map(([m]) => (m as PopoutMessage).type)).toEqual(["closed"]);
    expect(shellMocks.closeShellWindow).toHaveBeenCalledTimes(1);
    // The sign-off lands before the close request.
    expect(spy.mock.invocationCallOrder[0]).toBeLessThan(
      shellMocks.closeShellWindow.mock.invocationCallOrder[0],
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("closeSelf posts closed before closing through the shell's close invoker", () => {
    const closeSpy = window.close as unknown as ReturnType<typeof vi.fn>;
    shellMocks.canCloseShellWindow.mockReturnValue(true);
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    const { result } = renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => result.current.closeSelf());
    expect(spy.mock.calls.map(([m]) => (m as PopoutMessage).type)).toEqual(["closed"]);
    expect(shellMocks.closeShellWindow).toHaveBeenCalledTimes(1);
    expect(spy.mock.invocationCallOrder[0]).toBeLessThan(
      shellMocks.closeShellWindow.mock.invocationCallOrder[0],
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("closeSelf falls back to window.close when the shell lacks the close invoker", () => {
    const closeSpy = window.close as unknown as ReturnType<typeof vi.fn>;
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    const { result } = renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => result.current.closeSelf());
    expect(spy.mock.calls.map(([m]) => (m as PopoutMessage).type)).toEqual(["closed"]);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(shellMocks.closeShellWindow).not.toHaveBeenCalled();
  });

  it("posts closed on pagehide", () => {
    const spy = vi.spyOn(FakeBroadcastChannel.prototype, "postMessage");
    renderHook(() => usePopoutPresence(SERVER, WINDOW, "code", true));
    spy.mockClear();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(spy.mock.calls.map(([m]) => (m as PopoutMessage).type)).toEqual(["closed"]);
  });
});

function readStoredMarks(): string[] {
  const raw = localStorage.getItem(poppedKey(SERVER, WINDOW));
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}
