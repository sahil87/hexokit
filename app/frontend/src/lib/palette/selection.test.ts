import { describe, it, expect, vi } from "vitest";
import {
  batchToast,
  mergedWindowKeys,
  buildSelectAllMergedAction,
  buildSelectionCloseAction,
  buildSelectionMoveActions,
  buildSelectionSendPromptAction,
  executeSelectionBatch,
  SELECT_ALL_MERGED_ACTION_ID,
  SELECTION_CLOSE_ACTION_ID,
  SELECTION_MOVE_ACTION_PREFIX,
  SELECTION_SEND_PROMPT_ACTION_ID,
  SELECTION_GESTURE_HINT,
  type SelectableSession,
} from "./selection";

// The builders back the command-palette selection entries wired in app.tsx.
// Covering the merged derivation, hidden-when-ineligible cases, per-session
// entry composition, and label counts proves the behavior without mounting the
// shell — the lib/palette/pin.test.ts precedent.

const SRV = "srv";

function win(
  windowId: string,
  prState?: "open" | "merged" | "closed",
): { windowId: string; prState?: "open" | "merged" | "closed" } {
  return { windowId, prState };
}

const sessions: SelectableSession[] = [
  { name: "work", windows: [win("@1", "merged"), win("@2", "open"), win("@3")] },
  { name: "completed", windows: [win("@4", "merged")] },
];

describe("mergedWindowKeys", () => {
  it("collects composite keys for merged-PR windows across sessions", () => {
    expect(mergedWindowKeys(SRV, sessions)).toEqual(["srv:@1", "srv:@4"]);
  });

  it("ignores open, closed, and PR-less windows", () => {
    const only = [
      { name: "s", windows: [win("@1", "open"), win("@2", "closed"), win("@3")] },
    ];
    expect(mergedWindowKeys(SRV, only)).toEqual([]);
  });

  it("skips a ghost row with an empty windowId", () => {
    const withGhost = [{ name: "s", windows: [win("", "merged"), win("@2", "merged")] }];
    expect(mergedWindowKeys(SRV, withGhost)).toEqual(["srv:@2"]);
  });
});

describe("buildSelectAllMergedAction", () => {
  it("emits a single action whose label carries the live merged count", () => {
    const action = buildSelectAllMergedAction(SRV, sessions, vi.fn());
    expect(action).not.toBeNull();
    expect(action!.id).toBe(SELECT_ALL_MERGED_ACTION_ID);
    expect(action!.label).toBe("Selection: Select all merged (2)");
  });

  it("passes exactly the merged keys to the callback", () => {
    const onSelectAll = vi.fn();
    buildSelectAllMergedAction(SRV, sessions, onSelectAll)!.onSelect();
    expect(onSelectAll).toHaveBeenCalledWith(["srv:@1", "srv:@4"]);
  });

  it("is omitted (null) when there is no current-server context", () => {
    expect(buildSelectAllMergedAction(null, sessions, vi.fn())).toBeNull();
  });

  it("is omitted (null) when the server has no merged windows", () => {
    const none = [{ name: "s", windows: [win("@1", "open")] }];
    expect(buildSelectAllMergedAction(SRV, none, vi.fn())).toBeNull();
  });
});

describe("buildSelectionMoveActions", () => {
  it("emits one entry per session in display order, with the live count", () => {
    const actions = buildSelectionMoveActions(
      SRV,
      sessions,
      new Set(["srv:@1", "srv:@4"]),
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual([
      "Selection: Move 2 tabs to work",
      "Selection: Move 2 tabs to completed",
    ]);
    expect(actions[0].id).toBe(`${SELECTION_MOVE_ACTION_PREFIX}work`);
  });

  it("uses the singular noun for a one-tab selection", () => {
    const actions = buildSelectionMoveActions(SRV, sessions, new Set(["srv:@1"]), vi.fn());
    expect(actions.map((a) => a.label)).toEqual([
      "Selection: Move 1 tab to completed",
    ]);
  });

  it("excludes the target that would be a complete no-op", () => {
    // @1 and @2 both live in `work`, so moving them to `work` changes nothing.
    const actions = buildSelectionMoveActions(
      SRV,
      sessions,
      new Set(["srv:@1", "srv:@2"]),
      vi.fn(),
    );
    expect(actions.map((a) => a.label)).toEqual([
      "Selection: Move 2 tabs to completed",
    ]);
  });

  it("keeps every target when the selection spans multiple sessions", () => {
    const actions = buildSelectionMoveActions(
      SRV,
      sessions,
      new Set(["srv:@1", "srv:@4"]),
      vi.fn(),
    );
    expect(actions).toHaveLength(2);
  });

  it("returns [] for an empty selection", () => {
    expect(buildSelectionMoveActions(SRV, sessions, new Set(), vi.fn())).toEqual([]);
  });

  it("returns [] for a cross-server selection (tmux cannot move across servers)", () => {
    const actions = buildSelectionMoveActions(
      SRV,
      sessions,
      new Set(["srv:@1", "other:@1"]),
      vi.fn(),
    );
    expect(actions).toEqual([]);
  });

  it("passes the chosen target session to the callback", () => {
    const onMove = vi.fn();
    const actions = buildSelectionMoveActions(SRV, sessions, new Set(["srv:@1"]), onMove);
    actions[0].onSelect();
    expect(onMove).toHaveBeenCalledWith("completed");
  });

  // ── cross-server derivation (rework cycle 1, review must-fix 1) ───────────
  // With sessions scope "all" the sidebar paints every server's groups, so a
  // user can select rows on server A while routed to server B. tmux window ids
  // (`@N`) are unique per SERVER only, so the target list and the move must both
  // key off the SELECTION's server. The original wiring passed the ROUTE
  // server's list; `sessionsServer` now names whose sessions the caller passed
  // and a mismatch is refused outright.
  describe("cross-server derivation", () => {
    const otherSessions: SelectableSession[] = [
      { name: "staging", windows: [win("@1"), win("@2")] },
      { name: "archive", windows: [] },
    ];

    it("builds targets from the selection's OWN server when the caller agrees", () => {
      // Selection and sessions are both `other`. Both windows live in `staging`,
      // so `staging` is the complete no-op target and only `archive` is offered.
      const actions = buildSelectionMoveActions(
        "other",
        otherSessions,
        new Set(["other:@1", "other:@2"]),
        vi.fn(),
      );
      expect(actions.map((a) => a.label)).toEqual([
        "Selection: Move 2 tabs to archive",
      ]);
    });

    it("returns [] when handed a DIFFERENT server's sessions than the selection", () => {
      // The regression shape: selection on `other`, sessions from `srv`. Rather
      // than re-key `srv`'s windows under `other:` and emit plausible-looking
      // targets, the mismatch guard offers nothing at all.
      const actions = buildSelectionMoveActions(
        SRV,
        sessions,
        new Set(["other:@1", "other:@4"]),
        vi.fn(),
      );
      expect(actions).toEqual([]);
    });

    it("does not treat a same-id window on another server as the selection's own", () => {
      // `srv:@1` lives in `work`. Selecting `other:@1` — the SAME tmux id on a
      // different server — must not inherit that home, nor offer srv's sessions.
      const actions = buildSelectionMoveActions(
        SRV,
        sessions,
        new Set(["other:@1"]),
        vi.fn(),
      );
      expect(actions).toEqual([]);
    });

    it("still offers every target when the selection's own server has no id overlap", () => {
      // Selection on `other`, sessions on `other`, but the selected id lives in
      // neither session (a row that has since left the tree). Nothing resolves,
      // so no target is excluded — the move stays meaningful.
      const actions = buildSelectionMoveActions(
        "other",
        otherSessions,
        new Set(["other:@99"]),
        vi.fn(),
      );
      expect(actions.map((a) => a.label)).toEqual([
        "Selection: Move 1 tab to staging",
        "Selection: Move 1 tab to archive",
      ]);
    });
  });

  it("documents the selection gestures on the select-all entry's shortcut badge", () => {
    // The project review rule requires new keyboard shortcuts to be documented
    // at the palette registration; `x` is a bare tree key that appears on no
    // chord map (review should-fix 3).
    const action = buildSelectAllMergedAction(SRV, sessions, vi.fn());
    expect(action!.shortcut).toBe(SELECTION_GESTURE_HINT);
    expect(action!.shortcut).toContain("x");
  });
});

describe("buildSelectionCloseAction", () => {
  it("is omitted for an empty selection", () => {
    expect(buildSelectionCloseAction(new Set(), vi.fn())).toBeNull();
  });

  it("uses singular copy and carries the palette confirmation label", () => {
    const action = buildSelectionCloseAction(new Set(["srv:@1"]), vi.fn());
    expect(action).toMatchObject({
      id: SELECTION_CLOSE_ACTION_ID,
      label: "Selection: Close 1 tab",
      confirmLabel: "Close 1 tab — Enter to confirm",
    });
  });

  it("allows cross-server selections and snapshots their keys", () => {
    const onClose = vi.fn();
    const selected = new Set(["srv:@1", "other:@2"]);
    const action = buildSelectionCloseAction(selected, onClose)!;
    expect(action.label).toBe("Selection: Close 2 tabs");
    selected.clear();
    action.onSelect();
    expect(onClose).toHaveBeenCalledWith(["srv:@1", "other:@2"]);
  });
});

describe("buildSelectionSendPromptAction", () => {
  it("is omitted for an empty selection", () => {
    expect(buildSelectionSendPromptAction(new Set(), vi.fn())).toBeNull();
  });

  it("uses singular and plural agent labels", () => {
    expect(
      buildSelectionSendPromptAction(new Set(["srv:@1"]), vi.fn()),
    ).toMatchObject({
      id: SELECTION_SEND_PROMPT_ACTION_ID,
      label: "Selection: Send prompt to 1 agent",
    });
    expect(
      buildSelectionSendPromptAction(
        new Set(["srv:@1", "other:@2"]),
        vi.fn(),
      )!.label,
    ).toBe("Selection: Send prompt to 2 agents");
  });

  it("snapshots cross-server recipients for the compose target", () => {
    const onCompose = vi.fn();
    const selected = new Set(["srv:@1", "other:@2"]);
    const action = buildSelectionSendPromptAction(selected, onCompose)!;
    selected.delete("other:@2");
    action.onSelect();
    expect(onCompose).toHaveBeenCalledWith(["srv:@1", "other:@2"]);
  });
});

describe("executeSelectionBatch", () => {
  it("runs operations sequentially in key order", async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const operation = vi.fn(async ({ server, windowId }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(`${server}:${windowId}`);
      await Promise.resolve();
      inFlight--;
    });

    await executeSelectionBatch(["a:@1", "b:@2"], operation);

    expect(calls).toEqual(["a:@1", "b:@2"]);
    expect(maxInFlight).toBe(1);
  });

  it("continues after malformed keys and rejected operations", async () => {
    const operation = vi
      .fn<(target: { server: string; windowId: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce();

    const result = await executeSelectionBatch(
      ["srv:@1", "malformed", "other:@2"],
      operation,
    );

    expect(operation).toHaveBeenNthCalledWith(1, {
      server: "srv",
      windowId: "@1",
    });
    expect(operation).toHaveBeenNthCalledWith(2, {
      server: "other",
      windowId: "@2",
    });
    expect(result).toEqual({
      failedKeys: ["srv:@1", "malformed"],
      firstError: "probe failed",
    });
  });

  it("uses malformed-key text as the first error when it occurs first", async () => {
    const result = await executeSelectionBatch(
      ["bad", "srv:@1"],
      vi.fn().mockRejectedValue(new Error("later")),
    );
    expect(result.firstError).toBe("malformed tab key");
    expect(result.failedKeys).toEqual(["bad", "srv:@1"]);
  });
});

describe("batchToast", () => {
  const clean = { failedKeys: [], firstError: "" };

  it("reports the plain count on full success", () => {
    expect(
      batchToast({ success: "Closed", failure: "Closed", noun: "window" }, 3, clean),
    ).toEqual({ message: "Closed 3 windows", failed: false });
  });

  it("pluralizes on the batch total", () => {
    expect(
      batchToast({ success: "Closed", failure: "Closed", noun: "window" }, 1, clean)
        .message,
    ).toBe("Closed 1 window");
  });

  it("reports counts plus the first error on partial failure", () => {
    expect(
      batchToast({ success: "Sent prompt to", failure: "Sent to", noun: "agent" }, 3, {
        failedKeys: ["srv:@2"],
        firstError: "window not found",
      }),
    ).toEqual({
      message: "Sent to 2 of 3 agents — 1 failed: window not found",
      failed: true,
    });
  });

  it("reports 0 delivered on a total failure", () => {
    expect(
      batchToast({ success: "Sent prompt to", failure: "Sent to", noun: "agent" }, 2, {
        failedKeys: ["srv:@1", "srv:@2"],
        firstError: "boom",
      }).message,
    ).toBe("Sent to 0 of 2 agents — 2 failed: boom");
  });

  it("carries the operation's trailing qualifier in both messages", () => {
    const copy = {
      success: "Moved",
      failure: "Moved",
      noun: "window",
      qualifier: " to work",
    };
    expect(batchToast(copy, 2, clean).message).toBe("Moved 2 windows to work");
    expect(
      batchToast(copy, 2, { failedKeys: ["a:@1"], firstError: "nope" }).message,
    ).toBe("Moved 1 of 2 windows to work — 1 failed: nope");
  });
});
