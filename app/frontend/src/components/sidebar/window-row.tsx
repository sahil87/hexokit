import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
  memo,
} from "react";
import { isGhostWindow } from "@/contexts/optimistic-context";
import type { ProjectSession } from "@/types";
import type { MergedSession } from "@/contexts/optimistic-context";
import type { BoardSummary } from "@/api/boards";
import { UNCOLORED_SELECTED_KEY, type RowTint } from "@/themes";
import {
  MARKER_COARSE_SCALE,
  MARKER_STAGE_WIDTHS,
  MARKER_STAGE_WIDTHS_COARSE,
  MARKER_INK,
  MARKER_WELL_WIDTH_COARSE,
  MARKER_WELL_WIDTH_FINE,
  MARKER_WELL_BACKGROUND,
  MARKER_WELL_EDGE,
  MarkerChevrons,
  formatMarker,
  markerFillStyle,
  parseMarker,
  type Marker,
} from "@/marker";
import { SwatchPopover } from "@/components/swatch-popover";
import { FlairOverlay } from "@/components/flair-overlay";
import { StatusDot } from "@/components/status-dot";
import { prOwnsGlyph, prGlyphColor } from "@/components/pr-status-model";
import { PinPopover } from "./pin-popover";
import {
  MarkerPad,
  MARKER_PAD_POPOVER_INSET_PX,
  MARKER_PAD_POPOVER_PREFERRED_WIDTH_PX,
  closeMarkerPad,
  markerPadPopoverLayout,
  openMarkerPad,
  placeMarkerPad,
  sameCell,
  selectCell,
  stepStage,
} from "./marker-pad";
import { CloseIcon, prGlyphIcon, ComposeIcon, HeadsetIcon } from "./icons";
import { PinIcon } from "@/components/pin-icon";
import {
  useRowFlyout,
  useRailScrub,
  WindowFlyoutContent,
  STATUS_RAIL_WIDTH_PX,
  railRestBand,
  railHeldBand,
  RAIL_HELD_SEAM,
} from "./row-flyout-card";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { toSafeWindowName } from "@/lib/names";

type ProjectWindow = ProjectSession["windows"][number];
type GhostWindow = MergedSession["windows"][number];

type WindowRowProps = {
  win: ProjectWindow | GhostWindow;
  session: string;
  isSelected: boolean;
  isDragOver: boolean;
  /** Color value: an owned family name ("orange") or a legacy numeric/blend
   *  descriptor ("4" / "1+3") — the row's hue (label axis). */
  color?: string;
  /** Left-gutter marker state (`<mode>[:<stage>]`, where mode is manual, auto,
   *  or blocked and stage is 1–3; empty clears) — independent from `color`. */
  marker?: string;
  rowTints?: Map<string, RowTint>;
  /** Contrast-adjusted full-saturation guarded color per color value. Used for
   *  SERVER tile edges and — here — the flair overlay. */
  rowBorders?: Map<string, string>;
  editingWindow: { session: string; windowId: string } | null;
  // Note: callers may pass an object that also carries a `server` field — the
  // extra property is ignored (only session + windowId are read), and passing
  // the reference straight through keeps this prop stable across renders.
  editingName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Identity-arg handlers. The row binds its own (server, session, win)
   *  identity when invoking them, so a SINGLE stable reference can be shared by
   *  every row across the whole sidebar — which is what makes React.memo on
   *  WindowRow effective (the handler prop identity does not change per row or
   *  per SSE tick). The internal onClick wrappers the row builds are NOT part
   *  of the memo comparison, so rebuilding them per row-render is free. */
  onSelectWindow: (server: string, session: string, windowId: string) => void;
  /** Modifier-aware row-click seam for the bulk multi-select (260807-nf9f).
   *  Identity-arg like its siblings so ONE stable reference serves every row
   *  (the memo contract). Receives the raw modifier flags so the sidebar owns
   *  the whole gesture policy — cmd/ctrl toggles, shift extends a range, plain
   *  navigates and clears — in one place. Returns `true` when the sidebar
   *  CONSUMED the click as a selection gesture, in which case the row does NOT
   *  fall through to `onSelectWindow`. Omitted (e.g. a bare unit-test render)
   *  ⇒ every click is a plain navigate, exactly as before. */
  onRowClick?: (
    server: string,
    session: string,
    windowId: string,
    mods: { meta: boolean; ctrl: boolean; shift: boolean },
  ) => boolean;
  /** True when this row is in the sidebar's bulk selection (260807-nf9f) —
   *  drives `aria-selected` on the treeitem plus the visible selected treatment.
   *  Independent of `isSelected`, which is the URL-derived single-window
   *  navigation selection (`aria-current="page"`). */
  isBulkSelected?: boolean;
  onStartEditing: (server: string, session: string, windowId: string, currentName: string) => void;
  onWindowNameChange: (value: string) => void;
  onRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onRenameBlur: () => void;
  onKillClick: (server: string, session: string, windowId: string, ctrl: boolean) => void;
  /** Whether this row is draggable (ghost rows are not). When false the drag
   *  handlers are not wired. */
  draggable?: boolean;
  /** True while this row is the drag source — hides the flair overlay for the
   *  drag's duration (cube/warp animate transforms on child spans, which would
   *  corrupt the drag ghost; the guard is uniform across flairs). */
  isDragSource?: boolean;
  onDragStart?: (e: React.DragEvent, server: string, session: string, index: number, windowId: string, name: string) => void;
  onDragOver?: (e: React.DragEvent, server: string, session: string, index: number) => void;
  onDrop?: (e: React.DragEvent, server: string, session: string, index: number) => void;
  onDragEnd?: () => void;
  onColorChange?: (server: string, session: string, windowId: string, color: string | null) => void;
  /** Persist a marker for this window as `<mode>[:<stage>]`, or clear it with null. */
  onMarkerChange?: (server: string, session: string, windowId: string, marker: string | null) => void;
  /** Persist a flair state for this window. The Label picker's flair section
   *  passes the EXACT picked state here ("" mapped to null clears). Omitted on
   *  ghost rows (the label zone is disabled). */
  onFlairChange?: (server: string, session: string, windowId: string, flair: string | null) => void;
  /** Fork this window's agent conversation into a new window in the same session
   *  and directory (260806-s4av). Identity-arg like its siblings. Optional
   *  (mirrors `onColorChange`): when omitted — the board-route sidebar, ghost
   *  rows, or a bare unit-test render — the flyout renders no fork affordance.
   *  The card additionally gates on `agentProvider === "claude"`.
   *
   *  Returns a promise resolving when the fork POST settles (it surfaces its own
   *  errors and does not reject), which the flyout's button awaits to hold its
   *  in-flight disabled state. */
  onForkWindow?: (server: string, windowId: string) => Promise<void>;
  /** Ask the server's operator window to fix the subject window's tab name
   *  (260822-fih1-operator-request-fix-tab-name). Optional (mirrors
   *  `onForkWindow`): when omitted — e.g. the board-route sidebar — the row
   *  flyout's Fix tab name affordance is hidden. The flyout additionally gates
   *  on the derived availability rule (`canRequestWindowOperatorAction`). */
  onFixTabName?: (server: string, windowId: string) => Promise<void>;
  /** Open the operator compose dialog (260822-wyn3). Identity-arg like its
   *  siblings (the row binds the server). Optional (mirrors `onForkWindow`):
   *  when omitted — ordinary window rows, the board-route sidebar — no compose
   *  icon renders; only the pinned operator row's mount site passes it. */
  onOperatorCompose?: (server: string) => void;
  /** Whether the server has an operator window — availability input for the
   *  flyout's Fix tab name row (the row itself carries the rest of the rule). */
  hasOperator?: boolean;
  /** The owning session's server-derived operator-watchdog staleness flag
   *  (`ProjectSession.operatorStale`, threaded unchanged). True dims the
   *  watched underbar on the StatusDot; absent/false leaves it at full
   *  treatment. */
  operatorStale?: boolean;
  /** The owning session's operator-watchdog last tick
   *  (`ProjectSession.operatorLastTickAt`, threaded unchanged; unix seconds,
   *  0/absent = never ticked). Feeds the flyout card's `opr` register only —
   *  never used to recompute staleness client-side. */
  operatorLastTickAt?: number;
  /** Tmux server name for the pin popover (server-routing contract) AND the
   *  identity bound into the handlers above. When omitted the pin icon is
   *  hidden and handlers bind an empty server — used by tests that render
   *  WindowRow without the boards system wired up. */
  server?: string;
  /** Aggregate pin state — if this window is pinned to ANY board, the icon
   *  renders filled. */
  isPinnedToAny?: boolean;
  /** When true, the row is pinned to the *currently active board* (if any)
   *  and gets a subtle accent highlight in the Sessions tree. Independent of
   *  isPinnedToAny which controls the pin-icon fill. */
  isPinnedToActiveBoard?: boolean;
  /** All known boards (for the pin popover). */
  boards?: BoardSummary[];
  /** True while the board list is still loading — forwarded to the pin popover
   *  so its cold-start prefill isn't triggered by an empty mid-load list. */
  boardsLoading?: boolean;
  /** Predicate: is this window pinned to the given board? Identity-arg form
   *  (board, server, windowId) so a single stable reference (the context's
   *  `pinnedToBoard`) serves every row; the row binds its own (server,
   *  windowId). Used by the pin popover to render checkmarks. */
  isPinnedToBoard?: (board: string, server: string, windowId: string) => boolean;
  /** The single board this window is pinned to (co9z), or undefined if unpinned.
   *  When set, the pin popover offers a "Go to {board}" navigation row so the
   *  pinned-row indicator becomes a path to the owning board. */
  pinnedBoard?: string;
  /** Navigate to a board's route (`/board/{board}`). Stable identity-arg
   *  handler shared by every row (like the other identity-arg handlers). */
  onNavigateToBoard?: (board: string) => void;
  /** Roving-tabindex value: `0` for the single roving-focused tree row, `-1`
   *  for every other row (the roving model lives in `index.tsx`). Defaults to
   *  `-1` so a row rendered without the tree wiring is not a tab stop. Only the
   *  two affected rows change this per arrow keypress, preserving the memo tree. */
  tabIndex?: number;
  /** W3C-APG tree leaf metadata. Window rows are level-2 leaves. `ariaSetSize`
   *  is the count of sibling windows in the session; `ariaPosInSet` the row's
   *  1-based position among them. Omitted ⇒ not announced (e.g. in unit tests
   *  that render a bare row). */
  ariaLevel?: number;
  ariaSetSize?: number;
  ariaPosInSet?: number;
  /** Globally-unique roving-tabindex handle for the tree's keyboard model
   *  (`index.tsx`), exposed as `data-row-key`. Value is `${server}:${windowId}`
   *  (or `${server}:ghost-${optimisticId}`): bare tmux ids (@N) are only unique
   *  within one server and would collide across open server groups, so the
   *  roving cursor + Enter/Space activation key on this namespaced handle.
   *  `data-window-id` stays the bare id for tests/automation/pin lookups. */
  rowKey?: string;
};

function WindowRowInner({
  win,
  session,
  isSelected,
  isDragOver,
  color,
  marker,
  rowTints,
  rowBorders,
  editingWindow,
  editingName,
  inputRef,
  onSelectWindow,
  onRowClick,
  isBulkSelected = false,
  onStartEditing,
  onWindowNameChange,
  onRenameKeyDown,
  onRenameBlur,
  onKillClick,
  draggable = false,
  isDragSource = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onColorChange,
  onMarkerChange,
  onFlairChange,
  onForkWindow,
  onFixTabName,
  onOperatorCompose,
  hasOperator = false,
  operatorStale = false,
  operatorLastTickAt,
  server,
  isPinnedToAny = false,
  isPinnedToActiveBoard = false,
  boards = [],
  boardsLoading = false,
  isPinnedToBoard,
  pinnedBoard,
  onNavigateToBoard,
  tabIndex = -1,
  ariaLevel,
  ariaSetSize,
  ariaPosInSet,
  rowKey,
}: WindowRowProps) {
  const ghost = isGhostWindow(win);
  const srv = server ?? "";
  // Drag is wired only for non-ghost rows that opted in via `draggable`.
  const dragEnabled = draggable && !ghost;
  const isEditing = editingWindow?.session === session && editingWindow.windowId === win.windowId;
  // The color + flair picker opens from the row card or the label palette action.
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [showPinPopover, setShowPinPopover] = useState(false);
  const markerWired = !ghost && !!onMarkerChange && !!server;
  const [showMarkerPad, setShowMarkerPad] = useState(false);
  const [markerPreview, setMarkerPreview] = useState<Marker | null | undefined>(undefined);
  const stripRef = useRef<HTMLDivElement>(null);
  const padAnchorRef = useRef<HTMLDivElement>(null);
  const pressRef = useRef<{
    originX: number;
    originY: number;
    start: Marker | null;
    // Whether this row's pad was already open when the press landed. A no-move
    // release closes it in that case, which is what makes a second click on the
    // strip a toggle rather than a no-op.
    wasOpen: boolean;
  } | null>(null);
  const [padPosition, setPadPosition] = useState({ left: MARKER_WELL_WIDTH_FINE, top: 0 });
  const [padLayout, setPadLayout] = useState(() =>
    markerPadPopoverLayout(
      MARKER_PAD_POPOVER_PREFERRED_WIDTH_PX + MARKER_PAD_POPOVER_INSET_PX,
    ),
  );
  const padPitchRef = useRef(padLayout.cellPx);
  const padCloseRef = useRef<() => void>(() => {});
  const markerPadHandleRef = useRef({ close: () => padCloseRef.current() });
  const padClose = useCallback(() => {
    setMarkerPreview(undefined);
    setShowMarkerPad(false);
    pressRef.current = null;
    closeMarkerPad(markerPadHandleRef.current);
  }, []);
  padCloseRef.current = padClose;
  const padOpen = useCallback(() => {
    openMarkerPad(markerPadHandleRef.current);
    setShowMarkerPad(true);
  }, []);
  useEffect(
    () => () => closeMarkerPad(markerPadHandleRef.current),
    [],
  );
  const pinBtnRef = useRef<HTMLButtonElement>(null);
  // When the pin affordance is wired up, reserve a few extra px on the right so
  // labels don't run under the icon group. Also gates the flyout card's Pin
  // action row (the coarse-pointer pin path — the in-row cluster is
  // fine-pointer-only).
  const showPinIcon = !ghost && !!server;

  // Row-hover register flyout card (93dy) — the tier-2 hover surface that
  // replaced the per-dot StatusDotTip. ALL flyout state is row-local (this
  // hook), so the WindowRow memo stays effective. Suppressed while the row's
  // popovers are open (the card must not fight them) and on ghost rows (no
  // real window data yet).
  const coarse = useCoarsePointer();
  // Bind the row's own (server, windowId) onto the shared identity-arg handler.
  // Undefined (no handler, or a ghost row with no real window yet) means the card
  // renders no fork affordance at all — the optional-handler gate.
  const handleFork = useMemo(() => {
    if (!onForkWindow || ghost) return undefined;
    return () => onForkWindow(srv, win.windowId);
  }, [onForkWindow, ghost, srv, win.windowId]);
  // Same binding idiom as handleFork: undefined (no handler, or a ghost row)
  // means the card renders no Fix tab name affordance at all.
  const handleFixTabName = useMemo(() => {
    if (!onFixTabName || ghost) return undefined;
    return () => onFixTabName(srv, win.windowId);
  }, [onFixTabName, ghost, srv, win.windowId]);
  const flyout = useRowFlyout({
    suppressed: ghost || showPinPopover || showLabelPicker || showMarkerPad,
    content: ({ close }) => (
      <WindowFlyoutContent
        win={win}
        // The card's action rows (the coarse-pointer color/pin/kill home —
        // additive on fine pointers). Change color… and Pin run the
        // close-then-open idiom: close the card, THEN open the row's existing
        // picker/popover (ordering independent of state-update timing; the
        // `suppressed` gate above already includes both popover-open states,
        // so popover-over-card precedence holds). Kill routes through the
        // existing KillDialog confirm path — never a force-kill (no modifier
        // on touch). Optional-handler idiom: ghost rows and unwired seams
        // render no row.
        onChangeColorAction={
          onColorChange
            ? () => {
                close();
                setShowLabelPicker(true);
              }
            : undefined
        }
        onFork={handleFork}
        onFixTabName={handleFixTabName}
        hasOperator={hasOperator}
        onPinAction={
          showPinIcon
            ? () => {
                close();
                setShowPinPopover(true);
              }
            : undefined
        }
        pinned={isPinnedToAny}
        // Feeds the Pin action row's sub-hint (the board name when known).
        pinnedBoard={pinnedBoard}
        onKillAction={ghost ? undefined : () => onKillClick(srv, session, win.windowId, false)}
        operator={{ stale: operatorStale, lastTickAt: operatorLastTickAt }}
      />
    ),
  });

  // Slide-to-scrub (coarse pointers): pointerdown on the right-edge rail opens
  // this row's flyout card and captures the pointer; while the scrub is active,
  // pointermove hit-tests the finger
  // position against rail-bearing rows of ALL tiers and retargets the
  // single-open card via the module-scoped registry (the touch translation of
  // the desktop hover sweep). The scrub NEVER selects or navigates a row;
  // release keeps the last card open (outside-press dismissal is unchanged).
  // `touch-action: none` on the target keeps a drag that starts here from
  // scrolling the drawer; drags starting elsewhere scroll normally.
  const scrub = useRailScrub(flyout.openNow);

  // Listen for the imperative `pin-popover:open` / `label-popover:open` events
  // dispatched by the command palette's "Board: Pin Current Tab" and
  // "Tab: Label" actions. Only the row whose (server, windowId) matches the
  // event detail opens its popover; other rows ignore the event. Mirrors the
  // `palette:open` document-event pattern used elsewhere — see app.tsx command
  // palette wiring.
  useEffect(() => {
    if (!server) return;
    function isMatch(e: Event): boolean {
      const detail = (e as CustomEvent<{ server: string; windowId: string }>).detail;
      return !!detail && detail.server === server && detail.windowId === win.windowId;
    }
    function pinHandler(e: Event) {
      if (isMatch(e)) setShowPinPopover(true);
    }
    function labelHandler(e: Event) {
      if (isMatch(e)) setShowLabelPicker(true);
    }
    function padHandler(e: Event) {
      if (isMatch(e) && markerWired) padOpen();
    }
    document.addEventListener("pin-popover:open", pinHandler);
    document.addEventListener("label-popover:open", labelHandler);
    document.addEventListener("marker-pad:open", padHandler);
    return () => {
      document.removeEventListener("pin-popover:open", pinHandler);
      document.removeEventListener("label-popover:open", labelHandler);
      document.removeEventListener("marker-pad:open", padHandler);
    };
  }, [server, win.windowId, markerWired, padOpen]);

  const tint = useMemo(() => {
    if (color == null || !rowTints) return null;
    return rowTints.get(color) ?? null;
  }, [color, rowTints]);

  // Uncolored rows borrow the gray tint only in the selected state.
  const uncoloredSelectedTint = useMemo(() => {
    if (color != null || !rowTints || !isSelected) return null;
    return rowTints.get(UNCOLORED_SELECTED_KEY) ?? null;
  }, [color, rowTints, isSelected]);

  const parsedMarker = useMemo(() => parseMarker(marker), [marker]);
  const displayMarker = markerPreview !== undefined ? markerPreview : parsedMarker;
  const markerWellWidth = coarse ? MARKER_WELL_WIDTH_COARSE : MARKER_WELL_WIDTH_FINE;
  const markerStageWidths = coarse ? MARKER_STAGE_WIDTHS_COARSE : MARKER_STAGE_WIDTHS;
  const displayMarkerStyle = useMemo(
    () => (displayMarker ? markerFillStyle(displayMarker, markerStageWidths) : undefined),
    [displayMarker, markerStageWidths],
  );

  const padCommit = useCallback(
    (cell: Marker | null) => {
      padClose();
      onMarkerChange?.(
        srv,
        session,
        win.windowId,
        cell ? formatMarker(cell) : null,
      );
    },
    [onMarkerChange, padClose, session, srv, win.windowId],
  );

  const onStripDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // Click-to-toggle. The document dismissal listener deliberately ignores
    // presses on this row's own strip, so without this the strip could only
    // ever open. Coarse resolves the toggle here because its tap has no
    // release path (the drag gesture is fine-only); fine defers to the release
    // so a drag starting from an already-open pad still commits a cell.
    if (coarse && showMarkerPad) {
      padClose();
      return;
    }
    const wasOpen = showMarkerPad;
    const sidebarCandidate = event.currentTarget.closest("[data-sidebar-scroll]");
    if (sidebarCandidate instanceof HTMLElement) {
      const nextLayout = markerPadPopoverLayout(
        sidebarCandidate.getBoundingClientRect().width,
      );
      padPitchRef.current = nextLayout.cellPx;
      setPadLayout(nextLayout);
    }
    padOpen();
    if (coarse) return;
    pressRef.current = {
      originX: event.clientX,
      originY: event.clientY,
      start: displayMarker,
      wasOpen,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onStripMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (coarse) return;
    const press = pressRef.current;
    if (!press) return;
    setMarkerPreview(
      selectCell(
        press.start,
        event.clientX - press.originX,
        event.clientY - press.originY,
        padPitchRef.current,
      ),
    );
  };

  const onStripUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (coarse) return;
    const press = pressRef.current;
    if (!press) return;
    pressRef.current = null;
    const cell = selectCell(
      press.start,
      event.clientX - press.originX,
      event.clientY - press.originY,
      padPitchRef.current,
    );
    // A no-move release on a pad this press already found open closes it; on a
    // pad this press opened it leaves the click menu up.
    if (sameCell(cell, press.start)) {
      if (press.wasOpen) padClose();
      else setMarkerPreview(undefined);
    } else padCommit(cell);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onStripWheel = useCallback(
    (event: WheelEvent) => {
      if (!parsedMarker || event.deltaY === 0) return;
      event.preventDefault();
      const next = stepStage(parsedMarker, event.deltaY > 0 ? 1 : -1);
      if (!sameCell(next, parsedMarker)) {
        onMarkerChange?.(srv, session, win.windowId, formatMarker(next));
      }
    },
    [onMarkerChange, parsedMarker, session, srv, win.windowId],
  );

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.addEventListener("wheel", onStripWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onStripWheel);
  }, [onStripWheel]);

  useLayoutEffect(() => {
    if (!showMarkerPad) return;
    const anchor = padAnchorRef.current;
    const row = anchor?.parentElement;
    if (!anchor || !row) return;
    const sidebarCandidate = row.closest("[data-sidebar-scroll]");
    const sidebar =
      sidebarCandidate instanceof HTMLElement
        ? sidebarCandidate
        : document.documentElement;
    const bounds = sidebar.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const nextLayout = markerPadPopoverLayout(bounds.width);
    padPitchRef.current = nextLayout.cellPx;
    if (
      nextLayout.width !== padLayout.width ||
      nextLayout.cellPx !== padLayout.cellPx ||
      nextLayout.labelPx !== padLayout.labelPx
    ) {
      setPadLayout(nextLayout);
    }
    setPadPosition(
      placeMarkerPad(
        {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
        {
          left: rowRect.left,
          top: rowRect.top,
          width: rowRect.width,
          height: rowRect.height,
        },
        { width: nextLayout.width, height: anchor.offsetHeight },
        markerWellWidth,
      ),
    );
  }, [showMarkerPad, padLayout.width, padLayout.cellPx, padLayout.labelPx, markerWellWidth]);

  useEffect(() => {
    if (!showMarkerPad) return;
    const onDocumentDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (padAnchorRef.current?.contains(target) || stripRef.current?.contains(target))
      ) {
        return;
      }
      padClose();
    };
    document.addEventListener("pointerdown", onDocumentDown, true);
    return () => document.removeEventListener("pointerdown", onDocumentDown, true);
  }, [padClose, showMarkerPad]);

  // The flair overlay uses the row's guarded family color; marker shapes and
  // the hazard wedge use the fixed marker ink.
  const flairColor = useMemo(() => {
    if (!rowBorders) return "var(--color-border)";
    if (color != null) return rowBorders.get(color) ?? "var(--color-border)";
    return rowBorders.get(UNCOLORED_SELECTED_KEY) ?? "var(--color-border)";
  }, [color, rowBorders]);

  // Compute inline style for the button (background tint only — no left border).
  // While the flyout card is open the row HOLDS its hover shade (the held-row
  // continuity cue): the pointer traveling onto the card drops CSS :hover, and
  // without the hold the card visibly "detaches" from its row.
  const buttonStyle = useMemo(() => {
    const style: React.CSSProperties = {};
    if (tint) {
      style.backgroundColor = isSelected ? tint.selected : flyout.open ? tint.hover : tint.base;
    } else if (uncoloredSelectedTint) {
      style.backgroundColor = uncoloredSelectedTint.selected;
    }
    return Object.keys(style).length > 0 ? style : undefined;
  }, [tint, uncoloredSelectedTint, isSelected, flyout.open]);

  // The row box starts at the physical sidebar edge. Each pointer class keeps
  // an 8px gap between its marker well and the status dot.
  const buttonClass = useMemo(() => {
    const rightPad = showPinIcon ? "pr-[68px]" : "pr-11";
    // Coarse reserve (non-ghost rows): the name must truncate before the
    // 56px status rail that overlays the row's right edge (the literal
    // matches STATUS_RAIL_WIDTH_PX — Tailwind scans literal classes only).
    // Inert on fine pointers; ghost rows have no rail and no reserve.
    const coarsePad = ghost ? "" : " coarse:pr-[56px]";
    // Dense rows on fine pointers (24px); touch keeps the 36px target via the
    // `coarse:` variant (context.md § Mobile Responsive Design).
    // Content-start literals track MARKER_WELL_WIDTH_FINE + 8 and
    // MARKER_WELL_WIDTH_COARSE + 8; Tailwind scans literal classes only. The
    // 8px gap holds the status dot's waiting halo clear of the marker track.
    const base = `w-full text-left flex items-center justify-between gap-2 py-px pl-[30px] coarse:pl-[44px] ${rightPad}${coarsePad} text-xs transition-colors min-h-[24px] coarse:min-h-[36px]`;
    if (isSelected) {
      // Selection = deeper tint (tint.selected / gray sentinel via buttonStyle)
      // + bold + brightened text. No border (removed in the axis split).
      return `${base} text-text-primary font-medium`;
    }
    if (tint) {
      // Plain hover brightens text only; the open flyout holds the background shade.
      return `${base} text-text-secondary hover:text-text-primary${flyout.open ? " text-text-primary" : ""}`;
    }
    // Uncolored rows follow the same text-only hover and held-shade rule.
    return `${base} text-text-secondary hover:text-text-primary${
      flyout.open ? " text-text-primary bg-bg-chrome-raised" : ""
    }`;
  }, [tint, isSelected, showPinIcon, ghost, flyout.open]);

  // Rail background: the bg-inset band by default (a class); a SELECTED row
  // deepens it by mixing the row's own selected tint (tint.selected, or the
  // uncolored gray sentinel) into the inset base — derived from the existing
  // tint system, never a new token. While the row's card is OPEN (tap-held or
  // mid-scrub) the rail shows the held treatment — band steps up one shade,
  // seam brightens (R8); it travels row-to-row with the single-open card.
  const railStyle = useMemo(() => {
    if (!coarse || ghost) return undefined;
    const selected = tint?.selected ?? uncoloredSelectedTint?.selected;
    if (flyout.open) {
      return {
        backgroundColor: railHeldBand(
          isSelected && selected ? selected : (tint?.hover ?? "var(--color-bg-card)"),
        ),
        borderColor: RAIL_HELD_SEAM,
      };
    }
    if (isSelected && selected) return { backgroundColor: railRestBand(selected) };
    return undefined;
  }, [coarse, ghost, isSelected, tint, uncoloredSelectedTint, flyout.open]);

  const isBlocked = displayMarker?.mode === "blocked";

  return (
    <div
      key={ghost ? `ghost-${win.optimisticId}` : win.windowId}
      // Stable, unique handle for tests/automation. tmux window ids (@N) are
      // unique for a window's lifetime and survive rename/move/index reuse —
      // unlike the window name or session+index, which are ambiguous or
      // transient. Ghost rows expose their optimistic id until confirmed.
      data-window-id={ghost ? `ghost-${win.optimisticId}` : win.windowId}
      // Globally-unique roving handle (`${server}:${windowId}`) for the keyboard
      // model — bare @N collides across servers. Distinct from data-window-id,
      // which stays the bare id for tests/automation/pin lookups.
      data-row-key={rowKey}
      // The shared rail-row hit-test handle (260817-ve5m): the scrub gesture's
      // BOTH ends (this row's start-handler `closest` inside useRailScrub, and
      // `scrubTargetAt`) resolve row roots via the IDENTICAL `RAIL_ROW_SELECTOR`
      // across all three tier DOM shapes. Non-ghost rows only — ghost rows have
      // no rail and a suppressed flyout.
      data-rail-row={ghost ? undefined : ""}
      // W3C-APG tree leaf. The roving model in index.tsx threads `tabIndex`
      // (0 for the one roving row, -1 otherwise) + level/set/pos metadata.
      role="treeitem"
      aria-level={ariaLevel}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      // Bulk multi-select membership (260807-nf9f). Emitted ONLY on selectable
      // (window) rows and only when the tree is wired for multi-select — an
      // `aria-selected` on every row would announce a selection model the
      // board-route/unit-test mounts don't have. Distinct from `aria-current`
      // ("page" = the URL-navigated window), which lives on the inner button.
      aria-selected={onRowClick ? isBulkSelected : undefined}
      tabIndex={tabIndex}
      // `relative` anchors the absolute gutter + status dot + scanline overlay.
      // The scanline/CRT-band overlay is a dedicated inner element (below), NOT
      // classes on this root: the root must stay free to OVERFLOW so the row's
      // `top-full` pin/color popovers aren't clipped on a selected+double row
      // (must-fix 4). The `--rk-marker-color` custom property is set here (the
      // overlay's pseudos read it via inheritance). See globals.css § scanlines
      // and docs/specs/themes.md.
      className={`relative group${ghost ? " opacity-50 animate-pulse" : ""}`}
      // The row root is the flyout card's floating REFERENCE (93dy): the card
      // anchors to the whole ROW (placement "right" → the sidebar's right
      // edge), and the reference props wire hover (mouseOnly + safePolygon),
      // keyboard focus (the roving treeitem), and dismiss. Spread FIRST so the
      // row's own handlers below are never overridden.
      ref={flyout.setReference}
      {...flyout.referenceProps}
      // Not draggable while renaming: a pointer drag inside an input under a
      // `draggable` ancestor starts the ancestor's HTML5 drag instead of
      // selecting text (the input's mousedown stopPropagation cannot stop it).
      // The row stays a drop target.
      draggable={dragEnabled && !isEditing}
      onDragStart={
        dragEnabled && onDragStart
          ? (e) => {
              // An active touch scrub must not escalate into an HTML5 row drag.
              if (scrub.scrubActiveRef.current || pressRef.current || showMarkerPad) {
                e.preventDefault();
                return;
              }
              // A drag gesture must not leave (or race) an open hover card.
              flyout.close();
              onDragStart(e, srv, session, win.index, win.windowId, win.name);
            }
          : undefined
      }
      onDragOver={dragEnabled && onDragOver ? (e) => onDragOver(e, srv, session, win.index) : undefined}
      onDrop={dragEnabled && onDrop ? (e) => onDrop(e, srv, session, win.index) : undefined}
      onDragEnd={dragEnabled ? onDragEnd : undefined}
      style={{
        ...(isBlocked
          ? ({ "--rk-marker-color": MARKER_INK } as React.CSSProperties)
          : {}),
        // Bulk-selection treatment (260807-nf9f): a 2px inset accent ring, the
        // same `box-shadow` idiom the session-row drop target uses — it reads as
        // "member of a set" without competing with the URL selection's
        // tint-depth + bold treatment, and costs no layout (no border box
        // change, so rows never shift when a selection is made).
        // The transient drag-over indicator WINS while a drag is in flight: it
        // marks where the drop lands, which is the more urgent signal.
        ...(isDragOver
          ? { boxShadow: "0 -2px 0 0 var(--color-accent)" }
          : isBulkSelected
            ? { boxShadow: "inset 0 0 0 2px var(--color-accent)" }
            : {}),
      }}
    >
      {/* Hazard-wedge overlay for blocked-marker rows (in-progress / "work
          zone" cue — the marker axis's only texture pairing). A dedicated
          clipped inner element (never the root, whose `top-full` popovers
          must stay unclipped), pointer-events-none, z-5, STATIC in every
          state (rest, hover, selected): no animated twin exists by explicit
          design decision. The wedge reads the `--rk-marker-color` custom
          property set on the root above. */}
      {isBlocked && (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-[5] overflow-hidden pointer-events-none rk-hazard"
        />
      )}
      {/* Flair overlay (decoration-only channel): an always-on ambient
          CSS-only animation mounted whenever the window carries a flair value
          — in EVERY row state (rest, hover, selected). Same overlay discipline
          as the hazard texture above (dedicated clipped inner element, never
          the root, pointer-events-none, z-5) and composes with the color tint
          and the marker stripe. The row's guarded color rides as `color` so
          the tinted flairs (rain/scan) match the row's family. Hidden
          entirely under prefers-reduced-motion (globals.css § Flair overlays)
          and while this row is the drag source (cube/warp animate transforms
          on child spans — the drag ghost rule). */}
      <FlairOverlay flair={win.flair} hidden={isDragSource} color={flairColor} />
      {/* Display-only marker track. Its chrome is row-level; parsed markers add the fill. */}
      <div
        aria-hidden="true"
        data-testid="marker-well"
        className="absolute inset-y-0 left-0 z-10 pointer-events-none"
        style={{
          width: markerWellWidth,
          background: MARKER_WELL_BACKGROUND,
          borderRight: MARKER_WELL_EDGE,
        }}
      >
        {displayMarkerStyle && (
          <span
            aria-hidden
            data-testid="marker-fill"
            className="absolute inset-y-0 left-0"
            style={displayMarkerStyle}
          />
        )}
        {displayMarker?.mode === "auto" && (
          <span
            aria-hidden
            data-testid="marker-fill"
            className="absolute inset-y-0 left-0 flex items-center"
            style={{ width: markerStageWidths[3] }}
          >
            <MarkerChevrons
              count={displayMarker.stage}
              scale={coarse ? MARKER_COARSE_SCALE : 1}
            />
          </span>
        )}
      </div>
      {markerWired && (
        <div
          ref={stripRef}
          data-testid="marker-strip"
          aria-hidden="true"
          onPointerDown={onStripDown}
          onPointerMove={onStripMove}
          onPointerUp={onStripUp}
          className="absolute inset-y-0 left-0 cursor-pointer z-20"
          style={{ width: markerWellWidth }}
        />
      )}
      {showMarkerPad && markerWired && (
        <div
          ref={padAnchorRef}
          className="absolute z-50"
          style={padPosition}
          data-testid="marker-pad-anchor"
        >
          <MarkerPad
            cellPx={padLayout.cellPx}
            popoverWidth={padLayout.width}
            labelPx={padLayout.labelPx}
            value={parsedMarker}
            highlight={markerPreview}
            onPreview={setMarkerPreview}
            onCommit={padCommit}
            onCancel={padClose}
          />
        </div>
      )}
      <button
        onClick={(e) => {
          // Selection gestures (cmd/ctrl-click toggle, shift-click range) are
          // offered to the sidebar FIRST; it returns true when it consumed the
          // click, in which case the row must NOT also navigate. A plain click
          // is never consumed — it falls through to the unchanged navigation
          // path (the sidebar separately clears any live selection).
          if (
            onRowClick?.(srv, session, win.windowId, {
              meta: e.metaKey,
              ctrl: e.ctrlKey,
              shift: e.shiftKey,
            })
          ) {
            e.preventDefault();
            return;
          }
          onSelectWindow(srv, session, win.windowId);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!ghost) onStartEditing(srv, session, win.windowId, win.name);
        }}
        className={buttonClass}
        style={buttonStyle}
        aria-current={isSelected ? "page" : undefined}
      >
        {/* No `truncate` on this wrapper: the dot's waiting halo is a
            box-shadow that paints OUTSIDE the 7px dot, and `truncate`'s
            overflow-hidden clipped it into a half-moon at the span's left
            edge. The name span below carries its own `truncate`, so text
            ellipsis is unaffected; `min-w-0` stays so that inner truncation
            keeps working inside the flex row. */}
        <span className="flex items-center gap-1.5 min-w-0">
          {/* Unified status dot — the LOCAL story only (compositional
              vocabulary): blue building / green PR-ready for a fab change,
              yellow for a fresh ad-hoc agent, else monochrome terminal
              activity (filled=active, hollow ring=idle). The PR story lives on
              the trailing rest-state glyph, never here. Watched-by-operator is
              the dot's additive underbar overlay (never a hue, never a shape —
              the row's `opr` register carries the stage). See StatusDot /
              statusDotState.
              The wrapper is inert on every pointer class, so a dot tap follows
              the row's normal selection path. */}
          <span
            className="flex items-center shrink-0"
            data-testid="status-dot-tap"
          >
            <StatusDot
              win={win}
              watched={!ghost && win.monitored === true ? { stale: operatorStale } : undefined}
            />
          </span>
          {win.role === "operator" && (
            <span
              className={`shrink-0 transition-colors ${
                isSelected
                  ? "text-text-primary"
                  : "text-text-secondary group-hover:text-text-primary"
              }`}
            >
              <HeadsetIcon />
            </span>
          )}
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editingName}
              onChange={(e) => onWindowNameChange(toSafeWindowName(e.target.value))}
              onKeyDown={onRenameKeyDown}
              onBlur={onRenameBlur}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-xs bg-transparent border border-accent-green rounded px-0.5 outline-none truncate w-full"
              aria-label="Rename tab"
            />
          ) : (
            <span className="truncate">{win.name}</span>
          )}
        </span>
        {/* Row Minimalism, partially reversed (260706-y1ar → 93dy;
            status-pyramid.md § Row Minimalism): the trailing STATUS cluster —
            the stage word (red-when-failed) and the duration text — stays
            REMOVED, and the freed width still goes to the window name. The
            row's status signals are the leading StatusDot (hue = journey,
            shape = liveness, additive halo = waiting, additive red center =
            failed, additive underbar = watched by the operator) PLUS, for a
            window with an
            owned PR, a rest-state PR glyph in the trailing cluster's last slot
            (user-approved reversal — see the glyph below). The exact stage
            word + durations survive in the row-hover flyout card
            (row-flyout-card.tsx) and the PANE panel's register view. Hover-
            reveal action icons (pin/kill) below are actions, not status. The
            color affordance lives in the left-edge label zone (hwtr). */}
      </button>
      {/* Hover-reveal buttons: pin + kill (actions only — the color button moved
          to the left label zone, hwtr). FINE-POINTER-ONLY: on coarse pointers the
          whole cluster is not rendered at all — its buttons are fine-only (pin/
          kill live on the flyout card's action rows; an always-visible ✕ per row
          is a fat-finger hazard on a phone), the PR glyph's coarse home is the
          status rail, and the empty container would only risk swallowing rail
          touches when a sticky :hover restores its pointer-events. This is the
          ONE carve-out to the shared hover-reveal contract (canonical spelling:
          the status-panel PR-copy cluster) — deliberate design, not drift, so
          the cluster carries NO coarse: escapes. On fine
          pointers the cluster is inert at rest (pointer-events-none) so stray
          clicks near the row's right edge fall through to the row-select button
          instead of hitting an invisible icon; interactivity is restored on
          hover and keyboard focus within (has-[:focus-visible]). Named
          `group/icons` so the rest-state PR glyph below can key its hide on
          focus WITHIN this cluster. */}
      {!coarse && (
      <div className="group/icons absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 z-10 pointer-events-none group-hover:pointer-events-auto has-[:focus-visible]:pointer-events-auto">
        {/* Rest-state PR glyph (93dy — user-approved partial Row-Minimalism
            reversal): a window with an OWNED PR (prOwnsGlyph — open/failing/
            merged/closed) shows a git-pull-request glyph at rest,
            right-edge-aligned with the hover ✕ (an absolute overlay on the
            LAST slot, same 24px box — so pinned rows read rest `[pin][PR]` →
            hover `[pin][✕]`: the pin holds its slot, only the last slot
            swaps). It is INFORMATIONAL ONLY — aria-hidden decoration (the
            dot's aria-label + the flyout card + PANE panel carry the info),
            pointer-events-none, and it disappears entirely on row hover
            (display swap, not an opacity fade) and while keyboard focus is
            inside the action cluster — so it can never be a click target or
            occlude the revealed ✕. FINE-POINTER-ONLY: on coarse pointers the
            glyph renders in the status rail's fixed 16px slot instead — one
            PR channel per pointer world (the rail slot IS the coarse home).
            Color via the shared PR vocabulary (prGlyphColor),
            six-way: red closed (GitHub's closed red), red failing, gray
            open-draft, yellow checks-running, green open, purple merged —
            closed sits ABOVE fail (stale checks are noise), draft is
            open-gated and sits BELOW fail and ABOVE pending. Icon picked by
            state via the shared prGlyphIcon: ✕ for closed, dotted rail for
            an open draft, arc otherwise — shape separates closed from
            failing (both red) and draft from open (both arc-less/arc), color
            separates closed from draft. The glyph is the row's ONLY PR
            channel (the dot never renders PR state; see pr-status-model.ts). */}
        {!ghost && prOwnsGlyph(win) && (
          <span
            aria-hidden="true"
            data-testid="row-pr-glyph"
            className={`absolute right-0 top-1/2 -translate-y-1/2 flex items-center justify-center px-0.5 min-w-[24px] min-h-[24px] pointer-events-none group-hover:hidden group-has-[:focus-visible]/icons:hidden ${prGlyphColor(win)}`}
          >
            {prGlyphIcon(win)}
          </span>
        )}
        {onOperatorCompose && (
          <button
            type="button"
            aria-label="Compose task for operator"
            onClick={(e) => {
              e.stopPropagation();
              onOperatorCompose(srv);
            }}
            className="text-text-secondary hover:text-text-primary transition-opacity cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-0.5 min-w-[24px] min-h-[24px] flex items-center justify-center"
          >
            <ComposeIcon />
          </button>
        )}
        {showPinIcon && !coarse && (
          <button
            ref={pinBtnRef}
            type="button"
            aria-label={`Pin ${win.name} to a board`}
            aria-pressed={isPinnedToAny}
            // The active-board cue lives on THIS glyph now (the 4px left border
            // was removed in the axis split): a row pinned to the board you're
            // viewing gets a GREEN persistent glyph; a row pinned to
            // some other board is a monochrome persistent glyph; an unpinned row
            // shows the glyph only on hover/focus. isPinnedToActiveBoard
            // implies isPinnedToAny, so the green branch is always persistent.
            onClick={(e) => {
              e.stopPropagation();
              setShowPinPopover((v) => !v);
            }}
            className={`transition-opacity cursor-pointer ${
              isPinnedToActiveBoard
                ? "opacity-100 text-accent-green hover:text-accent-green"
                : isPinnedToAny
                ? "opacity-100 text-text-secondary hover:text-text-primary"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-text-secondary hover:text-text-primary"
            } px-0.5 min-w-[24px] min-h-[24px] flex items-center justify-center`}
          >
            <PinIcon filled={isPinnedToAny} />
          </button>
        )}
        {!coarse && (
        <button
          type="button"
          aria-label={`Kill tab ${win.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!ghost) onKillClick(srv, session, win.windowId, e.ctrlKey || e.metaKey);
          }}
          className="text-text-secondary hover:text-signal-red transition-opacity cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 px-0.5 min-w-[24px] min-h-[24px] flex items-center justify-center"
        >
          <CloseIcon />
        </button>
        )}
      </div>
      )}
      {/* Right-edge status rail — COARSE pointers, non-ghost rows only (on
          fine pointers the hover cluster above owns the right edge and no
          rail exists): a 56px recessed inset band giving the flyout gesture
          a visible, learnable home — ONE continuous strip down the tree,
          shared with the session-row and server-group rails. It is the sole
          coarse tap/scrub target: pointerdown opens the card + captures the
          pointer, a slide retargets via the shared registry, release keeps
          the last card. `touch-none` keeps a press-and-slide here from
          scrolling the drawer; the click stopPropagation keeps a rail tap
          from selecting the row. Two FIXED slots column-align down the
          sidebar: a 16px PR-glyph slot (an empty span when the row owns no
          PR — on coarse the glyph lives HERE, not in the fine-pointer
          overlay) and a 12px chevron hint on EVERY row (a consistent rail is
          a learnable rail). While this row's card is open the rail carries
          the held treatment (band a shade up, brightened seam — `railStyle`).
          Static per-render content only (its inputs are row props/
          derivations) — no subscriptions, no ticks. */}
      {coarse && !ghost && (
        <span
          data-testid="status-rail"
          className="absolute right-0 top-0 bottom-0 z-10 flex items-center justify-end gap-0.5 border-l border-border bg-bg-inset pr-1 touch-none"
          style={{ width: STATUS_RAIL_WIDTH_PX, ...railStyle }}
          {...scrub.handlers}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 16px PR-glyph slot — the empty span holds the column when the
              row owns no PR, so the chevron never shifts sideways. */}
          <span className="flex w-4 shrink-0 items-center justify-center">
            {prOwnsGlyph(win) && (
              <span
                aria-hidden="true"
                data-testid="row-pr-glyph"
                className={`flex items-center justify-center pointer-events-none ${prGlyphColor(win)}`}
              >
                {prGlyphIcon(win)}
              </span>
            )}
          </span>
          {/* 12px chevron hint — aria-hidden decoration (the Icon-System
              no-text-glyph rule governs ACTION icons; this is a static
              affordance hint), muted at ~55%. */}
          <span
            aria-hidden="true"
            className="flex w-3 shrink-0 items-center justify-center text-text-secondary opacity-55"
          >
            ›
          </span>
        </span>
      )}
      {showPinPopover && server && (
        <PinPopover
          server={server}
          windowId={win.windowId}
          boards={boards}
          boardsLoading={boardsLoading}
          isPinnedTo={(b) => (isPinnedToBoard ? isPinnedToBoard(b, srv, win.windowId) : false)}
          pinnedBoard={pinnedBoard}
          onNavigateToBoard={onNavigateToBoard}
          onClose={() => setShowPinPopover(false)}
        />
      )}
      {showLabelPicker && onColorChange && (
        // Color + flair picker anchored at the row's
        // BOTTOM-LEFT (twin of the shipped right-anchored color popover). The
        // row root stays overflow-free so this `top-full` popover is not
        // clipped.
        <div className="absolute left-0 top-full z-50">
          <SwatchPopover
            selectedColor={color}
            rowName={win.name}
            // Selection does NOT close (the picker's dismissal contract) — the
            // user can adjust both axes and watch the row update
            // live. Dismissal is the picker's ✕ / outside click / Escape.
            onSelect={(c) => onColorChange(srv, session, win.windowId, c)}
            selectedFlair={win.flair}
            onSelectFlair={
              onFlairChange
                ? (f) => onFlairChange(srv, session, win.windowId, f === "" ? null : f)
                : undefined
            }
            onClose={() => setShowLabelPicker(false)}
          />
        </div>
      )}
      {/* Row-hover register flyout card (93dy) — portalled to document.body,
          mounted ONLY while open (perf contract). */}
      {flyout.card}
    </div>
  );
}

/** Memoized window row. Re-renders only when its own props change identity —
 *  an SSE tick on an unrelated server, or the per-second clock tick (now scoped
 *  to the `WindowDuration` leaf below), no longer re-renders the whole row.
 *  Prop stability is the parent's responsibility: `index.tsx` passes
 *  identity-arg `useCallback`s + stable context refs. */
export const WindowRow = memo(WindowRowInner);

/* Row Minimalism (260706-y1ar): the `WindowDuration`/`TickingDuration` leaves
   (and their per-second `useNow()` tick) were removed with the trailing status
   cluster — the row renders no duration. Idle/elapsed durations now live only in
   the row-hover flyout card (row-flyout-card.tsx, whose clocks are leaf-scoped
   inside the open card) and the PANE panel's register view. This also drops the
   last `getWindowDuration` caller (removed from lib/format.ts). */
