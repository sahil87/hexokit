import { describe, it, expect, vi } from "vitest";
import { buildServerSetColorAction } from "./server-color";

describe("buildServerSetColorAction", () => {
  it("returns the single Workspace: Set Color entry for the current server", () => {
    const actions = buildServerSetColorAction("alpha", () => {});
    expect(actions.map((a) => a.id)).toEqual(["server-set-color"]);
    expect(actions.map((a) => a.label)).toEqual(["Workspace: Set Color"]);
  });

  it("returns nothing when no current server resolves (host/board routes)", () => {
    expect(buildServerSetColorAction(null, () => {})).toEqual([]);
    expect(buildServerSetColorAction("", () => {})).toEqual([]);
  });

  it("onSelect fires the caller's picker opener", () => {
    const onOpen = vi.fn();
    const [action] = buildServerSetColorAction("alpha", onOpen);
    action.onSelect();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
