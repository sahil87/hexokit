import { describe, it, expect, vi } from "vitest";
import { buildServerAdoptActions } from "./server-adopt";
import { DAEMON_SERVER, type ServerInfo } from "@/api/client";

const srv = (name: string, managed?: boolean): ServerInfo => ({
  name,
  sessionCount: 1,
  managed,
});

describe("buildServerAdoptActions", () => {
  it("emits one Adopt entry per EXTERNAL server (managed === false) only", () => {
    const actions = buildServerAdoptActions(
      [srv("a", false), srv("b", true), srv("c", false)],
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual([
      "Server: Adopt a into HexoKit",
      "Server: Adopt c into HexoKit",
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "adopt-server-a",
      "adopt-server-c",
    ]);
  });

  it("renders NO entry when managed is absent (old backend sends no flag)", () => {
    expect(buildServerAdoptActions([srv("a")], vi.fn())).toEqual([]);
  });

  it("excludes rk-daemon even when the payload marks it external", () => {
    const actions = buildServerAdoptActions(
      [srv("a", false), srv(DAEMON_SERVER, false)],
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual(["Server: Adopt a into HexoKit"]);
  });

  it("invokes onAdopt with the server name", () => {
    const onAdopt = vi.fn();
    const actions = buildServerAdoptActions([srv("a", false), srv("b", false)], onAdopt);
    actions[0].onSelect();
    expect(onAdopt).toHaveBeenCalledWith("a");
    actions[1].onSelect();
    expect(onAdopt).toHaveBeenCalledWith("b");
  });

  it("returns an empty list for no servers", () => {
    expect(buildServerAdoptActions([], vi.fn())).toEqual([]);
  });
});
