/**
 * Pure builders for the command-palette update surface (`HexoKit: Check for
 * Updates` / `… (incl. patches)`, `HexoKit: Dismiss Update Notice`, and the
 * maintenance entries) plus the check-result toast composition. Extracted from
 * app.tsx so the gating and label/summary composition are unit-testable without
 * mounting the whole shell — mirroring lib/palette/move.ts. The action bodies
 * are thin wrappers passed in by the caller.
 *
 * Note: the palette deliberately IGNORES chip dismissal (dismissal silences only
 * the ambient chip; the palette is deliberate discovery), so the dismiss gate
 * here is `qualifies` alone — NOT the chip's `showChip`.
 */

/** One matched tool for label composition (structurally the context's
 *  `UpdateTool`; declared locally to keep this module context-free). */
export type UpdateActionTool = { tool: string; current: string; latest: string };

/**
 * Compose the per-tool transition summary for a matched set — e.g.
 * `run-kit v3.8.0 → v3.9.0, fab-kit v2.16.0 → v2.17.0`. A tool with no known
 * current version degrades to `tool → v{latest}`. The SINGLE source consumed by
 * both the top-bar `UpdateChip` (title/aria) and the overflow-menu version-row
 * update surface (aria) so the two can never drift (R15 / A-024). Context-free
 * (takes the tool list directly), so it stays unit-testable without the context.
 */
export function updateChipToolSummary(tools: UpdateActionTool[]): string {
  return tools
    .map((t) => (t.current ? `${t.tool} v${t.current} → v${t.latest}` : `${t.tool} → v${t.latest}`))
    .join(", ");
}

/**
 * Compose the composite dismissal key over a tool set: sorted `tool@latest`
 * pairs, comma-joined — a verbatim client-side mirror of the backend's
 * `computeKey` (`app/backend/internal/updatecheck/updatecheck.go`), which
 * composes the `key` the ambient `update-available` payload carries. The MANUAL
 * check feed has no server-computed key of its own (the github source is a
 * side channel the daemon deliberately never caches), so the manual-fed chip
 * derives its key here — which is what lets the existing `hexokit-update-dismissed`
 * localStorage dismissal machinery work unchanged against it (§ Update
 * Notification). An empty set composes `""` (the cleared-key sentinel the
 * dismissal path already no-ops on). Context-free, so it stays unit-testable
 * alongside the other pure builders in this module.
 */
export function computeUpdateKey(tools: { tool: string; latest: string }[]): string {
  return tools
    .map((t) => `${t.tool}@${t.latest}`)
    .sort()
    .join(",");
}

export type UpdatePaletteAction = {
  id: string;
  label: string;
  onSelect: () => void;
};

/**
 * Build the qualifying-gated update palette actions. Since the dynamic
 * `HexoKit: Update to v{X}` entry was deleted (multi-tool ambiguous + stale
 * between checks — `HexoKit: Update Now` in buildMaintenanceActions is THE
 * single update action), only `HexoKit: Dismiss Update Notice` remains: the
 * keyboard mirror of the chip's `✕`. Returns an empty array when no qualifying
 * update is pending (`qualifies` false, or `tools` empty — e.g. the `dev`
 * version or no update-available event yet).
 */
export function buildUpdateActions(
  qualifies: boolean,
  tools: UpdateActionTool[],
  onDismiss: () => void,
): UpdatePaletteAction[] {
  if (!qualifies || tools.length === 0) return [];
  return [
    {
      id: "run-kit-dismiss-update",
      label: "HexoKit: Dismiss Update Notice",
      onSelect: onDismiss,
    },
  ];
}

/** One tool's verdict for check-result toast composition (structurally the
 *  client's `UpdateCheckTool`; declared locally to keep this module
 *  context-free): the `UpdateActionTool` versions plus the two verdict flags. */
export type CheckVerdictTool = UpdateActionTool & {
  /** installed < latest. */
  updateAvailable: boolean;
  /** The bump crosses the tool's notify threshold. */
  notable: boolean;
};

/** A composed check-result toast: the message plus whether anything updatable
 *  was reported (gates the toast's "Update Now" action slot). */
export type CheckToast = { message: string; updatable: boolean };

/**
 * The "relevant" (updatable) subset a check reports for the given view — the
 * SINGLE predicate behind both the check-result toast and the persisted manual
 * feed: incl.-patches ⇒ every pending update (`updateAvailable`); default ⇒ only
 * rows also crossing the notify threshold (`updateAvailable && notable`).
 * Consumed by `composeCheckToast` here and by `useUpdateCheck`'s
 * `applyManualCheckResult` persistence, so the chip can never contradict the
 * toast about what a check found — a change to the filter moves both at once.
 * Generic over the row type (structurally `CheckVerdictTool`) so a caller's
 * richer element type — e.g. the client's `UpdateCheckTool` — survives the
 * filter instead of widening.
 */
export function filterCheckRelevantTools<T extends CheckVerdictTool>(
  tools: T[],
  includePatches: boolean,
): T[] {
  return tools.filter((t) => (includePatches ? t.updateAvailable : t.updateAvailable && t.notable));
}

/**
 * Compose the check-result toast for the two palette check commands over the
 * verdict list (the minor/patch distinction is client-side filtering):
 *   - default view (`includePatches` false): tools where `notable` is true,
 *     each as `tool v{current} → v{latest}` (updateChipToolSummary's shape);
 *   - incl.-patches view: every tool where `updateAvailable` is true, with
 *     sub-threshold rows annotated `(patch — below notify threshold)`.
 * `source` is the ECHOED report backend from the check response (`"released"`/
 * `"github"`; defaults to `""` for old daemons that omit it, keeping today's
 * behavior). When it is `"github"` the sub-threshold annotation is SUPPRESSED:
 * that backend carries no notify policy, so every row lands `notable=false`
 * and a github minor bump would otherwise be mislabeled as a sub-threshold
 * patch. The filtering itself is unchanged — only the annotation keys off the
 * source. An empty filtered set composes "All tools up to date"
 * (updatable: false).
 */
export function composeCheckToast(
  tools: CheckVerdictTool[],
  includePatches: boolean,
  source = "",
): CheckToast {
  const relevant = filterCheckRelevantTools(tools, includePatches);
  if (relevant.length === 0) return { message: "All tools up to date", updatable: false };
  const annotationSuppressed = source === "github";
  const message = relevant
    .map((t) => {
      const base = updateChipToolSummary([t]);
      return t.notable || annotationSuppressed ? base : `${base} (patch — below notify threshold)`;
    })
    .join(", ");
  return { message, updatable: true };
}

// Sentinel running version for local (non-ldflags) builds — the maintenance
// entries are suppressed for it (a dev serve process is air-managed, so a
// force-update / restart would bounce the REAL daemon out from under `just dev`).
// Kept local to this pure builder (which takes `version` directly) so the module
// stays dependency-free and unit-testable without the context.
const DEV_VERSION = "dev";

/**
 * Build the always-available maintenance palette actions, independent of the
 * qualifying-update gate (unlike buildUpdateActions):
 *   - `HexoKit: Update Now` — THE single update action: a force update
 *     (full-roster `shll update`; idempotent, and it picks up patch-only bumps
 *     a scoped match set would skip). Included ONLY when the daemon is a
 *     Homebrew install (`brew`) AND the version is not the `dev` sentinel. NOT
 *     gated on a qualifying update, so it reaches patch releases and works
 *     before any check has run.
 *   - `HexoKit: Restart Daemon` — bounce the daemon. Included whenever the
 *     version is not `dev` (no brew requirement).
 * Both fire immediately on select (no confirmation dialog).
 */
export function buildMaintenanceActions(
  brew: boolean,
  version: string | null,
  onForceUpdate: () => void,
  onRestart: () => void,
): UpdatePaletteAction[] {
  const isDev = version === DEV_VERSION;
  const actions: UpdatePaletteAction[] = [];
  if (brew && !isDev) {
    actions.push({
      id: "run-kit-force-update",
      label: "HexoKit: Update Now",
      onSelect: onForceUpdate,
    });
  }
  if (!isDev) {
    actions.push({
      id: "run-kit-restart",
      label: "HexoKit: Restart Daemon",
      onSelect: onRestart,
    });
  }
  return actions;
}

/**
 * Build the two on-demand check palette actions:
 *   - `HexoKit: Check for Updates` — reports tools crossing their notify
 *     threshold (`notable`);
 *   - `HexoKit: Check for Updates (incl. patches)` — reports every tool with
 *     any pending update, annotating sub-threshold rows.
 * Both POST the same /api/updates/check (the difference is client-side
 * filtering — see composeCheckToast) and report via toast. Hidden on the `dev`
 * sentinel (same gating pattern as the maintenance entries; a `null` version —
 * no version event yet — counts as non-dev). No brew gate: checking is
 * harmless without a remediation path.
 */
export function buildCheckActions(
  version: string | null,
  onCheck: () => void,
  onCheckIncludingPatches: () => void,
): UpdatePaletteAction[] {
  if (version === DEV_VERSION) return [];
  return [
    {
      id: "run-kit-check-updates",
      label: "HexoKit: Check for Updates",
      onSelect: onCheck,
    },
    {
      id: "run-kit-check-updates-patches",
      label: "HexoKit: Check for Updates (incl. patches)",
      onSelect: onCheckIncludingPatches,
    },
  ];
}
