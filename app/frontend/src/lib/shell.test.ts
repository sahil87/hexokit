import { describe, it, expect, afterEach, vi } from "vitest";
import {
  addShellHost,
  addShellHostDirect,
  canAddShellHost,
  canAddShellHostDirect,
  canCloseShellWindow,
  canConfirmedRemoveShellHost,
  canNewShellWindow,
  canParkShellWebView,
  canRemoveShellHost,
  canRenameShellHost,
  canSetShellHostUrl,
  canReorderShellHosts,
  canShellPopout,
  canShellWeb,
  closeShellWindow,
  createShellWebView,
  destroyShellWebView,
  findShellWebView,
  goBackShellWebView,
  goForwardShellWebView,
  isShell,
  listShellServers,
  loadShellWebView,
  onShellWebEvent,
  openShellWebViewDevTools,
  parkShellWebView,
  parseShellWebEvent,
  confirmedRemoveShellHost,
  newShellWindow,
  reloadShellWebView,
  removeShellHost,
  renameShellHost,
  setShellHostUrl,
  setShellWebViewBounds,
  setShellWebViewChords,
  setShellWebViewVisible,
  setShellWebViewZoom,
  stopFindShellWebView,
  reorderShellHosts,
  setShellAccent,
  setShellBadge,
  shellInfo,
  shellPopout,
  shellWebMode,
  switchShellServer,
} from "./shell";

// The desktop shell injects window.runkitShell at runtime via its preload
// contextBridge — nothing type-level guarantees the shape, so these tests
// prove the structural narrowing: well-formed bridges are read, everything
// else (absent, null, primitives, wrong field types) reads as "not a shell".

afterEach(() => {
  delete window.runkitShell;
});

describe("shellInfo / isShell", () => {
  it("returns null / false in a plain browser (bridge absent)", () => {
    expect(shellInfo()).toBeNull();
    expect(isShell()).toBe(false);
  });

  it("returns the shell metadata for a well-formed bridge", () => {
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(shellInfo()).toEqual({ version: "1.2.3", platform: "darwin" });
    expect(isShell()).toBe(true);
  });

  it("does not leak extra bridge members (e.g. the welcome IPC namespace)", () => {
    window.runkitShell = {
      version: "1.2.3",
      platform: "darwin",
      __welcome: { testServer: () => Promise.resolve() },
    };
    expect(shellInfo()).toEqual({ version: "1.2.3", platform: "darwin" });
  });

  it("rejects a malformed bridge with a non-string version", () => {
    window.runkitShell = { version: 123, platform: "darwin" };
    expect(shellInfo()).toBeNull();
    expect(isShell()).toBe(false);
  });

  it("rejects a bridge missing the platform field", () => {
    window.runkitShell = { version: "1.2.3" };
    expect(shellInfo()).toBeNull();
  });

  it("rejects null and primitive bridge values", () => {
    window.runkitShell = null;
    expect(isShell()).toBe(false);
    window.runkitShell = "1.2.3";
    expect(isShell()).toBe(false);
  });
});

// The servers group rides the same runtime-injected bridge: list/switch must
// read well-formed results and degrade to null/false for everything else —
// absent bridge (plain browser), a pre-servers shell, malformed entries,
// denied ({ ok: false }) results, and rejected invokes.

const serverA = { id: "a", name: "studio-mac", url: "http://a:3000", active: true };
const serverB = { id: "b", name: "lab", url: "http://b:3000", active: false };

function bridgeWith(servers: unknown): void {
  window.runkitShell = { version: "1.2.3", platform: "darwin", servers };
}

describe("listShellServers", () => {
  it("resolves the entries for a well-formed bridge and list result", async () => {
    bridgeWith({
      list: () => Promise.resolve({ ok: true, servers: [serverA, serverB] }),
      switch: () => Promise.resolve({ ok: true }),
    });
    expect(await listShellServers()).toEqual([serverA, serverB]);
  });

  it("resolves null in a plain browser (bridge absent)", async () => {
    expect(await listShellServers()).toBeNull();
  });

  it("resolves null on a shell without the servers group (older shell)", async () => {
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(await listShellServers()).toBeNull();
  });

  it("resolves null when the group members are not functions", async () => {
    bridgeWith({ list: "nope", switch: () => Promise.resolve({ ok: true }) });
    expect(await listShellServers()).toBeNull();
  });

  it("resolves null on a malformed entry (non-boolean active)", async () => {
    bridgeWith({
      list: () => Promise.resolve({ ok: true, servers: [{ ...serverA, active: "yes" }] }),
      switch: () => Promise.resolve({ ok: true }),
    });
    expect(await listShellServers()).toBeNull();
  });

  it("resolves null on a denied result ({ ok: false })", async () => {
    bridgeWith({
      list: () => Promise.resolve({ ok: false, error: "Not allowed" }),
      switch: () => Promise.resolve({ ok: true }),
    });
    expect(await listShellServers()).toBeNull();
  });

  it("resolves null when the invoke rejects", async () => {
    bridgeWith({
      list: () => Promise.reject(new Error("ipc gone")),
      switch: () => Promise.resolve({ ok: true }),
    });
    expect(await listShellServers()).toBeNull();
  });
});

type BridgeCase = {
  name: string;
  available?: () => boolean;
  invoke: () => Promise<unknown>;
  install: (member: unknown) => void;
  installOlder: () => void;
  args: unknown[];
  structured?: boolean;
};

const baseServersBridge = {
  list: () => Promise.resolve({ ok: true, servers: [] }),
  switch: () => Promise.resolve({ ok: true }),
};

const bridgeCases: BridgeCase[] = [
  {
    name: "switch",
    invoke: () => switchShellServer("b"),
    install: (member) => bridgeWith({ ...baseServersBridge, switch: member }),
    installOlder: () => { window.runkitShell = { version: "1.2.3", platform: "darwin" }; },
    args: ["b"],
  },
  {
    name: "add",
    available: canAddShellHost,
    invoke: () => addShellHost(),
    install: (member) => bridgeWith({ ...baseServersBridge, add: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: [],
  },
  {
    name: "addDirect",
    available: canAddShellHostDirect,
    invoke: () => addShellHostDirect("lab", "http://b:3000"),
    install: (member) => bridgeWith({ ...baseServersBridge, addDirect: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["lab", "http://b:3000"],
    structured: true,
  },
  {
    name: "badge",
    invoke: () => setShellBadge(3),
    install: (member) => {
      window.runkitShell = { version: "1.2.3", platform: "darwin", badge: { set: member } };
    },
    installOlder: () => { window.runkitShell = { version: "1.2.3", platform: "darwin" }; },
    args: [3],
  },
  {
    name: "accent",
    invoke: () => setShellAccent("#8b7ff0"),
    install: (member) => {
      window.runkitShell = { version: "1.2.3", platform: "darwin", accent: { set: member } };
    },
    installOlder: () => { window.runkitShell = { version: "1.2.3", platform: "darwin" }; },
    args: ["#8b7ff0"],
  },
  {
    name: "newWindow",
    available: canNewShellWindow,
    invoke: () => newShellWindow(),
    install: (member) => {
      window.runkitShell = { version: "1.2.3", platform: "darwin", windows: { newWindow: member } };
    },
    installOlder: () => { window.runkitShell = { version: "1.2.3", platform: "darwin" }; },
    args: [],
  },
  {
    name: "closeWindow",
    available: canCloseShellWindow,
    invoke: () => closeShellWindow(),
    install: (member) => {
      window.runkitShell = {
        version: "1.2.3",
        platform: "darwin",
        windows: { newWindow: () => Promise.resolve({ ok: true }), close: member },
      };
    },
    installOlder: () => {
      window.runkitShell = {
        version: "1.2.3",
        platform: "darwin",
        windows: { newWindow: () => Promise.resolve({ ok: true }) },
      };
    },
    args: [],
  },
  {
    name: "reorder",
    available: canReorderShellHosts,
    invoke: () => reorderShellHosts("b", 0),
    install: (member) => bridgeWith({ ...baseServersBridge, reorder: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["b", 0],
  },
  {
    name: "remove",
    available: canRemoveShellHost,
    invoke: () => removeShellHost("b"),
    install: (member) => bridgeWith({ ...baseServersBridge, remove: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["b"],
  },
  {
    name: "removeConfirmed",
    available: canConfirmedRemoveShellHost,
    invoke: () => confirmedRemoveShellHost("b"),
    install: (member) => bridgeWith({ ...baseServersBridge, removeConfirmed: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["b"],
  },
  {
    name: "setHostUrl",
    available: canSetShellHostUrl,
    invoke: () => setShellHostUrl("b", "http://x:4100"),
    install: (member) => bridgeWith({ ...baseServersBridge, setUrl: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["b", "http://x:4100"],
  },
  {
    name: "rename",
    available: canRenameShellHost,
    invoke: () => renameShellHost("b", "lab-2"),
    install: (member) => bridgeWith({ ...baseServersBridge, rename: member }),
    installOlder: () => bridgeWith(baseServersBridge),
    args: ["b", "lab-2"],
  },
];

function expectBridgeResult(result: unknown, structured = false, success = false): void {
  if (structured) {
    expect(result).toMatchObject({ ok: success });
  } else {
    expect(result).toBe(success);
  }
}

describe("optional shell bridge invokers", () => {
  it.each(bridgeCases)("$name accepts a valid acknowledgement and forwards arguments", async (bridge) => {
    let seen: unknown[] | null = null;
    bridge.install((...args: unknown[]) => {
      seen = args;
      return Promise.resolve({ ok: true });
    });
    expect(bridge.available?.() ?? true).toBe(true);
    expectBridgeResult(await bridge.invoke(), bridge.structured, true);
    expect(seen).toEqual(bridge.args);
  });

  it.each(bridgeCases)("$name is unavailable in a browser and an older shell", async (bridge) => {
    expect(bridge.available?.() ?? false).toBe(false);
    expectBridgeResult(await bridge.invoke(), bridge.structured);
    bridge.installOlder();
    expect(bridge.available?.() ?? false).toBe(false);
    expectBridgeResult(await bridge.invoke(), bridge.structured);
  });

  it.each(bridgeCases)("$name rejects a non-function bridge member", async (bridge) => {
    bridge.install("not-a-function");
    expect(bridge.available?.() ?? false).toBe(false);
    expectBridgeResult(await bridge.invoke(), bridge.structured);
  });

  it.each(bridgeCases)("$name resolves failure for denied and rejected invocations", async (bridge) => {
    bridge.install(() => Promise.resolve({ ok: false, error: "Not allowed" }));
    expectBridgeResult(await bridge.invoke(), bridge.structured);
    bridge.install(() => Promise.reject(new Error("ipc gone")));
    expectBridgeResult(await bridge.invoke(), bridge.structured);
  });

  it("removeConfirmed remains independent from remove", async () => {
    bridgeWith({ ...baseServersBridge, remove: () => Promise.resolve({ ok: true }) });
    expect(canConfirmedRemoveShellHost()).toBe(false);
    expect(await confirmedRemoveShellHost("a")).toBe(false);
  });

  it("addDirect carries a main-side error and supplies a generic fallback", async () => {
    bridgeWith({
      ...baseServersBridge,
      addDirect: () => Promise.resolve({ ok: false, error: "No response from host" }),
    });
    expect(await addShellHostDirect("", "http://b:3000")).toEqual({
      ok: false,
      error: "No response from host",
    });

    bridgeWith({ ...baseServersBridge, addDirect: () => Promise.resolve({ ok: false }) });
    const result = await addShellHostDirect("", "http://b:3000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toBe("");
  });

  it("addDirect rejects malformed acknowledgements without throwing", async () => {
    bridgeWith({ ...baseServersBridge, addDirect: () => Promise.resolve("added") });
    expect((await addShellHostDirect("", "http://b:3000")).ok).toBe(false);
  });
});

// The windows.popout invoker rides the same additive pattern as close: a
// shell predating the channel narrows false and the wrapper resolves null,
// so an older shell's popout gate falls back to hiding the Pop out verb.
// The result is structural: only `{ ok: true, windowId: <finite number> }`
// resolves the id — everything else is null, and the wrapper never throws.

function windowsBridgeWith(windows: unknown): void {
  window.runkitShell = { version: "1.2.3", platform: "darwin", windows };
}

const baseWindowsBridge = {
  newWindow: () => Promise.resolve({ ok: true }),
};

describe("canShellPopout", () => {
  it("is false in a plain browser and on a shell without the windows group", () => {
    expect(canShellPopout()).toBe(false);
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(canShellPopout()).toBe(false);
  });

  it("is false on a windows group without popout (older shell)", () => {
    windowsBridgeWith(baseWindowsBridge);
    expect(canShellPopout()).toBe(false);
  });

  it("is false when the popout member is not a function", () => {
    windowsBridgeWith({ ...baseWindowsBridge, popout: "nope" });
    expect(canShellPopout()).toBe(false);
  });

  it("is true when the windows group carries a popout invoker", () => {
    windowsBridgeWith({ ...baseWindowsBridge, popout: () => Promise.resolve({ ok: true, windowId: 2 }) });
    expect(canShellPopout()).toBe(true);
  });
});

describe("shellPopout", () => {
  const ROUTE = "/rk-dev/@12?pop=web";

  it("resolves null in a plain browser (bridge absent)", async () => {
    expect(await shellPopout(ROUTE)).toBeNull();
  });

  it("resolves null on a windows group without popout (older shell)", async () => {
    windowsBridgeWith(baseWindowsBridge);
    expect(await shellPopout(ROUTE)).toBeNull();
  });

  it("resolves null when the popout member is not a function", async () => {
    windowsBridgeWith({ ...baseWindowsBridge, popout: 42 });
    expect(await shellPopout(ROUTE)).toBeNull();
  });

  it("resolves null when the invoke rejects", async () => {
    windowsBridgeWith({ ...baseWindowsBridge, popout: () => Promise.reject(new Error("ipc gone")) });
    expect(await shellPopout(ROUTE)).toBeNull();
  });

  it("resolves null on a denied result ({ ok: false })", async () => {
    windowsBridgeWith({
      ...baseWindowsBridge,
      popout: () => Promise.resolve({ ok: false, error: "Not allowed" }),
    });
    expect(await shellPopout(ROUTE)).toBeNull();
  });

  it("resolves null on malformed results (missing or wrong-typed windowId)", async () => {
    for (const malformed of [
      { ok: true },
      { ok: true, windowId: "2" },
      { ok: true, windowId: Number.POSITIVE_INFINITY },
      { windowId: 2 },
      "opened",
    ]) {
      windowsBridgeWith({ ...baseWindowsBridge, popout: () => Promise.resolve(malformed) });
      expect(await shellPopout(ROUTE)).toBeNull();
    }
  });

  it("resolves the window id on a well-formed result", async () => {
    windowsBridgeWith({
      ...baseWindowsBridge,
      popout: () => Promise.resolve({ ok: true, windowId: 7 }),
    });
    expect(await shellPopout(ROUTE)).toEqual({ windowId: 7 });
  });

  it("maps a positive rect to rounded width/height payload keys", async () => {
    let seen: unknown = null;
    windowsBridgeWith({
      ...baseWindowsBridge,
      popout: (payload: unknown) => {
        seen = payload;
        return Promise.resolve({ ok: true, windowId: 7 });
      },
    });
    expect(await shellPopout(ROUTE, { w: 640.4, h: 480.6 })).toEqual({ windowId: 7 });
    expect(seen).toEqual({ route: ROUTE, width: 640, height: 481 });
  });

  it("omits width/height when the rect is absent or non-positive", async () => {
    const seen: unknown[] = [];
    windowsBridgeWith({
      ...baseWindowsBridge,
      popout: (payload: unknown) => {
        seen.push(payload);
        return Promise.resolve({ ok: true, windowId: 7 });
      },
    });
    await shellPopout(ROUTE);
    await shellPopout(ROUTE, { w: 0, h: 480 });
    expect(seen).toEqual([{ route: ROUTE }, { route: ROUTE }]);
  });
});

describe("listShellServers optional fields", () => {
  it("parses newer optional fields and older entries", async () => {
    bridgeWith({
      ...baseServersBridge,
      list: () =>
        Promise.resolve({
          ok: true,
          servers: [
            { ...serverA, accentColor: "#8b7ff0", waiting: 3 },
            serverB,
          ],
        }),
    });
    expect(await listShellServers()).toEqual([
      { ...serverA, accentColor: "#8b7ff0", waiting: 3 },
      serverB,
    ]);
  });

  it("rejects wrong-typed optional fields", async () => {
    for (const entry of [
      { ...serverA, accentColor: 42 },
      { ...serverA, waiting: "3" },
    ]) {
      bridgeWith({
        ...baseServersBridge,
        list: () => Promise.resolve({ ok: true, servers: [entry] }),
      });
      expect(await listShellServers()).toBeNull();
    }
  });
});

// The web group backs the web tile's native engine: the fourteen core
// members shipped together in one shell release, so their presence is
// all-or-nothing (the `mode` and `park` invokers are additive, narrowed
// separately); the invokers degrade to false and the subscription to a
// no-op disposer everywhere else.

function fullWebBridge(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn(() => Promise.resolve({ ok: true })),
    destroy: vi.fn(() => Promise.resolve({ ok: true })),
    bounds: vi.fn(() => Promise.resolve({ ok: true })),
    visible: vi.fn(() => Promise.resolve({ ok: true })),
    load: vi.fn(() => Promise.resolve({ ok: true })),
    reload: vi.fn(() => Promise.resolve({ ok: true })),
    back: vi.fn(() => Promise.resolve({ ok: true })),
    forward: vi.fn(() => Promise.resolve({ ok: true })),
    find: vi.fn(() => Promise.resolve({ ok: true })),
    stopFind: vi.fn(() => Promise.resolve({ ok: true })),
    zoom: vi.fn(() => Promise.resolve({ ok: true })),
    chords: vi.fn(() => Promise.resolve({ ok: true })),
    devtools: vi.fn(() => Promise.resolve({ ok: true })),
    onEvent: vi.fn((_handler: (payload: unknown) => void) => vi.fn()),
    ...overrides,
  };
}

/** The pre-parity seven-member group (create/destroy/bounds/visible/load/
 *  reload/onEvent) — a shell that predates the parity channels. */
function legacyWebBridge() {
  const bridge = fullWebBridge() as Record<string, unknown>;
  for (const member of ["back", "forward", "find", "stopFind", "zoom", "chords", "devtools"]) {
    delete bridge[member];
  }
  return bridge;
}

function webBridgeWith(web: unknown): void {
  window.runkitShell = { version: "1.2.3", platform: "darwin", web };
}

describe("canShellWeb", () => {
  it("is false in a plain browser and on a shell without the web group", () => {
    expect(canShellWeb()).toBe(false);
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(canShellWeb()).toBe(false);
  });

  it("is false on a partial group (a missing member fails the whole group)", () => {
    const partial = fullWebBridge();
    delete (partial as Record<string, unknown>).onEvent;
    webBridgeWith(partial);
    expect(canShellWeb()).toBe(false);
  });

  it("is false when a member is not a function", () => {
    webBridgeWith(fullWebBridge({ create: "nope" }));
    expect(canShellWeb()).toBe(false);
  });

  it("is false on a pre-parity group (the seven-member 3d set narrows to null)", () => {
    webBridgeWith(legacyWebBridge());
    expect(canShellWeb()).toBe(false);
  });

  it("is true on the full fourteen-member group", () => {
    webBridgeWith(fullWebBridge());
    expect(canShellWeb()).toBe(true);
  });
});

describe("web bridge invokers", () => {
  it("forward arguments and resolve true on { ok: true }", async () => {
    const web = fullWebBridge();
    webBridgeWith(web);
    expect(await createShellWebView("web-1", "https://github.com")).toBe(true);
    expect(web.create).toHaveBeenCalledWith("web-1", "https://github.com", undefined);
    expect(await destroyShellWebView("web-1")).toBe(true);
    expect(web.destroy).toHaveBeenCalledWith("web-1");
    expect(await setShellWebViewBounds("web-1", { x: 10, y: 20, width: 300, height: 200 })).toBe(true);
    expect(web.bounds).toHaveBeenCalledWith("web-1", 10, 20, 300, 200);
    expect(await setShellWebViewVisible("web-1", false)).toBe(true);
    expect(web.visible).toHaveBeenCalledWith("web-1", false);
    expect(await loadShellWebView("web-1", "https://example.com")).toBe(true);
    expect(web.load).toHaveBeenCalledWith("web-1", "https://example.com");
    expect(await reloadShellWebView("web-1")).toBe(true);
    expect(web.reload).toHaveBeenCalledWith("web-1");
  });

  it("parity invokers forward arguments and resolve true on { ok: true }", async () => {
    const web = fullWebBridge();
    webBridgeWith(web);
    expect(await goBackShellWebView("web-1")).toBe(true);
    expect(web.back).toHaveBeenCalledWith("web-1");
    expect(await goForwardShellWebView("web-1")).toBe(true);
    expect(web.forward).toHaveBeenCalledWith("web-1");
    expect(await findShellWebView("web-1", "foo", { forward: true, findNext: false })).toBe(true);
    expect(web.find).toHaveBeenCalledWith("web-1", "foo", true, false);
    expect(await stopFindShellWebView("web-1")).toBe(true);
    expect(web.stopFind).toHaveBeenCalledWith("web-1");
    expect(await setShellWebViewZoom("web-1", 1.25)).toBe(true);
    expect(web.zoom).toHaveBeenCalledWith("web-1", 1.25);
    const chords = [{ code: "KeyK", ctrl: true, meta: false, shift: false, alt: false }];
    expect(await setShellWebViewChords("web-1", chords)).toBe(true);
    expect(web.chords).toHaveBeenCalledWith("web-1", chords);
    expect(await openShellWebViewDevTools("web-1")).toBe(true);
    expect(web.devtools).toHaveBeenCalledWith("web-1");
  });

  it("parity invokers resolve false outside the shell and on a pre-parity shell", async () => {
    expect(await goBackShellWebView("web-1")).toBe(false);
    expect(await findShellWebView("web-1", "x", { forward: true, findNext: false })).toBe(false);
    expect(await openShellWebViewDevTools("web-1")).toBe(false);
    webBridgeWith(legacyWebBridge());
    expect(await goBackShellWebView("web-1")).toBe(false);
    expect(await goForwardShellWebView("web-1")).toBe(false);
    expect(await findShellWebView("web-1", "x", { forward: false, findNext: true })).toBe(false);
    expect(await stopFindShellWebView("web-1")).toBe(false);
    expect(await setShellWebViewZoom("web-1", 1)).toBe(false);
    expect(await setShellWebViewChords("web-1", [])).toBe(false);
    expect(await openShellWebViewDevTools("web-1")).toBe(false);
  });

  it("parity invokers resolve false on a rejected invoke, never throwing", async () => {
    webBridgeWith(fullWebBridge({ zoom: () => Promise.reject(new Error("ipc gone")) }));
    expect(await setShellWebViewZoom("web-9", 1.5)).toBe(false);
    webBridgeWith(fullWebBridge({ devtools: () => Promise.resolve({ ok: false, error: "Unknown tab" }) }));
    expect(await openShellWebViewDevTools("web-9")).toBe(false);
  });

  it("resolve false outside the shell and on an older shell without the group", async () => {
    expect(await createShellWebView("web-1", "https://github.com")).toBe(false);
    expect(await destroyShellWebView("web-1")).toBe(false);
    expect(await setShellWebViewBounds("web-1", { x: 0, y: 0, width: 1, height: 1 })).toBe(false);
    expect(await setShellWebViewVisible("web-1", true)).toBe(false);
    expect(await loadShellWebView("web-1", "https://example.com")).toBe(false);
    expect(await reloadShellWebView("web-1")).toBe(false);
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(await createShellWebView("web-1", "https://github.com")).toBe(false);
    expect(await reloadShellWebView("web-1")).toBe(false);
  });

  it("resolve false on a non-{ok:true} result and on a rejected invoke, never throwing", async () => {
    webBridgeWith(fullWebBridge({ reload: () => Promise.resolve({ ok: false, error: "Unknown tab" }) }));
    expect(await reloadShellWebView("web-9")).toBe(false);
    webBridgeWith(fullWebBridge({ reload: () => Promise.reject(new Error("ipc gone")) }));
    expect(await reloadShellWebView("web-9")).toBe(false);
    webBridgeWith(fullWebBridge({ visible: () => Promise.resolve("shown") }));
    expect(await setShellWebViewVisible("web-1", true)).toBe(false);
  });
});

describe("parkShellWebView", () => {
  it("is unavailable outside the shell and on a shell whose web group lacks the additive park invoker", async () => {
    expect(canParkShellWebView()).toBe(false);
    expect(await parkShellWebView("web-1")).toBe(false);
    webBridgeWith(fullWebBridge());
    expect(canParkShellWebView()).toBe(false);
    expect(await parkShellWebView("web-1")).toBe(false);
  });

  it("narrows a non-function park member out (the group stays usable, park reads absent)", async () => {
    webBridgeWith(fullWebBridge({ park: "nope" }));
    expect(canShellWeb()).toBe(true);
    expect(canParkShellWebView()).toBe(false);
    expect(await parkShellWebView("web-1")).toBe(false);
  });

  it("forwards the tabKey and resolves true on { ok: true } when park is present", async () => {
    const park = vi.fn(() => Promise.resolve({ ok: true }));
    webBridgeWith(fullWebBridge({ park }));
    expect(canParkShellWebView()).toBe(true);
    expect(await parkShellWebView("web-1")).toBe(true);
    expect(park).toHaveBeenCalledWith("web-1");
  });

  it("resolves false on a rejected invoke and a non-{ok:true} result, never throwing", async () => {
    webBridgeWith(fullWebBridge({ park: () => Promise.reject(new Error("ipc gone")) }));
    expect(await parkShellWebView("web-1")).toBe(false);
    webBridgeWith(fullWebBridge({ park: () => Promise.resolve({ ok: false, error: "Unknown tab" }) }));
    expect(await parkShellWebView("web-1")).toBe(false);
  });
});

describe("shellWebMode", () => {
  it("resolves the reported mode on an { ok: true } result", async () => {
    for (const mode of ["direct", "proxy", "legacy"] as const) {
      const modeFn = vi.fn(() => Promise.resolve({ ok: true, mode }));
      webBridgeWith(fullWebBridge({ mode: modeFn }));
      expect(await shellWebMode()).toBe(mode);
      expect(modeFn).toHaveBeenCalledTimes(1);
    }
  });

  it("resolves legacy outside the shell and on an older shell without the mode invoker", async () => {
    expect(await shellWebMode()).toBe("legacy");
    window.runkitShell = { version: "1.2.3", platform: "darwin" };
    expect(await shellWebMode()).toBe("legacy");
    webBridgeWith(fullWebBridge());
    expect(await shellWebMode()).toBe("legacy");
  });

  it("resolves legacy on a rejected invoke and on malformed/denied results, never throwing", async () => {
    webBridgeWith(fullWebBridge({ mode: () => Promise.reject(new Error("ipc gone")) }));
    expect(await shellWebMode()).toBe("legacy");
    webBridgeWith(fullWebBridge({ mode: () => Promise.resolve({ ok: false, error: "denied" }) }));
    expect(await shellWebMode()).toBe("legacy");
    webBridgeWith(fullWebBridge({ mode: () => Promise.resolve({ ok: true, mode: "turbo" }) }));
    expect(await shellWebMode()).toBe("legacy");
    webBridgeWith(fullWebBridge({ mode: () => Promise.resolve({ ok: true }) }));
    expect(await shellWebMode()).toBe("legacy");
    webBridgeWith(fullWebBridge({ mode: () => Promise.resolve("direct") }));
    expect(await shellWebMode()).toBe("legacy");
  });

  it("a non-function mode member does not poison the group (mode reads as legacy)", async () => {
    webBridgeWith(fullWebBridge({ mode: "nope" }));
    expect(canShellWeb()).toBe(true);
    expect(await shellWebMode()).toBe("legacy");
  });
});

describe("parseShellWebEvent", () => {
  it("parses each relay kind with its fields", () => {
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "title", title: "GitHub" })).toEqual({
      tabKey: "web-1",
      kind: "title",
      title: "GitHub",
    });
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "favicon", favicons: ["https://x/f.ico"] }),
    ).toEqual({ tabKey: "web-1", kind: "favicon", favicons: ["https://x/f.ico"] });
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "loading", loading: true })).toEqual({
      tabKey: "web-1",
      kind: "loading",
      loading: true,
    });
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "failed", code: -105, description: "NAME_NOT_RESOLVED", url: "https://x" }),
    ).toEqual({ tabKey: "web-1", kind: "failed", code: -105, description: "NAME_NOT_RESOLVED", url: "https://x" });
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "url", url: "https://x/y", canGoBack: true, canGoForward: false }),
    ).toEqual({ tabKey: "web-1", kind: "url", url: "https://x/y", canGoBack: true, canGoForward: false });
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "focus" })).toEqual({
      tabKey: "web-1",
      kind: "focus",
    });
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "zoom", direction: "in" })).toEqual({
      tabKey: "web-1",
      kind: "zoom",
      direction: "in",
    });
  });

  it("parses the find relay with its ordinal fields", () => {
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "find", active: 2, total: 5, final: true }),
    ).toEqual({ tabKey: "web-1", kind: "find", active: 2, total: 5, final: true });
  });

  it("parses the chord relay with its key and modifier fields", () => {
    expect(
      parseShellWebEvent({
        tabKey: "web-1",
        kind: "chord",
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toEqual({
      tabKey: "web-1",
      kind: "chord",
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    });
  });

  it("url carries an optional numeric httpStatus and omits it otherwise", () => {
    expect(
      parseShellWebEvent({
        tabKey: "web-1",
        kind: "url",
        url: "https://x/y",
        canGoBack: false,
        canGoForward: false,
        httpStatus: 502,
      }),
    ).toEqual({
      tabKey: "web-1",
      kind: "url",
      url: "https://x/y",
      canGoBack: false,
      canGoForward: false,
      httpStatus: 502,
    });
    expect(
      parseShellWebEvent({
        tabKey: "web-1",
        kind: "url",
        url: "https://x/y",
        canGoBack: false,
        canGoForward: false,
      }),
    ).toEqual({ tabKey: "web-1", kind: "url", url: "https://x/y", canGoBack: false, canGoForward: false });
  });

  it("drops a wrong-typed httpStatus and malformed find/chord payloads", () => {
    expect(
      parseShellWebEvent({
        tabKey: "web-1",
        kind: "url",
        url: "https://x/y",
        canGoBack: false,
        canGoForward: false,
        httpStatus: "502",
      }),
    ).toBeNull();
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "find", active: 1, total: "x", final: true }),
    ).toBeNull();
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "find", active: 1, total: 2 }),
    ).toBeNull();
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "chord", key: "k", code: "KeyK", ctrlKey: "yes", metaKey: false, shiftKey: false, altKey: false }),
    ).toBeNull();
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "chord", key: "k" }),
    ).toBeNull();
  });

  it("returns null for non-objects, a missing/non-string tabKey, and unknown kinds", () => {
    expect(parseShellWebEvent("garbage")).toBeNull();
    expect(parseShellWebEvent(null)).toBeNull();
    expect(parseShellWebEvent(42)).toBeNull();
    expect(parseShellWebEvent({ kind: "title", title: "x" })).toBeNull();
    expect(parseShellWebEvent({ tabKey: 7, kind: "title", title: "x" })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "bogus" })).toBeNull();
  });

  it("returns null on wrong-typed required fields", () => {
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "title" })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "title", title: 3 })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "loading", loading: "yes" })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "failed", code: "x", description: "d", url: "u" })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "url", url: "https://x", canGoBack: true })).toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "favicon", favicons: "no" })).toBeNull();
  });

  it("keeps only string favicon entries and accepts only in/out zoom directions", () => {
    expect(
      parseShellWebEvent({ tabKey: "web-1", kind: "favicon", favicons: ["https://x/f.ico", 42, null] }),
    ).toEqual({ tabKey: "web-1", kind: "favicon", favicons: ["https://x/f.ico"] });
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "zoom", direction: "in" })).not.toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "zoom", direction: "out" })).not.toBeNull();
    expect(parseShellWebEvent({ tabKey: "web-1", kind: "zoom", direction: "reset" })).toBeNull();
  });
});

describe("onShellWebEvent", () => {
  it("returns a callable no-op disposer outside the shell and never fires", () => {
    const handler = vi.fn();
    const off = onShellWebEvent(handler);
    expect(typeof off).toBe("function");
    off();
    expect(handler).not.toHaveBeenCalled();
  });

  it("forwards parsed events and drops malformed payloads", () => {
    let relay: ((payload: unknown) => void) | null = null;
    const disposer = vi.fn();
    webBridgeWith(
      fullWebBridge({
        onEvent: (h: (payload: unknown) => void) => {
          relay = h;
          return disposer;
        },
      }),
    );
    const handler = vi.fn();
    const off = onShellWebEvent(handler);
    expect(relay).not.toBeNull();
    relay!({ tabKey: "web-1", kind: "title", title: "GitHub" });
    relay!({ tabKey: "web-1", kind: "bogus" });
    relay!("garbage");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ tabKey: "web-1", kind: "title", title: "GitHub" });
    off();
    expect(disposer).toHaveBeenCalledTimes(1);
  });
});
