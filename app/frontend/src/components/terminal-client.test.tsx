import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, waitFor, fireEvent } from "@testing-library/react";
import { FocusedTerminalProvider } from "@/contexts/focused-terminal-context";
import { ChromeProvider, useChrome } from "@/contexts/chrome-context";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ProgressAddon } from "@xterm/addon-progress";
import {
  TerminalClient,
  SCROLLBACK_DESKTOP,
  SCROLLBACK_MOBILE,
  WEBGL_FALLBACK_TOAST,
  resetWebglFallbackNoticeForTests,
} from "./terminal-client";
import { ToastProvider } from "@/components/toast";
import { COARSE_POINTER_QUERY } from "@/hooks/use-coarse-pointer";
import type { OpenStreamOpts, RelayStream } from "@/lib/relay-mux";
import { notifyFirstWrite } from "@/lib/window-transition";

// The switch-receipt seam is module-global; spy on it so the receipt-source
// tests can assert WHICH terminal reports (the real function is a no-op here —
// no switch is ever armed in this file).
vi.mock("@/lib/window-transition", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/window-transition")>();
  return { ...mod, notifyFirstWrite: vi.fn() };
});

// ---------------------------------------------------------------------------
// RelayMux mock — the terminals-mux transport (change 260717-803u-relay-mux).
// TerminalClient no longer opens a raw WebSocket; it calls relayMux.openStream()
// and drives the terminal through the returned stream handle
// ({send,resize,close,onData,onOpened,onClosed}). This mock captures every
// opened stream so tests can drive inbound data / opened / closed by hand and
// assert the outbound send/resize/close ops.
//
// Inbound data is now BINARY (a Uint8Array): the relay's byte stream, demuxed by
// the mux. String test payloads are encoded to bytes by emitData(). Socket-level
// reconnect is owned by RelayMux — a transient drop re-opens the stream
// transparently, surfaced to the client as a fresh onOpened() (NOT an onClosed);
// only a STREAM-level close (4004/4001/1000) fires onClosed.
// ---------------------------------------------------------------------------

class MockStream implements RelayStream {
  static instances: MockStream[] = [];
  opts: OpenStreamOpts;
  dataCb: ((d: Uint8Array) => void) | null = null;
  openedCb: (() => void) | null = null;
  closedCb: ((code: number, reason: string) => void) | null = null;
  send = vi.fn();
  resize = vi.fn();
  setWindowIdSpy = vi.fn();
  closeSpy = vi.fn();
  closed = false;

  constructor(opts: OpenStreamOpts) {
    this.opts = opts;
    MockStream.instances.push(this);
  }
  setWindowId = (windowId: string) => {
    this.opts = { ...this.opts, windowId };
    this.setWindowIdSpy(windowId);
  };
  close = () => {
    this.closed = true;
    this.closeSpy();
  };
  onData = (cb: (d: Uint8Array) => void) => {
    this.dataCb = cb;
  };
  onOpened = (cb: () => void) => {
    this.openedCb = cb;
  };
  onClosed = (cb: (code: number, reason: string) => void) => {
    this.closedCb = cb;
  };

  // --- test drivers ---
  /** Fire the stream-opened callback (initial open or a transparent re-open). */
  emitOpened() {
    this.openedCb?.();
  }
  /** Fire an inbound data frame. Strings are UTF-8 encoded to bytes. */
  emitData(data: string | Uint8Array) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.dataCb?.(bytes);
  }
  /** Fire a stream-level close (window-not-found / attach-failed / normal). */
  emitClosed(code: number, reason = "closed") {
    this.closedCb?.(code, reason);
  }
}

let muxIsOpen = true;
const mockRelayMux = {
  openStream: vi.fn((opts: OpenStreamOpts) => new MockStream(opts)),
  isOpen: () => muxIsOpen,
  close: vi.fn(),
};

vi.mock("@/lib/relay-mux", () => ({
  get relayMux() {
    return mockRelayMux;
  },
}));

// Mock all xterm-related modules to avoid actual terminal initialization
vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function () {
    return {
      loadAddon: vi.fn(),
      open: vi.fn(),
      onData: vi.fn(),
      attachCustomKeyEventHandler: vi.fn(),
      dispose: vi.fn(),
      focus: vi.fn(),
      reset: vi.fn(),
      clear: vi.fn(),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
      cols: 80,
      rows: 24,
      options: { fontSize: 13 },
      unicode: { activeVersion: "6" },
      hasSelection: vi.fn().mockReturnValue(false),
    };
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: vi.fn(), dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: vi.fn().mockImplementation(function () {
    // onContextLoss must exist: init() registers it BEFORE loadAddon, so a
    // mock without it throws into the fallback and WebGL never "loads" in
    // tests — masking load-order assertions.
    return { dispose: vi.fn(), onContextLoss: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-unicode-graphemes", () => ({
  UnicodeGraphemesAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), findNext: vi.fn(), findPrevious: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), serialize: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-progress", () => ({
  ProgressAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), onChange: vi.fn() };
  }),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("@/hooks/use-file-upload", () => ({
  useFileUpload: () => ({ uploadFiles: vi.fn().mockResolvedValue([]) }),
}));

vi.mock("@/contexts/theme-context", () => ({
  useTheme: () => ({
    theme: { palette: {} },
    preference: "dark",
    resolved: "dark",
  }),
  useThemeActions: () => ({ setTheme: vi.fn() }),
}));

vi.mock("@/themes", () => ({
  deriveXtermTheme: () => ({}),
}));

function createWsRef(): React.MutableRefObject<WebSocket | null> {
  return { current: null };
}

function renderTerminalClient(scrollLocked = false) {
  return render(
    <ChromeProvider>
      <FocusedTerminalProvider>
        <TerminalClient
          sessionName="test-session"
          windowId="@0"
          server="default"
          wsRef={createWsRef()}
          scrollLocked={scrollLocked}
        />
      </FocusedTerminalProvider>
    </ChromeProvider>,
  );
}

describe("TerminalClient transparent variant", () => {
  afterEach(() => {
    cleanup();
  });

  function renderWithTransparency(transparent: boolean) {
    return render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName="test-session"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
            transparent={transparent}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
  }

  it("marks the terminal container with rk-terminal-transparent — the globals.css override that neutralizes xterm.css's opaque .xterm-viewport black", () => {
    const { getByRole } = renderWithTransparency(true);
    expect(getByRole("application").className).toContain("rk-terminal-transparent");
  });

  it("constructs xterm with allowTransparency and an alpha-zero HEX background — the `transparent` keyword is unparseable to xterm and falls back to opaque black", async () => {
    renderWithTransparency(true);
    await waitFor(() => expect(vi.mocked(Terminal)).toHaveBeenCalled());
    const opts = vi.mocked(Terminal).mock.calls.at(-1)![0]!;
    expect(opts.allowTransparency).toBe(true);
    expect(opts.theme?.background).toBe("#00000000");
    // Never the keyword: xterm's css parser accepts only #hex/rgb()/rgba().
    expect(opts.theme?.background).not.toBe("transparent");
  });

  it("omits the class on the default opaque variant", () => {
    const { getByRole } = renderWithTransparency(false);
    expect(getByRole("application").className).not.toContain("rk-terminal-transparent");
  });
});

describe("TerminalClient scroll-lock focus prevention", () => {
  beforeEach(() => {
    // Coarse pointer must MATCH: the suppression effects gate on the shared
    // COARSE_POINTER_QUERY (a persisted lock rehydrated on a fine-pointer
    // profile must not suppress — see the fine-pointer test below). Keyed off
    // the imported constant so a query change cannot silently defeat the mock.
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: query === COARSE_POINTER_QUERY,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prevents focus via touchend preventDefault when scrollLocked is true", async () => {
    const { container } = renderTerminalClient(true);

    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    expect(terminalDiv).toBeTruthy();

    const touchEnd = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(touchEnd, "preventDefault");

    act(() => {
      terminalDiv!.dispatchEvent(touchEnd);
    });

    expect(preventSpy).toHaveBeenCalled();
  });

  it("does not prevent touchend when scrollLocked is false", async () => {
    const { container } = renderTerminalClient(false);

    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    expect(terminalDiv).toBeTruthy();

    const touchEnd = new TouchEvent("touchend", { bubbles: true, cancelable: true });
    const preventSpy = vi.spyOn(touchEnd, "preventDefault");

    act(() => {
      terminalDiv!.dispatchEvent(touchEnd);
    });

    expect(preventSpy).not.toHaveBeenCalled();
  });

  // The capture-phase suppressors must beat xterm's own element-level
  // listeners (contextmenu → rightClickHandler focuses the helper textarea;
  // mousedown → terminal.focus()). The child-level listener stands in for
  // xterm's: if it never fires and the event is defaultPrevented, xterm's
  // can't have run either.
  it.each(["contextmenu", "mousedown"] as const)(
    "suppresses %s in the capture phase before child listeners when locked",
    async (type) => {
      const { container } = renderTerminalClient(true);
      await act(async () => {});

      const terminalDiv = container.querySelector("[role='application']");
      expect(terminalDiv).toBeTruthy();
      const child = document.createElement("div");
      terminalDiv!.appendChild(child);
      const childListener = vi.fn();
      child.addEventListener(type, childListener);

      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      act(() => {
        child.dispatchEvent(event);
      });

      expect(childListener).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    },
  );

  // The deliberate tap's focus path: mousedown stays lock-gated, so unlocked
  // it must reach xterm's handlers unsuppressed (xterm's mousedown →
  // terminal.focus() → keyboard opens). Gating it always-on would kill
  // tap-to-focus on touch.
  it("lets mousedown through to child listeners when unlocked", async () => {
    const { container } = renderTerminalClient(false);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const child = document.createElement("div");
    terminalDiv!.appendChild(child);
    const childListener = vi.fn();
    child.addEventListener("mousedown", childListener);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      child.dispatchEvent(event);
    });

    expect(childListener).toHaveBeenCalled();
  });

  // Long-press → contextmenu is never a deliberate focus request on touch
  // (right-click has no touch meaning), so its capture-phase suppression is
  // ALWAYS on for coarse pointers — the scroll-lock state is irrelevant. This
  // is the unlocked-terminal phantom-keyboard gate: WebKit's long-press
  // recognizer can fire contextmenu during a slow scroll-drag.
  it("suppresses contextmenu in the capture phase even when unlocked", async () => {
    const { container } = renderTerminalClient(false);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    expect(terminalDiv).toBeTruthy();
    const child = document.createElement("div");
    terminalDiv!.appendChild(child);
    const childListener = vi.fn();
    child.addEventListener("contextmenu", childListener);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      child.dispatchEvent(event);
    });

    expect(childListener).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("blurs a focus landing inside .xterm while locked (backstop)", async () => {
    const { container } = renderTerminalClient(true);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const xtermEl = document.createElement("div");
    xtermEl.className = "xterm";
    const textarea = document.createElement("textarea");
    xtermEl.appendChild(textarea);
    terminalDiv!.appendChild(xtermEl);

    act(() => {
      textarea.focus();
    });

    expect(document.activeElement).not.toBe(textarea);
  });

  it("does not blur xterm focus when unlocked", async () => {
    const { container } = renderTerminalClient(false);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const xtermEl = document.createElement("div");
    xtermEl.className = "xterm";
    const textarea = document.createElement("textarea");
    xtermEl.appendChild(textarea);
    terminalDiv!.appendChild(xtermEl);

    act(() => {
      textarea.focus();
    });

    expect(document.activeElement).toBe(textarea);
  });

  it("does not suppress on a fine pointer even when locked (persisted-lock rehydration)", async () => {
    // A persisted lock rehydrated on a fine-pointer profile must leave the
    // terminal fully interactive — the unlock chip only renders on coarse.
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const { container } = renderTerminalClient(true);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const child = document.createElement("div");
    terminalDiv!.appendChild(child);
    const childListener = vi.fn();
    child.addEventListener("mousedown", childListener);

    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => {
      child.dispatchEvent(event);
    });

    expect(childListener).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("lets contextmenu through on a fine pointer (the always-on gate is coarse-only)", async () => {
    // The unconditional contextmenu suppression evaluates the coarse query PER
    // EVENT — a fine-pointer profile (desktop mouse right-click) must keep its
    // native context-menu path in every lock state.
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const { container } = renderTerminalClient(false);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const child = document.createElement("div");
    terminalDiv!.appendChild(child);
    const childListener = vi.fn();
    child.addEventListener("contextmenu", childListener);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      child.dispatchEvent(event);
    });

    expect(childListener).toHaveBeenCalled();
    // No defaultPrevented assertion: the container's React onContextMenu
    // preventDefaults at bubble phase in every state (it suppresses the
    // browser's native menu over the terminal) — the capture-phase gate is
    // proven by the child listener firing at all.
  });

  it("does not blur focus outside .xterm while locked", async () => {
    const { container } = renderTerminalClient(true);
    await act(async () => {});

    const terminalDiv = container.querySelector("[role='application']");
    const plain = document.createElement("textarea");
    terminalDiv!.appendChild(plain);

    act(() => {
      plain.focus();
    });

    expect(document.activeElement).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for the stream-connection describe blocks (deferred reset +
// connection identity). The mutable state (rAF queue, MockStream.instances,
// Terminal mock) is reset per test by stubConnectionEnv() in each beforeEach.
// ---------------------------------------------------------------------------

let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

function runRafCallbacks() {
  const cbs = [...rafCallbacks.values()];
  rafCallbacks.clear();
  for (const cb of cbs) cb(0);
}

type TerminalSpies = {
  reset: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

/** The Terminal instance created by this test's render. */
function terminalSpies(): TerminalSpies {
  const instance = vi.mocked(Terminal).mock.results[0]?.value as
    | TerminalSpies
    | undefined;
  expect(instance).toBeTruthy();
  return instance!;
}

/** Call order of the write(...) call whose payload matches `data` (a string is
 *  matched against a Uint8Array by comparing decoded bytes). */
function writeOrderOf(term: TerminalSpies, data: string | Uint8Array): number {
  const wantBytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const idx = term.write.mock.calls.findIndex((c) => {
    const got = c[0];
    // Duck-type rather than `instanceof Uint8Array`: jsdom's TextEncoder can
    // yield a cross-realm Uint8Array whose prototype differs from the test
    // realm's, so `instanceof` is unreliable. ArrayBuffer.isView is realm-safe.
    if (!ArrayBuffer.isView(got)) return false;
    const bytes = new Uint8Array(got.buffer, got.byteOffset, got.byteLength);
    return (
      bytes.length === wantBytes.length &&
      bytes.every((b: number, i: number) => b === wantBytes[i])
    );
  });
  expect(idx).toBeGreaterThanOrEqual(0);
  return term.write.mock.invocationCallOrder[idx];
}

/** Realm-safe assertion that `term.write` received `data` (see writeOrderOf). */
function expectWritten(term: TerminalSpies, data: string | Uint8Array) {
  const wantBytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const found = term.write.mock.calls.some((c) => {
    const got = c[0];
    if (!ArrayBuffer.isView(got)) return false;
    const bytes = new Uint8Array(got.buffer, got.byteOffset, got.byteLength);
    return (
      bytes.length === wantBytes.length &&
      bytes.every((b: number, i: number) => b === wantBytes[i])
    );
  });
  expect(found, `expected term.write to have received ${JSON.stringify(data)}`).toBe(true);
}

/** Per-test environment stubs shared by the stream-connection describe blocks. */
function stubConnectionEnv() {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  MockStream.instances = [];
  mockRelayMux.openStream.mockClear();
  muxIsOpen = true;
  rafCallbacks = new Map();
  nextRafId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.mocked(Terminal).mockClear();
}

describe("TerminalClient deferred reset (reset at first write, not receipt)", () => {
  async function mountAndGetStream(): Promise<MockStream> {
    renderTerminalClient(false);
    // Init is async (font-load await + state update + connect effect). Flush
    // microtasks until the stream has been opened.
    await act(async () => {});
    await act(async () => {});
    expect(MockStream.instances.length).toBeGreaterThan(0);
    const st = MockStream.instances[MockStream.instances.length - 1];
    // The stream opens → the mux acks `opened`, which arms the deferred reset.
    act(() => {
      st.emitOpened();
    });
    return st;
  }

  beforeEach(stubConnectionEnv);

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not reset at receipt time for a coalesced first chunk; resets inside the flush, before the write", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();
    const bigChunk = "x".repeat(200); // > IMMEDIATE_WRITE_MAX_BYTES → rAF path

    act(() => {
      st.emitData(bigChunk);
    });

    // Receipt time: no reset, no write.
    expect(term.reset).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();

    act(() => {
      runRafCallbacks();
    });

    // Flush time: reset exactly once, ordered before the buffered write.
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, bigChunk),
    );
  });

  it("resets synchronously before the write for a small first chunk (immediate path)", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();

    act(() => {
      st.emitData("ok"); // ≤ 64 bytes, idle → immediate path
    });

    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, "ok"),
    );
  });

  it("resets before the flush for a large first chunk (coalesced path)", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();
    const bytes = new Uint8Array(128).fill(120); // > 64 bytes → rAF path

    act(() => {
      st.emitData(bytes);
    });
    expect(term.reset).not.toHaveBeenCalled();

    act(() => {
      runRafCallbacks();
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, bytes),
    );
  });

  it("resets exactly once per open — subsequent chunks and flushes do not reset again", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();

    act(() => {
      st.emitData("a"); // immediate → consumes the reset
      st.emitData("b"); // same frame → buffers
      st.emitData("x".repeat(200)); // buffers
    });
    act(() => {
      runRafCallbacks(); // drain the buffered chunks
    });
    act(() => {
      st.emitData("c"); // fresh frame → immediate again
    });

    expect(term.reset).toHaveBeenCalledTimes(1);
  });

  it("re-arms the reset on a transparent re-open — the re-opened stream's first write resets again", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();

    act(() => {
      st.emitData("old"); // immediate write → sets wroteImmediatelyThisFrame
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    // Cross a frame boundary so the immediate-write flood guard resets (the next
    // small chunk can take the immediate path again).
    act(() => {
      runRafCallbacks();
    });

    // A socket-level drop is handled by RelayMux: it re-opens the SAME stream
    // transparently, surfaced as a fresh onOpened() (NOT a new MockStream, NOT
    // an onClosed). The re-open must re-arm the deferred reset.
    act(() => {
      st.emitOpened();
    });
    expect(MockStream.instances).toHaveLength(1); // no new stream — same handle
    expect(term.reset).toHaveBeenCalledTimes(1); // armed, not yet fired

    act(() => {
      st.emitData("new");
    });
    expect(term.reset).toHaveBeenCalledTimes(2);
    expect(term.reset.mock.invocationCallOrder[1]).toBeLessThan(
      writeOrderOf(term, "new"),
    );
  });

  it("does not reset on a stream close with no buffered data", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();
    term.reset.mockClear(); // ignore the arm from emitOpened (not yet fired anyway)

    act(() => {
      st.emitClosed(1000); // graceful close, no data ever arrived
    });

    expect(term.reset).not.toHaveBeenCalled();
  });

  it("does not write connection A's buffered-but-unflushed bytes after onOpened fires for connection B", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();
    const stale = "s".repeat(200); // > IMMEDIATE_WRITE_MAX_BYTES → buffers, rAF pending

    // Connection A buffers a chunk that never flushes (e.g. a backgrounded tab
    // where rAF doesn't fire), then the socket drops.
    act(() => {
      st.emitData(stale);
    });
    expect(term.write).not.toHaveBeenCalled();

    // RelayMux reconnects and transparently re-opens the SAME stream —
    // connection B's onOpened must wipe A's buffered bytes and cancel the
    // pending flush (change 260801-f715).
    act(() => {
      st.emitOpened();
    });
    act(() => {
      runRafCallbacks(); // any stray rAF tick must find nothing to flush
    });
    expect(term.write).not.toHaveBeenCalled();
    // The empty state neither consumed nor executed the freshly armed reset.
    expect(term.reset).not.toHaveBeenCalled();

    // Connection B's first chunk still resets-then-writes, and A's stale bytes
    // are never written.
    act(() => {
      st.emitData("fresh");
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(term.reset.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, "fresh"),
    );
    expect(term.write).toHaveBeenCalledTimes(1); // only "fresh" — never the stale chunk
  });

  it("drains buffered tail data on close without resetting when the reset was already consumed", async () => {
    const st = await mountAndGetStream();
    const term = terminalSpies();
    const tail = "t".repeat(100);

    act(() => {
      st.emitData("a"); // immediate → consumes the reset
      st.emitData(tail); // buffers; flush rAF pending
    });
    expect(term.reset).toHaveBeenCalledTimes(1);

    act(() => {
      st.emitClosed(1000); // cancels the rAF, drains the tail directly
    });

    expectWritten(term, tail);
    expect(term.reset).toHaveBeenCalledTimes(1); // no second reset on the tail drain
  });
});

describe("TerminalClient connection identity — (server, owning session), not windowId", () => {
  type Props = {
    sessionName: string;
    windowId: string;
    server?: string;
    onSessionNotFound?: () => void;
    clearOnRide?: boolean;
  };

  /** Rerenderable harness so tests can change session/window/server props. */
  function createHarness(initial: Props) {
    const wsRef = createWsRef();
    const renderAt = (p: Props) => (
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName={p.sessionName}
            windowId={p.windowId}
            server={p.server ?? "default"}
            wsRef={wsRef}
            onSessionNotFound={p.onSessionNotFound}
            clearOnRide={p.clearOnRide}
            scrollLocked={false}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>
    );
    const view = render(renderAt(initial));
    return { view, renderAt };
  }

  function lastStream(): MockStream {
    expect(MockStream.instances.length).toBeGreaterThan(0);
    return MockStream.instances[MockStream.instances.length - 1];
  }

  /** Init is async (font-load await + state update + connect effect). */
  async function flushInit() {
    await act(async () => {});
    await act(async () => {});
  }

  beforeEach(stubConnectionEnv);

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the live stream across a same-session windowId switch — no close, no new stream, no reset", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("ok"); // consume the deferred reset
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    const instanceCount = MockStream.instances.length;

    // Same-session window switch: tmux select-window moves the attached PTY in
    // place — the stream must survive.
    view.rerender(renderAt({ sessionName: "sess", windowId: "@1", clearOnRide: true }));
    await act(async () => {});

    expect(st1.closeSpy).not.toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount);
    expect(term.reset).toHaveBeenCalledTimes(1); // no new reset — scrollback survives

    // M1: the ride must push the NEW windowId into the live stream so a later
    // socket-level reconnect re-opens @1, not the stale @0 (which the server
    // would SelectWindowInSession, yanking the pane back). This is the
    // client-side half of M1; relay-mux.test.ts covers the mux re-issuing open
    // with the updated windowId.
    expect(st1.setWindowIdSpy).toHaveBeenCalledWith("@1");
    expect(st1.opts.windowId).toBe("@1");

    act(() => {
      st1.emitData("more");
    });
    act(() => {
      runRafCallbacks();
    });
    expectWritten(term, "more");
  });

  it("a same-session ride arms a deferred buffer CLEAR — run once, before the first post-switch chunk (immediate path)", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("@0-scrollback"); // consume the deferred reset
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    // Cross a frame boundary so the immediate-write flood guard resets.
    act(() => {
      runRafCallbacks();
    });

    // Same-session switch: rides the live stream and arms the deferred clear.
    view.rerender(renderAt({ sessionName: "sess", windowId: "@1", clearOnRide: true }));
    await act(async () => {});
    expect(st1.setWindowIdSpy).toHaveBeenCalledWith("@1");
    expect(term.clear).not.toHaveBeenCalled(); // armed, not yet fired

    // The first inbound chunk after the switch (small → immediate path) runs
    // the clear in the same tick, BEFORE the write — never reset() on a ride.
    act(() => {
      st1.emitData("r");
    });
    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(term.clear.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, "r"),
    );
    expect(term.reset).toHaveBeenCalledTimes(1); // no reset on a ride
  });

  it("the ride's deferred clear runs inside the flush before the write (coalesced path), exactly once", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("@0-scrollback");
    });
    act(() => {
      runRafCallbacks();
    });

    view.rerender(renderAt({ sessionName: "sess", windowId: "@1", clearOnRide: true }));
    await act(async () => {});

    // A large redraw chunk (> IMMEDIATE_WRITE_MAX_BYTES) coalesces: no clear
    // and no write at receipt time…
    const redraw = new Uint8Array(4096).fill(120);
    term.write.mockClear();
    act(() => {
      st1.emitData(redraw);
    });
    expect(term.clear).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();

    // …the clear runs at the top of the flush (same frame as the write).
    act(() => {
      runRafCallbacks();
    });
    expect(term.clear).toHaveBeenCalledTimes(1);
    expect(term.clear.mock.invocationCallOrder[0]).toBeLessThan(
      writeOrderOf(term, redraw),
    );
    expect(term.reset).toHaveBeenCalledTimes(1);

    // Exactly once: later chunks never re-clear.
    act(() => {
      runRafCallbacks();
      st1.emitData("tail");
    });
    expect(term.clear).toHaveBeenCalledTimes(1);
  });

  it("a stream re-open before the first post-switch chunk supersedes the pending clear — the deferred reset runs instead", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("@0-scrollback");
    });
    act(() => {
      runRafCallbacks();
    });

    // Ride to @1 (arms the clear), then a socket drop re-opens the stream
    // before any chunk arrives — onOpened arms the deferred reset and drops
    // the pending clear.
    view.rerender(renderAt({ sessionName: "sess", windowId: "@1", clearOnRide: true }));
    await act(async () => {});
    act(() => {
      st1.emitOpened();
    });

    act(() => {
      st1.emitData("redraw");
    });
    expect(term.reset).toHaveBeenCalledTimes(2); // the re-open's reset fired
    expect(term.clear).not.toHaveBeenCalled(); // the ride's clear was dropped
    expect(term.reset.mock.invocationCallOrder[1]).toBeLessThan(
      writeOrderOf(term, "redraw"),
    );
  });

  it("does NOT arm the clear on a tmux-driven ride (clearOnRide false) — the attached client already redrew, so the next chunk must not wipe it", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("@0-scrollback");
    });
    act(() => {
      runRafCallbacks();
    });

    // The URL followed a tmux select-window (SSE writeback): no pending click
    // intent, so the route passes no clearOnRide.
    view.rerender(renderAt({ sessionName: "sess", windowId: "@1" }));
    await act(async () => {});
    expect(st1.setWindowIdSpy).toHaveBeenCalledWith("@1");

    act(() => {
      st1.emitData("r");
    });
    expect(term.clear).not.toHaveBeenCalled();
    expect(term.reset).toHaveBeenCalledTimes(1);
    expectWritten(term, "r");
  });

  it("does NOT arm the clear while the connection is unresolved — the windowId change reconnects instead", async () => {
    const { view, renderAt } = createHarness({ sessionName: "", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("cold");
    });
    act(() => {
      runRafCallbacks();
    });

    // Unresolved (sessionName ""): a windowId change falls back to
    // windowId-based identity and reconnects — no ride, no clear.
    view.rerender(renderAt({ sessionName: "", windowId: "@1" }));
    await act(async () => {});
    expect(st1.closeSpy).toHaveBeenCalled();
    const st2 = lastStream();
    expect(st2).not.toBe(st1);

    act(() => {
      st2.emitOpened();
      st2.emitData("fresh");
    });
    expect(term.clear).not.toHaveBeenCalled();
    expect(term.reset).toHaveBeenCalledTimes(2); // both opens reset; never cleared
  });

  it("closes the old stream and opens exactly one new one on a cross-session switch, with the deferred reset before the new stream's first write", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess-a", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("old");
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    const instanceCount = MockStream.instances.length;

    // Cross-session navigation: the owning session genuinely changed — teardown
    // + reopen, targeting the LATEST windowId.
    view.rerender(renderAt({ sessionName: "sess-b", windowId: "@3" }));
    await act(async () => {});

    expect(st1.closeSpy).toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1); // exactly one
    const st2 = lastStream();
    expect(st2).not.toBe(st1);
    expect(st2.opts.windowId).toBe("@3");

    // Part-1 invariant on genuine reconnects: the reset is re-armed (on the new
    // stream's opened) and fires before its first write (no black frame).
    act(() => {
      st2.emitOpened();
    });
    expect(term.reset).toHaveBeenCalledTimes(1); // armed, not yet fired
    act(() => {
      st2.emitData("new");
    });
    expect(term.reset).toHaveBeenCalledTimes(2);
    expect(term.reset.mock.invocationCallOrder[1]).toBeLessThan(
      writeOrderOf(term, "new"),
    );
  });

  it('reopens when windowId changes while sessionName is still "" — unresolved identity falls back to windowId', async () => {
    const { view, renderAt } = createHarness({ sessionName: "", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    expect(st1.opts.windowId).toBe("@0");
    const instanceCount = MockStream.instances.length;

    view.rerender(renderAt({ sessionName: "", windowId: "@1" }));
    await act(async () => {});

    expect(st1.closeSpy).toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1);
    const st2 = lastStream();
    expect(st2.opts.windowId).toBe("@1");

    // The eventual resolution is absorbed as usual — no further reopen.
    view.rerender(renderAt({ sessionName: "resolved-sess", windowId: "@1" }));
    await act(async () => {});
    expect(st2.closeSpy).not.toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1);
  });

  it('does not reopen when sessionName resolves from "" — and a later genuine session change does', async () => {
    const { view, renderAt } = createHarness({ sessionName: "", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const term = terminalSpies();

    act(() => {
      st1.emitOpened();
      st1.emitData("ok");
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
    const instanceCount = MockStream.instances.length;

    view.rerender(renderAt({ sessionName: "resolved-sess", windowId: "@0" }));
    await act(async () => {});

    expect(st1.closeSpy).not.toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount);
    expect(term.reset).toHaveBeenCalledTimes(1);

    // A later genuine session change must reopen.
    view.rerender(renderAt({ sessionName: "other-sess", windowId: "@2" }));
    await act(async () => {});

    expect(st1.closeSpy).toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1);
  });

  it("a transient socket drop after a same-session ride re-opens the LATEST (ridden-to) windowId, not the stale open-time one (M1)", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    expect(st1.opts.windowId).toBe("@0");

    // Same-session switch rides the existing stream (no reopen)…
    view.rerender(renderAt({ sessionName: "sess", windowId: "@5" }));
    await act(async () => {});
    expect(lastStream()).toBe(st1); // rode the stream, no new one

    // …and pushed @5 into the live stream. A transient SOCKET drop is handled
    // inside RelayMux (it re-issues `open` for every live stream from its stored
    // opts — see relay-mux.test.ts's M1 test), so the client-observable
    // guarantee here is that the stream's re-open target is @5, not the stale
    // open-time @0. Before M1, only cols/rows were refreshed, so the reconnect
    // re-opened @0 and the server SelectWindowInSession-ed the pane back.
    expect(st1.setWindowIdSpy).toHaveBeenCalledWith("@5");
    expect(st1.opts.windowId).toBe("@5");
    const instanceCount = MockStream.instances.length;

    // A genuine cross-session change still reopens a fresh stream, targeting @5.
    view.rerender(renderAt({ sessionName: "sess-2", windowId: "@5" }));
    await act(async () => {});

    expect(MockStream.instances.length).toBe(instanceCount + 1);
    const st2 = lastStream();
    expect(st2).not.toBe(st1);
    expect(st2.opts.windowId).toBe("@5");
  });

  it("reopens exactly once when server and session change together (the watcher does not double-trigger)", async () => {
    const { view, renderAt } = createHarness({
      sessionName: "sess",
      windowId: "@0",
      server: "alpha",
    });
    await flushInit();
    const st1 = lastStream();
    expect(st1.opts.server).toBe("alpha");
    const instanceCount = MockStream.instances.length;

    view.rerender(renderAt({ sessionName: "sess-2", windowId: "@1", server: "beta" }));
    await act(async () => {});
    await act(async () => {});

    expect(st1.closeSpy).toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1); // exactly one
    expect(lastStream().opts.server).toBe("beta");
  });

  it('reopens on resolved → "" — loss of identity triggers a probe reopen', async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    await flushInit();
    const st1 = lastStream();
    const instanceCount = MockStream.instances.length;

    view.rerender(renderAt({ sessionName: "", windowId: "@0" }));
    await act(async () => {});

    expect(st1.closeSpy).toHaveBeenCalled();
    expect(MockStream.instances.length).toBe(instanceCount + 1);
    expect(lastStream()).not.toBe(st1);
  });

  it('restores the 4004 redirect after an external kill — resolved → "" probe stream closes 4004 and onSessionNotFound fires', async () => {
    const onSessionNotFound = vi.fn();
    const { view, renderAt } = createHarness({
      sessionName: "sess",
      windowId: "@0",
      onSessionNotFound,
    });
    await flushInit();
    const instanceCount = MockStream.instances.length;

    view.rerender(renderAt({ sessionName: "", windowId: "@0", onSessionNotFound }));
    await act(async () => {});
    expect(MockStream.instances.length).toBe(instanceCount + 1);
    const probe = lastStream();

    // The probe finds the window gone: the mux delivers a per-stream `closed`
    // 4004, and the redirect path must fire (no reconnect loop, no wedged route).
    act(() => {
      probe.emitClosed(4004, "Window not found");
    });
    expect(onSessionNotFound).toHaveBeenCalledTimes(1);
    // 4004 is a terminal stream close — no new stream opens.
    expect(MockStream.instances.length).toBe(instanceCount + 1);
  });

  it("probes ONE re-open on a non-4004 stream close (S1) — a still-live window re-attaches", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    void view;
    await flushInit();
    const st1 = lastStream();
    const instanceCount = MockStream.instances.length;

    // A non-4004 stream close (1000 graceful / PTY-EOF, or 4001 attach-failed):
    // the mux does NOT re-open a stream-level close, so the client probes ONE
    // fresh re-open (the old per-pane relay printed "[reconnecting…]" and
    // self-healed).
    act(() => {
      st1.emitClosed(1000, "closed");
    });
    expect(MockStream.instances.length).toBe(instanceCount + 1); // one probe re-open
    const probe = lastStream();
    expect(probe).not.toBe(st1);
    expect(probe.opts.windowId).toBe("@0"); // probes the current window

    // The probe re-attaches (still-live window): its data flows into the same
    // terminal, and NO further stream opens.
    act(() => {
      probe.emitOpened();
      probe.emitData("back");
    });
    const term = terminalSpies();
    expectWritten(term, "back");
    expect(MockStream.instances.length).toBe(instanceCount + 1); // still just the one probe
  });

  it("bounds the non-4004 probe to ONE — a second non-4004 close does not loop (S1)", async () => {
    const { view, renderAt } = createHarness({ sessionName: "sess", windowId: "@0" });
    void view;
    await flushInit();
    const st1 = lastStream();
    const instanceCount = MockStream.instances.length;

    act(() => {
      st1.emitClosed(1000, "closed"); // first close → one probe
    });
    expect(MockStream.instances.length).toBe(instanceCount + 1);
    const probe = lastStream();

    act(() => {
      probe.emitClosed(1000, "closed"); // second non-4004 close → NO further probe
    });
    // Bounded: the probe was already consumed, so no third stream opens (a
    // hard-failing window can't spin a re-open loop).
    expect(MockStream.instances.length).toBe(instanceCount + 1);
  });

  it("a non-4004 probe that finds the window gone 4004s → onSessionNotFound (S1)", async () => {
    const onSessionNotFound = vi.fn();
    const { view, renderAt } = createHarness({
      sessionName: "sess",
      windowId: "@0",
      onSessionNotFound,
    });
    void view;
    await flushInit();
    const st1 = lastStream();
    const instanceCount = MockStream.instances.length;

    act(() => {
      st1.emitClosed(1000, "closed"); // non-4004 → probe re-open
    });
    expect(MockStream.instances.length).toBe(instanceCount + 1);
    const probe = lastStream();

    // The probe finds the window genuinely gone: the mux 4004s it, and the
    // redirect fires (no wedged route).
    act(() => {
      probe.emitClosed(4004, "Window not found");
    });
    expect(onSessionNotFound).toHaveBeenCalledTimes(1);
    expect(MockStream.instances.length).toBe(instanceCount + 1); // no further re-open
  });
});

describe("TerminalClient Unicode width init", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(Terminal).mockClear();
    vi.mocked(UnicodeGraphemesAddon).mockClear();
    vi.mocked(WebglAddon).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads UnicodeGraphemesAddon and activates 15-graphemes before WebGL", async () => {
    renderTerminalClient(false);

    await waitFor(() => {
      expect(vi.mocked(UnicodeGraphemesAddon)).toHaveBeenCalled();
      expect(vi.mocked(WebglAddon)).toHaveBeenCalled();
    });

    const ctorArgs = vi.mocked(Terminal).mock.calls[0]?.[0];
    expect(ctorArgs?.allowProposedApi).toBe(true);

    const unicodeOrder = vi.mocked(UnicodeGraphemesAddon).mock.invocationCallOrder[0];
    const webglOrder = vi.mocked(WebglAddon).mock.invocationCallOrder[0];
    expect(unicodeOrder).toBeLessThan(webglOrder);

    const terminalInstance = vi.mocked(Terminal).mock.results[0]?.value as
      | { unicode: { activeVersion: string } }
      | undefined;
    expect(terminalInstance?.unicode.activeVersion).toBe("15-graphemes");
  });
});

describe("TerminalClient scrollback default split + explicit override", () => {
  // The scrollback option is the export transcript's ceiling: absent prop →
  // device split (SCROLLBACK_DESKTOP / SCROLLBACK_MOBILE by the narrow-width-
  // OR-coarse rule, resolved at Terminal construction); an explicit prop
  // (boards pin 1000) always wins.
  function stubViewport(mobile: boolean) {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: mobile,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  function renderWithScrollback(scrollback?: number) {
    return render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName="test-session"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
            scrollback={scrollback}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
  }

  beforeEach(() => {
    localStorage.clear();
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(Terminal).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to SCROLLBACK_DESKTOP on a desktop viewport when the prop is absent", async () => {
    stubViewport(false);
    renderWithScrollback(undefined);

    await waitFor(() => {
      expect(vi.mocked(Terminal)).toHaveBeenCalled();
    });

    const ctorArgs = vi.mocked(Terminal).mock.calls[0]?.[0];
    expect(ctorArgs?.scrollback).toBe(SCROLLBACK_DESKTOP);
  });

  it("defaults to SCROLLBACK_MOBILE on a mobile viewport when the prop is absent", async () => {
    stubViewport(true);
    renderWithScrollback(undefined);

    await waitFor(() => {
      expect(vi.mocked(Terminal)).toHaveBeenCalled();
    });

    const ctorArgs = vi.mocked(Terminal).mock.calls[0]?.[0];
    expect(ctorArgs?.scrollback).toBe(SCROLLBACK_MOBILE);
  });

  it("uses the explicit prop value over the device default", async () => {
    stubViewport(false);
    renderWithScrollback(1000);

    await waitFor(() => {
      expect(vi.mocked(Terminal)).toHaveBeenCalled();
    });

    const ctorArgs = vi.mocked(Terminal).mock.calls[0]?.[0];
    expect(ctorArgs?.scrollback).toBe(1000);
  });
});

describe("TerminalClient Option-as-Meta keyboard init", () => {
  // xterm.js defaults `macOptionIsMeta` to false, which makes macOS treat Option
  // as a third-level shift: the browser composes Option+P into `π` and those
  // bytes reach the pty instead of the `ESC p` a Meta-bound CLI keybinding needs.
  // The symptom itself cannot be reproduced here — composition happens in the
  // OS/IME layer before any JS event fires — so the constructor option is the
  // assertable contract.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(Terminal).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructs the Terminal with macOptionIsMeta enabled", async () => {
    renderTerminalClient(false);

    await waitFor(() => {
      expect(vi.mocked(Terminal)).toHaveBeenCalled();
    });

    const ctorArgs = vi.mocked(Terminal).mock.calls[0]?.[0];
    expect(ctorArgs?.macOptionIsMeta).toBe(true);
  });
});

describe("TerminalClient clickable links (WebLinksAddon handler)", () => {
  // The addon MUST be constructed with an explicit handler. Its default opens
  // a blank window and assigns location.href — inside the desktop shell that
  // surfaces to setWindowOpenHandler as "about:blank" (denied → dead links).
  // The explicit handler passes the real URI through window.open with the
  // codebase's universal "_blank"/"noopener,noreferrer" idiom.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(WebLinksAddon).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("constructs WebLinksAddon with a handler that opens the URI via window.open", async () => {
    renderTerminalClient(false);

    await waitFor(() => {
      expect(vi.mocked(WebLinksAddon)).toHaveBeenCalled();
    });

    const handler = vi.mocked(WebLinksAddon).mock.calls[0]?.[0];
    expect(typeof handler).toBe("function");

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    handler?.(new MouseEvent("click"), "https://github.com/sahil87/run-kit/pull/1");
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/sahil87/run-kit/pull/1",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("TerminalClient terminal-font change syncs the grid to tmux", () => {
  // A font change resizes the xterm grid but NOT the container, so the
  // ResizeObserver never fires. The font effect must therefore send the resize
  // itself — under the mux, that is a `resize` op on the stream. This regression
  // guards that path.

  function FontStepper() {
    const { increaseTerminalFont } = useChrome();
    return (
      <button data-testid="font-plus" onClick={() => increaseTerminalFont()}>
        +
      </button>
    );
  }

  beforeEach(() => {
    stubConnectionEnv();
    vi.mocked(FitAddon).mockClear();
    try { localStorage.removeItem("hexokit-terminal-font-size"); } catch { /* noop */ }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Mount the terminal + a font stepper sharing one ChromeProvider, open the
   *  stream, fire opened (the connect-time grid handshake), and return the
   *  stream. */
  async function mountConnected(): Promise<MockStream> {
    render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName="session-a"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
            scrollLocked={false}
          />
          <FontStepper />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    await act(async () => {});
    await act(async () => {});
    const st = MockStream.instances[MockStream.instances.length - 1];
    // Fire opened so the connect-time grid resize is sent.
    act(() => {
      st.emitOpened();
    });
    return st;
  }

  /** The FitAddon instance THIS test's component created (last result). */
  function fitSpy() {
    const results = vi.mocked(FitAddon).mock.results;
    const inst = results[results.length - 1]?.value as
      | { fit: ReturnType<typeof vi.fn> }
      | undefined;
    expect(inst).toBeTruthy();
    return inst!.fit;
  }

  it("does NOT send an extra resize on mount beyond the connection-open handshake", async () => {
    const st = await mountConnected();
    // onOpened sends exactly one resize (the connect-time grid handshake); the
    // font effect must NOT add a second one on mount (it skips its first run).
    expect(st.resize).toHaveBeenCalledTimes(1);
  });

  it("sends a resize op with the terminal's cols/rows when the font changes", async () => {
    const st = await mountConnected();
    const fit = fitSpy();
    const fitCallsBefore = fit.mock.calls.length;
    const resizesBefore = st.resize.mock.calls.length;

    act(() => {
      (document.querySelector('[data-testid="font-plus"]') as HTMLButtonElement)?.click();
    });
    await act(async () => {});

    // It re-fit the terminal AND told the backend the new grid via a resize op.
    expect(fit.mock.calls.length).toBeGreaterThan(fitCallsBefore);
    expect(st.resize.mock.calls.length).toBe(resizesBefore + 1);
    expect(st.resize.mock.calls[st.resize.mock.calls.length - 1]).toEqual([80, 24]);
  });
});

describe("TerminalClient addon scaffold (search/serialize/progress)", () => {
  // The three addons are pre-landed passively for downstream consumers: the
  // addons load on every terminal, but nothing invokes search/serialize and
  // nothing renders progress. What IS this change's contract: they load
  // without error alongside the existing addons, the imperative-ref seams
  // fill/clear on the focusRef lifecycle, and the progress addon's
  // { state, value } payload is adapted to the two-arg callback prop.
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(Terminal).mockClear();
    vi.mocked(SearchAddon).mockClear();
    vi.mocked(SerializeAddon).mockClear();
    vi.mocked(ProgressAddon).mockClear();
    vi.mocked(UnicodeGraphemesAddon).mockClear();
    vi.mocked(WebglAddon).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderWithSeams(onProgressChange?: (state: number, value: number) => void) {
    const searchAddonRef: React.MutableRefObject<SearchAddon | null> = { current: null };
    const serializeAddonRef: React.MutableRefObject<SerializeAddon | null> = { current: null };
    const terminalRef: React.MutableRefObject<InstanceType<typeof Terminal> | null> = { current: null };
    const result = render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName="test-session"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
            searchAddonRef={searchAddonRef}
            serializeAddonRef={serializeAddonRef}
            terminalRef={terminalRef}
            onProgressChange={onProgressChange}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
    return { result, searchAddonRef, serializeAddonRef, terminalRef };
  }

  it("loads all three addons without error alongside the existing ones", async () => {
    renderTerminalClient(false);

    await waitFor(() => {
      expect(vi.mocked(SearchAddon)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(SerializeAddon)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ProgressAddon)).toHaveBeenCalledTimes(1);
    });

    const terminal = vi.mocked(Terminal).mock.results[0]?.value;
    const loaded = terminal.loadAddon.mock.calls.map((c: unknown[]) => c[0]);
    expect(loaded).toContain(vi.mocked(SearchAddon).mock.results[0]?.value);
    expect(loaded).toContain(vi.mocked(SerializeAddon).mock.results[0]?.value);
    expect(loaded).toContain(vi.mocked(ProgressAddon).mock.results[0]?.value);
    // The existing addons still load — the scaffold adds, never reorders away.
    expect(loaded).toContain(vi.mocked(UnicodeGraphemesAddon).mock.results[0]?.value);
    expect(loaded).toContain(vi.mocked(WebglAddon).mock.results[0]?.value);
  });

  it("fills the search/serialize seam refs at init and clears them on unmount", async () => {
    const { result, searchAddonRef, serializeAddonRef } = renderWithSeams();

    await waitFor(() => {
      expect(searchAddonRef.current).toBe(vi.mocked(SearchAddon).mock.results[0]?.value);
      expect(serializeAddonRef.current).toBe(
        vi.mocked(SerializeAddon).mock.results[0]?.value,
      );
    });

    result.unmount();
    expect(searchAddonRef.current).toBeNull();
    expect(serializeAddonRef.current).toBeNull();
  });

  it("fills the terminal seam ref at init and clears it on unmount", async () => {
    const { result, terminalRef } = renderWithSeams();

    await waitFor(() => {
      expect(terminalRef.current).toBe(vi.mocked(Terminal).mock.results[0]?.value);
    });

    result.unmount();
    expect(terminalRef.current).toBeNull();
  });

  it("adapts the progress addon's { state, value } payload to the two-arg prop", async () => {
    const onProgressChange = vi.fn();
    renderWithSeams(onProgressChange);

    await waitFor(() => {
      expect(vi.mocked(ProgressAddon)).toHaveBeenCalledTimes(1);
    });

    const progress = vi.mocked(ProgressAddon).mock.results[0]?.value;
    const changeCb = progress.onChange.mock.calls[0]?.[0];
    expect(typeof changeCb).toBe("function");

    changeCb({ state: 1, value: 42 });
    expect(onProgressChange).toHaveBeenCalledWith(1, 42);
  });
});

describe("TerminalClient ctrl-wheel/pinch font zoom (260823-cwvv R7)", () => {
  function FontProbe() {
    const { terminalFontSize } = useChrome();
    return <div data-testid="font-size">{terminalFontSize}</div>;
  }

  function renderWithProbe() {
    return render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <FontProbe />
          <TerminalClient
            sessionName="test-session"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("ctrl-wheel steps the global font size and is prevented; plain wheel passes through", async () => {
    const { container, getByTestId } = renderWithProbe();
    await act(async () => {});
    const terminalDiv = container.querySelector("[role='application']") as HTMLElement;
    expect(terminalDiv).toBeTruthy();
    const before = Number(getByTestId("font-size").textContent);

    fireEvent(terminalDiv, new WheelEvent("wheel", { deltaY: -60, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(Number(getByTestId("font-size").textContent)).toBe(before + 1);

    fireEvent(terminalDiv, new WheelEvent("wheel", { deltaY: 60, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(Number(getByTestId("font-size").textContent)).toBe(before);

    // Unmodified wheel: no step.
    fireEvent(terminalDiv, new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
    expect(Number(getByTestId("font-size").textContent)).toBe(before);
  });

  it("a small ctrl-wheel tick below the threshold accumulates without stepping", async () => {
    const { container, getByTestId } = renderWithProbe();
    await act(async () => {});
    const terminalDiv = container.querySelector("[role='application']") as HTMLElement;
    const before = Number(getByTestId("font-size").textContent);
    fireEvent(terminalDiv, new WheelEvent("wheel", { deltaY: -20, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(Number(getByTestId("font-size").textContent)).toBe(before);
    // Crossing the accumulated threshold steps once.
    fireEvent(terminalDiv, new WheelEvent("wheel", { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true }));
    expect(Number(getByTestId("font-size").textContent)).toBe(before + 1);
  });
});

describe("TerminalClient switch-receipt source — exactly one terminal reports notifyFirstWrite", () => {
  function renderWith(switchReceiptSource: boolean | undefined) {
    return render(
      <ChromeProvider>
        <FocusedTerminalProvider>
          <TerminalClient
            sessionName="sess"
            windowId="@0"
            server="default"
            wsRef={createWsRef()}
            scrollLocked={false}
            switchReceiptSource={switchReceiptSource}
          />
        </FocusedTerminalProvider>
      </ChromeProvider>,
    );
  }

  function lastStream(): MockStream {
    expect(MockStream.instances.length).toBeGreaterThan(0);
    return MockStream.instances[MockStream.instances.length - 1];
  }

  beforeEach(() => {
    stubConnectionEnv();
    vi.mocked(notifyFirstWrite).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reports the receipt on each inbound frame when it is the route's receipt source", async () => {
    renderWith(true);
    await act(async () => {});
    await act(async () => {});
    const st = lastStream();
    act(() => {
      st.emitOpened();
      st.emitData("ok");
    });
    expect(notifyFirstWrite).toHaveBeenCalledTimes(1);
  });

  it("never reports the receipt when it is not the receipt source (the default) — board panes, duplicate tty tiles, the quake terminal", async () => {
    renderWith(undefined);
    await act(async () => {});
    await act(async () => {});
    const st = lastStream();
    act(() => {
      st.emitOpened();
      st.emitData("ok");
      st.emitData("x".repeat(200));
    });
    expect(notifyFirstWrite).not.toHaveBeenCalled();
  });
});

describe("TerminalClient WebGL fallback telemetry", () => {
  // The fallback is announced, not fixed: every fallback path warns on the
  // console with the greppable `rk: xterm WebGL` contract, and only the FIRST
  // runtime context loss of a page load raises one info toast. The loss is
  // forced by invoking the callback init() registered on the mocked addon.
  type LossAddon = { dispose: ReturnType<typeof vi.fn>; onContextLoss: ReturnType<typeof vi.fn> };

  function webglAddon(i = 0): LossAddon {
    const addon = vi.mocked(WebglAddon).mock.results[i]?.value as LossAddon | undefined;
    expect(addon).toBeDefined();
    return addon as LossAddon;
  }

  function lossCallback(i = 0): () => void {
    const cb = webglAddon(i).onContextLoss.mock.calls[0]?.[0];
    expect(typeof cb).toBe("function");
    return cb as () => void;
  }

  function renderInToastProvider(windowIds: string[]) {
    return render(
      <ToastProvider>
        <ChromeProvider>
          <FocusedTerminalProvider>
            {windowIds.map((id) => (
              <TerminalClient
                key={id}
                sessionName="test-session"
                windowId={id}
                server="default"
                wsRef={createWsRef()}
              />
            ))}
          </FocusedTerminalProvider>
        </ChromeProvider>
      </ToastProvider>,
    );
  }

  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      media: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    MockStream.instances = [];
    mockRelayMux.openStream.mockClear();
    vi.mocked(Terminal).mockClear();
    vi.mocked(UnicodeGraphemesAddon).mockClear();
    vi.mocked(WebglAddon).mockClear();
    resetWebglFallbackNoticeForTests();
    delete window.__rkRenderer;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete window.__rkRenderer;
  });

  it("a runtime context loss disposes the addon, records canvas, and warns once with server/window and the mounted count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderTerminalClient(false);
    await waitFor(() => expect(vi.mocked(WebglAddon)).toHaveBeenCalledTimes(1));
    expect(window.__rkRenderer?.["@0"]).toBe("webgl");

    act(() => lossCallback()());

    expect(webglAddon().dispose).toHaveBeenCalledTimes(1);
    expect(window.__rkRenderer?.["@0"]).toBe("canvas");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("rk: xterm WebGL context lost");
    expect(message).toContain("default/@0");
    expect(message).toContain("(1 terminal mounted)");
  });

  it("raises exactly one info toast per page load across terminals, while every loss warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = renderInToastProvider(["@1", "@2"]);
    await waitFor(() => expect(vi.mocked(WebglAddon)).toHaveBeenCalledTimes(2));

    act(() => {
      lossCallback(0)();
      lossCallback(1)();
    });

    const alerts = result.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain(WEBGL_FALLBACK_TOAST);
    expect(warn).toHaveBeenCalledTimes(2);
    // Both terminals had finished init, so each loss reports the pair.
    expect(String(warn.mock.calls[0]?.[0])).toContain("(2 terminals mounted)");
    expect(String(warn.mock.calls[1]?.[0])).toContain("(2 terminals mounted)");
  });

  it("outside a ToastProvider a context loss still warns and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = renderTerminalClient(false);
    await waitFor(() => expect(vi.mocked(WebglAddon)).toHaveBeenCalledTimes(1));

    expect(() => act(() => lossCallback()())).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(result.queryByRole("alert")).toBeNull();
  });

  it("a load-time WebGL failure warns without a toast and the terminal still initialises", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // `function`, not an arrow: init() calls `new WebglAddon()`, and Vitest
    // warns on the console (the spied channel) when an arrow mock is constructed.
    vi.mocked(WebglAddon).mockImplementationOnce(function () {
      throw new Error("no webgl");
    });
    const result = renderInToastProvider(["@0"]);

    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("rk: xterm WebGL unavailable at load");
    expect(message).toContain("default/@0");
    expect(message).toContain("(1 terminal mounted)");
    expect(result.queryByRole("alert")).toBeNull();
    expect(window.__rkRenderer?.["@0"]).toBe("canvas");

    // The rest of init ran: the addons before WebGL loaded on the terminal.
    const terminal = vi.mocked(Terminal).mock.results[0]?.value;
    const loaded = terminal.loadAddon.mock.calls.map((c: unknown[]) => c[0]);
    expect(loaded).toContain(vi.mocked(UnicodeGraphemesAddon).mock.results[0]?.value);
  });
});
