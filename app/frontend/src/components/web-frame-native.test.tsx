import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from "vitest";
import { act, render, cleanup, screen } from "@testing-library/react";
import { TileDragContext, type TileDragPosture } from "@/lib/tile-drag-context";
import { _resetForTests, acquire } from "@/lib/overlay-presence";
import { WebFrameNative, WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES } from "./web-frame-native";
import type {
  FrameChromeState,
  WebFrameEngineHandle,
  WebFrameEngineProps,
} from "@/lib/web-frame-engine";

// The shell bridge is installed on window.runkitShell by hand (the preload's
// job in production): vi.fn() invokers resolve { ok: true }, onEvent captures
// the relay handler and returns a disposer spy. The default bridge lacks the
// additive `mode` invoker, so the engine reads the host's web mode as
// `legacy`; mode tests install a bridge carrying their own `mode`. The mount
// effect awaits that query before creating the guest, so create assertions go
// through flushMount. ResizeObserver and requestAnimationFrame are stubbed
// controllable — the observer callback is fired manually, frames are pumped
// manually — and the placeholder's rect is driven through a stubbed
// getBoundingClientRect.

type RelayHandler = (payload: unknown) => void;

const bridge = vi.hoisted(() => ({
  create: vi.fn((_tabKey: string, _url: string, _identity?: string) =>
    Promise.resolve({ ok: true })),
  destroy: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  bounds: vi.fn((_tabKey: string, _x: number, _y: number, _w: number, _h: number) =>
    Promise.resolve({ ok: true }),
  ),
  visible: vi.fn((_tabKey: string, _visible: boolean) => Promise.resolve({ ok: true })),
  load: vi.fn((_tabKey: string, _url: string) => Promise.resolve({ ok: true })),
  reload: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  back: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  forward: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  find: vi.fn((_tabKey: string, _text: string, _forward: boolean, _findNext: boolean) =>
    Promise.resolve({ ok: true }),
  ),
  stopFind: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  zoom: vi.fn((_tabKey: string, _factor: number) => Promise.resolve({ ok: true })),
  chords: vi.fn((_tabKey: string, _chords: unknown) => Promise.resolve({ ok: true })),
  devtools: vi.fn((_tabKey: string) => Promise.resolve({ ok: true })),
  onEvent: vi.fn((_handler: RelayHandler) => () => {}),
}));

// The additive `park` invoker (guest retention) — NOT on the default bridge,
// so the default install reads as an older shell whose unmount path is
// destroy; retention tests opt in through installParkBridge (the mode
// precedent).
const parkFn = vi.hoisted(() => vi.fn((_tabKey: string) => Promise.resolve({ ok: true })));

let relayHandler: RelayHandler | null = null;
let relayDisposer: Mock<() => void>;

let currentRect = { x: 10, y: 20, width: 800, height: 600 };

function setRect(rect: { x: number; y: number; width: number; height: number }) {
  currentRect = rect;
}

let roCallbacks: ResizeObserverCallback[] = [];

function fireResize() {
  act(() => {
    for (const cb of roCallbacks) cb([], {} as ResizeObserver);
  });
}

let rafQueue: FrameRequestCallback[] = [];

function pumpFrames(n: number) {
  for (let i = 0; i < n; i++) {
    const queued = rafQueue;
    rafQueue = [];
    act(() => {
      for (const cb of queued) cb(0);
    });
  }
}

function deliver(payload: unknown) {
  act(() => {
    relayHandler?.(payload);
  });
}

/** Flush the mount effect's async mode-query → create chain (the effect
 *  awaits shellWebMode before creating the guest). A macrotask turn drains
 *  every pending microtask continuation. */
async function flushMount() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Install the shell bridge with an additive `mode` invoker resolving the
 *  given result (or rejecting when given a function returning a rejected
 *  promise). */
function installModeBridge(mode: () => Promise<unknown>) {
  window.runkitShell = { version: "1.2.3", platform: "linux", web: { ...bridge, mode: vi.fn(mode) } };
}

/** Install the shell bridge with the additive `park` invoker — a shell new
 *  enough to retain guests across tile unmounts. */
function installParkBridge() {
  window.runkitShell = { version: "1.2.3", platform: "linux", web: { ...bridge, park: parkFn } };
}

interface Rig {
  url: string;
  tabKey: string;
  states: Map<string, FrameChromeState>;
  handles: Map<string, WebFrameEngineHandle>;
  onState: Mock<(url: string, state: FrameChromeState) => void>;
  onLoad: Mock<(url: string) => void>;
  interactRef: { current: (() => void) | undefined };
  reclaimRef: { current: ((e: KeyboardEvent) => boolean) | undefined };
}

/** Render the engine directly behind a recording harness (the
 *  web-frame-iframe.test.tsx pattern): the latest reported state per URL
 *  lands in `states`, the registered handle in `handles`. The handle
 *  registrars and callbacks are STABLE identities — the engine's mount
 *  effect keys on them, and a fresh closure per render would re-run it. */
function renderEngine({
  url = "/present/x/y/index.html",
  active = true,
  posture = "idle",
  zoom = 1,
  chordTable,
  onZoomStep,
  onInteract,
  retentionScope,
}: {
  url?: string;
  active?: boolean;
  posture?: TileDragPosture;
  zoom?: number;
  chordTable?: WebFrameEngineProps["chordTable"];
  onZoomStep?: (direction: "in" | "out") => void;
  onInteract?: () => void;
  retentionScope?: WebFrameEngineProps["retentionScope"];
} = {}) {
  const rig: Rig = {
    url,
    tabKey: "",
    states: new Map(),
    handles: new Map(),
    onState: vi.fn<(url: string, state: FrameChromeState) => void>(),
    onLoad: vi.fn<(url: string) => void>(),
    interactRef: { current: onInteract },
    reclaimRef: { current: undefined },
  };
  const onState = (u: string, s: FrameChromeState) => {
    rig.onState(u, s);
    rig.states.set(u, s);
  };
  const registerHandle = (u: string, h: WebFrameEngineHandle) => rig.handles.set(u, h);
  const unregisterHandle = (u: string) => rig.handles.delete(u);
  const element = (
    nextActive: boolean,
    drag: TileDragPosture,
    nextZoom: number = zoom,
    nextChordTable: WebFrameEngineProps["chordTable"] = chordTable,
  ) => (
    <TileDragContext.Provider value={drag}>
      <WebFrameNative
        url={url}
        active={nextActive}
        zoom={nextZoom}
        wireGestureListeners={() => () => {}}
        onState={onState}
        onLoad={rig.onLoad}
        registerHandle={registerHandle}
        unregisterHandle={unregisterHandle}
        interactRef={rig.interactRef}
        reclaimRef={rig.reclaimRef}
        onZoomStep={onZoomStep}
        chordTable={nextChordTable}
        retentionScope={retentionScope}
      />
    </TileDragContext.Provider>
  );
  const view = render(element(active, posture));
  rig.tabKey = screen.getByTestId("web-native-placeholder").dataset.tabKey ?? "";
  // Rerenders are cumulative: an omitted prop keeps its last value, so a
  // bare rerender is a true no-op (the identity-change rules are assertable).
  let curActive = active;
  let curPosture = posture;
  let curZoom = zoom;
  let curChordTable = chordTable;
  return {
    ...view,
    rig,
    rerenderEngine: (
      overrides: {
        active?: boolean;
        posture?: TileDragPosture;
        zoom?: number;
        chordTable?: WebFrameEngineProps["chordTable"];
      } = {},
    ) => {
      if (overrides.active !== undefined) curActive = overrides.active;
      if (overrides.posture !== undefined) curPosture = overrides.posture;
      if (overrides.zoom !== undefined) curZoom = overrides.zoom;
      if ("chordTable" in overrides) curChordTable = overrides.chordTable;
      view.rerender(element(curActive, curPosture, curZoom, curChordTable));
    },
  };
}

beforeEach(() => {
  _resetForTests();
  relayHandler = null;
  relayDisposer = vi.fn();
  bridge.onEvent.mockImplementation((handler: RelayHandler) => {
    relayHandler = handler;
    return relayDisposer;
  });
  window.runkitShell = { version: "1.2.3", platform: "linux", web: bridge };
  setRect({ x: 10, y: 20, width: 800, height: 600 });
  roCallbacks = [];
  class MockResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      roCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue[id - 1] = () => {};
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => currentRect as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  delete window.runkitShell;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("WebFrameNative lifecycle", () => {
  it("subscribes before creating, and create receives the host-absolute URL for a relative present address", async () => {
    const { rig } = renderEngine({ url: "/present/x/y/index.html" });
    expect(bridge.onEvent).toHaveBeenCalledTimes(1);
    await flushMount();
    expect(bridge.create).toHaveBeenCalledTimes(1);
    expect(bridge.onEvent.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.create.mock.invocationCallOrder[0],
    );
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/present/x/y/index.html`,
      undefined,
    );
  });

  it("creates with the host-absolute proxy path for a loopback address (a mode-less shell reads as legacy)", async () => {
    const { rig } = renderEngine({ url: "http://localhost:8080/docs" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/proxy/8080/docs`,
      undefined,
    );
  });

  it("creates with an external URL unchanged", async () => {
    const { rig } = renderEngine({ url: "https://github.com/x" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(rig.tabKey, "https://github.com/x", undefined);
  });

  it("passes a stored address the URL constructor rejects to create raw, without throwing", async () => {
    // An unclosed IPv6 literal fails `new URL(...)` even against a base; the
    // engine must still mount and hand the shell the raw address.
    const { rig } = renderEngine({ url: "http://[::1" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledTimes(1);
    expect(bridge.create).toHaveBeenCalledWith(rig.tabKey, "http://[::1", undefined);
  });

  it("unmount destroys the guest and disposes the subscription exactly once", () => {
    const { rig, unmount } = renderEngine();
    unmount();
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).toHaveBeenCalledWith(rig.tabKey);
    expect(relayDisposer).toHaveBeenCalledTimes(1);
    expect(rig.handles.has(rig.url)).toBe(false);
  });

  it("exposes the tabKey on the placeholder", () => {
    const { rig } = renderEngine();
    expect(rig.tabKey).toMatch(/^web-\d+$/);
    const placeholder = screen.getByTestId("web-native-placeholder");
    expect(placeholder.dataset.tabKey).toBe(rig.tabKey);
  });
});

describe("WebFrameNative retention", () => {
  const scope = { server: "runkit", windowId: "@3" };
  const NUL = String.fromCharCode(0);
  const identityFor = (url: string) => [scope.server, scope.windowId, url].join(NUL);
  const createIdentityFor = (tabKey: string) =>
    bridge.create.mock.calls.find((call) => call[0] === tabKey)?.[2];

  it("sends the NUL-joined server + window id + slot url as the create identity", async () => {
    installParkBridge();
    const { rig } = renderEngine({ url: "/present/x/y/index.html", retentionScope: scope });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/present/x/y/index.html`,
      identityFor("/present/x/y/index.html"),
    );
  });

  it("creates with an undefined identity when no retention scope is given (the guest can never park)", async () => {
    installParkBridge();
    const { rig } = renderEngine();
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(rig.tabKey, expect.any(String), undefined);
  });

  it("a remount with the same scope and slot url sends the identical identity, and in-page navigation never changes it", async () => {
    installParkBridge();
    const first = renderEngine({ url: "http://localhost:6000/app", retentionScope: scope });
    await flushMount();
    // The guest navigates in-page — the tracked location drifts, the slot
    // url (and with it the identity) does not.
    deliver({
      tabKey: first.rig.tabKey,
      kind: "url",
      url: "http://localhost:6000/deep/link",
      canGoBack: true,
      canGoForward: false,
    });
    first.unmount();
    const second = renderEngine({ url: "http://localhost:6000/app", retentionScope: scope });
    await flushMount();
    const expected = identityFor("http://localhost:6000/app");
    expect(createIdentityFor(first.rig.tabKey)).toBe(expected);
    expect(createIdentityFor(second.rig.tabKey)).toBe(expected);
  });

  it("a different window id or slot url yields a different identity", async () => {
    installParkBridge();
    const a = renderEngine({ url: "/proxy/6000/", retentionScope: scope });
    await flushMount();
    a.unmount();
    const b = renderEngine({
      url: "/proxy/6000/",
      retentionScope: { server: "runkit", windowId: "@4" },
    });
    await flushMount();
    expect(createIdentityFor(b.rig.tabKey)).not.toBe(createIdentityFor(a.rig.tabKey));
  });

  it("unmount parks the guest (never destroys) when the bridge supports park", async () => {
    installParkBridge();
    const { rig, unmount } = renderEngine({ retentionScope: scope });
    await flushMount();
    unmount();
    expect(parkFn).toHaveBeenCalledTimes(1);
    expect(parkFn).toHaveBeenCalledWith(rig.tabKey);
    expect(bridge.destroy).not.toHaveBeenCalled();
    expect(relayDisposer).toHaveBeenCalledTimes(1);
    expect(rig.handles.has(rig.url)).toBe(false);
  });

  it("unmount destroys when the bridge lacks the park invoker (an older shell — the pre-retention path)", () => {
    const { rig, unmount } = renderEngine({ retentionScope: scope });
    unmount();
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).toHaveBeenCalledWith(rig.tabKey);
    expect(parkFn).not.toHaveBeenCalled();
  });

  it("the handle's destroy verb destroys immediately and suppresses the unmount park (a tab that is gone is never retained)", async () => {
    installParkBridge();
    const { rig, unmount } = renderEngine({ retentionScope: scope });
    await flushMount();
    act(() => rig.handles.get(rig.url)?.destroy?.());
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).toHaveBeenCalledWith(rig.tabKey);
    unmount();
    expect(parkFn).not.toHaveBeenCalled();
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
  });

  it("the adopt replay — title/favicon/url/loading right after create — maps onto the new mount's state through the normal relay", async () => {
    installParkBridge();
    const { rig } = renderEngine({ url: "http://localhost:6000/app", retentionScope: scope });
    await flushMount();
    // Main re-reports the adopted guest's chrome state immediately after the
    // adopt, demuxed by the NEW tabKey; the subscription preceded the create,
    // so no replayed event is missed.
    deliver({ tabKey: rig.tabKey, kind: "title", title: "Adopted App" });
    deliver({ tabKey: rig.tabKey, kind: "favicon", favicons: ["https://a/f.ico"] });
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: "http://localhost:6000/app/current",
      canGoBack: true,
      canGoForward: false,
    });
    deliver({ tabKey: rig.tabKey, kind: "loading", loading: false });
    const state = rig.states.get(rig.url);
    expect(state?.title).toBe("Adopted App");
    expect(state?.favicon).toBe("https://a/f.ico");
    expect(state?.trackedLocation).toBe("http://localhost:6000/app/current");
    expect(state?.canGoBack).toBe(true);
    expect(state?.canGoForward).toBe(false);
    expect(state?.loading).toBe(false);
    expect(rig.onLoad).toHaveBeenCalledWith(rig.url);
  });
});

describe("WebFrameNative host web mode", () => {
  it("direct mode: a stored /proxy slot loads as the literal loopback URL", async () => {
    installModeBridge(() => Promise.resolve({ ok: true, mode: "direct" }));
    const { rig } = renderEngine({ url: "/proxy/6000/" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(rig.tabKey, "http://localhost:6000/", undefined);
  });

  it("proxy mode: a stored /proxy slot loads as the literal loopback URL, and a literal loopback URL passes through", async () => {
    installModeBridge(() => Promise.resolve({ ok: true, mode: "proxy" }));
    const { rig } = renderEngine({ url: "/proxy/6000/assets/x.js" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(rig.tabKey, "http://localhost:6000/assets/x.js", undefined);

    cleanup();
    vi.clearAllMocks();
    const second = renderEngine({ url: "http://localhost:6000/x" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(second.rig.tabKey, "http://localhost:6000/x", undefined);
  });

  it("legacy mode loads byte-identical to today's behavior: the host-absolute /proxy path", async () => {
    installModeBridge(() => Promise.resolve({ ok: true, mode: "legacy" }));
    const { rig } = renderEngine({ url: "/proxy/6000/" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/proxy/6000/`,
      undefined,
    );

    cleanup();
    vi.clearAllMocks();
    const second = renderEngine({ url: "http://localhost:6000/x" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      second.rig.tabKey,
      `${window.location.origin}/proxy/6000/x`,
      undefined,
    );
  });

  it("a denied or malformed mode result reads as legacy", async () => {
    installModeBridge(() => Promise.resolve({ ok: false, error: "denied" }));
    const { rig } = renderEngine({ url: "/proxy/6000/" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/proxy/6000/`,
      undefined,
    );

    cleanup();
    vi.clearAllMocks();
    installModeBridge(() => Promise.resolve({ ok: true, mode: "turbo" }));
    const second = renderEngine({ url: "/proxy/6000/" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      second.rig.tabKey,
      `${window.location.origin}/proxy/6000/`,
      undefined,
    );
  });

  it("a rejected mode invoke reads as legacy, never throwing", async () => {
    installModeBridge(() => Promise.reject(new Error("ipc gone")));
    const { rig } = renderEngine({ url: "/proxy/6000/" });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledWith(
      rig.tabKey,
      `${window.location.origin}/proxy/6000/`,
      undefined,
    );
  });

  it("an unmount during the mode await never creates the guest", async () => {
    let resolveMode: (result: unknown) => void = () => {};
    installModeBridge(
      () =>
        new Promise<unknown>((resolve) => {
          resolveMode = resolve;
        }),
    );
    const { rig, unmount } = renderEngine({ url: "/proxy/6000/" });
    unmount();
    resolveMode({ ok: true, mode: "direct" });
    await flushMount();
    expect(bridge.create).not.toHaveBeenCalled();
    expect(bridge.destroy).toHaveBeenCalledTimes(1);
    expect(bridge.destroy).toHaveBeenCalledWith(rig.tabKey);
  });
});

describe("WebFrameNative relay events", () => {
  it("drops events for another tabKey before any state update", () => {
    const { rig } = renderEngine();
    const before = rig.states.get(rig.url);
    deliver({ tabKey: "web-other", kind: "title", title: "Foreign" });
    expect(rig.states.get(rig.url)?.title).toBe(before?.title ?? null);
    expect(rig.states.get(rig.url)?.title).toBeNull();
  });

  it("maps title/favicon/loading/url into the reported chrome state and fires onLoad on loading:false", () => {
    const { rig } = renderEngine();
    const key = rig.tabKey;
    deliver({ tabKey: key, kind: "title", title: "GitHub" });
    deliver({ tabKey: key, kind: "favicon", favicons: ["https://a/f.ico", "https://a/g.ico"] });
    deliver({ tabKey: key, kind: "loading", loading: false });
    deliver({
      tabKey: key,
      kind: "url",
      url: `${window.location.origin}/present/x/y/other.html?q=1#frag`,
      canGoBack: true,
      canGoForward: false,
    });
    const state = rig.states.get(rig.url);
    expect(state?.title).toBe("GitHub");
    expect(state?.favicon).toBe("https://a/f.ico");
    expect(state?.loading).toBe(false);
    expect(state?.trackedLocation).toBe("/present/x/y/other.html?q=1#frag");
    expect(state?.canGoBack).toBe(true);
    expect(state?.canGoForward).toBe(false);
    expect(rig.onLoad).toHaveBeenCalledTimes(1);
    expect(rig.onLoad).toHaveBeenCalledWith(rig.url);
  });

  it("stores an external url relay absolute", () => {
    const { rig } = renderEngine();
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: "https://github.com/x/y",
      canGoBack: false,
      canGoForward: false,
    });
    expect(rig.states.get(rig.url)?.trackedLocation).toBe("https://github.com/x/y");
  });

  it("maps an empty title to null and an empty favicon list to null", () => {
    const { rig } = renderEngine();
    deliver({ tabKey: rig.tabKey, kind: "title", title: "T" });
    deliver({ tabKey: rig.tabKey, kind: "favicon", favicons: ["https://a/f.ico"] });
    deliver({ tabKey: rig.tabKey, kind: "title", title: "" });
    deliver({ tabKey: rig.tabKey, kind: "favicon", favicons: [] });
    expect(rig.states.get(rig.url)?.title).toBeNull();
    expect(rig.states.get(rig.url)?.favicon).toBeNull();
  });

  it("failed clears loading and maps to an unreachable tileError on an external tab", () => {
    const { rig } = renderEngine({ url: "https://nope.example" });
    expect(rig.states.get(rig.url)?.loading).toBe(true);
    deliver({ tabKey: rig.tabKey, kind: "failed", code: -105, description: "ERR_NAME_NOT_RESOLVED", url: "https://nope.example/" });
    const state = rig.states.get(rig.url);
    expect(state?.loading).toBe(false);
    expect(state?.tileError).toEqual({
      kind: "unreachable",
      host: "nope.example",
      reason: "name not resolved",
    });
  });

  it("focus fires the interact seam; a zoom relay steps the bucket via onZoomStep without a state change", () => {
    const onInteract = vi.fn();
    const onZoomStep = vi.fn();
    const { rig } = renderEngine({ onInteract, onZoomStep });
    deliver({ tabKey: rig.tabKey, kind: "focus" });
    expect(onInteract).toHaveBeenCalledTimes(1);
    const before = rig.onState.mock.calls.length;
    deliver({ tabKey: rig.tabKey, kind: "zoom", direction: "in" });
    expect(onZoomStep).toHaveBeenCalledTimes(1);
    expect(onZoomStep).toHaveBeenCalledWith("in");
    expect(rig.onState.mock.calls.length).toBe(before);
  });

  it("a chord relay reports interaction first, then re-dispatches a bubbling keydown on the document", () => {
    const onInteract = vi.fn();
    const { rig } = renderEngine({ onInteract });
    const seen: KeyboardEvent[] = [];
    const listener = (e: Event) => seen.push(e as KeyboardEvent);
    document.addEventListener("keydown", listener);
    try {
      deliver({
        tabKey: rig.tabKey,
        kind: "chord",
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      });
    } finally {
      document.removeEventListener("keydown", listener);
    }
    expect(onInteract).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].code).toBe("KeyK");
    expect(seen[0].ctrlKey).toBe(true);
    expect(seen[0].bubbles).toBe(true);
  });

  it("a find relay maps the 1-based ordinal to the 0-based matchIndex", () => {
    const { rig } = renderEngine();
    deliver({ tabKey: rig.tabKey, kind: "find", active: 2, total: 5, final: false });
    expect(rig.states.get(rig.url)?.find).toEqual({ active: 1, total: 5 });
    // Chromium's 1-based first match (and the 0-match report) never go negative.
    deliver({ tabKey: rig.tabKey, kind: "find", active: 1, total: 5, final: true });
    expect(rig.states.get(rig.url)?.find).toEqual({ active: 0, total: 5 });
    deliver({ tabKey: rig.tabKey, kind: "find", active: 0, total: 0, final: true });
    expect(rig.states.get(rig.url)?.find).toEqual({ active: 0, total: 0 });
  });

  it("stopFind and the completed-load edge reset find to null", () => {
    const { rig } = renderEngine();
    deliver({ tabKey: rig.tabKey, kind: "find", active: 2, total: 5, final: true });
    expect(rig.states.get(rig.url)?.find).toEqual({ active: 1, total: 5 });
    act(() => rig.handles.get(rig.url)?.stopFind());
    expect(bridge.stopFind).toHaveBeenCalledWith(rig.tabKey);
    expect(rig.states.get(rig.url)?.find).toBeNull();
    deliver({ tabKey: rig.tabKey, kind: "find", active: 3, total: 5, final: true });
    deliver({ tabKey: rig.tabKey, kind: "loading", loading: true });
    deliver({ tabKey: rig.tabKey, kind: "loading", loading: false });
    expect(rig.states.get(rig.url)?.find).toBeNull();
  });
});

describe("WebFrameNative capabilities + handle", () => {
  it("reports the full parity capability set", () => {
    expect(WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES).toEqual({
      history: true,
      find: true,
      meta: true,
      zoomGestures: true,
      devtools: true,
    });
    const { rig } = renderEngine();
    expect(rig.states.get(rig.url)?.supports).toEqual(WEB_FRAME_NATIVE_DEFAULT_CAPABILITIES);
  });

  it("handle reload/retry call the bridge and report loading; back/forward/find/stopFind/openDevTools drive their channels", () => {
    const { rig } = renderEngine();
    const handle = rig.handles.get(rig.url);
    expect(handle?.kind).toBe("native");
    deliver({ tabKey: rig.tabKey, kind: "loading", loading: false });
    bridge.reload.mockClear();
    act(() => handle?.reload());
    expect(bridge.reload).toHaveBeenCalledTimes(1);
    expect(bridge.reload).toHaveBeenCalledWith(rig.tabKey);
    expect(rig.states.get(rig.url)?.loading).toBe(true);
    act(() => handle?.retry());
    expect(bridge.reload).toHaveBeenCalledTimes(2);

    act(() => {
      handle?.back();
      handle?.forward();
      handle?.find("foo", { forward: true, findNext: false });
      handle?.stopFind();
      handle?.openDevTools?.();
    });
    expect(bridge.back).toHaveBeenCalledWith(rig.tabKey);
    expect(bridge.forward).toHaveBeenCalledWith(rig.tabKey);
    expect(bridge.find).toHaveBeenCalledWith(rig.tabKey, "foo", true, false);
    expect(bridge.stopFind).toHaveBeenCalledWith(rig.tabKey);
    expect(bridge.devtools).toHaveBeenCalledWith(rig.tabKey);
  });
});

describe("WebFrameNative zoom", () => {
  it("sends the zoom factor after create resolves and on every zoom prop change", async () => {
    const { rig, rerenderEngine } = renderEngine({ zoom: 1.25 });
    await flushMount();
    expect(bridge.zoom).toHaveBeenCalledWith(rig.tabKey, 1.25);
    expect(bridge.zoom).toHaveBeenCalledTimes(1);
    rerenderEngine({ zoom: 1.5 });
    expect(bridge.zoom).toHaveBeenCalledWith(rig.tabKey, 1.5);
    expect(bridge.zoom).toHaveBeenCalledTimes(2);
    // An unrelated re-render sends nothing.
    rerenderEngine();
    expect(bridge.zoom).toHaveBeenCalledTimes(2);
  });

  it("re-applies the factor on EVERY url relay (Chromium's per-host store fights the bucket)", async () => {
    const { rig } = renderEngine({ zoom: 1.25 });
    await flushMount();
    bridge.zoom.mockClear();
    deliver({ tabKey: rig.tabKey, kind: "url", url: "https://example.com/a", canGoBack: true, canGoForward: false });
    deliver({ tabKey: rig.tabKey, kind: "url", url: "https://example.com/b", canGoBack: true, canGoForward: true });
    expect(bridge.zoom).toHaveBeenCalledTimes(2);
    expect(bridge.zoom).toHaveBeenLastCalledWith(rig.tabKey, 1.25);
  });
});

describe("WebFrameNative chord table", () => {
  it("uploads the table after create resolves and on every table identity change", async () => {
    const table = [
      { code: "KeyK", ctrl: true, meta: false, shift: false, alt: false as const },
      { code: "Escape", ctrl: false, meta: false, shift: false, alt: false as const },
    ];
    const { rig, rerenderEngine } = renderEngine({ chordTable: table });
    await flushMount();
    expect(bridge.chords).toHaveBeenCalledWith(rig.tabKey, table);
    expect(bridge.chords).toHaveBeenCalledTimes(1);
    // A re-render carrying the SAME array identity sends nothing.
    rerenderEngine();
    expect(bridge.chords).toHaveBeenCalledTimes(1);
    const rebound = [...table];
    rerenderEngine({ chordTable: rebound });
    expect(bridge.chords).toHaveBeenCalledWith(rig.tabKey, rebound);
    expect(bridge.chords).toHaveBeenCalledTimes(2);
  });

  it("uploads an empty table when the prop is absent", async () => {
    renderEngine();
    await flushMount();
    expect(bridge.chords).toHaveBeenCalledWith(expect.any(String), []);
  });
});

describe("WebFrameNative post-create ordering", () => {
  // Main's per-tab channels reject a tabKey whose guest does not exist yet
  // ("Unknown tab"), so the initial chords/zoom sends are sequenced after the
  // create resolves; these tests gate create on a manual promise to prove it.

  it("sends the initial chord table and zoom factor only after create resolves", async () => {
    const table = [{ code: "KeyK", ctrl: true, meta: false, shift: false, alt: false as const }];
    let resolveCreate: (result: { ok: boolean }) => void = () => {};
    bridge.create.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { rig } = renderEngine({ zoom: 1.25, chordTable: table });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledTimes(1);
    expect(bridge.chords).not.toHaveBeenCalled();
    expect(bridge.zoom).not.toHaveBeenCalled();
    resolveCreate({ ok: true });
    await flushMount();
    expect(bridge.chords).toHaveBeenCalledWith(rig.tabKey, table);
    expect(bridge.zoom).toHaveBeenCalledWith(rig.tabKey, 1.25);
  });

  it("a chord-table change landing before create resolves is not lost — the post-create send reads the latest table", async () => {
    const tableA = [{ code: "KeyA", ctrl: true, meta: false, shift: false, alt: false as const }];
    const tableB = [{ code: "KeyB", ctrl: true, meta: false, shift: false, alt: false as const }];
    let resolveCreate: (result: { ok: boolean }) => void = () => {};
    bridge.create.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { rig, rerenderEngine } = renderEngine({ chordTable: tableA });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledTimes(1);
    // The rebind re-sends immediately (this one races the pending create);
    // the post-create send must carry tableB, never the superseded tableA.
    rerenderEngine({ chordTable: tableB });
    expect(bridge.chords).toHaveBeenCalledWith(rig.tabKey, tableB);
    resolveCreate({ ok: true });
    await flushMount();
    expect(bridge.chords).not.toHaveBeenCalledWith(rig.tabKey, tableA);
    expect(bridge.chords).toHaveBeenLastCalledWith(rig.tabKey, tableB);
  });

  it("an unmount before create resolves sends no chords or zoom", async () => {
    const table = [{ code: "KeyK", ctrl: true, meta: false, shift: false, alt: false as const }];
    let resolveCreate: (result: { ok: boolean }) => void = () => {};
    bridge.create.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { unmount } = renderEngine({ zoom: 1.25, chordTable: table });
    await flushMount();
    expect(bridge.create).toHaveBeenCalledTimes(1);
    unmount();
    resolveCreate({ ok: true });
    await flushMount();
    expect(bridge.chords).not.toHaveBeenCalled();
    expect(bridge.zoom).not.toHaveBeenCalled();
  });
});

describe("WebFrameNative tileError surface", () => {
  it("a proxy tab's url relay with httpStatus 502 yields dead-port; a clean navigation clears it", () => {
    const { rig } = renderEngine({ url: "http://localhost:3000" });
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: `${window.location.origin}/proxy/3000/`,
      canGoBack: false,
      canGoForward: false,
      httpStatus: 502,
    });
    expect(rig.states.get(rig.url)?.tileError).toEqual({ kind: "dead-port", port: 3000 });
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: `${window.location.origin}/proxy/3000/`,
      canGoBack: false,
      canGoForward: false,
      httpStatus: 200,
    });
    expect(rig.states.get(rig.url)?.tileError).toBeNull();
  });

  it("a load start clears the error and retry reloads through the bridge", () => {
    const { rig } = renderEngine({ url: "http://localhost:3000" });
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: `${window.location.origin}/proxy/3000/`,
      canGoBack: false,
      canGoForward: false,
      httpStatus: 502,
    });
    expect(rig.states.get(rig.url)?.tileError).toEqual({ kind: "dead-port", port: 3000 });
    bridge.reload.mockClear();
    act(() => rig.handles.get(rig.url)?.retry());
    expect(bridge.reload).toHaveBeenCalledTimes(1);
    expect(rig.states.get(rig.url)?.tileError).toBeNull();
    expect(rig.states.get(rig.url)?.loading).toBe(true);
    // The relay's own load-start edge clears it too (a navigation the chrome
    // did not initiate).
    deliver({ tabKey: rig.tabKey, kind: "failed", code: -105, description: "ERR_NAME_NOT_RESOLVED", url: "https://x/" });
    expect(rig.states.get(rig.url)?.tileError).not.toBeNull();
    deliver({ tabKey: rig.tabKey, kind: "loading", loading: true });
    expect(rig.states.get(rig.url)?.tileError).toBeNull();
  });

  it("the guest hides while tileError is set and re-shows once cleared", async () => {
    const { rig } = renderEngine({ url: "http://localhost:3000" });
    await flushMount();
    bridge.visible.mockClear();
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: `${window.location.origin}/proxy/3000/`,
      canGoBack: false,
      canGoForward: false,
      httpStatus: 502,
    });
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
    deliver({
      tabKey: rig.tabKey,
      kind: "url",
      url: `${window.location.origin}/proxy/3000/`,
      canGoBack: false,
      canGoForward: false,
      httpStatus: 200,
    });
    const shows = bridge.visible.mock.calls.filter((c) => c[1] === true);
    expect(shows.length).toBeGreaterThan(0);
    expect(shows[shows.length - 1]?.[0]).toBe(rig.tabKey);
  });
});

describe("WebFrameNative placeholder", () => {
  it("is hidden for an inactive tab and paints the tile background when active", () => {
    const { rerenderEngine } = renderEngine({ active: false });
    const placeholder = screen.getByTestId("web-native-placeholder");
    expect(placeholder.hasAttribute("hidden")).toBe(true);
    rerenderEngine({ active: true });
    expect(placeholder.hasAttribute("hidden")).toBe(false);
    expect(placeholder.className).toContain("bg-bg-primary");
    expect(placeholder.style.transform).toBe("");
  });
});

describe("WebFrameNative first paint (create race)", () => {
  // Main rejects bounds/visible before the guest exists ("Unknown tab"), and
  // the create lands only after the host-mode query + proxy settle — slow in
  // remote-native mode (a tunnel probe). The engine must hold its first
  // bounds/visible until the create resolves, then send the CURRENT values;
  // otherwise the guest sat at main's 0×0 default until a window resize.
  function holdCreate() {
    let resolveCreate: (v: { ok: boolean }) => void = () => {};
    bridge.create.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );
    return (ok = true) => resolveCreate({ ok });
  }

  it("sends nothing before the create resolves, then bounds followed by visible(true)", async () => {
    const release = holdCreate();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    const { rig } = renderEngine();
    await flushMount();
    expect(bridge.create).toHaveBeenCalled();
    expect(bridge.bounds).not.toHaveBeenCalled();
    expect(bridge.visible).not.toHaveBeenCalled();
    release();
    await flushMount();
    expect(bridge.bounds).toHaveBeenCalledWith(rig.tabKey, 10, 20, 800, 600);
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, true);
    const boundsOrder = bridge.bounds.mock.invocationCallOrder[0];
    const showOrder = bridge.visible.mock.invocationCallOrder[0];
    expect(boundsOrder).toBeLessThan(showOrder);
  });

  it("a rect change while the create is pending is sent once the guest exists (the latest rect wins)", async () => {
    const release = holdCreate();
    bridge.bounds.mockClear();
    const { rig } = renderEngine();
    await flushMount();
    setRect({ x: 1, y: 2, width: 300, height: 200 });
    fireResize();
    expect(bridge.bounds).not.toHaveBeenCalled();
    release();
    await flushMount();
    expect(bridge.bounds).toHaveBeenCalledTimes(1);
    expect(bridge.bounds).toHaveBeenCalledWith(rig.tabKey, 1, 2, 300, 200);
  });

  it("an inactive tab whose create resolves sends visible(false), and activating later shows it", async () => {
    const release = holdCreate();
    bridge.visible.mockClear();
    const { rig, rerenderEngine } = renderEngine({ active: false });
    await flushMount();
    release();
    await flushMount();
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
    expect(bridge.visible).not.toHaveBeenCalledWith(rig.tabKey, true);
    rerenderEngine({ active: true });
    expect(bridge.visible).toHaveBeenLastCalledWith(rig.tabKey, true);
  });

  it("a failed create sends no bounds or visibility", async () => {
    const release = holdCreate();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    renderEngine();
    await flushMount();
    release(false);
    await flushMount();
    fireResize();
    expect(bridge.bounds).not.toHaveBeenCalled();
    expect(bridge.visible).not.toHaveBeenCalled();
  });
});

describe("WebFrameNative bounds", () => {
  it("sends the rounded rect on a ResizeObserver callback and dedupes an identical rect", async () => {
    const { rig } = renderEngine();
    await flushMount();
    bridge.bounds.mockClear();
    setRect({ x: 100.4, y: 50.6, width: 640.2, height: 480 });
    fireResize();
    expect(bridge.bounds).toHaveBeenCalledTimes(1);
    expect(bridge.bounds).toHaveBeenCalledWith(rig.tabKey, 100, 51, 640, 480);
    fireResize();
    expect(bridge.bounds).toHaveBeenCalledTimes(1);
  });

  it("sends no bounds for a zero-size rect and drives visible(false) instead", async () => {
    const { rig } = renderEngine();
    await flushMount();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    setRect({ x: 0, y: 0, width: 0, height: 0 });
    fireResize();
    expect(bridge.bounds).not.toHaveBeenCalled();
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
  });

  it("keeps sending bounds while the guest is hidden by a modal overlay (main parks them)", async () => {
    const { rig } = renderEngine();
    await flushMount();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    let release: () => void = () => {};
    act(() => {
      release = acquire("modal");
    });
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
    setRect({ x: 30, y: 40, width: 500, height: 400 });
    fireResize();
    expect(bridge.bounds).toHaveBeenCalledWith(rig.tabKey, 30, 40, 500, 400);
    bridge.visible.mockClear();
    act(() => release());
    const showCall = bridge.visible.mock.calls.find((call) => call[1] === true);
    expect(showCall?.[0]).toBe(rig.tabKey);
    // The show is preceded by a (parked) bounds measurement.
    const lastBoundsOrder = bridge.bounds.mock.invocationCallOrder.at(-1) ?? -1;
    const showOrder = bridge.visible.mock.invocationCallOrder[0];
    expect(lastBoundsOrder).toBeLessThan(showOrder);
  });

  it("a transient overlay (a click-opened menu) hides the guest and releasing restores it", async () => {
    const { rig } = renderEngine();
    await flushMount();
    bridge.visible.mockClear();
    let release: () => void = () => {};
    act(() => {
      release = acquire("transient");
    });
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
    bridge.visible.mockClear();
    act(() => release());
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, true);
  });
});

describe("WebFrameNative visibility", () => {
  it("an inactive tab mounts hidden; activating it re-measures and shows the guest", async () => {
    const { rig, rerenderEngine } = renderEngine({ active: false });
    await flushMount();
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, false);
    bridge.visible.mockClear();
    bridge.bounds.mockClear();
    setRect({ x: 5, y: 6, width: 700, height: 500 });
    rerenderEngine({ active: true });
    expect(bridge.visible).toHaveBeenCalledWith(rig.tabKey, true);
    expect(bridge.bounds).toHaveBeenCalledWith(rig.tabKey, 5, 6, 700, 500);
    const lastBoundsOrder = bridge.bounds.mock.invocationCallOrder.at(-1) ?? -1;
    const showOrder = bridge.visible.mock.invocationCallOrder[0];
    expect(lastBoundsOrder).toBeLessThan(showOrder);
  });
});

describe("WebFrameNative drag postures", () => {
  it("resize posture: sends deduped bounds on every pumped frame and never hides; the stop edge measures once more", async () => {
    const { rig, rerenderEngine } = renderEngine({ posture: "resize" });
    await flushMount();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    setRect({ x: 0, y: 0, width: 100, height: 100 });
    pumpFrames(1);
    setRect({ x: 0, y: 0, width: 110, height: 100 });
    pumpFrames(1);
    setRect({ x: 0, y: 0, width: 120, height: 100 });
    pumpFrames(1);
    expect(bridge.bounds).toHaveBeenCalledTimes(3);
    expect(bridge.bounds.mock.calls.map((c) => c[3])).toEqual([100, 110, 120]);
    // A sash drag keeps the guest visible — live bounds, no hide.
    expect(bridge.visible).not.toHaveBeenCalled();

    setRect({ x: 0, y: 0, width: 130, height: 100 });
    rerenderEngine({ posture: "idle" });
    // The resize → idle edge stops the loop and runs one final measure.
    expect(bridge.bounds).toHaveBeenCalledTimes(4);
    expect(bridge.bounds).toHaveBeenLastCalledWith(rig.tabKey, 0, 0, 130, 100);
    expect(rafQueue.every((cb) => cb.length >= 0)).toBe(true);
    pumpFrames(1);
    expect(bridge.bounds).toHaveBeenCalledTimes(4);
  });

  it("move posture hides the guest, runs no live-resize loop, and re-shows on the return to idle", async () => {
    const { rig, rerenderEngine } = renderEngine();
    await flushMount();
    bridge.bounds.mockClear();
    bridge.visible.mockClear();
    rerenderEngine({ posture: "move" });
    expect(bridge.visible).toHaveBeenLastCalledWith(rig.tabKey, false);
    // No rAF live-resize loop under move — bounds stay parked.
    pumpFrames(2);
    expect(bridge.bounds).not.toHaveBeenCalled();

    // move → idle: the show edge re-measures first, then re-shows.
    setRect({ x: 0, y: 0, width: 140, height: 100 });
    rerenderEngine({ posture: "idle" });
    expect(bridge.bounds).toHaveBeenLastCalledWith(rig.tabKey, 0, 0, 140, 100);
    expect(bridge.visible).toHaveBeenLastCalledWith(rig.tabKey, true);
    const lastBoundsOrder = bridge.bounds.mock.invocationCallOrder.at(-1) ?? -1;
    const showOrder = bridge.visible.mock.invocationCallOrder.at(-1) ?? -1;
    expect(lastBoundsOrder).toBeLessThan(showOrder);
  });
});
