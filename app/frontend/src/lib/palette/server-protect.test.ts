import { describe, it, expect, vi } from "vitest";
import { buildServerProtectActions } from "./server-protect";
import { DAEMON_SERVER, type ServerInfo } from "@/api/client";

const srv = (name: string, protected_?: boolean): ServerInfo => ({
  name,
  sessionCount: 1,
  protected: protected_,
});

describe("buildServerProtectActions", () => {
  it("emits Protect for unprotected servers and Unprotect for protected ones", () => {
    const actions = buildServerProtectActions(
      [srv("a", false), srv("b", true), srv("c")],
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual([
      "Workspace: Protect a",
      "Workspace: Unprotect b",
      "Workspace: Protect c",
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "protect-server-a",
      "unprotect-server-b",
      "protect-server-c",
    ]);
  });

  it("excludes rk-daemon (derived protection is not togglable)", () => {
    const actions = buildServerProtectActions(
      [srv("a", false), srv(DAEMON_SERVER, true)],
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual(["Workspace: Protect a"]);
  });

  it("invokes onToggle with the NEW protected state", () => {
    const onToggle = vi.fn();
    const actions = buildServerProtectActions([srv("a", false), srv("b", true)], onToggle);
    actions[0].onSelect();
    expect(onToggle).toHaveBeenCalledWith("a", true);
    actions[1].onSelect();
    expect(onToggle).toHaveBeenCalledWith("b", false);
  });

  it("returns an empty list for no servers", () => {
    expect(buildServerProtectActions([], vi.fn())).toEqual([]);
  });
});
