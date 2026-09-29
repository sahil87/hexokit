import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  ASK_OPERATOR_MIN_QUERY,
  LEGACY_QUAKE_GEOMETRY_KEY,
  LEGACY_QUAKE_OPACITY_KEY,
  QUAKE_GEOMETRY_DEFAULT,
  QUAKE_GEOMETRY_KEY,
  QUAKE_OPACITY_DEFAULT,
  QUAKE_OPACITY_KEY,
  attachOperatorFiles,
  clampQuakeGeometry,
  clampQuakeOpacity,
  cycleQuakeMachine,
  findOperatorWindow,
  getQuakeComposeEngaged,
  getQuakeMachineState,
  getQuakePinned,
  isQuakeTerminalRequest,
  isQuakeTerminalTarget,
  operatorComposeKey,
  QUAKE_TERMINAL_ROOT_ATTR,
  readQuakeGeometry,
  readQuakeOpacity,
  resetOperatorComposeFlags,
  resolveQuakeServer,
  sendOperatorMessage,
  setQuakeComposeEngaged,
  setQuakeMachineState,
  setQuakePinned,
  setQuakeRestoreOrigin,
  setOperatorComposeText,
  shouldShowAskOperatorRow,
  takeQuakeRestoreOrigin,
  useOperatorCompose,
  useQuakeComposeEngaged,
  useQuakePinned,
  writeQuakeGeometry,
  writeQuakeOpacity,
} from "./quake-terminal";
import { act, renderHook } from "@testing-library/react";
import { getComposeDraft, hydrateComposeDrafts, setComposeText } from "./compose-draft-store";
import { entryKey } from "@/store/window-store";
import type { ProjectSession, WindowInfo } from "@/types";

const mockSend = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  sendToWindow: mockSend,
  uploadFile: mockUpload,
}));

function win(overrides: Partial<WindowInfo>): WindowInfo {
  return {
    windowId: "@1",
    index: 0,
    name: "win",
    worktreePath: "/tmp",
    activity: "idle",
    isActiveWindow: false,
    activityTimestamp: 0,
    ...overrides,
  };
}

function session(name: string, windows: WindowInfo[]): ProjectSession {
  return { name, windows };
}

describe("resolveQuakeServer", () => {
  it("prefers the route server over every other source", () => {
    expect(resolveQuakeServer("fabKit1", ["a", "fabKit1"], "a")).toBe("fabKit1");
    expect(resolveQuakeServer("fabKit1", [], null)).toBe("fabKit1");
  });

  it("preselects the sole server when exactly one exists", () => {
    expect(resolveQuakeServer(null, ["only"], null)).toBe("only");
    expect(resolveQuakeServer(null, ["only"], "stale")).toBe("only");
  });

  it("defaults to the most recently viewed server when it is still listed", () => {
    expect(resolveQuakeServer(null, ["a", "b"], "b")).toBe("b");
  });

  it("falls back to the first server when lastViewed is stale or absent", () => {
    expect(resolveQuakeServer(null, ["a", "b"], "gone")).toBe("a");
    expect(resolveQuakeServer(null, ["a", "b"], null)).toBe("a");
  });

  it("returns null for an empty server list", () => {
    expect(resolveQuakeServer(null, [], "a")).toBeNull();
    expect(resolveQuakeServer(null, [], null)).toBeNull();
  });
});

describe("findOperatorWindow", () => {
  it("finds the role=operator window across sessions, with its session name", () => {
    const sessions = [
      session("main", [win({ windowId: "@1" }), win({ windowId: "@2" })]),
      session("_rk-operator", [win({ windowId: "@9", role: "operator", name: "operator" })]),
    ];
    expect(findOperatorWindow(sessions)).toEqual({
      window: sessions[1].windows[0],
      sessionName: "_rk-operator",
    });
  });

  it("returns undefined when no window carries the operator role", () => {
    expect(findOperatorWindow([session("main", [win({})])])).toBeUndefined();
    expect(findOperatorWindow([])).toBeUndefined();
  });

  it("ignores an empty windowId (ghost rows never carry a role, belt-and-suspenders)", () => {
    const sessions = [session("main", [win({ windowId: "", role: "operator" })])];
    expect(findOperatorWindow(sessions)).toBeUndefined();
  });
});

describe("shouldShowAskOperatorRow", () => {
  it("shows only at zero matches with an operator and a floor-length query", () => {
    expect(shouldShowAskOperatorRow("hello", 0, true)).toBe(true);
    expect(shouldShowAskOperatorRow("hello", 2, true)).toBe(false);
    expect(shouldShowAskOperatorRow("hello", 0, false)).toBe(false);
  });

  it("enforces the trimmed length floor", () => {
    const short = "x".repeat(ASK_OPERATOR_MIN_QUERY - 1);
    const exact = "x".repeat(ASK_OPERATOR_MIN_QUERY);
    expect(shouldShowAskOperatorRow(short, 0, true)).toBe(false);
    expect(shouldShowAskOperatorRow(exact, 0, true)).toBe(true);
    expect(shouldShowAskOperatorRow(`  ${short}  `, 0, true)).toBe(false);
    expect(shouldShowAskOperatorRow("   ", 0, true)).toBe(false);
  });
});

describe("isQuakeTerminalRequest", () => {
  it("accepts both actions and rejects foreign details", () => {
    expect(isQuakeTerminalRequest({ action: "toggle" })).toBe(true);
    expect(isQuakeTerminalRequest({ action: "open", server: "a", send: "hi" })).toBe(true);
    expect(isQuakeTerminalRequest({ action: "close" })).toBe(false);
    expect(isQuakeTerminalRequest(null)).toBe(false);
    expect(isQuakeTerminalRequest("open")).toBe(false);
    expect(isQuakeTerminalRequest(undefined)).toBe(false);
  });
});

describe("quake machine state", () => {
  beforeEach(() => {
    setQuakeMachineState("rest");
  });

  it("starts at rest and notifies subscribers on change", () => {
    expect(getQuakeMachineState()).toBe("rest");
    setQuakeMachineState("open");
    expect(getQuakeMachineState()).toBe("open");
  });

  it("toggles rest ⇄ open", () => {
    expect(cycleQuakeMachine("rest")).toBe("open");
    expect(cycleQuakeMachine("open")).toBe("rest");
  });
});

describe("quake pin slot", () => {
  beforeEach(() => {
    setQuakeMachineState("rest");
  });

  it("defaults to false and notifies subscribers on toggle", () => {
    const { result } = renderHook(() => useQuakePinned());
    expect(result.current).toBe(false);
    act(() => setQuakePinned(true));
    expect(result.current).toBe(true);
    expect(getQuakePinned()).toBe(true);
  });

  it("resets to false when the machine enters rest", () => {
    const { result } = renderHook(() => useQuakePinned());
    act(() => setQuakeMachineState("open"));
    act(() => setQuakePinned(true));
    expect(result.current).toBe(true);

    act(() => setQuakeMachineState("rest"));
    expect(result.current).toBe(false);
    expect(getQuakePinned()).toBe(false);
  });
});

describe("quake compose-engaged slot", () => {
  beforeEach(() => {
    setQuakeMachineState("rest");
  });

  it("notifies subscribers on change", () => {
    const { result } = renderHook(() => useQuakeComposeEngaged());
    expect(result.current).toBe(false);
    act(() => setQuakeComposeEngaged(true));
    expect(result.current).toBe(true);
    expect(getQuakeComposeEngaged()).toBe(true);
  });

  it("resets to false when the machine enters rest", () => {
    const { result } = renderHook(() => useQuakeComposeEngaged());
    act(() => setQuakeMachineState("open"));
    act(() => setQuakeComposeEngaged(true));

    act(() => setQuakeMachineState("rest"));
    expect(result.current).toBe(false);
  });
});

describe("quake restore-origin slot", () => {
  it("round-trips the recorded element and clears on take", () => {
    const el = document.createElement("button");
    setQuakeRestoreOrigin(el);
    expect(takeQuakeRestoreOrigin()).toBe(el);
    expect(takeQuakeRestoreOrigin()).toBeNull();
  });

  it("records null for a quake-owned (or absent) origin", () => {
    setQuakeRestoreOrigin(null);
    expect(takeQuakeRestoreOrigin()).toBeNull();
  });
});

describe("shared compose seam", () => {
  const target = {
    window: win({ windowId: "@9", name: "operator", role: "operator" }),
    sessionName: "_rk-operator",
  };
  // A second server's operator — the same window id is legal (ids are
  // server-scoped), which is exactly why the key carries the server.
  const targetB = {
    window: win({ windowId: "@9", name: "operator", role: "operator" }),
    sessionName: "_rk-operator",
  };

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ ok: true });
    mockUpload.mockReset();
    mockUpload.mockResolvedValue({ ok: true, path: "/tmp/op/.uploads/shot.png" });
    localStorage.clear();
    hydrateComposeDrafts();
    resetOperatorComposeFlags();
  });

  it("operatorComposeKey is the operator window's entryKey, null without a target or server", () => {
    expect(operatorComposeKey("srv1", target)).toBe(entryKey("srv1", "@9"));
    expect(operatorComposeKey("srv1", undefined)).toBeNull();
    expect(operatorComposeKey(null, target)).toBeNull();
  });

  it("the draft is keyed by server: A's text never renders under B and survives the round trip", () => {
    const { result, rerender } = renderHook(
      ({ server, tgt }: { server: string; tgt: typeof target }) => useOperatorCompose(server, tgt),
      { initialProps: { server: "srvA", tgt: target } },
    );
    act(() => setOperatorComposeText("srvA", target, "for A"));
    expect(result.current.text).toBe("for A");

    rerender({ server: "srvB", tgt: targetB });
    expect(result.current.text).toBe("");

    rerender({ server: "srvA", tgt: target });
    expect(result.current.text).toBe("for A");
    // The text lives in the shared draft store under the operator's key.
    expect(getComposeDraft(entryKey("srvA", "@9")).text).toBe("for A");
  });

  it("without an operator the draft is empty and edits write nothing", () => {
    const { result } = renderHook(() => useOperatorCompose("srvA", undefined));
    act(() => setOperatorComposeText("srvA", undefined, "typed into the void"));
    expect(result.current.text).toBe("");
    expect(localStorage.getItem("hexokit-compose-drafts")).toBeNull();
  });

  it("the returned state is reference-stable while neither text nor flags changed", () => {
    const { result, rerender } = renderHook(() => useOperatorCompose("srvA", target));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => setOperatorComposeText("srvA", target, "changed"));
    expect(result.current).not.toBe(first);
  });

  it("sendOperatorMessage delivers via the agent lane and clears the draft", async () => {
    const { result } = renderHook(() => useOperatorCompose("srv1", target));
    act(() => setOperatorComposeText("srv1", target, "restart the worker"));
    expect(result.current.text).toBe("restart the worker");

    let ok!: boolean;
    await act(async () => {
      ok = await sendOperatorMessage("srv1", target, "restart the worker");
    });
    expect(ok).toBe(true);
    expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "restart the worker", "submit", "agent");
    expect(result.current.text).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("guards whitespace-only and target-less sends as no-ops", async () => {
    await act(async () => {
      await sendOperatorMessage("srv1", target, "   ");
      await sendOperatorMessage(null, target, "hi");
      await sendOperatorMessage("srv1", undefined, "hi");
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("a failed send surfaces the error and preserves the draft; an edit clears it", async () => {
    mockSend.mockRejectedValue(new Error("probe failed"));
    const { result } = renderHook(() => useOperatorCompose("srv1", target));
    act(() => setOperatorComposeText("srv1", target, "retry me"));

    let ok!: boolean;
    await act(async () => {
      ok = await sendOperatorMessage("srv1", target, "retry me");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("probe failed");
    expect(result.current.text).toBe("retry me");

    act(() => setOperatorComposeText("srv1", target, "retry me, edited"));
    expect(result.current.error).toBeNull();
  });

  it("a send error on A is invisible under B; an edit on A clears only A", async () => {
    mockSend.mockRejectedValue(new Error("probe failed"));
    const a = renderHook(() => useOperatorCompose("srvA", target));
    const b = renderHook(() => useOperatorCompose("srvB", targetB));
    await act(async () => {
      await sendOperatorMessage("srvA", target, "for A");
    });
    expect(a.result.current.error).toBe("probe failed");
    expect(b.result.current.error).toBeNull();

    act(() => setOperatorComposeText("srvA", target, "for A, edited"));
    expect(a.result.current.error).toBeNull();
  });

  it("a successful send on A clears only A's draft — B's survives", async () => {
    act(() => {
      setOperatorComposeText("srvA", target, "for A");
      setOperatorComposeText("srvB", targetB, "for B");
    });
    await act(async () => {
      await sendOperatorMessage("srvA", target, "for A");
    });
    expect(getComposeDraft(entryKey("srvA", "@9")).text).toBe("");
    expect(getComposeDraft(entryKey("srvB", "@9")).text).toBe("for B");
  });

  it("the in-flight guard blocks a concurrent send on the same server, not on another", async () => {
    let release!: () => void;
    mockSend.mockImplementationOnce(
      () => new Promise<{ ok: boolean }>((resolve) => { release = () => resolve({ ok: true }); }),
    );
    let first!: Promise<boolean>;
    let second!: boolean;
    let onB!: boolean;
    await act(async () => {
      first = sendOperatorMessage("srv1", target, "one");
      second = await sendOperatorMessage("srv1", target, "two");
      onB = await sendOperatorMessage("srvB", targetB, "b");
    });
    expect(second).toBe(false);
    expect(onB).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
    await act(async () => {
      release();
      await first;
    });
  });

  it("the operator page's strip and the quake compose read one draft", () => {
    // The route strip writes the operator window's entryKey directly; the
    // quake seam must see that text under the same (server, target) pair.
    setComposeText(entryKey("srv1", "@9"), "seeded by the strip");
    const { result } = renderHook(() => useOperatorCompose("srv1", target));
    expect(result.current.text).toBe("seeded by the strip");
  });

  it("attachOperatorFiles uploads to the operator session and insert-delivers each path", async () => {
    const files = [new File(["a"], "a.png", { type: "image/png" })];
    await act(async () => {
      await attachOperatorFiles("srv1", target, files);
    });
    expect(mockUpload).toHaveBeenCalledWith("srv1", "_rk-operator", files[0], "@9");
    expect(mockSend).toHaveBeenCalledWith("srv1", "@9", "/tmp/op/.uploads/shot.png ", "raw", "agent");
  });

  it("attachOperatorFiles is a no-op without a target and surfaces upload failures inline", async () => {
    const files = [new File(["a"], "a.png", { type: "image/png" })];
    await act(async () => {
      await attachOperatorFiles("srv1", undefined, files);
    });
    expect(mockUpload).not.toHaveBeenCalled();

    mockUpload.mockRejectedValue(new Error("upload exploded"));
    const { result } = renderHook(() => useOperatorCompose("srv1", target));
    await act(async () => {
      await attachOperatorFiles("srv1", target, files);
    });
    expect(result.current.error).toBe("upload exploded");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("quake geometry store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the defaults when nothing is stored", () => {
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
  });

  it("the default opens centered", () => {
    expect(QUAKE_GEOMETRY_DEFAULT.centerOffsetPx).toBe(0);
  });

  it("round-trips a written three-field geometry", () => {
    writeQuakeGeometry({ heightVh: 70, widthPx: 900, centerOffsetPx: 40 });
    expect(readQuakeGeometry()).toEqual({ heightVh: 70, widthPx: 900, centerOffsetPx: 40 });
  });

  it("reads a stored two-field record (written before the offset existed) as centered", () => {
    localStorage.setItem(QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 70, widthPx: 900 }));
    expect(readQuakeGeometry()).toEqual({ heightVh: 70, widthPx: 900, centerOffsetPx: 0 });
  });

  it("reads a two-field record under the legacy key as centered", () => {
    localStorage.setItem(LEGACY_QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 70, widthPx: 900 }));
    expect(readQuakeGeometry()).toEqual({ heightVh: 70, widthPx: 900, centerOffsetPx: 0 });
  });

  it("degrades to defaults on corrupt JSON", () => {
    localStorage.setItem(QUAKE_GEOMETRY_KEY, "{not json");
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
  });

  it("degrades to defaults on a wrong shape", () => {
    localStorage.setItem(QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: "70", widthPx: 900 }));
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
  });

  it("degrades to defaults when the offset is present but not a number", () => {
    localStorage.setItem(
      QUAKE_GEOMETRY_KEY,
      JSON.stringify({ heightVh: 70, widthPx: 900, centerOffsetPx: "12" }),
    );
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
  });

  it("clamps out-of-range stored values instead of rejecting them", () => {
    localStorage.setItem(QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 99, widthPx: 100 }));
    expect(readQuakeGeometry()).toEqual({ heightVh: 85, widthPx: 420, centerOffsetPx: 0 });
  });

  it("clamps width against the 96vw ceiling", () => {
    const clamped = clampQuakeGeometry({ heightVh: 55, widthPx: 2000, centerOffsetPx: 0 }, 1000);
    expect(clamped.widthPx).toBe(960);
  });

  it("clamps height into 25–85vh", () => {
    expect(clampQuakeGeometry({ heightVh: 10, widthPx: 760, centerOffsetPx: 0 }).heightVh).toBe(25);
    expect(clampQuakeGeometry({ heightVh: 90, widthPx: 760, centerOffsetPx: 0 }).heightVh).toBe(85);
  });

  it("clamps the center offset so the drawer keeps the edge pad inside the viewport", () => {
    // (1000 − 760) / 2 − 8 = 112 on either side.
    expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: 500 }, 1000).centerOffsetPx).toBe(
      112,
    );
    expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: -500 }, 1000).centerOffsetPx).toBe(
      -112,
    );
    expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: 50 }, 1000).centerOffsetPx).toBe(50);
  });

  it("bounds the offset against the CLAMPED width and never goes negative at the ceiling", () => {
    // Width pins at 960 (96vw of 1000); (1000 − 960) / 2 − 8 = 12.
    const atCeiling = clampQuakeGeometry({ heightVh: 55, widthPx: 2000, centerOffsetPx: 300 }, 1000);
    expect(atCeiling).toEqual({ heightVh: 55, widthPx: 960, centerOffsetPx: 12 });
    // A viewport so narrow the pad cannot fit (2vw < 8px) still yields offset 0,
    // never a flipped range: 96vw of 300 is 288, (300 − 288) / 2 − 8 < 0.
    const tiny = clampQuakeGeometry({ heightVh: 55, widthPx: 420, centerOffsetPx: 30 }, 300);
    expect(tiny.centerOffsetPx).toBe(0);
    expect(tiny.widthPx).toBe(288);
  });

  it("treats a non-finite offset as centered and rounds the result", () => {
    expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: NaN }, 1000).centerOffsetPx).toBe(0);
    expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: 10.6 }, 1000).centerOffsetPx).toBe(11);
  });

  it("leaves the offset unclamped when no viewport width is known", () => {
    // An explicit `undefined` argument takes the default (window.innerWidth), so
    // the no-viewport path is reached by making innerWidth unusable.
    const original = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: NaN, configurable: true });
    try {
      expect(clampQuakeGeometry({ heightVh: 55, widthPx: 760, centerOffsetPx: 5000 }).centerOffsetPx).toBe(5000);
    } finally {
      Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
    }
  });

  it("falls back to the legacy key, clamped through the same path, when the new key is absent", () => {
    localStorage.setItem(LEGACY_QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 99, widthPx: 100 }));
    expect(readQuakeGeometry()).toEqual({ heightVh: 85, widthPx: 420, centerOffsetPx: 0 });
  });

  it("prefers the new key when both keys are set", () => {
    localStorage.setItem(LEGACY_QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 40, widthPx: 600 }));
    localStorage.setItem(QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 70, widthPx: 900, centerOffsetPx: 20 }));
    expect(readQuakeGeometry()).toEqual({ heightVh: 70, widthPx: 900, centerOffsetPx: 20 });
  });

  it("a write stores all three fields under the new key and removes the legacy key", () => {
    localStorage.setItem(LEGACY_QUAKE_GEOMETRY_KEY, JSON.stringify({ heightVh: 40, widthPx: 600 }));
    writeQuakeGeometry({ heightVh: 70, widthPx: 900, centerOffsetPx: 20 });
    expect(localStorage.getItem(QUAKE_GEOMETRY_KEY)).toBe(
      JSON.stringify({ heightVh: 70, widthPx: 900, centerOffsetPx: 20 }),
    );
    expect(localStorage.getItem(LEGACY_QUAKE_GEOMETRY_KEY)).toBeNull();
  });

  it("degrades to defaults on a corrupt legacy value", () => {
    localStorage.setItem(LEGACY_QUAKE_GEOMETRY_KEY, "{not json");
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
  });
});

describe("quake opacity store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns the default 0.95 when nothing is stored", () => {
    expect(readQuakeOpacity()).toBe(QUAKE_OPACITY_DEFAULT);
  });

  it("round-trips a written opacity", () => {
    writeQuakeOpacity(0.8);
    expect(readQuakeOpacity()).toBe(0.8);
  });

  it("degrades to the default on a non-numeric value", () => {
    localStorage.setItem(QUAKE_OPACITY_KEY, "opaque-ish");
    expect(readQuakeOpacity()).toBe(QUAKE_OPACITY_DEFAULT);
  });

  it("clamps into 0.5–1.0", () => {
    expect(clampQuakeOpacity(0.2)).toBe(0.5);
    expect(clampQuakeOpacity(1.4)).toBe(1.0);
    localStorage.setItem(QUAKE_OPACITY_KEY, "0.3");
    expect(readQuakeOpacity()).toBe(0.5);
  });

  it("falls back to the legacy key when the new key is absent", () => {
    localStorage.setItem(LEGACY_QUAKE_OPACITY_KEY, "0.7");
    expect(readQuakeOpacity()).toBe(0.7);
  });

  it("prefers the new key when both keys are set", () => {
    localStorage.setItem(LEGACY_QUAKE_OPACITY_KEY, "0.7");
    localStorage.setItem(QUAKE_OPACITY_KEY, "0.9");
    expect(readQuakeOpacity()).toBe(0.9);
  });

  it("a write stores the new key and removes the legacy key", () => {
    localStorage.setItem(LEGACY_QUAKE_OPACITY_KEY, "0.7");
    writeQuakeOpacity(0.8);
    expect(localStorage.getItem(QUAKE_OPACITY_KEY)).toBe("0.8");
    expect(localStorage.getItem(LEGACY_QUAKE_OPACITY_KEY)).toBeNull();
  });

  it("degrades to the default on a corrupt legacy value", () => {
    localStorage.setItem(LEGACY_QUAKE_OPACITY_KEY, "opaque-ish");
    expect(readQuakeOpacity()).toBe(QUAKE_OPACITY_DEFAULT);
  });
});

describe("isQuakeTerminalTarget", () => {
  it("recognizes targets inside the quake terminal root and rejects everything else", () => {
    const root = document.createElement("div");
    root.setAttribute(QUAKE_TERMINAL_ROOT_ATTR, "");
    const inner = document.createElement("textarea");
    root.appendChild(inner);
    document.body.appendChild(root);

    expect(isQuakeTerminalTarget(inner)).toBe(true);
    expect(isQuakeTerminalTarget(root)).toBe(true);
    expect(isQuakeTerminalTarget(document.body)).toBe(false);
    expect(isQuakeTerminalTarget(null)).toBe(false);
    root.remove();
  });
});
