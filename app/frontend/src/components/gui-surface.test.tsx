import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi, type Mock } from "vitest";
import { render, cleanup, fireEvent, act, screen } from "@testing-library/react";
import type { GuiSignal } from "@/contexts/session-context";
import type { GuiSurfaceCommands } from "./gui-surface";
import GuiSurface from "./gui-surface";
import RFB from "@novnc/novnc";
import { fetchGuiStatus, pingGui } from "@/api/client";
import { copyToClipboard } from "@/lib/clipboard";

// Fake RFB: settable plain props, an event registry tests can fire, and vi.fn
// seams for the verbs. `emit` delivers to every registered listener with a
// `{detail}` event envelope, mirroring noVNC's CustomEvent payloads. The class
// lives INSIDE the factory (vi.mock hoists); tests reach it via the default
// export below. The constructor appends a `<canvas>` to its target, mirroring
// noVNC's display mount, so the stats seam's canvas lookup has a node.
vi.mock("@novnc/novnc", () => {
  class FakeRFB {
    static instances: FakeRFB[] = [];
    scaleViewport = false;
    clipViewport = false;
    dragViewport = false;
    resizeSession = false;
    qualityLevel = 6;
    compressionLevel = 2;
    showDotCursor = false;
    viewOnly = false;
    focusOnClick = false;
    background = "white";
    disconnect = vi.fn();
    sendCredentials = vi.fn();
    clipboardPasteFrom = vi.fn();
    sendKey = vi.fn();
    focus = vi.fn();
    private listeners = new Map<string, Set<(e: { detail?: unknown }) => void>>();
    constructor(
      public target: HTMLElement,
      public urlOrChannel: unknown,
      public options?: unknown,
    ) {
      target.appendChild(document.createElement("canvas"));
      FakeRFB.instances.push(this);
    }
    addEventListener(type: string, fn: (e: { detail?: unknown }) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(fn);
    }
    removeEventListener(type: string, fn: (e: { detail?: unknown }) => void) {
      this.listeners.get(type)?.delete(fn);
    }
    emit(type: string, detail?: unknown) {
      for (const fn of this.listeners.get(type) ?? []) fn({ detail });
    }
  }
  return { default: FakeRFB };
});

// Fake WebSocket: records the URL and lets tests dispatch `message` events
// (the stats seam's byte counter) — jsdom's real WebSocket would dial.
class FakeWS {
  static instances: FakeWS[] = [];
  private listeners = new Map<string, Set<(e: { data?: unknown }) => void>>();
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {}
  send() {}
  emitMessage(data: unknown) {
    for (const fn of this.listeners.get("message") ?? []) fn({ data });
  }
}

// A per-canvas fake 2D context — jsdom's getContext returns null, and the
// stats seam wraps drawImage on the context INSTANCE.
type FakeCtx = { drawImage: Mock<(image: CanvasImageSource, ...args: number[]) => void> };
const fakeCtxs = new WeakMap<HTMLCanvasElement, FakeCtx>();
function fakeCtxFor(canvas: HTMLCanvasElement): FakeCtx {
  let ctx = fakeCtxs.get(canvas);
  if (!ctx) {
    ctx = { drawImage: vi.fn<(image: CanvasImageSource, ...args: number[]) => void>() };
    fakeCtxs.set(canvas, ctx);
  }
  return ctx;
}

vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  fetchGuiStatus: vi.fn(),
  pingGui: vi.fn(),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(),
}));

type FakeRFBInstance = {
  urlOrChannel: unknown;
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  resizeSession: boolean;
  qualityLevel: number;
  compressionLevel: number;
  showDotCursor: boolean;
  viewOnly: boolean;
  focusOnClick: boolean;
  background: string;
  disconnect: ReturnType<typeof vi.fn>;
  sendCredentials: ReturnType<typeof vi.fn>;
  clipboardPasteFrom: ReturnType<typeof vi.fn>;
  sendKey: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  emit(type: string, detail?: unknown): void;
};

const FakeRFBClass = RFB as unknown as {
  instances: FakeRFBInstance[];
  new (...args: unknown[]): FakeRFBInstance;
};

const GUI_ON: GuiSignal = {
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
  geometry: "auto",
};

const GUI_OFF: GuiSignal = { ...GUI_ON, enabled: false, reachable: false };
const GUI_UNREACHABLE: GuiSignal = { ...GUI_ON, reachable: false };
const GUI_BARE: GuiSignal = { ...GUI_ON, wm: "" };
const WM_HINT = "sudo apt install --no-install-recommends icewm";

function mockBareStatus(hint: string | undefined = WM_HINT) {
  vi.mocked(fetchGuiStatus).mockResolvedValue({
    wm: "",
    ...(hint === undefined ? {} : { wm_hint: hint }),
  } as Awaited<ReturnType<typeof fetchGuiStatus>>);
}

function guiProps(overrides: Partial<Parameters<typeof GuiSurface>[0]> = {}) {
  const props = {
    gui: GUI_ON,
    visible: true,
    focused: true,
    coarsePointer: false,
    quality: "balanced" as const,
    statsVisible: false,
    zoom: "fit" as const,
    pointerMode: "touch" as const,
    onZoomChange: vi.fn(),
    onPointerModeChange: vi.fn(),
    hidpi: false,
    keyBarVisible: true,
    onKeyBarVisibleChange: vi.fn(),
    onQualityChange: vi.fn(),
    onStatsVisibleChange: vi.fn(),
    onFullscreenChange: vi.fn(),
    resizeLocked: false,
    onConnectionChange: vi.fn(),
    onRestart: vi.fn().mockResolvedValue({ ok: true }),
    onOpenLogs: vi.fn(),
    ...overrides,
  };
  return props;
}

function guiEl(overrides: Partial<Parameters<typeof GuiSurface>[0]> = {}) {
  return <GuiSurface {...guiProps(overrides)} />;
}

function renderGui(overrides: Partial<Parameters<typeof GuiSurface>[0]> = {}) {
  const props = guiProps(overrides);
  return { ...render(<GuiSurface {...props} />), props };
}

const latestRfb = () => FakeRFBClass.instances[FakeRFBClass.instances.length - 1];

// jsdom has no TouchEvent constructor: plain Events with the touch lists
// assigned, which every handler under test reads.
function touchEvent(type: string, x: number, y: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const points = [{ clientX: x, clientY: y }];
  Object.assign(e, { touches: points, changedTouches: points });
  return e;
}

beforeEach(() => {
  FakeRFBClass.instances = [];
  FakeWS.instances = [];
  vi.mocked(fetchGuiStatus).mockReset();
  vi.mocked(pingGui).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyToClipboard).mockReset();
  localStorage.clear();
});

beforeAll(() => {
  vi.stubGlobal("WebSocket", FakeWS);
  // jsdom has no real canvas: getContext returns a per-canvas fake 2D ctx.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== "2d") return null;
    return fakeCtxFor(this) as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GuiSurface — content states", () => {
  it("enabled+reachable mounts the canvas host and dials an absolute ws:// URL", () => {
    renderGui();
    expect(screen.getByTestId("gui-surface-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("gui-surface-empty")).toBeNull();
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0].url).toBe(`ws://${window.location.host}/ws/gui/host`);
    expect(FakeWS.instances[0].url.startsWith("ws://")).toBe(true);
    // The constructed socket, not the URL string, is handed to the RFB
    // (noVNC 1.7's raw-channel constructor form — the byte counter's seam).
    expect(latestRfb().urlOrChannel).toBe(FakeWS.instances[0]);
  });

  it("enabled+unreachable renders the empty state with the fetched reason, and opens no WebSocket", async () => {
    vi.mocked(fetchGuiStatus).mockResolvedValue({
      reason: "no VNC backend: sudo apt install tigervnc-standalone-server openbox",
    } as Awaited<ReturnType<typeof fetchGuiStatus>>);
    renderGui({ gui: GUI_UNREACHABLE });
    expect(screen.getByTestId("gui-surface-empty")).toHaveTextContent(
      "GUI is on but not running",
    );
    expect(FakeRFBClass.instances).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(0);
    expect(
      await screen.findByText(
        "no VNC backend: sudo apt install tigervnc-standalone-server openbox",
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(fetchGuiStatus)).toHaveBeenCalledTimes(1);
  });

  it("a failed reason GET leaves the empty state without a reason line", async () => {
    vi.mocked(fetchGuiStatus).mockRejectedValue(new Error("boom"));
    renderGui({ gui: GUI_UNREACHABLE });
    expect(screen.getByTestId("gui-surface-empty")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByTestId("gui-surface-reason")).toBeNull();
  });

  it("the reason GET fires once per unreachable transition, not per render", async () => {
    vi.mocked(fetchGuiStatus).mockResolvedValue({ reason: "r" } as Awaited<
      ReturnType<typeof fetchGuiStatus>
    >);
    const { rerender } = renderGui({ gui: GUI_UNREACHABLE });
    await act(async () => {});
    rerender(guiEl({ gui: GUI_UNREACHABLE }));
    await act(async () => {});
    expect(vi.mocked(fetchGuiStatus)).toHaveBeenCalledTimes(1);
  });

  it("a 409 from Restart supervisor renders 'gui turned off'", async () => {
    vi.mocked(fetchGuiStatus).mockResolvedValue({ reason: "" } as Awaited<
      ReturnType<typeof fetchGuiStatus>
    >);
    const { props } = renderGui({
      gui: GUI_UNREACHABLE,
      onRestart: vi.fn().mockResolvedValue({ ok: false, disabled: true }),
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Restart supervisor" }));
    await act(async () => {});
    expect(props.onRestart).toHaveBeenCalledOnce();
    expect(screen.getByTestId("gui-surface-empty")).toHaveTextContent("gui turned off");
  });

  it("Open supervisor logs routes to the callback", async () => {
    vi.mocked(fetchGuiStatus).mockResolvedValue({ reason: "" } as Awaited<
      ReturnType<typeof fetchGuiStatus>
    >);
    const { props } = renderGui({ gui: GUI_UNREACHABLE });
    fireEvent.click(screen.getByRole("button", { name: "Open supervisor logs" }));
    expect(props.onOpenLogs).toHaveBeenCalledOnce();
  });

  it("a disabled signal renders nothing (degradation owns that state)", () => {
    renderGui({ gui: GUI_OFF });
    expect(screen.queryByTestId("gui-surface-canvas")).toBeNull();
    expect(screen.queryByTestId("gui-surface-empty")).toBeNull();
  });
});

describe("GuiSurface — the bare-WM strip", () => {
  it("WM present mounts the canvas host and no strip (and no status GET)", async () => {
    renderGui();
    expect(screen.getByTestId("gui-surface-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("gui-wm-strip")).toBeNull();
    await act(async () => {});
    expect(vi.mocked(fetchGuiStatus)).not.toHaveBeenCalled();
  });

  it("bare renders the strip with the exact text and the fetched install line, once per transition", async () => {
    mockBareStatus();
    const { rerender } = renderGui({ gui: GUI_BARE });
    const strip = await screen.findByTestId("gui-wm-strip");
    await act(async () => {});
    expect(strip).toHaveTextContent(
      "No window manager on the GUI host — sudo apt install --no-install-recommends icewm · then Restart supervisor",
    );
    expect(screen.getByRole("button", { name: "Copy install line" })).toHaveTextContent("Copy");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    rerender(guiEl({ gui: GUI_BARE }));
    await act(async () => {});
    expect(vi.mocked(fetchGuiStatus)).toHaveBeenCalledTimes(1);
  });

  it("the strip is the first child of the canvas wrapper, before the noVNC host div", async () => {
    mockBareStatus();
    renderGui({ gui: GUI_BARE });
    const strip = await screen.findByTestId("gui-wm-strip");
    const canvas = screen.getByTestId("gui-surface-canvas");
    expect(canvas.firstElementChild).toBe(strip);
    expect(strip.nextElementSibling).toHaveClass("flex-1", "min-h-0");
  });

  it("a failed status GET leaves the strip without the install segment and without Copy", async () => {
    vi.mocked(fetchGuiStatus).mockRejectedValue(new Error("boom"));
    renderGui({ gui: GUI_BARE });
    const strip = await screen.findByTestId("gui-wm-strip");
    await act(async () => {});
    expect(strip).toHaveTextContent("No window manager on the GUI host · then Restart supervisor");
    expect(strip).not.toHaveTextContent("apt install");
    expect(screen.queryByRole("button", { name: "Copy install line" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("the screen-sharing backend never renders the strip, even bare", async () => {
    mockBareStatus();
    renderGui({ gui: { ...GUI_BARE, backend: "screen-sharing" } });
    expect(screen.getByTestId("gui-surface-canvas")).toBeInTheDocument();
    await act(async () => {});
    expect(screen.queryByTestId("gui-wm-strip")).toBeNull();
    expect(vi.mocked(fetchGuiStatus)).not.toHaveBeenCalled();
  });

  it("Copy copies exactly the install line and reads Copied for 1.5s", async () => {
    vi.useFakeTimers();
    mockBareStatus();
    vi.mocked(copyToClipboard).mockResolvedValue(true);
    renderGui({ gui: GUI_BARE });
    expect(screen.getByTestId("gui-wm-strip")).toBeInTheDocument();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Copy install line" }));
    await act(async () => {});
    expect(copyToClipboard).toHaveBeenCalledOnce();
    expect(copyToClipboard).toHaveBeenCalledWith(WM_HINT);
    expect(screen.getByRole("button", { name: "Copy install line" })).toHaveTextContent("Copied");
    act(() => void vi.advanceTimersByTime(1_500));
    expect(screen.getByRole("button", { name: "Copy install line" })).toHaveTextContent("Copy");
  });

  it("a failed copy leaves the strip unchanged", async () => {
    mockBareStatus();
    vi.mocked(copyToClipboard).mockResolvedValue(false);
    renderGui({ gui: GUI_BARE });
    await screen.findByTestId("gui-wm-strip");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Copy install line" }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Copy install line" })).toHaveTextContent("Copy");
  });

  it("Restart supervisor in the strip calls onRestart", async () => {
    mockBareStatus();
    const { props } = renderGui({ gui: GUI_BARE });
    await screen.findByTestId("gui-wm-strip");
    fireEvent.click(screen.getByRole("button", { name: "Restart supervisor" }));
    expect(props.onRestart).toHaveBeenCalledOnce();
  });

  it("× hides the strip and persists the dismissal; a remount honors it", async () => {
    mockBareStatus();
    const first = renderGui({ gui: GUI_BARE });
    await screen.findByTestId("gui-wm-strip");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("gui-wm-strip")).toBeNull();
    expect(localStorage.getItem("hexokit-gui-wm-strip-dismissed")).toBe("1");
    first.unmount();

    renderGui({ gui: GUI_BARE });
    await act(async () => {});
    expect(screen.getByTestId("gui-surface-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("gui-wm-strip")).toBeNull();
  });

  it("a wm flip to non-empty removes the dismissal key (a later bare state shows the strip again)", async () => {
    localStorage.setItem("hexokit-gui-wm-strip-dismissed", "1");
    mockBareStatus();
    const { rerender } = renderGui({ gui: GUI_BARE });
    expect(screen.queryByTestId("gui-wm-strip")).toBeNull();

    rerender(guiEl());
    await act(async () => {});
    expect(localStorage.getItem("hexokit-gui-wm-strip-dismissed")).toBeNull();

    rerender(guiEl({ gui: GUI_BARE }));
    expect(await screen.findByTestId("gui-wm-strip")).toBeInTheDocument();
  });
});

describe("GuiSurface — RFB prop mapping", () => {
  it("resizeSession = !coarsePointer && focused && !resizeLocked && !hostLocked && geometry === \"auto\" && zoom === \"fit\", recomputed on prop change", () => {
    const { rerender } = renderGui();
    expect(latestRfb().resizeSession).toBe(true);

    rerender(guiEl({ resizeLocked: true }));
    expect(latestRfb().resizeSession).toBe(false);
    rerender(guiEl({ focused: false }));
    expect(latestRfb().resizeSession).toBe(false);
    rerender(guiEl({ coarsePointer: true }));
    expect(latestRfb().resizeSession).toBe(false);
    // The host pin (`rk gui lock`) is an AND term beside the viewer-local lock.
    rerender(guiEl({ gui: { ...GUI_ON, locked: true } }));
    expect(latestRfb().resizeSession).toBe(false);
    // A zoomed screen is deliberately larger than the tile and must not drive
    // SetDesktopSize — held false until back at fit.
    rerender(guiEl({ zoom: 150 }));
    expect(latestRfb().resizeSession).toBe(false);
    rerender(guiEl());
    expect(latestRfb().resizeSession).toBe(true);
  });

  it("a fixed geometry (or \"\") forces resizeSession false regardless of the other clauses", () => {
    const { rerender } = renderGui({ gui: { ...GUI_ON, geometry: "1920x1080" } });
    expect(latestRfb().resizeSession).toBe(false);

    rerender(guiEl({ gui: { ...GUI_ON, geometry: "" } }));
    expect(latestRfb().resizeSession).toBe(false);

    // Flipping the setting back to `auto` re-enables the follow live.
    rerender(guiEl({ gui: { ...GUI_ON, geometry: "auto" } }));
    expect(latestRfb().resizeSession).toBe(true);
  });

  it("zoom keeps scaleViewport on and clipViewport off; dragViewport only for a coarse touch-mode pointer while zoomed", () => {
    const { rerender } = renderGui({ zoom: "fit" });
    expect(latestRfb().scaleViewport).toBe(true);
    expect(latestRfb().clipViewport).toBe(false);
    expect(latestRfb().dragViewport).toBe(false);

    rerender(guiEl({ zoom: 150 }));
    expect(latestRfb().scaleViewport).toBe(true);
    expect(latestRfb().clipViewport).toBe(false);
    // Fine pointer: the wrapper's own drag pan — dragViewport stays off.
    expect(latestRfb().dragViewport).toBe(false);

    rerender(guiEl({ zoom: 150, coarsePointer: true, pointerMode: "touch" }));
    expect(latestRfb().dragViewport).toBe(true);

    // Trackpad mode forces it off — the translation layer owns the touches.
    rerender(guiEl({ zoom: 150, coarsePointer: true, pointerMode: "trackpad" }));
    expect(latestRfb().dragViewport).toBe(false);

    rerender(guiEl({ zoom: "fit", coarsePointer: true, pointerMode: "touch" }));
    expect(latestRfb().dragViewport).toBe(false);
  });

  it("quality follows the named preset tuple, applied live on prop change; coarse never resizes", () => {
    const { rerender } = renderGui({ quality: "sharp" });
    expect(latestRfb().qualityLevel).toBe(8);
    expect(latestRfb().compressionLevel).toBe(1);

    rerender(guiEl({ quality: "balanced" }));
    expect(latestRfb().qualityLevel).toBe(6);
    expect(latestRfb().compressionLevel).toBe(2);

    rerender(guiEl({ quality: "smooth" }));
    expect(latestRfb().qualityLevel).toBe(3);
    expect(latestRfb().compressionLevel).toBe(7);

    rerender(guiEl({ quality: "balanced", coarsePointer: true }));
    expect(latestRfb().qualityLevel).toBe(6);
    expect(latestRfb().compressionLevel).toBe(2);
    expect(latestRfb().resizeSession).toBe(false);
  });

  it("sets showDotCursor/focusOnClick/background, and viewOnly on screen-sharing", () => {
    renderGui({ gui: { ...GUI_ON, backend: "screen-sharing" } });
    const rfb = latestRfb();
    expect(rfb.showDotCursor).toBe(true);
    expect(rfb.focusOnClick).toBe(true);
    expect(rfb.background).toBe("");
    expect(rfb.viewOnly).toBe(true);
  });

  it("viewOnly stays false on the Xvnc backend", () => {
    renderGui();
    expect(latestRfb().viewOnly).toBe(false);
  });
});

describe("GuiSurface — zoom rendering (the sized host)", () => {
  it("sizes the noVNC host div to fb × z/100 for each zoom step; fit leaves it tile-sized", () => {
    const { rerender } = renderGui({ zoom: 100 });
    const host = screen.getByTestId("gui-novnc-host");
    expect(host.style.width).toBe("1920px");
    expect(host.style.height).toBe("1080px");
    expect(host).not.toHaveClass("flex-1");

    for (const z of [50, 75, 125, 150, 200] as const) {
      rerender(guiEl({ zoom: z }));
      expect(host.style.width).toBe(`${(1920 * z) / 100}px`);
      expect(host.style.height).toBe(`${(1080 * z) / 100}px`);
    }

    rerender(guiEl({ zoom: "fit" }));
    expect(host.style.width).toBe("");
    expect(host.style.height).toBe("");
    expect(host).toHaveClass("flex-1");
    // fit is unchanged from before zoom: scaleViewport letterbox + the
    // resizeSession formula back in force.
    expect(latestRfb().scaleViewport).toBe(true);
    expect(latestRfb().resizeSession).toBe(true);
  });

  it("follows framebuffer size changes from the gui signal", () => {
    const { rerender } = renderGui({ zoom: 150 });
    rerender(guiEl({ zoom: 150, gui: { ...GUI_ON, width: 1280, height: 720 } }));
    const host = screen.getByTestId("gui-novnc-host");
    expect(host.style.width).toBe("1920px");
    expect(host.style.height).toBe("1080px");
  });
});

describe("GuiSurface — zoom badge", () => {
  it("does not show on the initial mount (nothing changed yet)", () => {
    vi.useFakeTimers();
    renderGui({ zoom: 150 });
    expect(screen.queryByTestId("gui-zoom-badge")).toBeNull();
  });

  it("shows the new zoom on change, hides after 1.5s, and a second change restarts the timer", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui({ zoom: 100 });
    rerender(guiEl({ zoom: 125 }));
    expect(screen.getByTestId("gui-zoom-badge")).toHaveTextContent("125%");
    act(() => void vi.advanceTimersByTime(1_000));
    rerender(guiEl({ zoom: 150 }));
    expect(screen.getByTestId("gui-zoom-badge")).toHaveTextContent("150%");
    act(() => void vi.advanceTimersByTime(1_499));
    expect(screen.getByTestId("gui-zoom-badge")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByTestId("gui-zoom-badge")).toBeNull();
  });

  it("reads 'fit' when zooming out to fit", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui({ zoom: 200 });
    rerender(guiEl({ zoom: "fit" }));
    expect(screen.getByTestId("gui-zoom-badge")).toHaveTextContent("fit");
    act(() => void vi.advanceTimersByTime(1_500));
    expect(screen.queryByTestId("gui-zoom-badge")).toBeNull();
  });

  it("clears the hide timer on unmount", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = renderGui({ zoom: 100 });
    rerender(guiEl({ zoom: 125 }));
    unmount();
    act(() => void vi.advanceTimersByTime(5_000));
  });
});

describe("GuiSurface — pan", () => {
  // jsdom has no layout: the wrapper's scroll geometry is stubbed so the
  // clamp math has something to bite on.
  function stubScrollGeometry(el: HTMLElement, viewport: [number, number], content: [number, number]) {
    let left = 0;
    let top = 0;
    Object.defineProperties(el, {
      clientWidth: { get: () => viewport[0], configurable: true },
      clientHeight: { get: () => viewport[1], configurable: true },
      scrollWidth: { get: () => content[0], configurable: true },
      scrollHeight: { get: () => content[1], configurable: true },
      scrollLeft: { get: () => left, set: (v: number) => { left = v; }, configurable: true },
      scrollTop: { get: () => top, set: (v: number) => { top = v; }, configurable: true },
    });
  }

  it("a fine drag pans the visible window and no mousedown-derived state reaches the canvas subtree", () => {
    renderGui({ zoom: 150 });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    stubScrollGeometry(wrapper, [800, 600], [2880, 1620]);
    const host = screen.getByTestId("gui-novnc-host");
    const mouseSpy = vi.fn();
    host.addEventListener("mousedown", mouseSpy);
    host.addEventListener("mousemove", mouseSpy);
    host.addEventListener("mouseup", mouseSpy);

    fireEvent.mouseDown(host, { button: 0, clientX: 400, clientY: 300 });
    fireEvent.mouseMove(wrapper, { clientX: 300, clientY: 250 });
    fireEvent.mouseMove(wrapper, { clientX: 250, clientY: 250 });
    fireEvent.mouseUp(wrapper, { clientX: 250, clientY: 250 });

    expect(wrapper.scrollLeft).toBe(150);
    expect(wrapper.scrollTop).toBe(50);
    expect(mouseSpy).not.toHaveBeenCalled();
  });

  it("clamps the pan at the content edges so the canvas always covers the tile", () => {
    renderGui({ zoom: 150 });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    stubScrollGeometry(wrapper, [800, 600], [2880, 1620]);
    const host = screen.getByTestId("gui-novnc-host");

    fireEvent.mouseDown(host, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(wrapper, { clientX: -5_000, clientY: -5_000 });
    fireEvent.mouseUp(wrapper, { clientX: -5_000, clientY: -5_000 });
    expect(wrapper.scrollLeft).toBe(2_080);
    expect(wrapper.scrollTop).toBe(1_020);

    fireEvent.mouseDown(host, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.mouseMove(wrapper, { clientX: 99_999, clientY: 99_999 });
    fireEvent.mouseUp(wrapper, { clientX: 99_999, clientY: 99_999 });
    expect(wrapper.scrollLeft).toBe(0);
    expect(wrapper.scrollTop).toBe(0);
  });

  it("a sub-threshold release replays a click to the canvas instead of panning", () => {
    renderGui({ zoom: 150 });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    stubScrollGeometry(wrapper, [800, 600], [2880, 1620]);
    const host = screen.getByTestId("gui-novnc-host");
    const canvas = host.querySelector("canvas")!;
    const pressSpy = vi.fn();
    canvas.addEventListener("mousedown", pressSpy);

    fireEvent.mouseDown(host, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(wrapper, { clientX: 103, clientY: 102 });
    fireEvent.mouseUp(wrapper, { clientX: 103, clientY: 102 });

    expect(wrapper.scrollLeft).toBe(0);
    expect(wrapper.scrollTop).toBe(0);
    // Exactly one mousedown — the replay; the swallowed original never landed.
    expect(pressSpy).toHaveBeenCalledOnce();
  });

  it("no pan gesture at fit — the press passes through to the canvas subtree", () => {
    renderGui({ zoom: "fit" });
    const host = screen.getByTestId("gui-novnc-host");
    const pressSpy = vi.fn();
    host.addEventListener("mousedown", pressSpy);
    fireEvent.mouseDown(host, { button: 0, clientX: 10, clientY: 10 });
    expect(pressSpy).toHaveBeenCalledOnce();
  });

  it("a press outside the noVNC host (the wm strip) is never swallowed", () => {
    mockBareStatus();
    renderGui({ gui: GUI_BARE, zoom: 150 });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    stubScrollGeometry(wrapper, [800, 600], [2880, 1620]);
    const strip = screen.getByTestId("gui-wm-strip");
    const stripSpy = vi.fn();
    strip.addEventListener("mousedown", stripSpy);
    fireEvent.mouseDown(strip, { button: 0, clientX: 50, clientY: 5 });
    expect(stripSpy).toHaveBeenCalledOnce();
  });

  it("a coarse one-finger drag pans in touch mode, inert at fit or in trackpad mode", () => {
    const { rerender } = renderGui({ zoom: 150, coarsePointer: true, pointerMode: "touch" });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    stubScrollGeometry(wrapper, [800, 600], [2880, 1620]);

    fireEvent(wrapper, touchEvent("touchstart", 200, 200));
    fireEvent(wrapper, touchEvent("touchmove", 150, 180));
    expect(wrapper.scrollLeft).toBe(50);
    expect(wrapper.scrollTop).toBe(20);
    fireEvent(wrapper, touchEvent("touchend", 150, 180));

    // A new gesture starts clean (no stale anchor from the last one).
    fireEvent(wrapper, touchEvent("touchstart", 10, 10));
    fireEvent(wrapper, touchEvent("touchmove", 0, 10));
    expect(wrapper.scrollLeft).toBe(60);

    rerender(guiEl({ zoom: "fit", coarsePointer: true, pointerMode: "touch" }));
    fireEvent(wrapper, touchEvent("touchstart", 200, 200));
    fireEvent(wrapper, touchEvent("touchmove", 100, 100));
    expect(wrapper.scrollLeft).toBe(60);

    rerender(guiEl({ zoom: 150, coarsePointer: true, pointerMode: "trackpad" }));
    fireEvent(wrapper, touchEvent("touchstart", 200, 200));
    fireEvent(wrapper, touchEvent("touchmove", 100, 100));
    expect(wrapper.scrollLeft).toBe(60);
  });
});

describe("GuiSurface — trackpad mode (the translation layer)", () => {
  it("attaches in trackpad mode (touches intercepted, rfb focused) and detaches on the touch flip", () => {
    const { rerender } = renderGui({ coarsePointer: true, pointerMode: "trackpad" });
    const host = screen.getByTestId("gui-novnc-host");
    const touchSpy = vi.fn();
    host.addEventListener("touchstart", touchSpy); // stands in for noVNC's canvas listeners

    fireEvent(host, touchEvent("touchstart", 100, 100));
    expect(latestRfb().focus).toHaveBeenCalledOnce();
    expect(touchSpy).not.toHaveBeenCalled();

    rerender(guiEl({ coarsePointer: true, pointerMode: "touch" }));
    fireEvent(host, touchEvent("touchstart", 100, 100));
    expect(touchSpy).toHaveBeenCalledOnce();
  });

  it("forces dragViewport false while attached; the touch flip restores the zoom rule", () => {
    const { rerender } = renderGui({ zoom: 150, coarsePointer: true, pointerMode: "trackpad" });
    expect(latestRfb().dragViewport).toBe(false);
    rerender(guiEl({ zoom: 150, coarsePointer: true, pointerMode: "touch" }));
    expect(latestRfb().dragViewport).toBe(true);
  });

  it("a mode flip mid-long-press releases the held button", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui({ coarsePointer: true, pointerMode: "trackpad" });
    const host = screen.getByTestId("gui-novnc-host");
    const canvas = host.querySelector("canvas")!;
    const upSpy = vi.fn();
    canvas.addEventListener("mouseup", upSpy);

    fireEvent(screen.getByTestId("gui-surface-canvas"), touchEvent("touchstart", 100, 100));
    act(() => void vi.advanceTimersByTime(500));
    rerender(guiEl({ coarsePointer: true, pointerMode: "touch" }));
    expect(upSpy).toHaveBeenCalledOnce();
  });

  it("renders the cursor indicator only in trackpad mode on coarse pointers", () => {
    const { rerender } = renderGui({ coarsePointer: true, pointerMode: "trackpad" });
    expect(screen.getByTestId("gui-trackpad-cursor")).toBeInTheDocument();
    rerender(guiEl({ coarsePointer: true, pointerMode: "touch" }));
    expect(screen.queryByTestId("gui-trackpad-cursor")).toBeNull();
    rerender(guiEl({ coarsePointer: false, pointerMode: "trackpad" }));
    expect(screen.queryByTestId("gui-trackpad-cursor")).toBeNull();
  });

  it("does not attach on a fine pointer even in trackpad mode", () => {
    renderGui({ coarsePointer: false, pointerMode: "trackpad" });
    fireEvent(screen.getByTestId("gui-surface-canvas"), touchEvent("touchstart", 100, 100));
    expect(latestRfb().focus).not.toHaveBeenCalled();
  });

  it("detaches while the credentials prompt is up — taps reach the password field and Connect", () => {
    renderGui({
      coarsePointer: true,
      pointerMode: "trackpad",
      gui: { ...GUI_ON, backend: "screen-sharing" },
    });
    // Attached: a canvas touch is owned and focuses the RFB.
    fireEvent(screen.getByTestId("gui-surface-canvas"), touchEvent("touchstart", 100, 100));
    expect(latestRfb().focus).toHaveBeenCalledOnce();

    act(() => latestRfb().emit("credentialsrequired"));
    for (const el of [
      screen.getByLabelText("Screen Sharing password"),
      screen.getByRole("button", { name: "Connect" }),
    ]) {
      const spy = vi.fn();
      el.addEventListener("touchstart", spy);
      // dispatchEvent returns false iff preventDefault ran — a swallowed tap.
      expect(el.dispatchEvent(touchEvent("touchstart", 10, 10))).toBe(true);
      expect(spy).toHaveBeenCalledOnce();
    }
    expect(latestRfb().focus).toHaveBeenCalledOnce(); // the detached layer is inert
  });
});

describe("GuiSurface — the key bar", () => {
  it("renders under the noVNC host div on coarse pointers, not on fine", () => {
    const { rerender } = renderGui({ coarsePointer: true });
    const bar = screen.getByTestId("gui-keybar");
    const host = screen.getByTestId("gui-novnc-host");
    expect(host.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    rerender(guiEl({ coarsePointer: false }));
    expect(screen.queryByTestId("gui-keybar")).toBeNull();
  });

  it("sends keys through the live RFB's sendKey; hidden in the credentials state", () => {
    renderGui({ coarsePointer: true });
    fireEvent.click(screen.getByRole("button", { name: "Esc" }));
    expect(latestRfb().sendKey).toHaveBeenCalledWith(0xff1b, "Escape", undefined);

    act(() => latestRfb().emit("credentialsrequired"));
    expect(screen.queryByTestId("gui-keybar")).toBeNull();
  });
});

describe("GuiSurface — Ctrl+wheel zoom", () => {
  it("steps once per accumulated 50px of Ctrl+wheel deltaY and swallows the event", () => {
    const { props } = renderGui({ zoom: 100 });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    const host = screen.getByTestId("gui-novnc-host");
    const wheelSpy = vi.fn();
    host.addEventListener("wheel", wheelSpy);

    // Sub-threshold deltas accumulate (mac trackpad pinch) rather than
    // stepping one notch per event.
    expect(fireEvent.wheel(host, { deltaY: -30, ctrlKey: true })).toBe(false);
    expect(props.onZoomChange).not.toHaveBeenCalled();
    expect(fireEvent.wheel(host, { deltaY: -30, ctrlKey: true })).toBe(false);
    expect(props.onZoomChange).toHaveBeenCalledWith(125);
    // Swallowed in capture — noVNC's wheel handler (the canvas subtree) and
    // the browser page zoom never see it.
    expect(wheelSpy).not.toHaveBeenCalled();
  });

  it("a large delta steps multiple notches at once", () => {
    const { props } = renderGui({ zoom: 100 });
    fireEvent.wheel(screen.getByTestId("gui-novnc-host"), { deltaY: -120, ctrlKey: true });
    expect(props.onZoomChange).toHaveBeenCalledWith(150);
  });

  it("saturation never emits a no-op change (fit stays fit on wheel-down)", () => {
    const { props } = renderGui({ zoom: "fit" });
    fireEvent.wheel(screen.getByTestId("gui-novnc-host"), { deltaY: 120, ctrlKey: true });
    expect(props.onZoomChange).not.toHaveBeenCalled();
  });

  it("wheel-down steps out through the ladder to fit", () => {
    const { props } = renderGui({ zoom: 50 });
    fireEvent.wheel(screen.getByTestId("gui-novnc-host"), { deltaY: 60, ctrlKey: true });
    expect(props.onZoomChange).toHaveBeenCalledWith("fit");
  });

  it("a wheel without Ctrl passes to the canvas subtree untouched", () => {
    const { props } = renderGui({ zoom: 100 });
    const host = screen.getByTestId("gui-novnc-host");
    const wheelSpy = vi.fn();
    host.addEventListener("wheel", wheelSpy);

    expect(fireEvent.wheel(host, { deltaY: -120 })).toBe(true);
    expect(wheelSpy).toHaveBeenCalledOnce();
    expect(props.onZoomChange).not.toHaveBeenCalled();
  });
});

describe("GuiSurface — connection lifecycle", () => {
  it("reports connect/disconnect through onConnectionChange (the dot seam)", () => {
    const { props } = renderGui();
    expect(props.onConnectionChange).not.toHaveBeenCalled();
    act(() => latestRfb().emit("connect"));
    expect(props.onConnectionChange).toHaveBeenLastCalledWith(true);
    act(() => latestRfb().emit("disconnect"));
    expect(props.onConnectionChange).toHaveBeenLastCalledWith(false);
  });

  it("a disconnect while reachable overlays 'disconnected — reconnecting…' and re-dials with 1s→2s→4s→8s backoff", () => {
    vi.useFakeTimers();
    renderGui();
    const first = latestRfb();
    act(() => first.emit("disconnect"));
    expect(screen.getByTestId("gui-surface-reconnecting")).toHaveTextContent(
      "disconnected — reconnecting…",
    );

    act(() => void vi.advanceTimersByTime(999));
    expect(FakeRFBClass.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeRFBClass.instances).toHaveLength(2);

    const second = latestRfb();
    act(() => second.emit("disconnect"));
    act(() => void vi.advanceTimersByTime(1999));
    expect(FakeRFBClass.instances).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeRFBClass.instances).toHaveLength(3);

    // Connect resets the backoff: the next drop waits 1s again.
    act(() => latestRfb().emit("connect"));
    expect(screen.queryByTestId("gui-surface-reconnecting")).toBeNull();
    act(() => latestRfb().emit("disconnect"));
    act(() => void vi.advanceTimersByTime(1000));
    expect(FakeRFBClass.instances).toHaveLength(4);
  });

  it("caps the backoff at 8s", () => {
    vi.useFakeTimers();
    renderGui();
    const drops = [1000, 2000, 4000, 8000];
    for (const wait of drops) {
      act(() => latestRfb().emit("disconnect"));
      act(() => void vi.advanceTimersByTime(wait));
    }
    const count = FakeRFBClass.instances.length;
    act(() => latestRfb().emit("disconnect"));
    act(() => void vi.advanceTimersByTime(7999));
    expect(FakeRFBClass.instances).toHaveLength(count);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeRFBClass.instances).toHaveLength(count + 1);
  });

  it("reachable flipping false mid-backoff clears the timer and renders the empty state", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchGuiStatus).mockResolvedValue({ reason: "" } as Awaited<
      ReturnType<typeof fetchGuiStatus>
    >);
    const { rerender } = renderGui();
    act(() => latestRfb().emit("disconnect"));
    expect(screen.getByTestId("gui-surface-reconnecting")).toBeInTheDocument();

    rerender(guiEl({ gui: GUI_UNREACHABLE }));
    expect(screen.getByTestId("gui-surface-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("gui-surface-reconnecting")).toBeNull();
    const count = FakeRFBClass.instances.length;
    act(() => void vi.advanceTimersByTime(30_000));
    expect(FakeRFBClass.instances).toHaveLength(count);
    await act(async () => {});
  });

  it("disconnects after 15s not-visible and reconnects on the next visible true", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui();
    const first = latestRfb();

    rerender(guiEl({ visible: false }));
    act(() => void vi.advanceTimersByTime(14_999));
    expect(first.disconnect).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(first.disconnect).toHaveBeenCalledOnce();

    rerender(guiEl());
    expect(FakeRFBClass.instances).toHaveLength(2);
  });

  it("a hidden document counts as not-visible for the 15s rule", () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      renderGui();
      const first = latestRfb();
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      act(() => void vi.advanceTimersByTime(15_000));
      expect(first.disconnect).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it("focus loss alone never disconnects (no timer without invisible)", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui();
    rerender(guiEl({ focused: false }));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(latestRfb().disconnect).not.toHaveBeenCalled();
    expect(FakeRFBClass.instances).toHaveLength(1);
  });

  it("unmount disconnects and clears every timer", () => {
    vi.useFakeTimers();
    const { unmount } = renderGui();
    const rfb = latestRfb();
    act(() => rfb.emit("disconnect")); // arms a backoff timer
    unmount();
    expect(rfb.disconnect).toHaveBeenCalled();
    const count = FakeRFBClass.instances.length;
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeRFBClass.instances).toHaveLength(count);
  });
});

describe("GuiSurface — chord gate and interaction seam", () => {
  function canvasChild(): HTMLElement {
    const host = screen.getByTestId("gui-surface-canvas").firstElementChild;
    if (!(host instanceof HTMLElement)) throw new Error("no canvas host");
    return host;
  }

  it("a reclaim-matching chord never reaches the canvas subtree and is re-dispatched to the document", () => {
    const shouldReclaimChord = vi.fn().mockReturnValue(true);
    const innerSpy = vi.fn();
    const docSpy = vi.fn();
    renderGui({ shouldReclaimChord });
    const inner = canvasChild();
    inner.addEventListener("keydown", innerSpy);
    document.addEventListener("keydown", docSpy);
    try {
      fireEvent.keyDown(inner, { key: "4", code: "Digit4", metaKey: true });
      expect(innerSpy).not.toHaveBeenCalled();
      expect(docSpy).toHaveBeenCalledOnce();
      expect(shouldReclaimChord).toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", docSpy);
    }
  });

  it("a non-matching key reaches the canvas subtree untouched", () => {
    const shouldReclaimChord = vi.fn().mockReturnValue(false);
    const innerSpy = vi.fn();
    renderGui({ shouldReclaimChord });
    const inner = canvasChild();
    inner.addEventListener("keydown", innerSpy);
    fireEvent.keyDown(inner, { key: "a", code: "KeyA" });
    expect(innerSpy).toHaveBeenCalledOnce();
  });

  it("pointerdown and keydown on the canvas wrapper fire onInteract", () => {
    const onInteract = vi.fn();
    renderGui({ onInteract });
    fireEvent.pointerDown(screen.getByTestId("gui-surface-canvas"));
    expect(onInteract).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(canvasChild(), { key: "a", code: "KeyA" });
    expect(onInteract).toHaveBeenCalledTimes(2);
  });

  it("an RFB clipboard event writes to the browser clipboard best-effort", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderGui();
    act(() => latestRfb().emit("clipboard", { text: "from-guest" }));
    expect(writeText).toHaveBeenCalledWith("from-guest");
  });
});

describe("GuiSurface — macOS credentials prompt", () => {
  const GUI_MAC: GuiSignal = { ...GUI_ON, backend: "screen-sharing" };

  it("credentialsrequired renders the password field; Enter submits via sendCredentials and stores nothing", () => {
    renderGui({ gui: GUI_MAC });
    act(() => latestRfb().emit("credentialsrequired"));
    const overlay = screen.getByTestId("gui-surface-credentials");
    expect(overlay).toHaveTextContent("Screen Sharing password");
    const input = screen.getByLabelText("Screen Sharing password");
    fireEvent.change(input, { target: { value: "s3cret" } });
    fireEvent.submit(overlay.querySelector("form")!);
    expect(latestRfb().sendCredentials).toHaveBeenCalledWith({ password: "s3cret" });
    expect(screen.queryByTestId("gui-surface-credentials")).toBeNull();
    expect(Object.keys(localStorage).join(",")).not.toMatch(/password/i);
    expect(Object.keys(sessionStorage).join(",")).not.toMatch(/password/i);
  });

  it("the Connect button submits like Enter", () => {
    renderGui({ gui: GUI_MAC });
    act(() => latestRfb().emit("credentialsrequired"));
    fireEvent.change(screen.getByLabelText("Screen Sharing password"), {
      target: { value: "pw" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(latestRfb().sendCredentials).toHaveBeenCalledWith({ password: "pw" });
  });

  it("Escape disconnects into the empty state with the password-required reason", () => {
    renderGui({ gui: GUI_MAC });
    const rfb = latestRfb();
    act(() => rfb.emit("credentialsrequired"));
    fireEvent.keyDown(screen.getByLabelText("Screen Sharing password"), { key: "Escape" });
    expect(rfb.disconnect).toHaveBeenCalled();
    expect(screen.getByTestId("gui-surface-empty")).toHaveTextContent(
      "Screen Sharing password required",
    );
  });

  it("a securityfailure after submit re-shows the field with the wrong-password note", () => {
    renderGui({ gui: GUI_MAC });
    act(() => latestRfb().emit("credentialsrequired"));
    fireEvent.change(screen.getByLabelText("Screen Sharing password"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    act(() => latestRfb().emit("securityfailure", { status: 1, reason: "auth failed" }));
    expect(screen.getByTestId("gui-surface-credentials")).toHaveTextContent(
      "Wrong password — try again",
    );
  });
});

describe("GuiSurface — palette command seams", () => {
  it("paste forwards to the live RFB; reconnect re-dials immediately", () => {
    vi.useFakeTimers();
    const commandsRef: { current: GuiSurfaceCommands | null } = { current: null };
    renderGui({ commandsRef });
    expect(commandsRef.current).not.toBeNull();

    act(() => commandsRef.current!.paste("clip"));
    expect(latestRfb().clipboardPasteFrom).toHaveBeenCalledWith("clip");

    act(() => latestRfb().emit("disconnect"));
    act(() => commandsRef.current!.reconnect());
    expect(FakeRFBClass.instances).toHaveLength(2);
  });
});

describe("GuiSurface — the stats seam and overlay", () => {
  const tileCanvas = () => screen.getByTestId("gui-novnc-host").querySelector("canvas")!;

  it("renders dash placeholders before the first tick and suppresses the zoom badge while visible", () => {
    vi.useFakeTimers();
    const { rerender } = renderGui({ statsVisible: true, zoom: 100 });
    act(() => latestRfb().emit("connect"));
    expect(screen.getByTestId("gui-stats-overlay")).toHaveTextContent(
      "— fps · — Mbit/s · — ms · 1920×1080 · 100%",
    );

    // A zoom change while the overlay is up moves the overlay's zoom segment;
    // the badge never renders.
    rerender(guiEl({ statsVisible: true, zoom: 150 }));
    expect(screen.getByTestId("gui-stats-overlay")).toHaveTextContent("· 150%");
    expect(screen.queryByTestId("gui-zoom-badge")).toBeNull();

    // Hiding stats restores the badge behavior.
    rerender(guiEl({ statsVisible: false, zoom: 125 }));
    expect(screen.queryByTestId("gui-stats-overlay")).toBeNull();
    expect(screen.getByTestId("gui-zoom-badge")).toHaveTextContent("125%");
  });

  it("the R4 tick: 30 canvas-source flips and 125 000 bytes in one 1 s window read 30 fps and 1.0 Mbit/s", () => {
    vi.useFakeTimers();
    renderGui({ statsVisible: true });
    act(() => latestRfb().emit("connect"));
    const ctx = fakeCtxFor(tileCanvas());
    const source = document.createElement("canvas");
    act(() => {
      for (let i = 0; i < 30; i++) ctx.drawImage(source, 0, 0);
      // A non-canvas source is not a framebuffer flip.
      ctx.drawImage(document.createElement("img"), 0, 0);
      FakeWS.instances[0].emitMessage(new ArrayBuffer(125_000));
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("gui-stats-overlay")).toHaveTextContent(
      "30 fps · 1.0 Mbit/s · — ms · 1920×1080 · fit",
    );
  });

  it("times a pingGui round trip every 5 s into the RTT segment", async () => {
    vi.useFakeTimers();
    renderGui({ statsVisible: true });
    act(() => latestRfb().emit("connect"));
    expect(pingGui).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(pingGui).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gui-stats-overlay")).toHaveTextContent(/\d+ ms/);
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(pingGui).toHaveBeenCalledTimes(2);
  });

  it("a rejected ping leaves the RTT segment at a dash and never throws", async () => {
    vi.useFakeTimers();
    vi.mocked(pingGui).mockRejectedValue(new Error("boom"));
    renderGui({ statsVisible: true });
    act(() => latestRfb().emit("connect"));
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(screen.getByTestId("gui-stats-overlay")).toHaveTextContent("— ms");
  });

  it("hiding stats stops the collector and restores the wrapped drawImage", async () => {
    vi.useFakeTimers();
    const { rerender } = renderGui({ statsVisible: true });
    const canvas = tileCanvas();
    const original = fakeCtxFor(canvas).drawImage;
    act(() => latestRfb().emit("connect"));
    expect(fakeCtxFor(canvas).drawImage).not.toBe(original);
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(pingGui).toHaveBeenCalledTimes(1);

    rerender(guiEl({ statsVisible: false }));
    expect(fakeCtxFor(canvas).drawImage).toBe(original);
    await act(async () => void vi.advanceTimersByTime(15_000));
    expect(pingGui).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gui-stats-overlay")).toBeNull();
  });

  it("an RFB disconnect stops the collector until the next connect", async () => {
    vi.useFakeTimers();
    renderGui({ statsVisible: true });
    act(() => latestRfb().emit("connect"));
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(pingGui).toHaveBeenCalledTimes(1);

    act(() => latestRfb().emit("disconnect"));
    // The 1 s backoff re-dial lands a new RFB that never connects here.
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(pingGui).toHaveBeenCalledTimes(1);

    act(() => latestRfb().emit("connect"));
    await act(async () => void vi.advanceTimersByTime(5_000));
    expect(pingGui).toHaveBeenCalledTimes(2);
  });

  it("unmount stops the collector", async () => {
    vi.useFakeTimers();
    const { unmount } = renderGui({ statsVisible: true });
    act(() => latestRfb().emit("connect"));
    unmount();
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(pingGui).not.toHaveBeenCalled();
  });

  it("hidden means fully idle — no wrap, no sample tick, no ping, no overlay", async () => {
    vi.useFakeTimers();
    renderGui({ statsVisible: false });
    const canvas = tileCanvas();
    const original = fakeCtxFor(canvas).drawImage;
    act(() => latestRfb().emit("connect"));
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(pingGui).not.toHaveBeenCalled();
    expect(fakeCtxFor(canvas).drawImage).toBe(original);
    expect(screen.queryByTestId("gui-stats-overlay")).toBeNull();
  });
});

describe("GuiSurface — fullscreen report", () => {
  /** Stub document.fullscreenElement for the duration of `fn`. */
  function withFullscreenElement(el: Element | null, fn: () => void) {
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "fullscreenElement");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => el });
    try {
      fn();
    } finally {
      if (original) Object.defineProperty(document, "fullscreenElement", original);
      else Reflect.deleteProperty(document, "fullscreenElement");
    }
  }

  it("reports true when an ANCESTOR (the tile) is the fullscreen element — containment, not identity", () => {
    const onFullscreenChange = vi.fn();
    renderGui({ onFullscreenChange });
    const wrapper = screen.getByTestId("gui-surface-canvas");
    const tile = wrapper.parentElement!;
    withFullscreenElement(tile, () => {
      act(() => {
        document.dispatchEvent(new Event("fullscreenchange"));
      });
    });
    expect(onFullscreenChange).toHaveBeenCalledWith(true);
  });

  it("reports false on exit and when a FOREIGN element is fullscreen", () => {
    const onFullscreenChange = vi.fn();
    renderGui({ onFullscreenChange });
    withFullscreenElement(document.createElement("div"), () => {
      act(() => {
        document.dispatchEvent(new Event("fullscreenchange"));
      });
    });
    expect(onFullscreenChange).toHaveBeenCalledWith(false);
  });
});

describe("GuiSurface — key bar visibility posture", () => {
  it("the bar renders by default on a coarse pointer", () => {
    renderGui({ coarsePointer: true });
    expect(screen.getByTestId("gui-keybar")).toBeInTheDocument();
  });

  it("keyBarVisible=false hides the bar", () => {
    renderGui({ coarsePointer: true, keyBarVisible: false });
    expect(screen.queryByTestId("gui-keybar")).toBeNull();
  });
});

describe("GuiSurface — HiDPI host sizing", () => {
  function stubDpr(value: number) {
    const original = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
    return () => {
      if (original) Object.defineProperty(window, "devicePixelRatio", original);
      else Reflect.deleteProperty(window, "devicePixelRatio");
    };
  }

  it("hidpi divides the percentage-zoom host CSS size by devicePixelRatio", () => {
    const restore = stubDpr(2);
    try {
      renderGui({ zoom: 100, hidpi: true });
      const host = screen.getByTestId("gui-novnc-host");
      expect(host.style.width).toBe("960px");
      expect(host.style.height).toBe("540px");
    } finally {
      restore();
    }
  });

  it("without hidpi the same dpr leaves the host at fb × z/100", () => {
    const restore = stubDpr(2);
    try {
      renderGui({ zoom: 100, hidpi: false });
      expect(screen.getByTestId("gui-novnc-host").style.width).toBe("1920px");
    } finally {
      restore();
    }
  });

  it("fit is unaffected by hidpi (the host stays tile-sized)", () => {
    const restore = stubDpr(2);
    try {
      renderGui({ zoom: "fit", hidpi: true });
      expect(screen.getByTestId("gui-novnc-host").style.width).toBe("");
    } finally {
      restore();
    }
  });
});

describe("GuiSurface — sendKey command seam", () => {
  it("commandsRef.sendKey reaches the live RFB and no-ops without one", () => {
    const commandsRef: { current: GuiSurfaceCommands | null } = { current: null };
    const { unmount } = renderGui({ commandsRef });
    act(() => commandsRef.current!.sendKey(0xffe9, "AltLeft", true));
    expect(latestRfb().sendKey).toHaveBeenCalledWith(0xffe9, "AltLeft", true);
    unmount();
    expect(commandsRef.current).toBeNull();
  });
});
