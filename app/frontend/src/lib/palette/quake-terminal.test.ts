import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQuakeTerminalAction,
  buildQuakeTerminalListAction,
  buildQuakeTerminalLogAction,
  buildQuakeTerminalOpenAsTabAction,
  buildQuakeTerminalPinAction,
  buildQuakeTerminalResetSizeAction,
  buildQuakeTerminalTasksAction,
  buildOperatorStartAction,
} from "./quake-terminal";
import {
  QUAKE_GEOMETRY_DEFAULT,
  QUAKE_GEOMETRY_KEY,
  QUAKE_TERMINAL_EVENT,
  getQuakeMachineActivity,
  getQuakeMachineState,
  getQuakePinned,
  isQuakeTerminalRequest,
  readQuakeGeometry,
  setQuakeMachineState,
  setQuakePinned,
} from "@/lib/quake-terminal";

import { ApiError } from "@/api/client";

const mockStartOperator = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", async (importActual) => ({
  ...(await importActual<typeof import("@/api/client")>()),
  startOperator: mockStartOperator,
}));

describe("buildQuakeTerminalAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the registry actionId so the effective-chord hint attaches", () => {
    const action = buildQuakeTerminalAction();
    expect(action.id).toBe("quake-terminal");
    expect(action.label).toBe("Operator: Open quake terminal");
  });

  it("dispatches the quake terminal open (open+focused) through the document-event seam", () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<unknown>).detail);
    document.addEventListener(QUAKE_TERMINAL_EVENT, listener);
    try {
      buildQuakeTerminalAction().onSelect();
    } finally {
      document.removeEventListener(QUAKE_TERMINAL_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    expect(isQuakeTerminalRequest(seen[0])).toBe(true);
    expect(seen[0]).toEqual({ action: "open" });
  });
});

describe.each([
  {
    build: buildQuakeTerminalListAction,
    id: "quake-terminal-list",
    label: "Operator: Show cron list",
    segment: "list",
  },
  {
    build: buildQuakeTerminalLogAction,
    id: "quake-terminal-log",
    label: "Operator: Show cron log",
    segment: "log",
  },
])("the cron-segment entry $label", ({ build, id, label, segment }) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the chord-less palette entry", () => {
    const action = build();
    expect(action).toMatchObject({ id, label });
    expect(action.shortcut).toBeUndefined();
  });

  it(`onSelect dispatches the seam event with segment: ${segment}`, () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<unknown>).detail);
    document.addEventListener(QUAKE_TERMINAL_EVENT, listener);
    try {
      build().onSelect();
    } finally {
      document.removeEventListener(QUAKE_TERMINAL_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    expect(isQuakeTerminalRequest(seen[0])).toBe(true);
    expect(seen[0]).toEqual({ action: "open", segment });
  });
});

describe("buildQuakeTerminalTasksAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the chord-less Operator: Show tasks entry", () => {
    const action = buildQuakeTerminalTasksAction();
    expect(action).toMatchObject({
      id: "quake-terminal-tasks",
      label: "Operator: Show tasks",
    });
    expect(action.shortcut).toBeUndefined();
  });

  it("onSelect dispatches the seam event with segment: tasks", () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<unknown>).detail);
    document.addEventListener(QUAKE_TERMINAL_EVENT, listener);
    try {
      buildQuakeTerminalTasksAction().onSelect();
    } finally {
      document.removeEventListener(QUAKE_TERMINAL_EVENT, listener);
    }
    expect(seen).toHaveLength(1);
    expect(isQuakeTerminalRequest(seen[0])).toBe(true);
    expect(seen[0]).toEqual({ action: "open", segment: "tasks" });
  });
});

describe("buildQuakeTerminalResetSizeAction", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("is the chord-less palette entry", () => {
    const action = buildQuakeTerminalResetSizeAction();
    expect(action).toMatchObject({
      id: "quake-terminal-reset-size",
      label: "Operator: Reset quake terminal size",
    });
    expect(action.shortcut).toBeUndefined();
  });

  it("onSelect writes the default geometry to the per-viewer store without opening the drawer", () => {
    localStorage.setItem(
      QUAKE_GEOMETRY_KEY,
      JSON.stringify({ heightVh: 70, widthPx: 900, centerOffsetPx: 40 }),
    );
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<unknown>).detail);
    document.addEventListener(QUAKE_TERMINAL_EVENT, listener);
    try {
      buildQuakeTerminalResetSizeAction().onSelect();
    } finally {
      document.removeEventListener(QUAKE_TERMINAL_EVENT, listener);
    }
    expect(readQuakeGeometry()).toEqual(QUAKE_GEOMETRY_DEFAULT);
    expect(seen).toHaveLength(0);
  });
});

describe("buildQuakeTerminalPinAction", () => {
  beforeEach(() => {
    // Entering rest resets the pin slot — a clean slate per test.
    setQuakeMachineState("open");
    setQuakeMachineState("rest");
  });

  it("toggles its id-stable label on the pinned flag", () => {
    expect(buildQuakeTerminalPinAction(false)).toMatchObject({
      id: "quake-terminal-pin",
      label: "Operator: Pin quake terminal",
    });
    expect(buildQuakeTerminalPinAction(true)).toMatchObject({
      id: "quake-terminal-pin",
      label: "Operator: Unpin quake terminal",
    });
    expect(buildQuakeTerminalPinAction(false).shortcut).toBeUndefined();
  });

  it("onSelect flips the pin slot and re-asserts the open machine state (the mouse-pick race)", () => {
    setQuakeMachineState("open");
    const activityBefore = getQuakeMachineActivity();
    buildQuakeTerminalPinAction(false).onSelect();
    expect(getQuakePinned()).toBe(true);
    // The outside-click settle backs off only on a machine-activity bump —
    // the same-value re-assert must register even though the state is
    // already open.
    expect(getQuakeMachineState()).toBe("open");
    expect(getQuakeMachineActivity()).toBeGreaterThan(activityBefore);
    buildQuakeTerminalPinAction(true).onSelect();
    expect(getQuakePinned()).toBe(false);
    expect(getQuakeMachineState()).toBe("open");
  });
});

describe("buildQuakeTerminalOpenAsTabAction", () => {
  beforeEach(() => {
    setQuakeMachineState("open");
  });
  afterEach(() => {
    setQuakeMachineState("rest");
    vi.restoreAllMocks();
  });

  it("is the chord-less palette twin of the header control", () => {
    const action = buildQuakeTerminalOpenAsTabAction(
      { server: "srv1", windowId: "@9" },
      vi.fn(),
    );
    expect(action).toMatchObject({
      id: "quake-terminal-open-as-tab",
      label: "Operator: Open as tab",
    });
    expect(action.shortcut).toBeUndefined();
  });

  it("onSelect navigates to the operator route with the segment as ?tab= and rests the machine", () => {
    const navigate = vi.fn();
    buildQuakeTerminalOpenAsTabAction({ server: "srv1", windowId: "@9" }, navigate, "log").onSelect();
    expect(navigate).toHaveBeenCalledWith({
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: { tab: "log" },
    });
    expect(getQuakeMachineState()).toBe("rest");
  });

  it("drops the tab param for the terminal segment (and when the palette arm carries no segment)", () => {
    const navigate = vi.fn();
    buildQuakeTerminalOpenAsTabAction({ server: "srv1", windowId: "@9" }, navigate, "terminal").onSelect();
    buildQuakeTerminalOpenAsTabAction({ server: "srv1", windowId: "@9" }, navigate).onSelect();
    expect(navigate).toHaveBeenNthCalledWith(1, {
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: {},
    });
    expect(navigate).toHaveBeenNthCalledWith(2, {
      to: "/$server/$window",
      params: { server: "srv1", window: "@9" },
      search: {},
    });
  });
});

describe("buildOperatorStartAction", () => {
  beforeEach(() => {
    mockStartOperator.mockReset();
  });

  it("is the chord-less Operator: Start operator entry", () => {
    const action = buildOperatorStartAction("srv1", undefined, vi.fn(), vi.fn());
    expect(action).toMatchObject({ id: "operator-start", label: "Operator: Start operator" });
    expect(action.shortcut).toBeUndefined();
  });

  it("onSelect posts and reports the receipt to onStarted", async () => {
    mockStartOperator.mockResolvedValue({ windowId: "@7", server: "srv1" });
    const onStarted = vi.fn();
    const onError = vi.fn();
    buildOperatorStartAction("srv1", undefined, onStarted, onError).onSelect();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith({ windowId: "@7", server: "srv1" }));
    expect(mockStartOperator).toHaveBeenCalledWith("srv1", undefined);
    expect(onError).not.toHaveBeenCalled();
  });

  it("onSelect passes the viewed window through to the POST", async () => {
    mockStartOperator.mockResolvedValue({ windowId: "@7", server: "srv1" });
    const onStarted = vi.fn();
    buildOperatorStartAction("srv1", "@1", onStarted, vi.fn()).onSelect();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(mockStartOperator).toHaveBeenCalledWith("srv1", "@1");
  });

  it("treats a 409 operator_exists carrying a windowId as success", async () => {
    mockStartOperator.mockRejectedValue(new ApiError("operator already present", 409, "operator_exists", "@3"));
    const onStarted = vi.fn();
    const onError = vi.fn();
    buildOperatorStartAction("srv1", undefined, onStarted, onError).onSelect();
    await vi.waitFor(() => expect(onStarted).toHaveBeenCalledWith({ windowId: "@3", server: "srv1" }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("routes any other failure to onError with the server's message", async () => {
    mockStartOperator.mockRejectedValue(new ApiError("fab not found on PATH", 502));
    const onStarted = vi.fn();
    const onError = vi.fn();
    buildOperatorStartAction("srv1", undefined, onStarted, onError).onSelect();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith("fab not found on PATH"));
    expect(onStarted).not.toHaveBeenCalled();
  });
});
