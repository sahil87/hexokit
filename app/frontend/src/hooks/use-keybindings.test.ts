import { describe, it, expect, afterEach } from "vitest";
import { cleanup, renderHook, act } from "@testing-library/react";
import { useKeybindings } from "./use-keybindings";
import { KEYBINDINGS_STORAGE_KEY } from "@/lib/keybindings";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useKeybindings", () => {
  it("resolves the default map (jsdom = non-mac browser host)", () => {
    const { result } = renderHook(() => useKeybindings());
    expect(result.current.host.shell).toBe(false);
    expect(result.current.byAction.get("window-next")).toMatchObject({
      code: "ArrowDown",
      tier: "shifted",
      enabled: true,
      isDefault: true,
    });
    // Browser host: shifted N is browser-reserved.
    expect(result.current.byAction.get("create-session")).toMatchObject({
      enabled: false,
      disabledReason: "reserved",
    });
  });

  it("hydrates from stored diffs", () => {
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "window-next": { code: "KeyU", tier: "shifted" } }),
    );
    const { result } = renderHook(() => useKeybindings());
    expect(result.current.byAction.get("window-next")).toMatchObject({
      code: "KeyU",
      isDefault: false,
    });
  });

  it("setBinding persists the diff and re-renders", () => {
    const { result } = renderHook(() => useKeybindings());
    act(() => {
      result.current.setBinding("window-next", { code: "KeyU", tier: "shifted" });
    });
    expect(result.current.byAction.get("window-next")).toMatchObject({ code: "KeyU" });
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "window-next": { code: "KeyU", tier: "shifted" },
    });
  });

  it("setBinding reports and unbinds the steal victim", () => {
    const { result } = renderHook(() => useKeybindings());
    let stolen: string | null = null;
    act(() => {
      stolen = result.current.setBinding("window-next", { code: "KeyA", tier: "shifted" });
    });
    expect(stolen).toBe("agent-next-waiting");
    expect(result.current.byAction.get("agent-next-waiting")).toMatchObject({
      enabled: false,
      disabledReason: "user",
    });
  });

  it("keeps sibling subscribers in sync within the tab", () => {
    const first = renderHook(() => useKeybindings());
    const second = renderHook(() => useKeybindings());
    act(() => {
      first.result.current.setBinding("window-prev", { code: "KeyJ", tier: "shifted" });
    });
    expect(second.result.current.byAction.get("window-prev")).toMatchObject({ code: "KeyJ" });
  });

  it("resetBinding drops one diff; resetAll drops them all (and the storage key)", () => {
    const { result } = renderHook(() => useKeybindings());
    act(() => {
      result.current.setBinding("window-next", { code: "KeyU", tier: "shifted" });
      result.current.setBinding("window-prev", { code: "KeyJ", tier: "shifted" });
    });
    act(() => {
      result.current.resetBinding("window-next");
    });
    expect(result.current.byAction.get("window-next")).toMatchObject({ code: "ArrowDown", isDefault: true });
    expect(result.current.byAction.get("window-prev")).toMatchObject({ code: "KeyJ" });
    act(() => {
      result.current.resetAll();
    });
    expect(result.current.overrides).toEqual({});
    expect(localStorage.getItem(KEYBINDINGS_STORAGE_KEY)).toBeNull();
  });

  it("re-syncs on the cross-tab storage event", () => {
    const { result } = renderHook(() => useKeybindings());
    act(() => {
      localStorage.setItem(
        KEYBINDINGS_STORAGE_KEY,
        JSON.stringify({ "window-next": { code: "KeyU", tier: "shifted" } }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: KEYBINDINGS_STORAGE_KEY }),
      );
    });
    expect(result.current.byAction.get("window-next")).toMatchObject({ code: "KeyU" });
  });
});

describe("useKeybindings macro-awareness (260730-hbyh)", () => {
  const DISCUSS = {
    actionId: "macro:discuss",
    kind: "macro",
    label: "riff: discuss",
    target: { type: "riff", preset: "discuss" },
  };

  it("surfaces a stored macro in the effective map (unbound without a diff)", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    const { result } = renderHook(() => useKeybindings());
    expect(result.current.byAction.get("macro:discuss")).toMatchObject({
      kind: "macro",
      enabled: false,
      disabledReason: "user",
    });
  });

  it("a stored combo diff makes the macro live", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "macro:discuss": { code: "KeyD", tier: "shifted" } }),
    );
    const { result } = renderHook(() => useKeybindings());
    expect(result.current.byAction.get("macro:discuss")).toMatchObject({
      code: "KeyD",
      tier: "shifted",
      enabled: true,
    });
  });

  it("capturing a macro-owned combo for a builtin steals from the macro", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    localStorage.setItem(
      KEYBINDINGS_STORAGE_KEY,
      JSON.stringify({ "macro:discuss": { code: "KeyD", tier: "shifted" } }),
    );
    const { result } = renderHook(() => useKeybindings());
    let stolen: string | null = null;
    act(() => {
      stolen = result.current.setBinding("window-next", { code: "KeyD", tier: "shifted" });
    });
    expect(stolen).toBe("macro:discuss");
    expect(result.current.byAction.get("macro:discuss")).toMatchObject({
      enabled: false,
      disabledReason: "user",
    });
  });

  it("setBinding binds a macro (stored as an ordinary diff entry)", () => {
    localStorage.setItem("hexokit-macros", JSON.stringify([DISCUSS]));
    const { result } = renderHook(() => useKeybindings());
    act(() => {
      result.current.setBinding("macro:discuss", { code: "KeyD", tier: "shifted" });
    });
    expect(JSON.parse(localStorage.getItem(KEYBINDINGS_STORAGE_KEY) ?? "{}")).toEqual({
      "macro:discuss": { code: "KeyD", tier: "shifted" },
    });
    expect(result.current.byAction.get("macro:discuss")).toMatchObject({ enabled: true, code: "KeyD" });
  });
});
