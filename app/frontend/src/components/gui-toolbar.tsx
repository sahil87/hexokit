/**
 * The gui tile's header fold cluster (spec gui.md § The tile). The session
 * controls live INSIDE the tile header's flex-1 spring (SurfaceLayout's gui
 * branch mirrors the tty branch) — nothing overlays the noVNC framebuffer,
 * no hide timer, no reveal gesture. Fullscreen targets the TILE, so this
 * header travels into fullscreen and serves it like every other case.
 *
 * The cluster is a measured priority fold (lib/gui-toolbar-fold.ts owns the
 * decision; this component owns the DOM measurement — the same split
 * top-bar.tsx / top-bar-overflow.ts document): ONE ResizeObserver plus a
 * hidden probe row rendering every fit candidate's real width (both label
 * forms of the degradable items, one divider, and the pinned block), so
 * nothing is hardcoded (labels vary at runtime: `1920×1080` vs `auto`, the
 * quality label, coarse sizing). The priority ladder: 1 screen size ·
 * 2 zoom (`− fit +`) · 3 quality · 4 input (`⎘ ⌥`) · 5 launch (`▣ ◍`) ·
 * 6 health (`∿ ↻`); a label degrades one step before its item folds, and the
 * pinned block renders at the cluster's tail. The block holds the keyboard
 * capture verb as a PERMANENT member whenever its palette row exists (fine
 * pointers — the chord gate the verb toggles never sees touch input), plus
 * the `⚙` toggle only while something is actually folded (the two-pass
 * reserve — see the module). The permanent member's probed width is
 * subtracted from the fit budget up front, so the verb can never fold or
 * clip, and the reserve never causes the fold that justifies the `⚙`.
 * Collapse-first: the fold state starts
 * null and is set in a useLayoutEffect BEFORE paint, so no overflowing frame
 * ever renders.
 *
 * Grouping: FOUR groups (size ┆ zoom ┆ quality ┆ the six action glyphs) with
 * THREE hairline dividers, items separated by 2px (`mx-[1px]` a side) — the
 * idiom; the dividers carry all separation at the shipped
 * `mx-0.5 h-3.5 w-px bg-border` spec. Verb boxes stay 24×24 (26 coarse), so
 * WCAG 2.2 SC 2.5.8 is untouched. Chrome is the header's vocabulary, not the
 * header verbs': borderless, `hover:bg-bg-inset`, secondary ink at rest,
 * latched = green ink + inset ring (the ⌕ find-toggle precedent).
 *
 * The cluster is a by-id MIRROR of the palette: every chip and every panel
 * row fires the `onSelect` of the `buildGuiActions` row with that id
 * (Constitution V) — no control carries logic of its own. Presence follows
 * the palette's omit-not-disable rule EXCEPT the three zoom chips and the
 * quality chip, which always render and disable when the destination row is
 * absent, so the fold never reflows on a zoom or preset change. The coarse
 * posture pair (⌖, ⌨) lives in the `⚙` panel only.
 *
 * Every control carries a `Tip` inside ONE `TipGroup` (the warm cluster);
 * `Tip` REPLACES the native `title=` and adds no wrapper node, so the probe
 * is unaffected. The zoom tips' keycaps read the LIVE `gui-zoom-*` registry
 * bindings (the source `withShortcutHints` reads), so a remap updates the
 * tooltip for free.
 *
 * The `⚙` panel's open state is the per-viewer `rk-gui-toolbar` posture,
 * owned by the caller (app.tsx) and mirrored by the palette's
 * `GUI: Show/Hide toolbar` rows. A persisted-open panel whose items have all
 * unfolded renders nothing (no `⚙`, no anchor) without rewriting the
 * posture — the state goes latent, not false. On mobile there is no tile
 * header: `GuiToolbarMobileOverflow` renders the pinned block into the top
 * bar with every rung folded (the bottom rung of the same ladder).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { controlClass } from "./control";
import { GuiToolbarMenu, type GuiToolbarMenuRow } from "./gui-toolbar-menu";
import { Tip, TipGroup } from "./tip";
import { pickGuiActions, stripGuiLabel, type GuiPaletteAction } from "@/lib/palette/gui";
import { presetLabel } from "@/lib/gui-geometry";
import {
  computeGuiToolbarFold,
  ladderWidth,
  guiToolbarFolded,
  type GuiToolbarFold,
  type GuiToolbarFoldItem,
} from "@/lib/gui-toolbar-fold";
import { GUI_QUALITY_LABELS, nextGuiQuality, type GuiQuality } from "@/lib/gui-posture";
import {
  BrowserGlyph,
  GearGlyph,
  KeyboardGlyph,
  PasteGlyph,
  ReconnectGlyph,
  SendKeyGlyph,
  StatsGlyph,
  TerminalGlyph,
} from "./top-bar-icons";
import { useKeybindings } from "@/hooks/use-keybindings";
import { formatCombo } from "@/lib/keybindings";

/** Header-chrome geometry — lockstep with surface-layout.tsx's
 *  VERB_BUTTON_BASE/VERB_BUTTON_CLASS (the 24px verb axis, 26 coarse); the
 *  fold cluster renders INSIDE that header, so the pair MUST change
 *  together. */
const HEADER_VERB_BASE =
  "inline-flex items-center justify-center h-[24px] w-[24px] coarse:h-[26px] coarse:w-[26px] mx-[1px] rounded transition-colors";
const HEADER_VERB_CLASS = `${HEADER_VERB_BASE} hover:bg-bg-inset hover:text-text-primary`;
/** The text chips (size, quality): borderless, content-width, 6px side
 *  padding on the same height axis. */
const HEADER_CHIP_CLASS =
  "inline-flex items-center h-[24px] coarse:h-[26px] mx-[1px] px-1.5 rounded transition-colors hover:bg-bg-inset hover:text-text-primary";
/** The shipped group divider (D11) — 2px side margins, a 14px hairline. */
const HEADER_DIVIDER_CLASS = "mx-0.5 h-3.5 w-px bg-border";

/** Centred mode: the clear air the cluster must keep from BOTH neighbours (the
 *  name/meta block on the left, the pinned block + frame verbs on the right)
 *  before centring is allowed. Below ~8px a centred cluster reads as crowded
 *  rather than centred. */
export const GUI_TOOLBAR_CENTRE_CLEARANCE_PX = 16;
/** One-sided hysteresis on ENTERING centred mode (matches the fold's own
 *  GUI_TOOLBAR_FOLD_HYSTERESIS_PX). Leaving is immediate. Without it the two
 *  thresholds chase each other: right-aligning frees width, which unfolds an
 *  item, which widens the cluster, which makes centring infeasible again. */
export const GUI_TOOLBAR_CENTRE_HYSTERESIS_PX = 24;

/** The resolution menu's row order — palette ids, each present only if the
 *  built list contains it (the lock rows exist on fine pointers only). */
const RESOLUTION_MENU_IDS = [
  "gui-res-1280x720",
  "gui-res-1600x900",
  "gui-res-1920x1080",
  "gui-res-2560x1440",
  "gui-res-1080x1920",
  "gui-res-match",
  "gui-res-auto",
  "gui-res-custom",
  "gui-lock",
  "gui-unlock",
];

type FoldGroup = "size" | "zoom" | "quality" | "actions";

/** One ladder rung's static identity; the live bits (row presence, labels,
 *  handlers) are read from the built palette list at render. */
interface ClusterItem {
  id: string;
  group: FoldGroup;
  /** The measured probe renders the degraded form under this key. */
  degradable?: boolean;
}

/** The priority ladder (D2): fold consumes from the TAIL. */
const LADDER: ClusterItem[] = [
  { id: "size", group: "size", degradable: true },
  { id: "zoom-out", group: "zoom" },
  { id: "zoom-fit", group: "zoom" },
  { id: "zoom-in", group: "zoom" },
  { id: "quality", group: "quality", degradable: true },
  { id: "paste", group: "actions" },
  { id: "send-key", group: "actions" },
  { id: "terminal", group: "actions" },
  { id: "browser", group: "actions" },
  { id: "stats", group: "actions" },
  { id: "reconnect", group: "actions" },
];

interface GuiToolbarProps {
  /** The built `GUI:` palette list (the same array the palette renders) —
   *  every chip and panel row fires a row picked from it by id. */
  actions: GuiPaletteAction[];
  /** Coarse pointers get the ⌖/⌨ rows appended to the `⚙` panel. */
  coarsePointer: boolean;
  /** The viewer's current quality preset — the ◐ chip / panel row fire the
   *  `gui-quality-<nextGuiQuality(quality)>` row (the cycle). */
  quality: GuiQuality;
  statsVisible: boolean;
  /** The keyboard-capture latch (`rk-gui-capture`) — the pinned block's
   *  capture verb latches green while set. */
  capture: boolean;
  /** The host signal's geometry/width/height/locked — the size chip's label. */
  geometry: string;
  width: number;
  height: number;
  locked: boolean;
  /** The `⚙` panel's open state (the `rk-gui-toolbar` posture, app-owned). */
  toolbarVisible: boolean;
  onToolbarVisibleChange: (visible: boolean) => void;
}

/** Read one probed element's full footprint — the divider's footprint
 *  includes its side margins (offsetWidth excludes them). jsdom reports no
 *  margins, so empty parses read as 0. */
function probeWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  return el.offsetWidth + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0);
}

export function GuiToolbar({
  actions,
  coarsePointer,
  quality,
  statsVisible,
  capture,
  geometry,
  width,
  height,
  locked,
  toolbarVisible,
  onToolbarVisibleChange,
}: GuiToolbarProps) {
  const [fold, setFold] = useState<GuiToolbarFold | null>(null);
  /** Pixel offset INSIDE the spring at which the cluster is centred on the
   *  header's midpoint, or null for right-aligned (the flow default). */
  const [centreLeft, setCentreLeft] = useState<number | null>(null);
  const centredRef = useRef(false);
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const sizeChipRef = useRef<HTMLButtonElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  // A persisted-open panel mounts WITH the page — its menu must not steal
  // focus on load. Autofocus only when the open TRANSITIONED during this
  // mount's lifetime (a ⚙ click or the palette row).
  const prevVisibleRef = useRef(toolbarVisible);
  useEffect(() => {
    prevVisibleRef.current = toolbarVisible;
  }, [toolbarVisible]);
  const panelAutoFocus = !prevVisibleRef.current && toolbarVisible;

  const { byAction, host } = useKeybindings();
  /** The effective chord for a registry action, or none — a chip advertising
   *  a dead chord would lie (the settings-gear chord pattern). */
  const kbdFor = (actionId: string) => {
    const binding = byAction.get(actionId);
    return binding?.enabled
      ? formatCombo({ code: binding.code, tier: binding.tier }, host.platform)
      : undefined;
  };

  const byId = new Map(actions.map((a) => [a.id, a]));
  const zoomOutRow = byId.get("gui-zoom-out");
  const zoomFitRow = byId.get("gui-zoom-fit");
  const zoomInRow = byId.get("gui-zoom-in");
  const qualityRow = byId.get(`gui-quality-${nextGuiQuality(quality)}`);
  const pasteRow = byId.get("gui-paste");
  const sendKeyRow = byId.get("gui-send-key");
  const terminalRow = byId.get("gui-open-terminal");
  const browserRow = byId.get("gui-open-browser");
  const statsRow = byId.get("gui-stats-hide") ?? byId.get("gui-stats-show");
  const reconnectRow = byId.get("gui-reconnect");
  // The pinned block's permanent member (fine pointers only — the palette
  // omits the row on coarse). It is NOT a ladder item: it can never fold.
  const captureRow = byId.get("gui-capture-toggle");
  const hasResolution = actions.some((a) => a.id.startsWith("gui-res-"));

  // The size chip reads the stream entry's live size; a zeroed entry falls
  // back to the geometry preset label, never with the (portrait) suffix (the
  // menu rows keep it).
  const sizeText =
    geometry === "auto"
      ? "auto"
      : width > 0 && height > 0
        ? `${width}×${height}`
        : presetLabel(geometry).replace(" (portrait)", "");
  const shortSize = sizeText.includes("×") ? sizeText.slice(0, sizeText.indexOf("×")) : sizeText;
  const resolutionAria = `Resolution ${sizeText}${locked ? ", locked" : ""}, menu`;

  // Which rungs exist at all rides the palette's omit-not-disable rule; the
  // zoom trio and the quality chip always render (disabled without their
  // row) so the fold never reflows on a zoom/preset change.
  const presentIds = new Set<string>(["zoom-out", "zoom-fit", "zoom-in", "quality", "stats"]);
  if (hasResolution) presentIds.add("size");
  if (pasteRow) presentIds.add("paste");
  if (sendKeyRow) presentIds.add("send-key");
  if (terminalRow) presentIds.add("terminal");
  if (browserRow) presentIds.add("browser");
  if (reconnectRow) presentIds.add("reconnect");
  const items = LADDER.filter((item) => presentIds.has(item.id));

  // Serialize the probed SET so the measure effect re-runs when it changes
  // (connection state, reachability), not on every render; width changes
  // with an UNCHANGED set (a new geometry label, coarse flip) re-fit through
  // the observed probe instead.
  const candidateKey =
    items.map((i) => i.id).join(",") + `|${coarsePointer}|${captureRow ? "cap" : ""}`;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const probe = probeRef.current;
    if (!root || !probe) return;
    const measure = () => {
      const widths = new Map<string, number>();
      for (const el of probe.querySelectorAll<HTMLElement>("[data-fold]")) {
        const key = el.getAttribute("data-fold");
        if (key !== null) widths.set(key, probeWidth(el));
      }
      const foldItems: GuiToolbarFoldItem[] = items.map((item) => ({
        full: widths.get(item.id) ?? 0,
        short: item.degradable ? widths.get(`${item.id}:short`) : undefined,
        group: item.group,
      }));
      const pinnedW = widths.get("pinned") ?? 0;
      const dividerW = widths.get("divider") ?? 0;
      // The pinned block's PERMANENT member (the capture verb) renders at
      // every width, so its probed width leaves the budget up front in BOTH
      // modes. `pinnedWidth` keeps covering the conditional `⚙` alone (the
      // two-pass rule).
      const captureW = widths.get("capture") ?? 0;

      // Centred mode is decided BEFORE the fold, because the two modes have
      // different budgets and fitting against the wrong one would place items
      // that then overlap a neighbour. The spring is `flex-1`, so its own box
      // already spans exactly the free space between the name/meta block and
      // the frame verbs — the header geometry falls out of two rects.
      const header = root.parentElement;
      const rootRect = root.getBoundingClientRect();
      let centred: number | null = null;
      let centredBudget = 0;
      if (header) {
        const hs = getComputedStyle(header);
        const hRect = header.getBoundingClientRect();
        const contentLeft = hRect.left + (parseFloat(hs.paddingLeft) || 0);
        const contentRight = hRect.right - (parseFloat(hs.paddingRight) || 0);
        const hw = contentRight - contentLeft;
        const leftBlock = rootRect.left - contentLeft;
        // The frame verbs sit outside the spring; the pinned block sits at the
        // spring's right end, so it counts toward the right side too.
        const rightBlock = contentRight - rootRect.right + pinnedW + captureW;
        const clear = GUI_TOOLBAR_CENTRE_CLEARANCE_PX;
        // Centred, the cluster may only use the SYMMETRIC middle.
        centredBudget = hw - 2 * Math.max(leftBlock, rightBlock) - 2 * clear;
        const centredFold = computeGuiToolbarFold(centredBudget, foldItems, 0, dividerW, null);
        // Centring must be FREE. The symmetric middle is narrower than the
        // spring, so fitting against it would otherwise always "succeed" by
        // folding harder — at 860px that quietly cost 4 controls, and at 720px
        // all but one. Compare against what right-aligned would show and give
        // up centring the moment it would hide or degrade anything extra.
        const rightFold = computeGuiToolbarFold(
          root.clientWidth - captureW,
          foldItems,
          pinnedW,
          dividerW,
          null,
        );
        const free =
          centredFold.visibleCount >= rightFold.visibleCount &&
          centredFold.degradeFrom >= rightFold.degradeFrom;
        const clusterW = ladderWidth(
          foldItems,
          centredFold.visibleCount,
          centredFold.degradeFrom,
          dividerW,
        );
        const centredStart = contentLeft + (hw - clusterW) / 2;
        // Entering costs the hysteresis margin; leaving is immediate.
        const margin = centredRef.current ? 0 : GUI_TOOLBAR_CENTRE_HYSTERESIS_PX;
        const fits =
          free &&
          clusterW > 0 &&
          centredStart >= contentLeft + leftBlock + clear + margin &&
          centredStart + clusterW <= contentRight - rightBlock - clear - margin;
        if (fits) centred = centredStart - rootRect.left;
      }
      centredRef.current = centred !== null;
      setCentreLeft(centred);

      setFold((prev) =>
        computeGuiToolbarFold(
          // Centred fits the symmetric middle the decision above validated;
          // right-aligned keeps today's full-spring budget.
          centred !== null ? centredBudget : root.clientWidth - captureW,
          foldItems,
          pinnedW,
          dividerW,
          prev,
        ),
      );
    };
    measure();
    // Observe the spring AND the probe: an item's own width can change (a new
    // geometry label, coarse sizing) without resizing the spring. The pinned
    // block lives INSIDE the probe, so the probe's observation covers it.
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    ro.observe(probe);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  /** One cluster control in one label form. `probe` renders the bare control
   *  (no Tip — measurement only); the visible row wraps it in its Tip. */
  const renderControl = (item: ClusterItem, form: "full" | "short", probe: boolean): ReactNode => {
    const degraded = form === "short";
    switch (item.id) {
      case "size": {
        const button = (
          <button
            key={item.id}
            type="button"
            ref={probe ? undefined : sizeChipRef}
            data-testid={probe ? undefined : "gui-toolbar-resolution"}
            aria-haspopup={probe ? undefined : "menu"}
            aria-expanded={probe ? undefined : resolutionOpen}
            aria-label={probe ? undefined : resolutionAria}
            onClick={
              probe
                ? undefined
                : () => {
                    // One menu at a time: opening the resolution menu closes
                    // the ⚙ panel (the single-openMenu predecessor's rule).
                    const next = !resolutionOpen;
                    setResolutionOpen(next);
                    if (next && toolbarVisible) onToolbarVisibleChange(false);
                  }
            }
            tabIndex={probe ? -1 : undefined}
            className={HEADER_CHIP_CLASS}
          >
            {`${locked ? "🔒 " : ""}${degraded ? shortSize : sizeText} ▾`}
          </button>
        );
        return probe ? (
          button
        ) : (
          <Tip key={item.id} label="Resolution" note="menu">
            {button}
          </Tip>
        );
      }
      case "zoom-out":
      case "zoom-fit":
      case "zoom-in": {
        const row = item.id === "zoom-out" ? zoomOutRow : item.id === "zoom-fit" ? zoomFitRow : zoomInRow;
        const label =
          item.id === "zoom-out" ? "Zoom out" : item.id === "zoom-fit" ? "Zoom to fit" : "Zoom in";
        // The zoom trio stays LEXICAL — `− fit +` reads as one stepper, which
        // magnifier glyphs break: two near-identical lenses either side of a
        // word, where the SIGN is the whole message. `fit` names a mode, not a
        // direction.
        const glyph = (
          <span className="text-[11px] leading-none">
            {item.id === "zoom-out" ? "−" : item.id === "zoom-fit" ? "fit" : "+"}
          </span>
        );
        const button = (
          <button
            key={item.id}
            type="button"
            aria-label={probe ? undefined : label}
            disabled={!row}
            onClick={probe ? undefined : () => row?.onSelect()}
            tabIndex={probe ? -1 : undefined}
            className={HEADER_VERB_CLASS}
          >
            {glyph}
          </button>
        );
        return probe ? (
          button
        ) : (
          <Tip key={item.id} label={label} kbd={kbdFor(`gui-${item.id}`)}>
            {button}
          </Tip>
        );
      }
      case "quality": {
        // The degraded `◐` is square-ish: it renders as a verb box so it sits
        // on the same 24px grid as its neighbours (the design study's rule).
        const button = (
          <button
            key={item.id}
            type="button"
            aria-label={probe ? undefined : "Quality"}
            disabled={!qualityRow}
            onClick={probe ? undefined : () => qualityRow?.onSelect()}
            tabIndex={probe ? -1 : undefined}
            className={degraded ? HEADER_VERB_CLASS : HEADER_CHIP_CLASS}
          >
            {degraded ? "◐" : `◐ ${GUI_QUALITY_LABELS[quality]}`}
          </button>
        );
        return probe ? (
          button
        ) : (
          <Tip
            key={item.id}
            label={degraded ? `Quality — ${GUI_QUALITY_LABELS[quality]}` : "Quality"}
            note="cycles"
          >
            {button}
          </Tip>
        );
      }
      default: {
        const verbs: Record<string, { row: (typeof pasteRow); label: string; glyph: ReactNode }> = {
          paste: { row: pasteRow, label: "Paste clipboard", glyph: <PasteGlyph /> },
          "send-key": { row: sendKeyRow, label: "Send key…", glyph: <SendKeyGlyph /> },
          terminal: { row: terminalRow, label: "Open terminal", glyph: <TerminalGlyph /> },
          browser: { row: browserRow, label: "Open browser", glyph: <BrowserGlyph /> },
          stats: { row: statsRow, label: "Toggle stats", glyph: <StatsGlyph /> },
          reconnect: { row: reconnectRow, label: "Reconnect", glyph: <ReconnectGlyph /> },
        };
        const verb = verbs[item.id];
        const button = (
          <button
            key={item.id}
            type="button"
            aria-label={probe ? undefined : verb.label}
            aria-pressed={!probe && item.id === "stats" ? statsVisible : undefined}
            disabled={!verb.row}
            onClick={probe ? undefined : () => verb.row?.onSelect()}
            tabIndex={probe ? -1 : undefined}
            className={
              item.id === "stats"
                ? controlClass({
                    variant: "toggle",
                    base: HEADER_VERB_BASE,
                    rest: "hover:bg-bg-inset hover:text-text-primary",
                    ringed: true,
                    pressed: statsVisible,
                    disabled: !verb.row,
                  })
                : HEADER_VERB_CLASS
            }
          >
            {verb.glyph}
          </button>
        );
        return probe ? (
          button
        ) : (
          <Tip key={item.id} label={verb.label}>
            {button}
          </Tip>
        );
      }
    }
  };

  const visibleItems = fold ? items.slice(0, fold.visibleCount) : [];
  const foldedItems = fold ? items.slice(fold.visibleCount) : [];
  const showGear = fold !== null && guiToolbarFolded(fold, items.length);
  // A folded-away size chip takes its open menu with it (the anchor is gone).
  const sizeIndex = items.findIndex((i) => i.id === "size");
  const sizeFolded = fold !== null && sizeIndex >= 0 && fold.visibleCount <= sizeIndex;
  useEffect(() => {
    if (sizeFolded) setResolutionOpen(false);
  }, [sizeFolded]);

  const resolutionMenuRows: GuiToolbarMenuRow[] = resolutionMenuRowsFrom(actions);

  const overflowRows = buildGuiOverflowRows({
    actions,
    quality,
    coarsePointer,
    foldedIds: new Set(foldedItems.map((i) => i.id)),
    fullscreenRow: false,
  });

  return (
    <div
      ref={rootRef}
      data-testid="gui-toolbar"
      // -mr-1.5 cancels the tile header's own gap-1.5 (6px) on this ONE seam.
      // The cluster's internal rhythm is 2px (mx-[1px] a side), so an
      // un-cancelled header gap leaves the pinned block's right seam wider
      // than its left. Every other major part keeps the header's 6px.
      // min-h keeps the spring a real box: in centred mode the cluster is
      // absolutely positioned, and with nothing folded there is no pinned
      // block either, so the spring would otherwise have no in-flow child,
      // collapse to zero height, and read as hidden.
      className="relative flex-1 min-w-0 min-h-[24px] coarse:min-h-[26px] -mr-1.5 flex items-center justify-end text-text-secondary"
    >
      <TipGroup>
        {/* Centred mode lifts the ladder out of the flow and pins it at the
            header's midpoint (an offset INSIDE this spring, since the spring
            is the positioned ancestor). The pinned block and the frame verbs
            stay right-aligned either way — they are chrome, not content. */}
        <span
          data-testid="gui-toolbar-cluster"
          data-centred={centreLeft !== null ? "true" : undefined}
          className={
            centreLeft !== null
              ? "absolute top-0 bottom-0 flex items-center"
              : "contents"
          }
          style={centreLeft !== null ? { left: `${Math.round(centreLeft)}px` } : undefined}
        >
          {visibleItems.map((item, i) => {
            const prevGroup = i > 0 ? visibleItems[i - 1].group : null;
            return (
              <span key={item.id} className="contents">
                {prevGroup !== null && item.group !== prevGroup ? (
                  <span aria-hidden="true" className={HEADER_DIVIDER_CLASS} />
                ) : null}
                {renderControl(item, fold !== null && i >= fold.degradeFrom ? "short" : "full", false)}
              </span>
            );
          })}
        </span>
        {showGear || captureRow ? (
          <span className="flex items-center shrink-0">
            <span aria-hidden="true" className={HEADER_DIVIDER_CLASS} />
            {captureRow ? (
              <Tip label="Keyboard capture" kbd={kbdFor("gui-capture-toggle")}>
                <button
                  type="button"
                  data-testid="gui-capture-toggle"
                  aria-label="Keyboard capture"
                  aria-pressed={capture}
                  // Toggling must leave keyboard focus on the guest canvas.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => captureRow.onSelect()}
                  className={controlClass({
                    variant: "toggle",
                    base: HEADER_VERB_BASE,
                    rest: "hover:bg-bg-inset hover:text-text-primary",
                    ringed: true,
                    pressed: capture,
                  })}
                >
                  <KeyboardGlyph />
                </button>
              </Tip>
            ) : null}
            {showGear ? (
              <Tip label="More controls" note={`${foldedItems.length} folded`}>
                <button
                  ref={gearRef}
                  type="button"
                  data-testid="gui-toolbar-overflow"
                  aria-label="More controls"
                  aria-haspopup="menu"
                  aria-expanded={toolbarVisible}
                  onClick={() => {
                    // One menu at a time (the single-openMenu predecessor's rule).
                    setResolutionOpen(false);
                    onToolbarVisibleChange(!toolbarVisible);
                  }}
                  className={controlClass({
                    variant: "toggle",
                    base: HEADER_VERB_BASE,
                    rest: "hover:bg-bg-inset hover:text-text-primary",
                    ringed: true,
                    pressed: toolbarVisible,
                  })}
                >
                  <GearGlyph />
                </button>
              </Tip>
            ) : null}
          </span>
        ) : null}
      </TipGroup>
      {resolutionOpen ? (
        <GuiToolbarMenu
          kind="resolution"
          anchorRef={sizeChipRef}
          rows={resolutionMenuRows}
          ariaLabel="Resolution"
          onClose={() => setResolutionOpen(false)}
        />
      ) : null}
      {showGear && toolbarVisible ? (
        <GuiToolbarMenu
          kind="overflow"
          anchorRef={gearRef}
          rows={overflowRows}
          ariaLabel="More controls"
          autoFocus={panelAutoFocus}
          onClose={() => onToolbarVisibleChange(false)}
        />
      ) : null}
      {/* Hidden measurement probe — every candidate in BOTH label forms, one
          divider, the capture verb's permanent pinned block (divider + ⌨),
          and the conditional ⚙ pinned block (divider + ⚙), so the fit reads
          real widths and nothing is hardcoded. `inert` + aria-hidden + off-screen:
          the duplicated controls can never receive focus or clicks. */}
      <div
        ref={probeRef}
        data-testid="gui-toolbar-probe"
        aria-hidden="true"
        inert
        className="absolute -left-[9999px] top-0 flex items-center pointer-events-none"
      >
        {items.map((item) => (
          <span key={item.id} data-fold={item.id} className="flex items-center shrink-0">
            {renderControl(item, "full", true)}
          </span>
        ))}
        {items
          .filter((item) => item.degradable)
          .map((item) => (
            <span key={`${item.id}:short`} data-fold={`${item.id}:short`} className="flex items-center shrink-0">
              {renderControl(item, "short", true)}
            </span>
          ))}
        <span data-fold="divider" className={HEADER_DIVIDER_CLASS} />
        {captureRow ? (
          <span data-fold="capture" className="flex items-center shrink-0">
            <span className={HEADER_DIVIDER_CLASS} />
            <button type="button" tabIndex={-1} className={HEADER_VERB_CLASS}>
              <KeyboardGlyph />
            </button>
          </span>
        ) : null}
        {/* The rendered pinned block carries ONE leading divider for the whole
            run, so only the FIRST member probes it: with capture present the
            `capture` probe owns it and the gear measures bare, otherwise the
            gear owns it. Probing it twice over-reserved a divider and folded a
            ladder item a few px early. */}
        <span data-fold="pinned" className="flex items-center shrink-0">
          {captureRow ? null : <span className={HEADER_DIVIDER_CLASS} />}
          <button type="button" tabIndex={-1} className={HEADER_VERB_CLASS}>
            <GearGlyph />
          </button>
        </span>
      </div>
    </div>
  );
}

/** Resolution menu rows, shared by the size chip's own menu and the `⚙`
 *  panel's folded `size` group — one mapping so the two cannot drift. The
 *  lock/unlock pair keeps its bare label; every preset is stripped of the
 *  `Resolution → ` prefix the palette carries. */
function resolutionMenuRowsFrom(actions: GuiPaletteAction[]): GuiToolbarMenuRow[] {
  return pickGuiActions(actions, RESOLUTION_MENU_IDS).map((a) => ({
    id: a.id,
    label:
      a.id === "gui-lock" || a.id === "gui-unlock"
        ? stripGuiLabel(a.label)
        : stripGuiLabel(a.label, "Resolution → "),
    description: a.description,
    disabled: a.disabled,
    onSelect: a.onSelect,
  }));
}

/** The flat by-id rows of the `⚙` fold panel (D9): the folded rungs in
 *  ladder order with a separator at each group seam, plus the coarse-only
 *  ⌖/⌨ rows appended. `fullscreenRow` prepends the `gui-fullscreen` row to
 *  the size group — the mobile panel, where no header rail verb exists. */
function buildGuiOverflowRows(args: {
  actions: GuiPaletteAction[];
  quality: GuiQuality;
  coarsePointer: boolean;
  foldedIds: ReadonlySet<string>;
  fullscreenRow: boolean;
}): GuiToolbarMenuRow[] {
  const { actions, quality, coarsePointer, foldedIds, fullscreenRow } = args;
  const byId = new Map(actions.map((a) => [a.id, a]));
  const rows: GuiToolbarMenuRow[] = [];
  let lastGroup: string | null = null;
  const pushGroup = (group: string, groupRows: GuiToolbarMenuRow[]) => {
    if (groupRows.length === 0) return;
    if (lastGroup !== null && group !== lastGroup) {
      rows.push({ id: `sep-${group}-${rows.length}`, separator: true });
    }
    rows.push(...groupRows);
    lastGroup = group;
  };
  const simple = (id: string): GuiToolbarMenuRow[] => {
    const row = byId.get(id);
    return row
      ? [{ id: row.id, label: stripGuiLabel(row.label), description: row.description, disabled: row.disabled, onSelect: row.onSelect }]
      : [];
  };

  // Per-item row builders in ladder order — a folded item contributes exactly
  // its own palette row(s), never a sibling's.
  const perItem: Record<string, () => GuiToolbarMenuRow[]> = {
    size: () => [
      ...(fullscreenRow ? simple("gui-fullscreen") : []),
      ...resolutionMenuRowsFrom(actions),
    ],
    "zoom-out": () => simple("gui-zoom-out"),
    "zoom-fit": () => simple("gui-zoom-fit"),
    "zoom-in": () => simple("gui-zoom-in"),
    quality: () => {
      const qualityRow = byId.get(`gui-quality-${nextGuiQuality(quality)}`);
      return qualityRow
        ? [
            {
              id: qualityRow.id,
              label: `Quality → ${GUI_QUALITY_LABELS[quality]}`,
              onSelect: qualityRow.onSelect,
            },
          ]
        : [];
    },
    paste: () => simple("gui-paste"),
    "send-key": () => simple("gui-send-key"),
    terminal: () => simple("gui-open-terminal"),
    browser: () => simple("gui-open-browser"),
    stats: () => simple(byId.has("gui-stats-hide") ? "gui-stats-hide" : "gui-stats-show"),
    reconnect: () => simple("gui-reconnect"),
  };
  for (const item of LADDER) {
    if (!foldedIds.has(item.id)) continue;
    pushGroup(item.group, perItem[item.id]());
  }
  if (coarsePointer) {
    pushGroup("coarse", [
      ...simple(byId.has("gui-pointer-touch") ? "gui-pointer-touch" : "gui-pointer-trackpad"),
      ...simple(byId.has("gui-keybar-hide") ? "gui-keybar-hide" : "gui-keybar-show"),
    ]);
  }
  return rows;
}

/** The mobile bottom rung (D7): there is no tile header on mobile, so the
 *  pinned block renders into the TOP BAR beside the pinned switch group and
 *  every rung counts as folded — the panel carries all ladder rows plus the
 *  fullscreen row (mobile has no tile header) and the coarse ⌖/⌨ rows. */
export function GuiToolbarMobileOverflow({
  actions,
  quality,
  visible,
  onVisibleChange,
}: {
  actions: GuiPaletteAction[];
  quality: GuiQuality;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
}) {
  const gearRef = useRef<HTMLButtonElement>(null);
  const rows = buildGuiOverflowRows({
    actions,
    quality,
    coarsePointer: true,
    foldedIds: new Set(LADDER.map((i) => i.id)),
    fullscreenRow: true,
  });
  return (
    <span className="relative flex items-center shrink-0">
      <button
        ref={gearRef}
        type="button"
        data-testid="gui-toolbar-overflow"
        aria-label="More controls"
        aria-haspopup="menu"
        aria-expanded={visible}
        onClick={() => onVisibleChange(!visible)}
        className={controlClass({ variant: "icon", open: visible })}
      >
        <GearGlyph />
      </button>
      {visible ? (
        <GuiToolbarMenu
          kind="overflow"
          anchorRef={gearRef}
          rows={rows}
          ariaLabel="More controls"
          onClose={() => onVisibleChange(false)}
        />
      ) : null}
    </span>
  );
}
