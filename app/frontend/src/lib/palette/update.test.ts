import { describe, it, expect, vi } from "vitest";
import {
  buildUpdateActions,
  buildMaintenanceActions,
  buildCheckActions,
  composeCheckToast,
  computeUpdateKey,
  filterCheckRelevantTools,
  updateChipToolSummary,
  type CheckVerdictTool,
} from "./update";

const runKitOnly = [{ tool: "run-kit", current: "3.8.0", latest: "3.9.0" }];

describe("buildUpdateActions (Dismiss-only after the Update-to-vX deletion)", () => {
  it("returns no actions when no update qualifies", () => {
    expect(buildUpdateActions(false, runKitOnly, vi.fn())).toEqual([]);
  });

  it("returns no actions when tools is empty", () => {
    expect(buildUpdateActions(true, [], vi.fn())).toEqual([]);
  });

  it("builds ONLY the Dismiss action for a qualifying update — no dynamic Update entry", () => {
    const onDismiss = vi.fn();
    const actions = buildUpdateActions(true, runKitOnly, onDismiss);

    expect(actions.map((a) => a.label)).toEqual(["HexoKit: Dismiss Update Notice"]);
    expect(actions.map((a) => a.id)).toEqual(["run-kit-dismiss-update"]);
    // The deleted label shapes must never reappear.
    expect(actions.some((a) => /Update to v|Update \d+ tools|Update .* to v/.test(a.label))).toBe(
      false,
    );
  });

  it("wires the dismiss action to onDismiss", () => {
    const onDismiss = vi.fn();
    const [dismiss] = buildUpdateActions(true, runKitOnly, onDismiss);

    dismiss.onSelect();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("qualifies independently of chip dismissal (palette ignores dismissal)", () => {
    // The builder gates on `qualifies` only — there is no dismissal parameter,
    // so a dismissed chip still yields the Dismiss action when qualifies is true.
    const actions = buildUpdateActions(
      true,
      [{ tool: "run-kit", current: "3.8.0", latest: "3.10.0" }],
      vi.fn(),
    );
    expect(actions).toHaveLength(1);
  });
});

describe("updateChipToolSummary (single shared source, A-024)", () => {
  it("names each per-tool transition, comma-joined", () => {
    expect(
      updateChipToolSummary([
        { tool: "run-kit", current: "3.8.0", latest: "3.9.0" },
        { tool: "fab-kit", current: "2.16.0", latest: "2.17.0" },
      ]),
    ).toBe("run-kit v3.8.0 → v3.9.0, fab-kit v2.16.0 → v2.17.0");
  });

  it("degrades to `tool → v{latest}` when a tool has no known current version", () => {
    expect(updateChipToolSummary([{ tool: "tu", current: "", latest: "0.9.2" }])).toBe(
      "tu → v0.9.2",
    );
  });

  it("returns an empty string for no tools", () => {
    expect(updateChipToolSummary([])).toBe("");
  });
});

describe("buildCheckActions", () => {
  it("builds the two check entries for a non-dev version", () => {
    const actions = buildCheckActions("0.5.3", vi.fn(), vi.fn());
    expect(actions.map((a) => a.label)).toEqual([
      "HexoKit: Check for Updates",
      "HexoKit: Check for Updates (incl. patches)",
    ]);
    expect(actions.map((a) => a.id)).toEqual([
      "run-kit-check-updates",
      "run-kit-check-updates-patches",
    ]);
  });

  it("hides BOTH entries on the dev sentinel (same gating pattern as maintenance)", () => {
    expect(buildCheckActions("dev", vi.fn(), vi.fn())).toEqual([]);
  });

  it("treats a null version (no version event yet) as non-dev", () => {
    expect(buildCheckActions(null, vi.fn(), vi.fn())).toHaveLength(2);
  });

  it("wires the default check to onCheck and the incl.-patches check to onCheckIncludingPatches", () => {
    const onCheck = vi.fn();
    const onCheckAll = vi.fn();
    const [check, checkAll] = buildCheckActions("0.5.3", onCheck, onCheckAll);

    check.onSelect();
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onCheckAll).not.toHaveBeenCalled();

    checkAll.onSelect();
    expect(onCheckAll).toHaveBeenCalledTimes(1);
  });
});

describe("composeCheckToast", () => {
  const notableRunKit: CheckVerdictTool = {
    tool: "run-kit",
    current: "3.8.0",
    latest: "3.9.0",
    updateAvailable: true,
    notable: true,
  };
  const subThresholdTu: CheckVerdictTool = {
    tool: "tu",
    current: "0.9.1",
    latest: "0.9.2",
    updateAvailable: true,
    notable: false,
  };

  it("default view reports notable tools only", () => {
    const toast = composeCheckToast([notableRunKit, subThresholdTu], false);
    expect(toast).toEqual({ message: "run-kit v3.8.0 → v3.9.0", updatable: true });
  });

  it("default view reports up-to-date when only sub-threshold bumps exist", () => {
    expect(composeCheckToast([subThresholdTu], false)).toEqual({
      message: "All tools up to date",
      updatable: false,
    });
  });

  it("incl.-patches view reports every pending update, annotating sub-threshold rows", () => {
    const toast = composeCheckToast([notableRunKit, subThresholdTu], true);
    expect(toast).toEqual({
      message: "run-kit v3.8.0 → v3.9.0, tu v0.9.1 → v0.9.2 (patch — below notify threshold)",
      updatable: true,
    });
  });

  it("reports up-to-date for an empty verdict list in both views", () => {
    expect(composeCheckToast([], false)).toEqual({
      message: "All tools up to date",
      updatable: false,
    });
    expect(composeCheckToast([], true)).toEqual({
      message: "All tools up to date",
      updatable: false,
    });
  });

  describe("source-aware annotation (260720-wb3n)", () => {
    // A github-backend row: no notify policy exists there, so a genuine MINOR
    // bump still arrives notable=false — annotating it "(patch — below notify
    // threshold)" would mislabel it.
    const githubMinorBump: CheckVerdictTool = {
      tool: "run-kit",
      current: "3.8.7",
      latest: "3.9.1",
      updateAvailable: true,
      notable: false,
    };

    it('suppresses the sub-threshold annotation when the echoed source is "github"', () => {
      expect(composeCheckToast([githubMinorBump], true, "github")).toEqual({
        message: "run-kit v3.8.7 → v3.9.1",
        updatable: true,
      });
    });

    it('keeps the annotation for a released-sourced non-notable row', () => {
      expect(composeCheckToast([subThresholdTu], true, "released")).toEqual({
        message: "tu v0.9.1 → v0.9.2 (patch — below notify threshold)",
        updatable: true,
      });
    });

    it("keeps the annotation when the source is absent (old daemon fallback)", () => {
      expect(composeCheckToast([subThresholdTu], true)).toEqual({
        message: "tu v0.9.1 → v0.9.2 (patch — below notify threshold)",
        updatable: true,
      });
    });

    it("leaves the incl.-patches filter untouched by the source (github rows ride updateAvailable)", () => {
      // Default (notable-only) view: a github row is never notable, so the
      // default check over a github verdict composes up-to-date — filtering is
      // source-blind by design; only the annotation keys off the source.
      expect(composeCheckToast([githubMinorBump], false, "github")).toEqual({
        message: "All tools up to date",
        updatable: false,
      });
    });
  });
});

describe("filterCheckRelevantTools (the single toast/manual-feed predicate)", () => {
  const notableRunKit: CheckVerdictTool = {
    tool: "run-kit",
    current: "3.8.0",
    latest: "3.9.0",
    updateAvailable: true,
    notable: true,
  };
  const subThresholdTu: CheckVerdictTool = {
    tool: "tu",
    current: "0.9.1",
    latest: "0.9.2",
    updateAvailable: true,
    notable: false,
  };
  const upToDateFab: CheckVerdictTool = {
    tool: "fab-kit",
    current: "2.16.0",
    latest: "2.16.0",
    updateAvailable: false,
    notable: false,
  };
  const all = [notableRunKit, subThresholdTu, upToDateFab];

  it("default view keeps only updatable rows that are also notable", () => {
    expect(filterCheckRelevantTools(all, false)).toEqual([notableRunKit]);
  });

  it("incl.-patches view keeps every updatable row regardless of notable", () => {
    expect(filterCheckRelevantTools(all, true)).toEqual([notableRunKit, subThresholdTu]);
  });

  it("never reports a tool with no pending update", () => {
    expect(filterCheckRelevantTools([upToDateFab], true)).toEqual([]);
    expect(filterCheckRelevantTools([upToDateFab], false)).toEqual([]);
  });

  it("returns the same set composeCheckToast reports on (anti-drift guarantee)", () => {
    // The manual feed persists this subset while the toast composes off the same
    // predicate — so `updatable` and a non-empty subset must agree in both views.
    for (const includePatches of [false, true]) {
      const subset = filterCheckRelevantTools(all, includePatches);
      expect(composeCheckToast(all, includePatches).updatable).toBe(subset.length > 0);
    }
    // All-up-to-date: empty subset (clears a stale positive) and a false verdict.
    expect(filterCheckRelevantTools([upToDateFab], false)).toEqual([]);
    expect(composeCheckToast([upToDateFab], false).updatable).toBe(false);
  });

  it("preserves the caller's richer row type through the filter", () => {
    // The manual feed passes the client's UpdateCheckTool rows; extra fields must
    // survive rather than widen to the structural CheckVerdictTool.
    const withExtra = [{ ...notableRunKit, source: "released" as const }];
    expect(filterCheckRelevantTools(withExtra, false)[0].source).toBe("released");
  });
});

describe("buildMaintenanceActions", () => {
  it("includes both Update Now and Restart Daemon when brew and non-dev", () => {
    const actions = buildMaintenanceActions(true, "0.5.3", vi.fn(), vi.fn());
    expect(actions.map((a) => a.label)).toEqual([
      "HexoKit: Update Now",
      "HexoKit: Restart Daemon",
    ]);
    expect(actions.map((a) => a.id)).toEqual(["run-kit-force-update", "run-kit-restart"]);
  });

  it("omits Update Now when not a brew install, but keeps Restart Daemon", () => {
    const actions = buildMaintenanceActions(false, "0.5.3", vi.fn(), vi.fn());
    expect(actions.map((a) => a.label)).toEqual(["HexoKit: Restart Daemon"]);
  });

  it("omits BOTH entries on the dev version, even when brew is true", () => {
    expect(buildMaintenanceActions(true, "dev", vi.fn(), vi.fn())).toEqual([]);
  });

  it("omits BOTH entries on the dev version when not brew", () => {
    expect(buildMaintenanceActions(false, "dev", vi.fn(), vi.fn())).toEqual([]);
  });

  it("treats a null version (no version event yet) as non-dev: Restart shows, Update Now gated on brew", () => {
    expect(buildMaintenanceActions(false, null, vi.fn(), vi.fn()).map((a) => a.label)).toEqual([
      "HexoKit: Restart Daemon",
    ]);
    expect(buildMaintenanceActions(true, null, vi.fn(), vi.fn()).map((a) => a.label)).toEqual([
      "HexoKit: Update Now",
      "HexoKit: Restart Daemon",
    ]);
  });

  it("wires Update Now to onForceUpdate and Restart Daemon to onRestart", () => {
    const onForceUpdate = vi.fn();
    const onRestart = vi.fn();
    const [update, restart] = buildMaintenanceActions(true, "0.5.3", onForceUpdate, onRestart);

    update.onSelect();
    expect(onForceUpdate).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();

    restart.onSelect();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

describe("computeUpdateKey (client mirror of the backend composite key)", () => {
  it("composes a single tool as `tool@latest`", () => {
    expect(computeUpdateKey([{ tool: "run-kit", latest: "3.9.1" }])).toBe("run-kit@3.9.1");
  });

  it("sorts the pairs regardless of input order and comma-joins them", () => {
    const key = computeUpdateKey([
      { tool: "tu", latest: "0.9.2" },
      { tool: "run-kit", latest: "3.9.1" },
    ]);
    expect(key).toBe("run-kit@3.9.1,tu@0.9.2");
    // Input order is irrelevant — the reversed list composes the same key, which
    // is what makes the dismissal stable across differently-ordered payloads.
    expect(
      computeUpdateKey([
        { tool: "run-kit", latest: "3.9.1" },
        { tool: "tu", latest: "0.9.2" },
      ]),
    ).toBe(key);
  });

  it("composes an empty set as the empty key", () => {
    expect(computeUpdateKey([])).toBe("");
  });

  it("keys on `latest`, so a newer target yields a different key (re-show semantics)", () => {
    expect(computeUpdateKey([{ tool: "run-kit", latest: "3.9.1" }])).not.toBe(
      computeUpdateKey([{ tool: "run-kit", latest: "3.9.2" }]),
    );
  });
});
