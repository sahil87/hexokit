import { describe, it, expect, afterEach } from "vitest";
import {
  MACROS_STORAGE_KEY,
  isMacroActionId,
  macroCommandPreview,
  macroToBinding,
  makeMacroActionId,
  parseMacros,
  readStoredMacros,
  writeStoredMacros,
  type MacroAction,
} from "./macros";

const DISCUSS: MacroAction = {
  actionId: "macro:discuss",
  kind: "macro",
  label: "riff: discuss",
  target: { type: "riff", riff_preset: "discuss" },
};

const PALETTE: MacroAction = {
  actionId: "macro:new-window",
  kind: "macro",
  label: "new window",
  target: { type: "palette", paletteActionId: "create-window" },
};

afterEach(() => {
  localStorage.clear();
});

describe("parseMacros (tolerant)", () => {
  it("parses valid riff + palette macros", () => {
    expect(parseMacros(JSON.stringify([DISCUSS, PALETTE]))).toEqual([DISCUSS, PALETTE]);
  });

  it("degrades malformed JSON and non-array roots to empty", () => {
    expect(parseMacros(null)).toEqual([]);
    expect(parseMacros("")).toEqual([]);
    expect(parseMacros("{not json")).toEqual([]);
    expect(parseMacros('{"actionId":"macro:x"}')).toEqual([]);
    expect(parseMacros('"macro:x"')).toEqual([]);
  });

  it("drops garbage entries and keeps valid ones", () => {
    const raw = JSON.stringify([
      DISCUSS,
      "garbage",
      null,
      { actionId: "not-prefixed", kind: "macro", label: "x", target: { type: "riff", riff_preset: "p" } },
      { actionId: "macro:empty-label", kind: "macro", label: "", target: { type: "riff", riff_preset: "p" } },
      { actionId: "macro:no-preset", kind: "macro", label: "x", target: { type: "riff", riff_preset: "" } },
      { actionId: "macro:bad-target", kind: "macro", label: "x", target: { type: "shell", cmd: "rm -rf" } },
      { actionId: "macro:no-target", kind: "macro", label: "x" },
    ]);
    expect(parseMacros(raw)).toEqual([DISCUSS]);
  });

  it("re-projects a legacy riff target (`preset`) to `riff_preset`", () => {
    const raw = JSON.stringify([
      { actionId: "macro:x", kind: "macro", label: "X", target: { type: "riff", preset: "discuss" } },
    ]);
    const [macro] = parseMacros(raw);
    expect(macro.target).toEqual({ type: "riff", riff_preset: "discuss" });
    expect(macro.target).not.toHaveProperty("preset");
  });

  it("prefers `riff_preset` when a target carries both keys", () => {
    const raw = JSON.stringify([
      { ...DISCUSS, target: { type: "riff", riff_preset: "new", preset: "old" } },
    ]);
    expect(parseMacros(raw)[0].target).toEqual({ type: "riff", riff_preset: "new" });
  });

  it("pins kind and drops unknown keys on re-projection", () => {
    const raw = JSON.stringify([{ ...DISCUSS, kind: "builtin", extra: 42 }]);
    expect(parseMacros(raw)).toEqual([DISCUSS]);
  });
});

describe("storage wrappers", () => {
  it("round-trips through localStorage and removes the key when empty", () => {
    writeStoredMacros([DISCUSS]);
    expect(JSON.parse(localStorage.getItem(MACROS_STORAGE_KEY) ?? "[]")).toHaveLength(1);
    expect(readStoredMacros()).toEqual([DISCUSS]);
    writeStoredMacros([]);
    expect(localStorage.getItem(MACROS_STORAGE_KEY)).toBeNull();
  });

  it("reads [] from a corrupted blob", () => {
    localStorage.setItem(MACROS_STORAGE_KEY, "{corrupt");
    expect(readStoredMacros()).toEqual([]);
  });
});

describe("makeMacroActionId", () => {
  it("slugifies the label", () => {
    expect(makeMacroActionId("riff: discuss", [])).toBe("macro:riff-discuss");
    expect(makeMacroActionId("Codex Loop @a", [])).toBe("macro:codex-loop-a");
  });

  it("falls back to 'macro' for an empty slug", () => {
    expect(makeMacroActionId("¯\\_(ツ)_/¯", [])).toBe("macro:macro");
  });

  it("uniquifies with -2/-3 suffixes against existing ids", () => {
    expect(makeMacroActionId("discuss", ["macro:discuss"])).toBe("macro:discuss-2");
    expect(makeMacroActionId("discuss", ["macro:discuss", "macro:discuss-2"])).toBe(
      "macro:discuss-3",
    );
  });
});

describe("macroToBinding", () => {
  it("projects a keyless global macro binding", () => {
    expect(macroToBinding(DISCUSS)).toEqual({
      actionId: "macro:discuss",
      code: "",
      tier: "shifted",
      scope: "global",
      kind: "macro",
      label: "riff: discuss",
      description: "rk riff --riff-preset discuss",
      mapLabel: "riff: discuss",
    });
  });
});

describe("macroCommandPreview", () => {
  it("renders riff and palette previews", () => {
    expect(macroCommandPreview(DISCUSS.target)).toBe("rk riff --riff-preset discuss");
    expect(macroCommandPreview(PALETTE.target)).toBe("palette: create-window");
  });
});

describe("isMacroActionId", () => {
  it("keys on the macro: prefix", () => {
    expect(isMacroActionId("macro:discuss")).toBe(true);
    expect(isMacroActionId("create-window")).toBe(false);
  });
});
