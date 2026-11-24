import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useStripPrefs } from "./use-strip-prefs";

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function shellWithPrefs(prefs = { strip: { effect: "hex", motion: "sweep" } }) {
  const set = vi.fn().mockResolvedValue({ ok: true });
  let push: ((payload: unknown) => void) | undefined;
  const off = vi.fn();
  window.runkitShell = {
    version: "1.0.0",
    platform: "linux",
    prefs: {
      get: () => Promise.resolve({ ok: true, prefs }),
      set,
      onChange: (cb: (payload: unknown) => void) => {
        push = cb;
        return off;
      },
    },
  };
  return { set, off, emit: (p: unknown) => push?.(p) };
}

afterEach(() => {
  delete window.runkitShell;
  vi.unstubAllGlobals();
});

describe("useStripPrefs", () => {
  it("holds the Glow + Light slides defaults, and cannot set, without the shell's prefs invokers", () => {
    stubReducedMotion(false);
    const { result } = renderHook(() => useStripPrefs());
    expect(result.current).toMatchObject({ effect: "glow", motion: "slide", appliedMotion: "slide", canSet: false });
    expect(() => result.current.setEffect("hex")).not.toThrow();
  });

  it("seeds from prefs.get and follows the prefs:changed broadcast", async () => {
    stubReducedMotion(false);
    const bridge = shellWithPrefs();
    const { result, unmount } = renderHook(() => useStripPrefs());
    expect(result.current.canSet).toBe(true);
    await waitFor(() => expect(result.current).toMatchObject({ effect: "hex", motion: "sweep" }));
    act(() => bridge.emit({ strip: { effect: "scan", motion: "cut" } }));
    expect(result.current).toMatchObject({ effect: "scan", motion: "cut" });
    act(() => bridge.emit({ strip: { effect: "nope", motion: "cut" } })); // malformed: dropped
    expect(result.current.effect).toBe("scan");
    unmount();
    expect(bridge.off).toHaveBeenCalled();
  });

  it("setEffect / setMotion write one key each through the shell", async () => {
    stubReducedMotion(false);
    const bridge = shellWithPrefs();
    const { result } = renderHook(() => useStripPrefs());
    act(() => result.current.setEffect("edge"));
    act(() => result.current.setMotion("cut"));
    expect(bridge.set).toHaveBeenCalledWith("strip.effect", "edge");
    expect(bridge.set).toHaveBeenCalledWith("strip.motion", "cut");
  });

  it("reduced motion applies Cut while the stored choice stays what Settings shows", async () => {
    stubReducedMotion(true);
    shellWithPrefs();
    const { result } = renderHook(() => useStripPrefs());
    await waitFor(() => expect(result.current.motion).toBe("sweep"));
    expect(result.current.appliedMotion).toBe("cut");
  });
});
