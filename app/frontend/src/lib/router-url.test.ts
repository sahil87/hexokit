import { describe, expect, it } from "vitest";
// Import from the leaf module, NOT "./router" — the route tree transitively
// imports xterm's unicode-graphemes addon, whose import-time init is a
// documented CI flake ("Data error") that killed this suite before any test
// ran. The leaf import keeps this suite xterm-free by construction.
import {
  urlSegmentToWindowId,
  windowIdToUrlSegment,
  validateTerminalSearch,
} from "./router-url";

// The terminal route serializes the tmux window id (@N) as its numeric part
// only in the URL. These cover both directions of that mapping and the
// idempotency contract that keeps old %40N bookmarks resolving to @N (not @@N).
describe("window id ↔ URL segment mapping", () => {
  describe("windowIdToUrlSegment (stringify)", () => {
    it.each([["@0", "0"], ["@12", "12"]])("maps %s to %s", (windowId, segment) => {
      expect(windowIdToUrlSegment(windowId)).toBe(segment);
    });
  });

  describe("urlSegmentToWindowId (parse)", () => {
    it.each([["0", "@0"], ["12", "@12"]])("maps %s to %s", (segment, windowId) => {
      expect(urlSegmentToWindowId(segment)).toBe(windowId);
    });

    it("is idempotent — an already-prefixed segment (old %40N bookmark) is unchanged, never @@N", () => {
      expect(urlSegmentToWindowId("@0")).toBe("@0");
      expect(urlSegmentToWindowId("@12")).toBe("@12");
    });
  });

  it("round-trips @N → N → @N", () => {
    for (const id of ["@0", "@12", "@7"]) {
      expect(urlSegmentToWindowId(windowIdToUrlSegment(id))).toBe(id);
    }
  });
});

// The `?view=` param carries the per-viewer window-view lens (spec R2). `web`
// and `code` are valid; any other/unknown value is DROPPED (treated as absent),
// never errored, so a stale/garbage deep link degrades to the default view.
describe("validateTerminalSearch (?view= drop)", () => {
  it.each(["web", "code"] as const)("accepts view=%s", (view) => {
    expect(validateTerminalSearch({ view })).toEqual({ view });
  });

  it("drops the removed chat lens (?view=chat → view undefined, bare-route cleanup)", () => {
    expect(() => validateTerminalSearch({ view: "chat" })).not.toThrow();
    expect(validateTerminalSearch({ view: "chat" })).toEqual({});
  });

  it("drops an unknown value without throwing (?view=bogus → view undefined)", () => {
    expect(() => validateTerminalSearch({ view: "bogus" })).not.toThrow();
    expect(validateTerminalSearch({ view: "bogus" }).view).toBeUndefined();
  });

  it("drops a non-string view (?view=1 → view undefined)", () => {
    expect(validateTerminalSearch({ view: 1 }).view).toBeUndefined();
  });

  it("drops an absent param (no view) to an empty search", () => {
    expect(validateTerminalSearch({})).toEqual({});
    expect(validateTerminalSearch({ other: "x" }).view).toBeUndefined();
  });
});

// The `?panel=` param (260811-2r1w-right-panel-shell-web-surface, right-panel
// P1; `code` joined in 260811-k3vp) carries the per-viewer right-panel surface
// — handled exactly like `?view=`: `web` and `code` are the valid values;
// anything else is DROPPED.
describe("validateTerminalSearch (?panel= drop)", () => {
  it.each(["web", "code"] as const)("accepts panel=%s", (panel) => {
    expect(validateTerminalSearch({ panel })).toEqual({ panel });
  });

  it("drops an unknown value without throwing (?panel=bogus → panel undefined)", () => {
    expect(() => validateTerminalSearch({ panel: "bogus" })).not.toThrow();
    expect(validateTerminalSearch({ panel: "bogus" }).panel).toBeUndefined();
  });

  it("drops a non-string panel (?panel=1 → panel undefined)", () => {
    expect(validateTerminalSearch({ panel: 1 }).panel).toBeUndefined();
  });

  it("keeps view and panel independent (both may be present)", () => {
    expect(validateTerminalSearch({ view: "web", panel: "web" })).toEqual({
      view: "web",
      panel: "web",
    });
    expect(validateTerminalSearch({ view: "bogus", panel: "web" })).toEqual({
      panel: "web",
    });
    expect(validateTerminalSearch({ view: "web", panel: "bogus" })).toEqual({
      view: "web",
    });
  });
});

// The `?from=` param carries the quake terminal's origin window id onto the
// operator window's route. It passes through as a raw string (the `?layout=`
// posture — the consumer validates it against the sessions payload); empty and
// non-string values are DROPPED.
describe("validateTerminalSearch (?from= pass-through)", () => {
  it("accepts a window id string", () => {
    expect(validateTerminalSearch({ from: "@5" })).toEqual({ from: "@5" });
  });

  it("drops empty and non-string values", () => {
    expect(validateTerminalSearch({ from: "" }).from).toBeUndefined();
    expect(validateTerminalSearch({ from: 5 }).from).toBeUndefined();
  });
});

// The `?pop=` param names the popped-out leaf a popout window renders
// chrome-less. It passes through as a raw string like `?from=` (the
// leaf-grammar validation lives in the consumer, `lib/popout.ts`); empty and
// non-string values are DROPPED.
describe("validateTerminalSearch (?pop= pass-through)", () => {
  it.each(["tty", "tty#2", "@12/tty"] as const)("accepts pop=%s", (pop) => {
    expect(validateTerminalSearch({ pop })).toEqual({ pop });
  });

  it("drops empty and non-string values", () => {
    expect(validateTerminalSearch({ pop: "" }).pop).toBeUndefined();
    expect(validateTerminalSearch({ pop: 3 }).pop).toBeUndefined();
  });

  it("keeps pop independent of the retired params", () => {
    expect(validateTerminalSearch({ view: "web", pop: "code" })).toEqual({
      view: "web",
      pop: "code",
    });
  });
});

// The `?tab=` param selects the operator route's segment — handled exactly
// like `?view=`: the four known values pass, anything else is DROPPED (absent
// reads as "terminal"), never thrown. The legacy `activity` token
// (already-sent push notifications) is normalized to `log` for one release.
describe("validateTerminalSearch (?tab= drop)", () => {
  it.each(["terminal", "tasks", "list", "log"] as const)("accepts tab=%s", (tab) => {
    expect(validateTerminalSearch({ tab })).toEqual({ tab });
  });

  it("normalizes the legacy tab=activity to log", () => {
    expect(validateTerminalSearch({ tab: "activity" })).toEqual({ tab: "log" });
  });

  it("drops an unknown value without throwing (?tab=bogus → tab undefined)", () => {
    expect(() => validateTerminalSearch({ tab: "bogus" })).not.toThrow();
    expect(validateTerminalSearch({ tab: "bogus" }).tab).toBeUndefined();
  });

  it("drops a non-string tab (?tab=1 → tab undefined)", () => {
    expect(validateTerminalSearch({ tab: 1 }).tab).toBeUndefined();
  });
});
