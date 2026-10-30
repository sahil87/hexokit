import { describe, it, expect, vi } from "vitest";
import { buildRecoveryActions } from "./recovery";
import type { RecoveryOffer } from "@/api/client";

function offer(server: string): RecoveryOffer {
  return {
    server,
    takenAt: "2026-08-20T06:00:00Z",
    sessionCount: 1,
    windowCount: 1,
    sessions: [],
  };
}

function handlers() {
  return { onRestore: vi.fn(), onRestoreAll: vi.fn(), onDismiss: vi.fn(), onDismissAll: vi.fn() };
}

describe("buildRecoveryActions", () => {
  it("returns no entries when there are no offers (the whole family is offer-gated)", () => {
    expect(buildRecoveryActions([], handlers())).toEqual([]);
  });

  it("builds one restore and one dismiss entry per offer plus both bulk verbs, preserving order", () => {
    const actions = buildRecoveryActions([offer("kit"), offer("work")], handlers());
    expect(actions.map((a) => a.label)).toEqual([
      "Workspace: Restore kit",
      "Workspace: Restore work",
      "Restore all previous workspaces",
      "Workspace: Dismiss recovery kit",
      "Workspace: Dismiss recovery work",
      "Dismiss all previous workspaces",
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "recovery-restore-kit",
      "recovery-restore-work",
      "recovery-restore-all",
      "recovery-dismiss-kit",
      "recovery-dismiss-work",
      "recovery-dismiss-all",
    ]);
  });

  it("omits both bulk verbs with a single offer", () => {
    const actions = buildRecoveryActions([offer("kit")], handlers());
    expect(actions.map((a) => a.id)).toEqual([
      "recovery-restore-kit",
      "recovery-dismiss-kit",
    ]);
  });

  it("invokes the handler with the entry's own server name on select", () => {
    const h = handlers();
    const actions = buildRecoveryActions([offer("kit"), offer("work")], h);

    actions[1].onSelect();
    expect(h.onRestore).toHaveBeenCalledTimes(1);
    expect(h.onRestore).toHaveBeenCalledWith("work");

    actions[4].onSelect();
    expect(h.onDismiss).toHaveBeenCalledTimes(1);
    expect(h.onDismiss).toHaveBeenCalledWith("work");

    actions[2].onSelect();
    expect(h.onRestoreAll).toHaveBeenCalledTimes(1);

    actions[5].onSelect();
    expect(h.onDismissAll).toHaveBeenCalledTimes(1);
  });
});
