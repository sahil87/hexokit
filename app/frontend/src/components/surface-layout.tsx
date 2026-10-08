import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { Tip } from "@/components/tip";
import { controlClass } from "@/components/control";
import { TerminalClient } from "@/components/terminal-client";
import { FindBar } from "@/components/find-bar";
import { CodeSurface } from "@/components/code-surface";
import { ReviewSurface, type ReviewSurfaceCommands } from "@/components/review-surface";
import { WorkingSurface } from "@/components/working-surface";
import { IframeWindow } from "@/components/iframe-window";
import { StatusDot } from "@/components/status-dot";
import { DEFAULT_DARK_THEME, type ThemePalette } from "@/themes";
import {
  TERMINAL_FIND_OPEN_EVENT,
  TERMINAL_FIND_SCOPE_NOTE,
  buildSearchOptions,
  runFind,
} from "@/lib/terminal-find";
import {
  SURFACE_GLYPH,
  SURFACE_LABEL,
  leafIds,
  leaves,
  layoutRects,
  readStoredSizes,
  readStoredZoom,
  serializeLayoutTree,
  structureSig,
  writeStoredSizes,
  writeStoredZoom,
  zoomLeafKind,
  NOMINAL_BOX,
  SPLIT_GAP_PX,
  type Layout,
  type LayoutSizes,
  type Rect,
  type SurfaceKind,
} from "@/lib/surface-layout";
import {
  isLeaf,
  layoutDividers,
  parseLeafAddress,
  sizesOf,
  templateSizes,
  type DividerLine,
  type LayoutLeaf,
  type LayoutNode,
  type SplitDir,
} from "@/lib/layout-tree";
import {
  DRAG_THRESHOLD_PX,
  hitTest,
  resolveDrop,
  zoneRegion,
  type DropHit,
  type DropResult,
} from "@/lib/layout-drop";
import { WINDOW_DRAG_MIME } from "@/components/sidebar/boards-section";
import { SurfacePlaceholder } from "@/components/surface-placeholder";
import { clampSiblingFraction } from "@/lib/right-panel";
import { TileDragContext } from "@/lib/tile-drag-context";
import { codeRootFollowTarget, codeRootFor } from "@/lib/code-folder-latch";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useOccludes } from "@/hooks/use-occludes";
import type { CodeFollowSrc } from "@/hooks/use-code-workspace";
import type { GuiSignal } from "@/contexts/session-context";
import type { GuiPointerMode, GuiQuality, GuiZoom } from "@/lib/gui-posture";
import type { GuiRestartResult, GuiSurfaceCommands } from "@/components/gui-surface";
import { GuiToolbar } from "@/components/gui-toolbar";
import type { GuiPaletteAction } from "@/lib/palette/gui";

// noVNC's core is ~150 KB min — the gui tile lazy-loads so tabs that never
// open it pay nothing.
const GuiSurface = lazy(() => import("@/components/gui-surface"));
import {
  disarmGuard,
  focusMemoryKey,
  isGuardArmed,
  recallFocus,
  recordFocus,
} from "@/lib/focus-memory";
import {
  ClosePaneBoxedGlyph,
  ExportGlyph,
  FindGlyph,
  FollowTerminalGlyph,
  FullscreenGlyph,
  KeyboardGlyph,
  PopOutGlyph,
  RefreshGlyph,
  SendHomeGlyph,
  SplitHorizontalGlyph,
  SplitVerticalGlyph,
  TileCloseGlyph,
  ZoomGlyph,
} from "@/components/top-bar-icons";
import type { ViewWindow } from "@/lib/window-view";
import { activeWebUrl } from "@/lib/window-view";
import { useKeybindings } from "@/hooks/use-keybindings";
import { formatCombo } from "@/lib/keybindings";
import {
  IDLE_PROGRESS,
  isValuedProgress,
  reduceProgress,
  type TtyProgress,
} from "@/lib/tty-progress";
import { classifyAddress, displayForm, proxyPortOf, toWebAddTarget } from "@/lib/web-url";
import { canShellPopout } from "@/lib/shell";
import type { WindowInfo } from "@/types";
import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { copyToClipboard } from "@/lib/clipboard";
import {
  addWebTab,
  fetchWindowHistory,
  moveWebTab,
  removeWebTab,
  selectWebTab,
  setWindowOptions,
} from "@/api/client";
import type { CodeBridgeResult, CodeServerRestartResult } from "@/api/client";
import { useToast } from "@/components/toast";
import { useOptimisticAction } from "@/hooks/use-optimistic-action";
import {
  entryKey,
  useWindowStore,
  webFamilyAfterRemove,
  webFamilyAfterMove,
  type WebTabOverride,
} from "@/store/window-store";
import {
  EXPORT_EVENT,
  buildExportFilename,
  downloadTextFile,
  transcriptFromBuffer,
  visibleScreenText,
  wrapHtmlSnapshot,
  type ExportAction,
} from "@/lib/terminal-export";

/**
 * SurfaceLayout — the tile renderer for the terminal route's center (spec
 * docs/specs/surface-layout.md § The Model, § Verbs). Replaces the legacy
 * exclusive-lens render branch AND the right-panel surface slot: the resolved
 * layout — a canonical split TREE (`lib/layout-tree.ts`) — renders as 1–N
 * TILES (offers gated by the per-viewport size floor), each mounting an
 * EXISTING renderer unchanged — `TerminalClient`
 * (tty), `IframeWindow` (web), `CodeSurface` (code), `GuiSurface` (gui —
 * lazy-loaded: noVNC's ~150 KB core is paid only by tabs that open the tile).
 * A tile may also point at ANOTHER tab's surface (a foreign leaf, `@N/<kind>`
 * — see the duplicate/foreign bullet below), and a bare leaf whose surface is
 * live in another tab renders the AWAY PLACEHOLDER instead of mounting the
 * surface.
 *
 * - **Flat rect-positioned leaves**: every leaf of the tree renders as an
 *   absolutely positioned tile in ONE flat sibling list keyed by leaf id,
 *   placed from `layoutRects(tree, containerBox, sizes, SPLIT_GAP_PX)` over a
 *   ResizeObserver-measured container (NOMINAL_BOX proportions until the first
 *   measure, so an unmeasured jsdom mount still lays out sanely). A
 *   restructure never unmounts or re-keys a surviving tile — an iframe
 *   re-parent/reload is the hazard this avoids.
 * - **Tile chrome (R7, redesigned in 260812-wfic; gap-seam 260814-011r)**: the
 *   desktop layout floats tiles as cards — 6px gutters (the SPLIT_GAP_PX seam
 *   between sibling rects), each tile a 6px-radius card (`rounded-md`) whose
 *   REST border is the dimmed
 *   `rk-card-border` (a 55% color-mix: the gap does the separating, the border
 *   only defines the card edge). The outer 6px ground inset and the
 *   `bg-bg-inset` ground itself are provided by the Shell STAGE
 *   (260814-ldbs) — this container ceded its own `p-[6px]`/`bg-bg-inset` so
 *   the tiles and the rail card share ONE continuous ground. Each tile carries
 *   a 35px header painted on the tile's own `bg-bg-primary` surface (32px
 *   content + 3px bottom rule, aligned with the sidebar rail's
 *   `border-t-[3px]` seam) — the rule separates header from content, never a
 *   second surface color, so header, content and compose strip read as one
 *   well inside the chrome frame; its verb hovers and meta chip use
 *   `bg-bg-card`, the one step above that surface —
 *   kind glyph (`SURFACE_GLYPH`) + surface name + the small meta as an inset
 *   chip (code-root basename for code, the active web tab's host for web) — with
 *   rest-visible boxed verb buttons (24×24, 26×26 coarse; 14px SVG glyphs
 *   from the `top-bar-icons.tsx` register): zoom and ✕ close (a hairline rule
 *   separates ✕ from the safe verbs; its hover turns `text-signal-red`).
 *   While a tile is zoomed its zoom verb stays `accent-green`.
 *   Single-leaf layouts render NO layout verbs (closing the last tile is
 *   disallowed and zooming one tile is meaningless). The tty header also mounts the
 *   shared `StatusDot` (agent state) when the parent passes `statusWindow`.
 *   Tty headers additionally carry a bordered PANE SEGMENT (260813-w1lf
 *   content verbs — Split H · Split V · Close Pane) at ANY arity, including
 *   the bare `tty` leaf, and visible while zoomed; a hairline separates it
 *   from the layout-verb cluster when that renders. Its verbs call the
 *   parent's `onSplitPane`/`onClosePane` callbacks. The code tile carries the
 *   same per-kind content-verb structure: Follow terminal (only while the
 *   latched code root drifts from the live derivation — the verb's presence IS
 *   the drift indicator) and Reload editor (only while the active window's
 *   frame is mounted), before the layout-verb cluster; both are
 *   palette-registered through `codeCommandsRef` (Constitution V).
 * - **Header drag — drop to snap**: a primary-button press on a tile header's
 *   background (never its buttons, pane segment, code verbs, meta chip, or
 *   menus) arms a drag; past DRAG_THRESHOLD_PX the header captures the
 *   pointer and the drag snapshots the tree, sizes, layout box, and leaf
 *   rects. Hit-testing (`lib/layout-drop.ts`) offers the hovered tile's center
 *   (swap), its edge bands (split beside), and the layout box's outer 18px
 *   (span a side at 50%); the overlay previews the RESULT tree at the
 *   viewer's sizes (the dragged destination filled accent-green), marks a
 *   same-arrangement drop "no change", and refuses a drop that breaks the
 *   150×100 floor with a red "too small". Release on a `move` commits exactly
 *   one write: the viewer's sizes under the new structure signature, then
 *   `onApplyLayout(result.tree)` (the parent's ONE mutation path); focus
 *   lands on the dragged tile's new position. Escape, release outside/over
 *   the dragged tile, `pointercancel`, a window switch, and a mid-drag
 *   `layout` prop change (a stale snapshot) all cancel with no write. The
 *   drag never arms on a coarse pointer, a zoomed render, or a single-leaf
 *   layout (and the mobile branch renders one tile). The native web engine
 *   hides its guest for the drag's duration (the `move` posture — the overlay
 *   cannot paint over a composited WebContentsView).
 * - **Focused tile (260812-wfic R2)**: transient component state — the LEAF
 *   that last received pointer/keyboard interaction (pointerdown-capture +
 *   focusin seams on the tile wrapper for parent-DOM interaction; the iframe
 *   tiles — `CodeSurface`, `IframeWindow` — report in-frame interaction via
 *   `onInteract`, since no parent-document event fires when focus enters
 *   iframe content). The focused tile's border
 *   and kind glyph turn `accent-green` (the tmux active-pane metaphor);
 *   suppressed at arity 1. Default = the first leaf in reading order; falls
 *   back there when the focused leaf leaves the layout. The focused KIND is
 *   reported upward via `onFocusedKindChange` (app.tsx mirrors it for the
 *   `ttyOnly` shortcut gate), the focused leaf id via `onFocusedLeafChange`
 *   (the palette's directional swaps act on the focused leaf), and focus is
 *   settable by kind through the `focusTileRef` seam (the `zoomToggleRef`
 *   pattern — the palette's `Tile: Focus <Surface>`, first leaf of the kind).
 * - **Zoom (R6)**: one tile full-center, the others hidden at display level.
 *   Per-viewer state, persisted as the zoomed LEAF ID under
 *   `rk-layout-zoom:{server}:{@N}` (the mobile switch group reads the same
 *   key; its kind writes double as a unique bare leaf's id, and an exact id
 *   that left the tree resolves to its kind's first leaf); the toggle renders
 *   only when arity > 1.
 * - **Hide-never-unmount (P3)**: a leaf opened earlier this route visit stays
 *   mounted (`hidden` class) when closed or zoomed away, so iframe /
 *   terminal state survives. The "ever opened" bookkeeping is keyed by leaf
 *   id and is per-window — `app.tsx` keys this component by server, so the set
 *   (with the other per-window transient state) resets via the
 *   `[server, windowId]` reset effect on a window switch.
 * - **Code-frame retention (the P3 cross-window half)**: the `code` tile
 *   additionally survives a same-server WINDOW switch — the component keeps a
 *   per-server ordered list of live frame records (`{windowId, src, root}`,
 *   most-recently-shown last), rendering every non-active record as a
 *   display-hidden tile (`hidden` class, never `visibility`/off-screen) and
 *   evicting on overflow (cap 3 desktop / 1 mobile), window kill, non-follow
 *   root divergence, or a reachability true→false flip. An iframe unmount is
 *   a page unload — code-server disposes the connection and kills the
 *   workbench's extension host (~250–320 MB each, hence the bound), and a
 *   fresh boot costs seconds while a display-hidden frame re-shows in ~16 ms.
 * - **Dividers**: one divider per adjacent sibling pair of every split
 *   (`layoutDividers`), rendered in the 6px gutter with a 14px hit zone
 *   centered on the seam. Drag mutates SIZES only (never the tree): the
 *   pointer position maps to the FIRST sibling's fraction of the pair's
 *   combined extent, clamped via `clampSiblingFraction` (280px floor both
 *   sides on the divider's own axis), the pair's sum held constant, and the
 *   full sizes persist per (window, structure signature) ON RELEASE ONLY.
 *   Tiles stay live mid-drag — no suspension/unmount (the board pane-resize
 *   bug class); tile content gets `pointer-events: none` so iframes cannot
 *   swallow pointermove (the RightPanel drag-handle pattern). The chrome is
 *   the gap-seam three-state treatment (`rk-divider`/`rk-sash`/`rk-grips` in
 *   globals.css): 3 rest grip dots, a rounded accent-green sash pill on hover
 *   (~150ms anti-flicker delay) and drag (immediate). Where a divider's end
 *   meets a perpendicular divider, a `surface-divider-intersection` zone
 *   lights BOTH sashes on hover and drags BOTH fraction pairs at once (each
 *   clamped on its own axis), persisted on release.
 * - **Duplicate and foreign tty tiles**: the muxed relay supports N clients
 *   per pane, so two bare tty tiles are legal (`tty`, `tty#2` by
 *   reading-order occurrence), and a foreign leaf (`@12/tty`) tiles ANOTHER
 *   window's terminal — its relay stream opens with the home window id and
 *   `isolate: true` (the `_rk-iso-*` attach, never fighting the home tab).
 *   Only the FIRST BARE tty leaf in reading order receives the shared
 *   `wsRef`/`focusRef` holder (a foreign tty never takes it); every tty tile
 *   mounts its own stream bucket, and the FOCUSED tty tile — bare or foreign
 *   — registers as the shell's focused terminal with its own
 *   server/session/window/wsRef, so the compose strip, bottom bar, and focus
 *   memory follow the tile the user is in.
 * - **Away placeholder**: a BARE leaf whose kind is named by the route
 *   window's server-derived `awayIn` (a live holder exists) renders
 *   `SurfacePlaceholder` INSTEAD of the surface — the mount is gated, so an
 *   away tty opens no relay stream. The placeholder carries bring back (the
 *   parent's `onSendHome` with from = the holder), go to the holder
 *   (`onGoToWindow`), the tty status dot, and ✕ (hidden when it is the only
 *   leaf — a layout never renders empty). A foreign tile's header identifies
 *   its home tab (name chip) and carries a ↩ verb (`onSendHome` with from =
 *   the route window), disabled while the home window is dead.
 * - **Popout (per viewer)**: a tile can pop out into its own browser window —
 *   the opener's parent hands the REDUCED tree (popped minus revealed) plus
 *   this viewer's popped leaf ids (`popped`), which disarm the header drag (a
 *   drop resolved on the reduced tree would drop the popped leaf from the
 *   SHARED layout), unzoom a popped zoomed leaf, and evict a popped code
 *   leaf's retained frame (the popout boots its own extension host). A
 *   REVEALED popped leaf (`revealedPoppedIds`) stays in the rendered tree and
 *   mounts the popped `SurfacePlaceholder` under the away placeholder's mount
 *   gate (no header, no surface mount — the popout owns the live surface).
 *   The header's Pop out verb sits in
 *   the content-verb family ahead of the layout-verb cluster. The popout
 *   window itself mounts this component with `popoutLeafId` on a one-leaf
 *   tree: chrome-less, the layout-verb cluster replaced by a single Pop back
 *   in verb, and a tty tile's relay stream opening with `isolate: true` (the
 *   `_rk-iso-*` attach — the popout keeps its window while the opener's
 *   session switches windows).
 * - **Sidebar row-drag borrow**: a window-row HTML5 drag (WINDOW_DRAG_MIME)
 *   in flight arms a drop-catcher overlay above all tiles — window-level
 *   dragstart/dragend listeners (the payload is readable at dragstart), the
 *   header drag's mid-drag seam, and the external-leaf mode of
 *   `hitTest`/`resolveDrop`. Edge zones insert `@<dragged>/tty` and commit
 *   through `onBorrowDrop` (the parent's borrow helper); the center zone and
 *   the refused drops (route window's own row, address already in the layout,
 *   cross-server) preview "no change" and write nothing.
 *
 * Presentational by contract (the view-switcher/right-panel precedent): the
 * tree lives in `app.tsx` and arrives as the `layout` prop; verbs call the
 * parent's callbacks (`onClose` addressed by LEAF ID, `onApplyLayout` handed
 * the drop's result tree), which run the pure mutations + persistence/URL
 * mirroring. The component owns
 * only transient interaction state: zoom, the in-flight drags, and the
 * mount-once bookkeeping.
 */

/** Human labels for the tile header + verb aria-labels live in
 *  `lib/surface-layout.ts` (`SURFACE_LABEL` — shared with the surface
 *  toggles, palette, and mobile switch group so none drift). */

/** Live code-frame retention caps (measured: each live frame is one
 *  ~250–320 MB extension-host process on the server plus a browser renderer).
 *  The cap counts the ACTIVE window's frame; a pending tile (src unresolved)
 *  has no frame and never counts. Mobile keeps one frame — the narrow-or-
 *  coarse `isMobile` prop selects. */
const CODE_FRAME_CAP_DESKTOP = 3;
const CODE_FRAME_CAP_MOBILE = 1;

/** A retained code frame — one live `CodeSurface` instance. `src` is the
 *  creation-time mount src: the frame's identity and React key, never
 *  rewritten (a follow re-navigates the LIVE frame through the `followSrc`
 *  nonce, and the mount-generation rule pins the iframe's src anyway).
 *  `root` is the eviction baseline — the window's `codeRootFor` at creation,
 *  moved in place by a follow so the payload's codeRoot update never reads as
 *  a divergence. */
interface CodeFrameRecord {
  windowId: string;
  src: string;
  root: string;
}

/** The code tile's imperative verbs, filled into `codeCommandsRef` while the
 *  active window's code tile is open (the `guiCommandsRef` precedent) — the
 *  palette's `Code:` rows run the same bodies as the header verbs. */
export interface CodeTileCommands {
  followTerminal: () => void;
  reload: () => void;
}

/** Split a leaf id into kind + occurrence (+ home for a foreign leaf): an
 *  address id (`@12/tty`) yields the address's kind and home; a bare id is
 *  the kind itself for a unique kind, `tty`, `tty#2`, … by reading-order
 *  occurrence for duplicate tty leaves. */
function leafIdParts(leafId: string): { kind: SurfaceKind; occ: number; home?: string } {
  const foreign = parseLeafAddress(leafId);
  if (foreign !== null) return { kind: foreign.kind, occ: 0, home: foreign.home };
  const kind = zoomLeafKind(leafId) ?? "tty";
  const hash = leafId.indexOf("#");
  const n = hash < 0 ? 1 : Number(leafId.slice(hash + 1));
  return { kind, occ: Number.isFinite(n) && n >= 1 ? n - 1 : 0 };
}

/** The window a tile's surface belongs to (the tile's OWN window): a foreign
 *  leaf's home window, the route window for a bare leaf. Every per-tile
 *  read/write — relay stream, focus registration, progress slot, web tabs,
 *  code root — targets this window, never implicitly the route's. */
function tileWindowIdOf(leafId: string, routeWindowId: string): string {
  return leafIdParts(leafId).home ?? routeWindowId;
}

/** Resolve a stored zoom leaf id to a live leaf: the exact id when the leaf
 *  survives, else the kind's first leaf in reading order (a shared restructure
 *  moves the zoom with its surface), else null (the zoom clears). */
function resolveZoomLeaf(layout: LayoutNode, stored: string): string | null {
  const ids = leafIds(layout);
  if (ids.includes(stored)) return stored;
  const i = leaves(layout).indexOf(leafIdParts(stored).kind);
  return i >= 0 ? ids[i] : null;
}

/** One tile entry: a visible leaf, an ever-opened-but-closed leaf id, or a
 *  retained code frame from a non-active window (all rendered through the
 *  same flat list so the visible↔hidden transition never remounts). */
interface TileModel {
  kind: SurfaceKind;
  /** The leaf id of a visible tile, or the id a hidden tile last held (a
   *  re-opened leaf reclaims it — unique kinds keep their kind as id). */
  leafId: string;
  /** Duplicate-tty occurrence (0 for the first/only), driving the testid and
   *  key suffixes. */
  occ: number;
  /** True when the leaf is in the current tree (hidden/retained entries are
   *  not — the old `slot >= 0` gate). */
  visible: boolean;
  /** The frame this tile renders (code tiles only): the active window's
   *  record when one exists, or a retained record for a non-active window.
   *  Undefined ⇒ the active window's code tile with no record yet. */
  frame?: CodeFrameRecord;
}

/** The render's concrete per-split fractions (pre-order): the override where
 *  it is well-shaped for its split, else the split's own sizes, else equal
 *  shares — `layoutRects`' per-split fallback, materialized so a drag always
 *  has a full array to edit. */
function resolveSizes(tree: LayoutNode, override: LayoutSizes | undefined): LayoutSizes {
  const out: LayoutSizes = [];
  const walk = (n: LayoutNode): void => {
    if (isLeaf(n)) return;
    const o = override?.[out.length];
    out.push(
      o !== undefined &&
        o.length === n.children.length &&
        o.every((f) => Number.isFinite(f) && f > 0)
        ? [...o]
        : [...sizesOf(n)],
    );
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/** Per-divider drag frame, in `layoutDividers`' enumeration order: the
 *  split's pre-order sizes index, the boundary (index of the child AFTER the
 *  divider), and the joined pair's geometry on the split axis — the pair's
 *  start and its combined child extent in px (the gutter between the two
 *  siblings excluded), the drag math's coordinate frame. */
interface DividerFrame {
  splitIndex: number;
  boundary: number;
  dir: SplitDir;
  start: number;
  len: number;
}

/** Same walk as `layoutDividers` (child order, pre-order sizes indexing), so
 *  frame i always describes divider i. `sizes` must be the RESOLVED sizes
 *  (every split present). */
function dividerFrames(
  tree: LayoutNode,
  box: Rect,
  sizes: LayoutSizes,
  gap: number,
): DividerFrame[] {
  const frames: DividerFrame[] = [];
  let si = 0;
  const walk = (n: LayoutNode, b: Rect): void => {
    if (isLeaf(n)) return;
    const fractions = sizes[si];
    const index = si;
    si++;
    const horiz = n.dir === "h";
    const avail = (horiz ? b.w : b.h) - gap * (n.children.length - 1);
    let at = horiz ? b.x : b.y;
    let prevLen = 0;
    n.children.forEach((k, i) => {
      const len = avail * fractions[i];
      if (i > 0) {
        frames.push({
          splitIndex: index,
          boundary: i,
          dir: n.dir,
          start: at - gap - prevLen,
          len: prevLen + len,
        });
      }
      walk(
        k,
        horiz ? { x: at, y: b.y, w: len, h: b.h } : { x: b.x, y: at, w: b.w, h: len },
      );
      prevLen = len;
      at += len + gap;
    });
  };
  walk(tree, box);
  return frames;
}

interface SurfaceLayoutProps {
  /** The RESOLVED layout tree (app.tsx ran the parse + degradation). */
  layout: Layout;
  server: string;
  /** The route window id (`@N`). */
  windowId: string;
  /** True when the current `windowId` was reached by a UI-initiated switch
   *  (a pending click intent targets it). Forwarded to the tty tile as
   *  `clearOnRide`: only a UI-initiated same-session ride arms the deferred
   *  buffer clear — on a tmux/SSE-driven switch the attached client has
   *  already redrawn the new window BEFORE the URL followed, so a clear armed
   *  then would wipe painted content on its next chunk. */
  clearOnWindowChange?: boolean;
  sessionName: string;
  /** The SSE-derived window record — tile meta + renderer props (web URL,
   *  code root) narrow from it; an unavailable kind renders an empty tile body
   *  (degradation should already have dropped it). */
  window: ViewWindow | null;
  /** The route server's windows by id (payload-derived) — a FOREIGN leaf's
   *  tile resolves its home window's record from this map (name, status dot,
   *  code root, web tabs); a home absent from the map is dead. */
  windowsById?: ReadonlyMap<string, WindowInfo>;
  /** The owning session name per window id on the route server
   *  (payload-derived) — a foreign tile's TerminalClient connects under its
   *  HOME session and registers focus with it. Absent ⇒ foreign tiles fall
   *  back to the route session name. */
  sessionNameByWindowId?: ReadonlyMap<string, string>;
  /** Below `isMobileViewport()` only ONE leaf renders (R13) — no dividers, no
   *  verb chrome. `mobileActiveSlot` picks WHICH leaf (its index in reading
   *  order): the top-bar switch group swaps the shown surface via the
   *  per-viewer zoom key WITHOUT mutating the shared layout for an
   *  already-open surface (the layout stays desktop's arrangement).
   *  Absent/out-of-range → leaf 0. */
  isMobile: boolean;
  mobileActiveSlot?: number;
  /** Shared terminal plumbing — handed to the FIRST tty leaf only. */
  wsRef: React.MutableRefObject<WebSocket | null>;
  focusRef: React.MutableRefObject<(() => void) | null>;
  scrollLocked: boolean;
  onSessionNotFound: () => void;
  /** Host code-server reachability — selects the code tile's CONTENT (live
   *  iframe vs not-running empty state), never availability. */
  codeReachable: boolean;
  /** The host-global gui signal — selects the gui tile's CONTENT (live canvas
   *  vs the enabled-but-unreachable empty state); availability is the
   *  signal's `enabled`, applied upstream by the layout degradation. */
  gui?: GuiSignal | null;
  /** Per-viewer gui postures (app.tsx owns the localStorage-backed state).
   *  `guiPointerMode` falls back to the pointer-class default (trackpad on
   *  coarse, touch on fine) when absent; `guiQuality` defaults to
   *  `"balanced"`, `guiStatsVisible` to hidden. */
  guiZoom?: GuiZoom;
  guiPointerMode?: GuiPointerMode;
  onGuiZoomChange?: (z: GuiZoom) => void;
  onGuiPointerModeChange?: (m: GuiPointerMode) => void;
  /** HiDPI (`rk-gui-hidpi`) and key-bar visibility (`rk-gui-keybar`) postures
   *  — both default to today's behavior (off / shown). */
  guiHidpi?: boolean;
  guiKeyBarVisible?: boolean;
  onGuiKeyBarVisibleChange?: (visible: boolean) => void;
  /** The gui header fold's `⚙` panel open state (`rk-gui-toolbar`, owned by
   *  app.tsx) and its seam. */
  guiToolbarVisible?: boolean;
  onGuiToolbarVisibleChange?: (visible: boolean) => void;
  /** The keyboard-capture latch (`rk-gui-capture`, owned by app.tsx) — while
   *  set, the gui header's meta chip reads `keys → desktop` and the pinned
   *  block's capture verb latches. */
  guiCapture?: boolean;
  /** The web tile's keyboard-capture latch (`rk-web-capture`, owned by
   *  app.tsx) — while set, the web header shows a `keys → page` chip and its
   *  capture verb latches; both web engines hand every chord but the release
   *  binding to the page. */
  webCapture?: boolean;
  /** Flip the web capture latch (the header verb's click seam). Absent ⇒ the
   *  verb is not rendered. */
  onWebCaptureChange?: (on: boolean) => void;
  guiResizeLocked?: boolean;
  guiQuality?: GuiQuality;
  guiStatsVisible?: boolean;
  onGuiQualityChange?: (q: GuiQuality) => void;
  onGuiStatsVisibleChange?: (visible: boolean) => void;
  /** RFB connection report — app.tsx folds it into the toggle dot. */
  onGuiConnection?: (connected: boolean) => void;
  /** Restart supervisor verb for the gui empty state (POSTs the restart
   *  route; a 409 arrives as `{ ok: false, disabled: true }`). */
  onGuiRestart?: () => Promise<GuiRestartResult>;
  /** The code lens empty state's Restart code-server action (app.tsx passes
   *  the API client's `restartCodeServer`). Absent ⇒ no button. */
  onCodeServerRestart?: () => Promise<CodeServerRestartResult>;
  /** Open the supervisor logs (navigates to the rk-gui pane). */
  onGuiOpenLogs?: () => void;
  /** Filled with the gui tile's imperative seams (paste/reconnect) while an
   *  RFB is live — the palette's `GUI:` verbs drive them. */
  guiCommandsRef?: { current: GuiSurfaceCommands | null };
  /** The memoized `buildGuiActions` output app.tsx feeds the palette (the
   *  zen-fallback description patch included) — the gui tile's header fold
   *  mirrors it by row id. */
  guiActions?: GuiPaletteAction[];
  /** The review tile's imperative verb seams (the palette's `Review:` entries)
   *  and its unhandled-thread reporter (the surface toggle's dot). Absent on
   *  mounts that do not offer the surface. */
  reviewCommandsRef?: { current: ReviewSurfaceCommands | null };
  onReviewUnhandledChange?: (count: number) => void;
  onReviewListeningChange?: (listening: boolean) => void;
  /** Follow-the-editor passthrough (260813-if5d R3): handed straight to the code
   *  tile's `CodeSurface`, which reports the folder the EDITOR navigated itself
   *  to. The parent latches it — this component only carries the prop. A
   *  returned promise's REJECTION (the latch POST failed) clears the pending
   *  follow target the wrapper records at report time. */
  onCodeFolderNavigated?: (folder: string) => void | Promise<void>;
  /** Follow-terminal verb's parent half: re-seeds `@rk_win_code_root` from
   *  the live derivation and re-derives the workspace with the
   *  `degradeToFolder` posture — the verb's frame still sits on the OLD
   *  folder, unlike the editor-initiated follow. Rides the same
   *  `requestCodeFollow` wrapper as `onCodeFolderNavigated`, so the
   *  pending-follow target is recorded for it by construction; a returned
   *  promise's rejection clears that target (and re-enables the verb). */
  onCodeFollowTerminal?: (folder: string) => void | Promise<void>;
  /** Filled with the code tile's imperative verbs while the active window's
   *  code tile is open, cleared otherwise and on unmount (the
   *  `zoomToggleRef` pattern) — the palette's `Code: Follow Terminal` /
   *  `Code: Reload Editor` rows drive them (Constitution V). */
  codeCommandsRef?: React.MutableRefObject<CodeTileCommands | null>;
  /** Filled with a getter returning the CURRENT leaf-id→Rect map (latest
   *  measured container + live sizes, NOMINAL_BOX before the first measure),
   *  cleared on unmount (the `codeCommandsRef` refill pattern) — app.tsx's
   *  add/directional-swap verbs read their real geometry through it. */
  layoutRectsRef?: React.MutableRefObject<(() => Map<string, Rect>) | null>;
  /** Per-window lookup over the parent's resolved srcs (the hook's map): the
   *  active window's src reads through it (null ⇒ the tile renders its
   *  pending state), so a revisit resolves synchronously. Retained frames
   *  never consult it — they read their record. The parent (app.tsx's
   *  layout-state block) owns the fetch — this component only carries the
   *  prop. */
  codeSrcFor?: (windowId: string) => string | null;
  /** The server's live window ids (payload-derived): a frame record whose
   *  window leaves the set (killed/closed) is evicted. Absent ⇒ no kill
   *  eviction. */
  liveWindowIds?: ReadonlySet<string>;
  /** The CURRENT code root of any live window (payload-derived) — the
   *  root-divergence eviction's comparison input. Absent ⇒ no root
   *  eviction. */
  codeRootForWindow?: (windowId: string) => string;
  /** The follow-navigation override: after the editor navigated ITSELF to a
   *  new folder, the parent re-derived the workspace URL and hands it down
   *  with a fresh nonce — the one sanctioned parent re-navigation. Carried
   *  straight to CodeSurface, and the nonce adoption moves the active frame
   *  record's eviction baseline (`root`) in place. Active-window only. */
  codeFollowSrc?: CodeFollowSrc | null;
  /** First-boot rescue's status-read seam, as a PER-WINDOW factory: a
   *  retained frame's verdict can fire after its window stopped being
   *  active, so each frame's fetcher binds the FRAME's window, not the
   *  active one. Absent ⇒ no rescue runs. */
  fetchBridgeStatusFor?: (windowId: string) => () => Promise<CodeBridgeResult>;
  /** Chord-reclaim predicate FACTORY (260819-ie2i R3): called with a tile's
   *  kind at each iframe mount to bind the kind-aware registry predicate —
   *  `case "code"` passes `shouldReclaimChord("code")` to CodeSurface
   *  (behavior unchanged), `case "web"` passes `shouldReclaimChord("web")` to
   *  IframeWindow. Each mount consults a predicate bound to its OWN kind,
   *  built from the one registry. */
  shouldReclaimChord?: (kind: SurfaceKind) => (e: KeyboardEvent) => boolean;
  /** Steal-guard revert seam (spec right-panel.md § The code lens): handed
   *  straight to the code tile's `CodeSurface`, which invokes it when focus
   *  lands inside the frame's document (the in-frame `focusin` — a script
   *  `focus()` grab fires no parent-side iframe event). The parent's callback
   *  decides — armed guard + remembered kind ≠ `code` ⇒ revert and return
   *  `true`; anything else ⇒ `false` (the focus stands). Absent ⇒ no guard. */
  onProgrammaticFocus?: () => boolean;
  /** Verb callbacks — the parent applies the pure tree mutation + persistence
   *  (R3 write discipline). Verbs address their tile by LEAF ID — duplicate
   *  tty tiles are distinct leaves. A disallowed close (the last leaf) is a
   *  null no-op in the parent's mutation. */
  onClose: (leafId: string) => void;
  /** The header drag-to-snap commit seam: a released drop whose resolution is
   *  a `move` calls this ONCE with the result tree (the parent's
   *  `applyLayout` — the one `@rk_win_layout` write path); the viewer's sizes
   *  for the new structure signature are already written when it fires. */
  onApplyLayout: (next: Layout) => void;
  /** Popout posture (spec surface-layout.md § Verbs → Pop out): this render
   *  IS the popout window — a one-leaf tree, chrome-less. The tile header
   *  replaces the layout-verb cluster (zoom/↩/✕) with a single Pop back in
   *  verb, and a tty tile's relay stream opens with `isolate: true`. */
  popoutLeafId?: string;
  /** The popout header's Pop back in verb — the parent's close seam (the
   *  popout posts `closed` and closes its window). */
  onPopBackIn?: () => void;
  /** Opener posture: this viewer's popped leaf ids for the window. A popped
   *  leaf is absent from the RENDERED tree unless revealed (the parent reduced
   *  it by `popped − revealedPoppedIds`), so here
   *  the set governs what the reduction hides: header drag stays disarmed
   *  while any leaf is popped (a drop resolved on the reduced tree would drop
   *  the popped leaf from the SHARED layout for every viewer), a popped
   *  zoomed leaf renders unzoomed, and a popped code leaf's retained frame is
   *  evicted (one extension host, not two — the popout boots its own). */
  popped?: string[];
  /** The header's Pop out verb (content-verb family, before the layout
   *  cluster). Absent ⇒ not offered (the caller gates mobile, coarse
   *  pointers, and a desktop shell without the `windows.popout` channel). */
  onPopOut?: (leafId: string, rect?: Rect) => void;
  /** Opener posture: the REVEALED subset of `popped` — the popped leaves this
   *  viewer asked to see. A revealed leaf stays in the rendered tree and
   *  mounts the popped `SurfacePlaceholder` INSTEAD of its surface (the away
   *  placeholder's mount gate: no header, no relay stream, no code frame, no
   *  web guest — the popout owns the live surface), and gets no hidden-tile
   *  retention entry. */
  revealedPoppedIds?: string[];
  /** The popped placeholder's bring back verb — the parent's popIn. */
  onPopIn?: (leafId: string) => void;
  /** The popped placeholder's go to window verb — focuses the live popout
   *  without reloading it. */
  onFocusPopout?: (leafId: string) => void;
  /** The popped placeholder's ✕ — removes the leaf from the revealed set
   *  only (never a layout close). */
  onHidePopped?: (leafId: string) => void;
  /** Send a held surface back to its home window (the parent's `sendHome` —
   *  `POST /api/layout/return`): the placeholder's bring back passes
   *  from = the HOLDER, the foreign tile header's ↩ passes from = the ROUTE
   *  window. `leafAddr` is the leaf's address (`@3/tty`). Absent ⇒ those
   *  verbs render disabled. */
  onSendHome?: (from: string, leafAddr: string) => void;
  /** Navigate to another tab's route — the placeholder's "go to <holder>". */
  onGoToWindow?: (windowId: string) => void;
  /** The sidebar row-drag borrow's commit seam (the parent's `borrowInto`):
   *  a drop whose resolution is a `move` calls this ONCE with the new leaf's
   *  address and the result tree; the viewer's sizes for the new structure
   *  signature are already written when it fires. */
  onBorrowDrop?: (leafAddr: string, tree: Layout) => void;
  /** Pane-segment callbacks (260813-w1lf content verbs — tty tiles only):
   *  the parent routes these through its `executeSplit`/`executeClosePane`
   *  optimistic actions (the palette split/close path). Both required for
   *  the segment to render. The second argument is the TILE's own window id
   *  (a foreign tty tile's home) — pane verbs act on the tile's window, never
   *  implicitly the route's. */
  onSplitPane?: (horizontal: boolean, tileWindowId: string) => void;
  onClosePane?: (tileWindowId: string) => void;
  /** Optional divider observers — fired during a drag (per move, with the
   *  divider's index in `layoutDividers` order and the FIRST sibling's
   *  percentage of its pair) and on release (commit). The component owns
   *  sizes state + persistence itself; these let a parent/e2e observe without
   *  owning anything. */
  onRatioChange?: (index: number, pct: number) => void;
  onRatioCommit?: () => void;
  /** ⏶ Zoom palette seam (T012/R11): zoom is component-owned state persisted
   *  to the per-viewer zoom key, but the palette's `Layout: Expand`/`Restore`
   *  entries must observe and trigger it. The component registers a
   *  FOCUSED-leaf zoom toggle into this ref (260819-qwr7 R7 — cleared on
   *  unmount) and reports zoom flips via `onZoomChange` so the palette list
   *  rebuilds. */
  zoomToggleRef?: React.MutableRefObject<(() => void) | null>;
  onZoomChange?: (zoomed: boolean) => void;
  /** Focused-tile reporting (260812-wfic R2): fired with the focused leaf's
   *  KIND whenever it changes (default: the first leaf in reading order).
   *  Arity-1 still reports — the shell's `ttyOnly` shortcut gate treats the
   *  bare `tty` leaf as tty-focused. */
  onFocusedKindChange?: (kind: SurfaceKind) => void;
  /** The focused-tile report's leaf half: fired alongside
   *  `onFocusedKindChange` with the focused LEAF ID — the palette's
   *  directional `Tile: Swap …` rows act on the focused leaf. */
  onFocusedLeafChange?: (leafId: string) => void;
  /** `Tile: Focus <Surface>` palette seam (260812-wfic R10): the component
   *  registers a focus-by-kind setter here (the FIRST leaf of that kind),
   *  cleared on unmount — the `zoomToggleRef` pattern. */
  focusTileRef?: React.MutableRefObject<((kind: SurfaceKind) => void) | null>;
  /** The SSE `WindowInfo` for the tty header's status dot (260812-wfic R6).
   *  The FULL record because `StatusDot` consumes `WindowInfo` — the `window`
   *  prop stays the pure-lib narrow `ViewWindow`. Null/non-tty → no dot. */
  statusWindow?: WindowInfo | null;
  /** In-tile compose-strip dock (260813-j3jb): an opaque node the parent
   *  (app.tsx) hands over when the strip belongs INSIDE the tile — the
   *  desktop terminal route's single-send mode. Rendered as the last child of
   *  the FIRST tty leaf's flex column (below the terminal body, inside the
   *  frame), so the target is self-evident and zoom/hide/close carries the
   *  strip for free; the flex column shrinks the terminal body, and the
   *  existing ResizeObserver fit refits — no new resize plumbing. The parent
   *  owns the whole dock decision (broadcast/board/mobile/no-tty → the shell
   *  footer instead); this component stays presentational and knows nothing
   *  about the strip. */
  ttyDockContent?: React.ReactNode;
  /** Active theme palette — the tty find bar's decoration colors derive from
   *  it. Optional with a default-theme fallback so provider-less harnesses
   *  (unit tests) still render. */
  themePalette?: ThemePalette;
}

/** Verb button chrome: fixed-size boxed buttons — 24×24 (WCAG 2.2 SC 2.5.8
 *  target minimum), 26×26 on coarse pointers (the Control primitive's `icon`
 *  variant fixed-size
 *  precedent: rendered size must not drift with content) — visible at rest at
 *  FULL opacity in `text-text-secondary` (contrast-passing over `bg-bg-card`
 *  in both themes; a rest-state alpha dim compounds against the ground and
 *  fails SC 1.4.11, so muted looks must be solid tokens tuned ≥3:1 per theme,
 *  never opacity). Hover gives an inset background + `text-text-primary`.
 *  Decomposed so latched verbs compose BASE + the ring-inset arm with NO
 *  competing hover utility (the Control primitive's `toggle` variant swaps the
 *  REST out):
 *
 *  - `VERB_BUTTON_BASE` — geometry, radius, transition. No color tokens.
 *  - `VERB_BUTTON_CLASS` — the default composition (base + hover) used by
 *    every plain verb. */
const VERB_BUTTON_BASE =
  "inline-flex items-center justify-center h-[24px] w-[24px] coarse:h-[26px] coarse:w-[26px] rounded transition-colors";
const VERB_BUTTON_CLASS = `${VERB_BUTTON_BASE} hover:bg-bg-card`;

/** Tty progress colors (260819-1vxq, design study state 03): green = running,
 *  red = error, amber = pause/warning — the existing signal-token vocabulary.
 *  The chip follows the web-kind badge idiom; the bar is the fill color. */
const PROGRESS_CHIP_CLASS = {
  determinate: "text-accent-green border-accent-green/40 bg-accent-green/10",
  error: "text-signal-red border-signal-red/40 bg-signal-red/10",
  paused: "text-signal-yellow border-signal-yellow/40 bg-signal-yellow/10",
} as const;
const PROGRESS_BAR_CLASS = {
  determinate: "bg-accent-green",
  error: "bg-signal-red",
  paused: "bg-signal-yellow",
} as const;

/** The resolution cache key for a hit: one resolver run per ZONE CHANGE, not
 *  per pointermove (a drag caches its resolution per hit kind + target +
 *  side). */
function dropHitKey(hit: DropHit | null): string {
  if (hit === null) return "none";
  switch (hit.kind) {
    case "self":
      return "self";
    case "root":
      return `root:${hit.side}`;
    case "center":
      return `center:${hit.targetId}`;
    case "edge":
      return `edge:${hit.targetId}:${hit.side}`;
  }
}

/** Small header meta (R7): the code root's basename for code, the active web
 *  tab's display form for web (the kind-specific pretty form — never throws,
 *  so a relative `/present/…`/`/proxy/…` address gets header meta too,
 *  260819-v6y4 R10), and `wm · display` for gui (the bare-WM state degrades
 *  to the display alone). The code root arrives via `codeRootFor` — the shared
 *  `@rk_win_code_root` — so the header names the folder the editor is actually
 *  in, never the pane the terminal happens to sit in. */
function tileMeta(kind: SurfaceKind, win: ViewWindow | null, gui?: GuiSignal | null): string | null {
  if (kind === "gui" && gui) {
    const parts = [gui.wm, gui.display].filter((part) => part !== "");
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  // The review tile's meta is the PR the surface is backed by — the one fact
  // that says WHICH pull request the tile is showing without opening it.
  if (kind === "review") {
    const prUrl = win?.prUrl ?? "";
    if (!prUrl) return null;
    const number = prUrl.split("/").pop() ?? "";
    return number ? `#${number}` : null;
  }
  // The working tile's meta is the repo whose tree it is showing.
  if (kind === "diff") {
    const root = win?.gitRoot ?? "";
    if (!root) return null;
    const parts = root.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }
  const codeRoot = kind === "code" ? codeRootFor(win) : "";
  if (codeRoot) {
    const parts = codeRoot.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }
  const webUrl = kind === "web" ? activeWebUrl(win) : "";
  if (webUrl) {
    return displayForm(webUrl);
  }
  return null;
}

/** The web tile's content mount — one instance per web TILE, keyed by the
 *  tile's own window: a foreign `@N/web` tile reads and writes its HOME
 *  window's tab family (`@rk_win_web_<n>` options, the optimistic
 *  `webOverride` keyed `entryKey(server, home)`), never the route window's.
 *
 *  Select/remove/move ride the window store's per-entry `webOverride` (the
 *  pendingName/killed precedent): the optimistic write repaints the strip
 *  immediately while the POST is in flight; the SSE tick is authoritative and
 *  the reconcile effect drops the override once the payload matches. A
 *  rejection reverts the override and toasts. Add is NOT optimistic — the
 *  slot index is server-assigned. */
function WebTileContent({
  server,
  sessionName,
  windowId,
  win,
  visible,
  onInteract,
  onPageTitle,
  shouldReclaimChord,
  webCapture,
}: {
  server: string;
  /** The tile window's owning session (the override entry's session half). */
  sessionName: string;
  /** The tile's OWN window id — the home window for a foreign web leaf. */
  windowId: string;
  /** The tile window's payload record; null renders nothing. */
  win: ViewWindow | null;
  visible: boolean;
  onInteract?: () => void;
  onPageTitle: (title: string | null) => void;
  shouldReclaimChord?: (e: KeyboardEvent) => boolean;
  /** The web keyboard-capture latch (SurfaceLayout prop) — narrows the
   *  native engine's chord table. */
  webCapture?: boolean;
}) {
  const { addToast } = useToast();
  const webOverride = useWindowStore(
    (s) => s.entries.get(entryKey(server, windowId))?.webOverride,
  );
  const setWebOverride = useWindowStore((s) => s.setWebOverride);
  const clearWebOverride = useWindowStore((s) => s.clearWebOverride);
  // Ref writes are synchronous, so two gestures in the same render compound
  // against the first optimistic family instead of both reading the same SSE
  // payload. The POST queue preserves that ordering at the tmux writer and
  // invalidates dependent moves when an earlier request fails.
  const webOverrideRef = useRef(webOverride);
  webOverrideRef.current = webOverride;
  const webMoveQueueRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const applyWebOverride = (override: WebTabOverride) => {
    webOverrideRef.current = { ...webOverrideRef.current, ...override };
    setWebOverride(server, sessionName, windowId, override);
  };
  const revertWebOverride = () => {
    webOverrideRef.current = undefined;
    clearWebOverride(server, sessionName, windowId);
  };

  const { execute: selectWebTabOptimistic } = useOptimisticAction<[number]>({
    action: (n) => selectWebTab(server, windowId, n),
    onOptimistic: (n) => applyWebOverride({ webActive: n }),
    onAlwaysRollback: revertWebOverride,
    onError: (err) => addToast(err.message || "Failed to select web tab", "error"),
  });

  const { execute: removeWebTabOptimistic } = useOptimisticAction<[number]>({
    action: (n) => removeWebTab(server, windowId, n),
    onOptimistic: (n) => {
      // Compound on any in-flight override so back-to-back strip clicks
      // shift the family the user is looking at, not the stale payload.
      const tabs = webOverrideRef.current?.webTabs ?? win?.webTabs ?? [];
      const active = webOverrideRef.current?.webActive ?? win?.webActive ?? 0;
      applyWebOverride(webFamilyAfterRemove(tabs, active, n));
    },
    onAlwaysRollback: revertWebOverride,
    onError: (err) => addToast(err.message || "Failed to close web tab", "error"),
  });

  const { execute: moveWebTabOptimistic } = useOptimisticAction<[number, number]>({
    action: (n, to) => {
      const predecessor = webMoveQueueRef.current;
      const queued = predecessor.then(async (chainAlive) => {
        if (!chainAlive) return false;
        try {
          await moveWebTab(server, windowId, n, to);
          return true;
        } catch (err) {
          // Already-enqueued moves retain their failed predecessor and cancel
          // silently. A later gesture starts a fresh chain after rollback.
          webMoveQueueRef.current = Promise.resolve(true);
          throw err;
        }
      });
      webMoveQueueRef.current = queued.catch(() => false);
      return queued.then(() => undefined);
    },
    onOptimistic: (n, to) => {
      // Compound on any in-flight override so back-to-back reorder drop the
      // family the user sees, not the stale payload (the remove precedent).
      const tabs = webOverrideRef.current?.webTabs ?? win?.webTabs ?? [];
      const active = webOverrideRef.current?.webActive ?? win?.webActive ?? 0;
      applyWebOverride(webFamilyAfterMove(tabs, active, n, to));
    },
    onAlwaysRollback: revertWebOverride,
    onError: (err) => addToast(err.message || "Failed to move web tab", "error"),
  });

  // Reconcile: the options write wakes the SSE hub, so the confirming tick
  // lands within ~1–2s; once the payload matches, the override has nothing
  // left to say.
  useEffect(() => {
    if (!webOverride || !win) return;
    const payloadTabs = win.webTabs ?? [];
    const tabsSettled =
      webOverride.webTabs === undefined ||
      (webOverride.webTabs.length === payloadTabs.length &&
        webOverride.webTabs.every((url, i) => url === payloadTabs[i]));
    const activeSettled =
      webOverride.webActive === undefined ||
      webOverride.webActive === (win.webActive ?? 0);
    if (tabsSettled && activeSettled) clearWebOverride(server, sessionName, windowId);
  }, [webOverride, win, server, sessionName, windowId, clearWebOverride]);

  // Unmount/window-switch cleanup: drop any in-flight override for the window
  // left behind, and start the move queue fresh — a failed or still-pending
  // move chain must not cancel the window's next reorder or strand its
  // optimistic override.
  useEffect(
    () => () => {
      clearWebOverride(server, sessionName, windowId);
      webMoveQueueRef.current = Promise.resolve(true);
    },
    [server, sessionName, windowId, clearWebOverride],
  );

  // Web availability is unconditional (260821-zqlq): an empty active web tab
  // renders IframeWindow's onboarding content branch, so the tile mounts
  // regardless — the `win` guard narrows for the props.
  return win ? (
    <IframeWindow
      tabs={webOverride?.webTabs ?? win.webTabs ?? []}
      active={webOverride?.webActive ?? win.webActive}
      webCapture={webCapture}
      // The tile's tmux identity — scopes the native engine's guest retention
      // (park/adopt) and the chrome-owned destroy rule. A foreign tile passes
      // its HOME window, so the surface keeps one guest wherever it is shown.
      server={server}
      windowId={windowId}
      // Address-bar write seam: the ACTIVE web slot's option write
      // (n = webActive, slot 1 while the pointer is unset) — the component
      // stays payload-shape agnostic. The active pointer is read through the
      // same optimistic override the strip renders, so a submit during an
      // in-flight select/remove targets the tab the user is looking at, not
      // the stale payload slot.
      onWriteUrl={(url) => {
        const active = webOverride?.webActive ?? win.webActive;
        const n = active !== undefined && active >= 1 ? active : 1;
        return setWindowOptions(server, windowId, { [`@rk_win_web_${n}`]: url });
      }}
      // Strip verbs: select/remove are optimistic (the webOverride block
      // above); add is NOT optimistic — the slot index is server-assigned,
      // the SSE tick repaints the family. The component types the verbs as
      // promise-returning (the `+` flow chains onSelectTab after onAddTab
      // resolves); the optimistic executors are fire-and-forget, so the
      // wrappers resolve at once. The add route resolves targets like
      // `rk present`, so the component's relative /proxy/ draft is
      // re-expressed as the absolute loopback URL (toWebAddTarget) the
      // backend parses.
      onSelectTab={(n) => {
        selectWebTabOptimistic(n);
        return Promise.resolve();
      }}
      onCloseTab={(n) => {
        removeWebTabOptimistic(n);
        return Promise.resolve();
      }}
      onAddTab={(target) => addWebTab(server, windowId, toWebAddTarget(target))}
      onMoveTab={(n, to) => {
        moveWebTabOptimistic(n, to);
        return Promise.resolve();
      }}
      onInteract={visible ? onInteract : undefined}
      // Page-title seam (260819-v6y4 R10): the header render is the parent's,
      // but only the mounted iframe can read the same-origin
      // contentDocument.title — reported up on each load, keyed by the tile's
      // window.
      onPageMeta={(m) => onPageTitle(m.title)}
      shouldReclaimChord={shouldReclaimChord}
    />
  ) : null;
}

export function SurfaceLayout({
  layout,
  server,
  windowId,
  clearOnWindowChange = false,
  sessionName,
  window: win,
  windowsById,
  sessionNameByWindowId,
  isMobile,
  mobileActiveSlot,
  wsRef,
  focusRef,
  scrollLocked,
  onSessionNotFound,
  codeReachable,
  gui = null,
  guiZoom = "fit",
  guiPointerMode,
  onGuiZoomChange,
  onGuiPointerModeChange,
  guiHidpi = false,
  guiKeyBarVisible = true,
  onGuiKeyBarVisibleChange,
  guiToolbarVisible = false,
  onGuiToolbarVisibleChange,
  guiCapture = false,
  webCapture = false,
  onWebCaptureChange,
  guiResizeLocked = false,
  guiQuality = "balanced",
  guiStatsVisible = false,
  onGuiQualityChange,
  onGuiStatsVisibleChange,
  onGuiConnection,
  onGuiRestart,
  onCodeServerRestart,
  onGuiOpenLogs,
  guiCommandsRef,
  guiActions = [],
  onCodeFolderNavigated,
  onCodeFollowTerminal,
  codeCommandsRef,
  reviewCommandsRef,
  onReviewUnhandledChange,
  onReviewListeningChange,
  layoutRectsRef,
  codeSrcFor,
  liveWindowIds,
  codeRootForWindow,
  codeFollowSrc,
  fetchBridgeStatusFor,
  shouldReclaimChord,
  onProgrammaticFocus,
  onClose,
  onApplyLayout,
  popoutLeafId,
  onPopBackIn,
  popped,
  onPopOut,
  revealedPoppedIds,
  onPopIn,
  onFocusPopout,
  onHidePopped,
  onSendHome,
  onGoToWindow,
  onBorrowDrop,
  onSplitPane,
  onClosePane,
  onRatioChange,
  onRatioCommit,
  zoomToggleRef,
  onZoomChange,
  onFocusedKindChange,
  onFocusedLeafChange,
  focusTileRef,
  statusWindow,
  ttyDockContent,
  themePalette = DEFAULT_DARK_THEME.palette,
}: SurfaceLayoutProps) {
  // The web header capture verb's tooltip chord — only while the binding is
  // live (a keycap advertising a dead chord would lie; the gui toolbar's
  // kbdFor rule).
  const { byAction: bindingsByAction, host: bindingHost } = useKeybindings();
  const webCaptureBinding = bindingsByAction.get("web-capture-toggle");
  const webCaptureKbd = webCaptureBinding?.enabled
    ? formatCombo({ code: webCaptureBinding.code, tier: webCaptureBinding.tier }, bindingHost.platform)
    : undefined;
  // The tree's reading-order view for this render: leaf ids, kinds, the
  // structure signature (the sizes storage key), and the leaf count.
  const layoutLeafIds = leafIds(layout);
  const layoutKinds = leaves(layout);
  const layoutSig = structureSig(layout);
  const arity = layoutLeafIds.length;
  // The popout/opener postures (spec surface-layout.md § Verbs → Pop out /
  // Pop back in). `popoutLeafId` set ⇒ this render IS the popout window — a
  // one-leaf tree, chrome-less; the header trades the layout-verb cluster for
  // a single Pop back in verb. `popped` ⇒ the opener's per-viewer popped set:
  // the parent renders the REDUCED tree, and here the set disarms the header
  // drag (a drop resolved on the reduced tree would drop the popped leaf from
  // the SHARED layout for every viewer), unzooms a popped zoomed leaf, and
  // evicts a popped code leaf's retained frame (the popout boots its own
  // extension host — one, not two).
  const popoutTile = popoutLeafId !== undefined;
  const poppedIdsKey = (popped ?? []).join("\n");
  const poppedSet = useMemo(
    () => new Set(popped ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [poppedIdsKey],
  );
  const revealedPoppedIdsKey = (revealedPoppedIds ?? []).join("\n");
  const revealedPoppedSet = useMemo(
    () => new Set(revealedPoppedIds ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revealedPoppedIdsKey],
  );
  // Render-mirrored for the row-drag's dragstart listener (the effect keys on
  // server/window, not the set — the latest-closure pattern).
  const poppedSetRef = useRef(poppedSet);
  poppedSetRef.current = poppedSet;
  // The focus-memory key for this window (spec right-panel.md § The code
  // lens): the recording seams below write the user's focus choice under it,
  // and the steal guard consults it. This component is keyed by server and
  // survives a same-server window switch — the memory is what carries the
  // per-window focus choice across it.
  const focusKey = focusMemoryKey(server, windowId);

  // Coarse pointer — the gui tile's resize/quality policy key (a coarse
  // viewer never drives SetDesktopSize).
  const coarsePointer = useCoarsePointer();

  // The payload record a tile reads: the route window for a bare leaf, the
  // home window's map entry for a foreign leaf. A foreign home absent from
  // the map is dead — dead leaves are pruned before render, so a null here is
  // only the transient between a kill and the next payload.
  const windowRecordFor = (id: string): ViewWindow | null =>
    id === windowId ? win : (windowsById?.get(id) ?? null);
  // A foreign tty tile's session: its home window's owning session (the relay
  // stream's connection identity and the focus registration's session half).
  const tileSessionFor = (id: string): string =>
    id === windowId ? sessionName : (sessionNameByWindowId?.get(id) ?? "");

  // The away derivation (server-computed `awayIn` on the route window's
  // record): a BARE leaf whose kind names a LIVE holder renders the
  // placeholder instead of mounting the surface. A holder absent from the
  // window map is dead — the surface is back, so the leaf renders live.
  const awayHolderFor = (kind: SurfaceKind): string | undefined => {
    const holder = windowsById?.get(windowId)?.awayIn?.[kind];
    return holder !== undefined && (windowsById?.has(holder) ?? false) ? holder : undefined;
  };

  // Per-leaf ws buckets for NON-PRIMARY tty tiles — TerminalClient types
  // `wsRef` as required and fills it with its stream's adapter; the focused
  // tty tile (bare or foreign) registers with its own bucket so the shell's
  // bottom bar / compose strip reach the focused tile's stream. Only the
  // first bare tty leaf owns the shared refs.
  const ttyWsRefsRef = useRef(new Map<string, React.MutableRefObject<WebSocket | null>>());
  const ttyWsRefFor = (leafId: string): React.MutableRefObject<WebSocket | null> => {
    let bucket = ttyWsRefsRef.current.get(leafId);
    if (!bucket) {
      bucket = { current: null };
      ttyWsRefsRef.current.set(leafId, bucket);
    }
    return bucket;
  };

  // ── tty find state ───────────────────────────────────────────────────────
  // The tile layer drives the scaffold's passive SearchAddon through the
  // searchAddonRef seam (primary tty only — the wsRef/focusRef precedent).
  // TerminalClient fills the ref asynchronously at init, so a stable proxy
  // ref mirrors the instance into state: the result-count subscription and
  // the search effect key on it, and a window switch re-subscribes against
  // the fresh addon. The proxy's IDENTITY must stay constant — it sits in
  // TerminalClient's init-effect deps.
  const searchAddonBox = useRef<SearchAddon | null>(null);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);
  const searchAddonRef = useMemo<React.MutableRefObject<SearchAddon | null>>(
    () => ({
      get current() {
        return searchAddonBox.current;
      },
      set current(addon: SearchAddon | null) {
        searchAddonBox.current = addon;
        setSearchAddon(addon);
      },
    }),
    [],
  );
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findRegex, setFindRegex] = useState(false);
  const [findResults, setFindResults] = useState<{
    resultIndex: number;
    resultCount: number;
  } | null>(null);
  // Sticky "a search has run" flag — gates the buffer-scope hint; closing the
  // bar clears it with everything else. The per-window reset effect clears it
  // on a window switch, so no query survives one.
  const [findRan, setFindRan] = useState(false);
  const findOptions = useMemo(
    () =>
      buildSearchOptions(
        { caseSensitive: findCaseSensitive, regex: findRegex },
        themePalette,
      ),
    [findCaseSensitive, findRegex, themePalette],
  );

  // The counter derives from the addon's result-change event — no polling.
  useEffect(() => {
    if (!searchAddon) return;
    const disposable = searchAddon.onDidChangeResults((e) => {
      setFindResults({ resultIndex: e.resultIndex, resultCount: e.resultCount });
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  // Query or toggle changes re-run the active search; the addon itself
  // re-indexes incrementally as new pane output streams in. Clearing the
  // query clears the decorations.
  useEffect(() => {
    if (!findOpen) return;
    if (findQuery === "") {
      searchAddon?.clearDecorations();
      setFindResults(null);
      return;
    }
    setFindRan(true);
    runFind(searchAddon, findQuery, 1, findOptions);
  }, [findOpen, findQuery, findOptions, searchAddon]);

  const stepFind = useCallback(
    (delta: 1 | -1) => {
      runFind(searchAddon, findQuery, delta, findOptions);
    },
    [searchAddon, findQuery, findOptions],
  );

  // Closing the bar (✕, Escape, the ⌕ toggle) clears everything and returns
  // focus to the pane so the next keystroke lands in the terminal.
  const closeFind = useCallback(() => {
    searchAddon?.clearDecorations();
    setFindOpen(false);
    setFindQuery("");
    setFindResults(null);
    setFindRan(false);
    focusRef.current?.();
  }, [searchAddon, focusRef]);

  // The `terminal-find:open` seam: the chord handler and the palette action
  // dispatch one document CustomEvent; the mounted layout is its single
  // receiver (at most one terminal route's SurfaceLayout is mounted).
  useEffect(() => {
    const open = () => setFindOpen(true);
    document.addEventListener(TERMINAL_FIND_OPEN_EVENT, open);
    return () => document.removeEventListener(TERMINAL_FIND_OPEN_EVENT, open);
  }, []);

  // Terminal export seams (260819-shqo): the PRIMARY tty tile's TerminalClient
  // fills these (the wsRef/focusRef primary-tty rule); the ⇩ header menu and
  // the palette's `Terminal: …` actions (one `EXPORT_EVENT` CustomEvent seam,
  // the `web-find:open` precedent) both run against this buffer.
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const ttyTerminalRef = useRef<Terminal | null>(null);
  const { addToast } = useToast();
  const [exportMenuPos, setExportMenuPos] = useState<{ top: number; right: number } | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  // Menus register `transient` (overlay-presence): while open, a native guest
  // composited above the DOM hides so the menu never paints underneath it.
  useOccludes("transient", exportMenuPos !== null);

  const runExport = useCallback(
    async (action: ExportAction) => {
      const now = new Date();
      // Window display name (safe-name sanitization lives in
      // buildExportFilename), the windowId as fallback.
      const windowName = statusWindow?.name ?? windowId;
      const term = ttyTerminalRef.current;
      switch (action) {
        case "snapshot": {
          const addon = serializeAddonRef.current;
          if (!addon) return;
          const inner = addon.serializeAsHTML({ includeGlobalBackground: true });
          downloadTextFile(
            buildExportFilename(sessionName, windowName, now, "html"),
            "text/html",
            wrapHtmlSnapshot(inner, `${sessionName}-${windowName}`),
          );
          return;
        }
        case "transcript": {
          if (!term) return;
          downloadTextFile(
            buildExportFilename(sessionName, windowName, now, "txt"),
            "text/plain; charset=utf-8",
            transcriptFromBuffer(term.buffer.active),
          );
          return;
        }
        case "copy-visible": {
          if (!term) return;
          const ok = await copyToClipboard(
            visibleScreenText(term.buffer.active, term.rows),
          );
          if (!ok) addToast("Copy failed — clipboard unavailable");
          return;
        }
        case "history": {
          try {
            const body = await fetchWindowHistory(server, windowId);
            downloadTextFile(
              buildExportFilename(sessionName, windowName, now, "txt", true),
              "text/plain; charset=utf-8",
              body,
            );
          } catch (err) {
            addToast(
              `History export failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
      }
    },
    [sessionName, statusWindow?.name, windowId, server, addToast],
  );

  // The palette entry points (T008): one document CustomEvent carries the
  // action; this cluster is the single receiver (one terminal route mount).
  useEffect(() => {
    const onExport = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: unknown = e.detail;
      if (typeof detail !== "object" || detail === null || !("action" in detail)) return;
      const action = detail.action;
      if (
        action === "snapshot" ||
        action === "transcript" ||
        action === "copy-visible" ||
        action === "history"
      ) {
        void runExport(action);
      }
    };
    document.addEventListener(EXPORT_EVENT, onExport);
    return () => document.removeEventListener(EXPORT_EVENT, onExport);
  }, [runExport]);

  // Export menu dismissal (the top-bar-overflow-menu contract): outside
  // mousedown closes; Escape closes and refocuses the trigger.
  useEffect(() => {
    if (!exportMenuPos) return;
    function handleClick(e: MouseEvent) {
      if (!(e.target instanceof Node)) return;
      if (exportMenuRef.current?.contains(e.target)) return;
      if (exportButtonRef.current?.contains(e.target)) return;
      setExportMenuPos(null);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setExportMenuPos(null);
        exportButtonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey, { capture: true });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey, { capture: true });
    };
  }, [exportMenuPos]);

  const toggleExportMenu = () => {
    if (exportMenuPos) {
      setExportMenuPos(null);
      return;
    }
    const rect = exportButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // position:fixed anchored to the trigger rect — an in-flow popup would be
    // clipped by the tile wrapper's overflow-hidden (the overflow-menu
    // precedent).
    setExportMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  };

  const pickExport = (action: ExportAction) => () => {
    setExportMenuPos(null);
    void runExport(action);
  };


  // Hide-never-unmount (P3): leaf ids opened earlier this route visit stay
  // mounted at display level. Per-window: the reset effect re-seeds the set
  // from the new window's layout on a window switch.
  const [everOpened, setEverOpened] = useState<string[]>(() => leafIds(layout));
  useEffect(() => {
    const ids = leafIds(layout);
    setEverOpened((prev) => {
      const missing = ids.filter((id) => !prev.includes(id));
      return missing.length > 0 ? [...prev, ...missing] : prev;
    });
  }, [layout]);

  // ── Code-frame retention (the P3 cross-window half) ─────────────────────
  // An ordered list of live code-frame records, most-recently-shown LAST.
  // Unlike `everOpened` this is deliberately NOT per-window: the list is the
  // cross-window state, so the `[server, windowId]` reset effect never
  // touches it (the component is keyed by server, making the list per-server
  // by construction). A record is created only for the ACTIVE window once its
  // src has resolved and its code tile is open — a pending tile has no frame
  // and never counts toward the cap.
  const [codeFrames, setCodeFrames] = useState<CodeFrameRecord[]>([]);
  // Committed-records mirror for effects that decide outside a `setCodeFrames`
  // updater (the eviction reconciliation) — updaters must stay pure.
  const codeFramesRef = useRef<CodeFrameRecord[]>(codeFrames);
  codeFramesRef.current = codeFrames;
  const codeFrameCap = isMobile ? CODE_FRAME_CAP_MOBILE : CODE_FRAME_CAP_DESKTOP;
  // The visible code leaves' tile windows in reading order: the bare `code`
  // leaf resolves to the route window, a foreign `@N/code` leaf to its home.
  // Frame records key on these — a borrowed code tile reuses its home
  // window's retained frame when one exists. A REVEALED popped code leaf is
  // excluded: its slot mounts the popped placeholder (no frame), and the show
  // bookkeeping must not re-create the record the popped-frame eviction
  // dropped — the popout owns the live frame.
  const codeTileWindowIds = layoutLeafIds
    .filter((id) => leafIdParts(id).kind === "code" && !revealedPoppedSet.has(id))
    .map((id) => tileWindowIdOf(id, windowId));
  const codeTileWindowsKey = codeTileWindowIds.join(",");
  const activeCodeTileOpen = codeTileWindowIds.length > 0;
  // A frame record's lookup by its window.
  const frameForWindow = (id: string) => codeFrames.find((r) => r.windowId === id);
  // The hidden-tile leaf set: ever-opened ids, plus a forced `code` slot when
  // the ROUTE window has a frame record but no code leaf in the set — the
  // per-window reset re-seeds `everOpened` from the new window's layout, so
  // returning to a window whose code tile is CLOSED would otherwise drop the
  // tile here while `retainedCodeTiles` filters the record out as claimed —
  // unmounting (killing) a frame the close-tile rule says stays retained and
  // counted.
  const hiddenLeafIds: string[] =
    frameForWindow(windowId) && !everOpened.includes("code")
      ? [...everOpened, "code"]
      : everOpened;
  // Code windows with a tile mounted this route visit (visible or hidden):
  // their frame records are claimed by those tiles — never by the retained
  // list — and are protected from cap eviction.
  const mountedCodeWindowIds = [
    ...new Set(
      [...layoutLeafIds, ...hiddenLeafIds]
        .filter((id) => leafIdParts(id).kind === "code")
        .map((id) => tileWindowIdOf(id, windowId)),
    ),
  ];
  const mountedCodeWindowsKey = mountedCodeWindowIds.join(",");

  // Show bookkeeping: each visible code tile's record is created on first
  // resolve and bumped to most-recently-shown on every show; overflow evicts
  // least-recently-shown NON-VISIBLE records first (an on-screen frame is
  // never the victim). A retained frame never bumps itself: it cannot become
  // visible without a tile claiming its window. Gated on reachability — an
  // unreachable host holds no frames (the eviction effect below drops them on
  // the true→false flip).
  useEffect(() => {
    if (!codeReachable) return;
    setCodeFrames((prev) => {
      let next = prev;
      let changed = false;
      for (const id of codeTileWindowIds) {
        const src = codeSrcFor?.(id) ?? null;
        if (src === null) continue;
        const root = codeRootFor(windowRecordFor(id));
        if (root === "") continue;
        const at = next.findIndex((r) => r.windowId === id);
        if (at >= 0 && at === next.length - 1) continue; // already most-recently-shown
        next =
          at < 0
            ? [...next, { windowId: id, src, root }]
            : [...next.slice(0, at), ...next.slice(at + 1), next[at]];
        changed = true;
      }
      if (!changed) return prev;
      if (next.length > codeFrameCap) {
        let excess = next.length - codeFrameCap;
        next = next.filter((r) => {
          if (excess > 0 && !codeTileWindowIds.includes(r.windowId)) {
            excess -= 1;
            return false;
          }
          return true;
        });
      }
      return next;
    });
    // `codeFrames` is a dep so an eviction (or a follow's in-place baseline
    // move) re-runs the check: a dropped visible record is re-created at the
    // CURRENT src on the next render. Idempotent — present, most-recent
    // records return `prev` unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server, codeTileWindowsKey, codeSrcFor, codeReachable, codeFrameCap, codeFrames, windowsById, win, windowId]);

  // A follow is never an eviction. The pending follow target is recorded
  // SYNCHRONOUSLY at report time by the shared `requestCodeFollow` wrapper
  // (both triggers: the editor's File > Open Folder report and the header's
  // Follow terminal verb) — BEFORE the parent's latch POST, whose option
  // write wakes the SSE hub: the payload tick carrying the new codeRoot can
  // land before the POST response and the re-derivation GET produce the
  // follow nonce, and the eviction effect must not read the follow's own
  // write as an external divergence. A divergence TOWARD the pending target
  // IS the follow: the baseline moves in place and the pending target clears.
  // A failed latch POST leaves the payload unmoved, so nothing diverges and
  // the frame survives; the wrapper's `.catch` clears the target on the
  // parent's rejection. Keyed by WINDOW ID: overlapping follows (A reports,
  // the viewer switches, B reports before A's payload tick) must not
  // overwrite each other.
  const pendingCodeFollowRef = useRef<Map<string, string>>(new Map());

  // The ONE follow wrapper both follow triggers ride — the editor-initiated
  // load-seam report (`onCodeFolderNavigated`) and the header's Follow
  // terminal verb (`onCodeFollowTerminal`): record the pending target
  // SYNCHRONOUSLY with the report, BEFORE the parent's latch POST (whose
  // option write wakes the SSE hub — the payload tick can outrun the follow
  // nonce, and the eviction effect reads this target to tell the follow's own
  // write from an external root change). A REJECTED parent call clears the
  // target (the eviction effect's pending arms would otherwise accept a later
  // same-folder update as the failed follow); a fulfilled one leaves it for
  // the payload/nonce to consume. The returned promise settles after that
  // bookkeeping so the verb can hold its in-flight guard until then.
  const requestCodeFollow = (
    frameWindowId: string,
    folder: string,
    report: ((folder: string) => void | Promise<void>) | undefined,
  ): Promise<void> => {
    pendingCodeFollowRef.current.set(frameWindowId, folder);
    return Promise.resolve(report?.(folder)).catch(() => {
      if (pendingCodeFollowRef.current.get(frameWindowId) === folder) {
        pendingCodeFollowRef.current.delete(frameWindowId);
      }
    });
  };

  // Code-tile header verbs (Follow terminal / Reload editor). `codeReload`
  // targets exactly one frame by window id — the nonce prop reaches only that
  // frame (every other frame receives undefined). `codeFollowInFlight`
  // disables the Follow verb from click until the follow promise settles: the
  // payload still reads the OLD root until the option tick, so an unguarded
  // second click would re-POST and produce a second nonce/re-navigation.
  const [codeFollowInFlight, setCodeFollowInFlight] = useState(false);
  const [codeReload, setCodeReload] = useState<{ windowId: string; nonce: number } | null>(null);
  // The Follow drift predicate reads the TILE window's payload record (a
  // foreign code tile drifts against its home window's derivation) — a
  // retained frame is never offered the verb (its tile renders no header;
  // `visible` gates the render below). The verb's presence IS the drift
  // indicator — no other badge or copy.
  const codeFollowTargetFor = (tileWindowId: string): string | null =>
    codeRootFollowTarget(windowRecordFor(tileWindowId));
  // A frame record exists only once the tile window's src resolved and the
  // iframe mounted — pending or unreachable tiles show no Reload verb (there
  // is no frame to reload).
  const codeFrameMountedFor = (tileWindowId: string): boolean =>
    codeReachable && codeFrames.some((r) => r.windowId === tileWindowId);

  const followCodeTerminal = (tileWindowId: string) => {
    const target = codeFollowTargetFor(tileWindowId);
    if (target === null || codeFollowInFlight) return;
    setCodeFollowInFlight(true);
    void requestCodeFollow(tileWindowId, target, onCodeFollowTerminal).finally(() => {
      setCodeFollowInFlight(false);
    });
  };
  const reloadCodeFrame = (tileWindowId: string) => {
    if (!codeFrameMountedFor(tileWindowId)) return;
    setCodeReload((r) => ({ windowId: tileWindowId, nonce: (r?.nonce ?? 0) + 1 }));
  };

  // Palette command seam (Constitution V): the `Code: Follow Terminal` /
  // `Code: Reload Editor` rows run the same bodies as the header verbs — the
  // FIRST visible code tile's, matching the parent's code-root write target.
  // Filled while a code tile is open, null otherwise and on unmount — the
  // `zoomToggleRef` pattern. Refilled after EVERY render so the bodies always
  // close over the current drift/in-flight/frame state.
  useEffect(() => {
    if (!codeCommandsRef) return;
    const firstCodeWindow = codeTileWindowIds[0];
    codeCommandsRef.current =
      activeCodeTileOpen && firstCodeWindow !== undefined
        ? {
            followTerminal: () => followCodeTerminal(firstCodeWindow),
            reload: () => reloadCodeFrame(firstCodeWindow),
          }
        : null;
    return () => {
      codeCommandsRef.current = null;
    };
  });

  // Eviction reconciliation (payload-driven — no timers): (a) the frame's
  // window left the server's live set (killed/closed); (b) the window's live
  // code root diverged from the record's baseline by anything OTHER than a
  // follow (a transient empty read never evicts); (c) reachability flipped
  // true→false — every frame is dead with the host; plus a runtime cap
  // decrease (an isMobile flip) evicts down immediately, oldest records NOT
  // claimed by a visible code tile first — a visible tile's record is
  // protected even when its code tile is closed (a closed tile keeps its
  // frame counted, and the show-bookkeeping effect can't bump it to the tail
  // while it is).
  //
  // The `setCodeFrames` updater MUST stay pure: React may invoke it more
  // than once for a single update (StrictMode double-invocation, or the
  // eager-then-render path). A pending-target deletion inside it made the
  // second pass see the target already consumed and classify the follow's
  // own latch write as an external divergence — evicting the live frame the
  // follow was meant to keep. So the decision reads a SNAPSHOT of the
  // pending targets, the consumption is applied once in the effect body from
  // the committed records (`codeFramesRef`), and the updater only maps
  // `prev` through the same pure decision.
  useEffect(() => {
    const pendingSnapshot = new Map(pendingCodeFollowRef.current);
    const reconcile = (
      prev: CodeFrameRecord[],
    ): { next: CodeFrameRecord[]; changed: boolean; consumed: string[] } => {
      let next = prev;
      let changed = false;
      const consumed: string[] = [];
      if (liveWindowIds) {
        next = next.filter((r) => liveWindowIds.has(r.windowId));
      }
      if (codeRootForWindow) {
        const reconciled: CodeFrameRecord[] = [];
        for (const r of next) {
          const current = codeRootForWindow(r.windowId);
          const pending = pendingSnapshot.get(r.windowId);
          if (current === "" || current === r.root) {
            // A pending target the current root already satisfies IS the
            // follow's own write arriving after the nonce moved the baseline
            // — consume it so a later same-folder update can't inherit it.
            if (current !== "" && pending === current) consumed.push(r.windowId);
            reconciled.push(r);
            continue;
          }
          if (pending === current) {
            // The follow's own latch write (payload-first ordering): move the
            // baseline in place, keep the frame, consume the target.
            consumed.push(r.windowId);
            reconciled.push({ ...r, root: current });
            changed = true;
            continue;
          }
          if (pending === r.root) {
            // The nonce moved the baseline first; the payload tick hasn't
            // landed — keep the frame AND the target until the current root
            // observes it (dropping the target here would read the follow's
            // own in-flight state as an external divergence on the next tick).
            reconciled.push(r);
            continue;
          }
          changed = true; // genuine external divergence — evict
        }
        next = reconciled;
      }
      if (next.length > codeFrameCap) {
        let excess = next.length - codeFrameCap;
        next = next.filter((r) => {
          if (excess > 0 && !mountedCodeWindowIds.includes(r.windowId)) {
            excess -= 1;
            return false;
          }
          return true;
        });
        changed = true;
      }
      return { next, changed: changed || next.length !== prev.length, consumed };
    };

    const committed = codeFramesRef.current;
    if (committed.length === 0 || !codeReachable) {
      // No live frames — every pending target is stale (a follow implies a
      // mounted frame, hence a record).
      pendingCodeFollowRef.current.clear();
      if (!codeReachable) setCodeFrames((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Side effects once, from the committed records; then the pure write.
    const decided = reconcile(committed);
    for (const id of decided.consumed) pendingCodeFollowRef.current.delete(id);
    // Targets whose record is gone (evicted above) are stale: a later
    // same-folder update must never inherit one as a follow.
    for (const id of pendingCodeFollowRef.current.keys()) {
      if (!decided.next.some((r) => r.windowId === id)) pendingCodeFollowRef.current.delete(id);
    }
    setCodeFrames((prev) => {
      const d = reconcile(prev);
      return d.changed ? d.next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeReachable, liveWindowIds, codeRootForWindow, codeFrameCap, mountedCodeWindowsKey]);

  // The nonce half of the follow: when the parent's re-derivation GET lands
  // before the payload tick, the baseline moves here instead (the eviction
  // effect's pending-target arms cover both orderings). The pending target is
  // deliberately LEFT SET: the eviction effect consumes it once the current
  // root observes it — clearing it here would leave a window where the
  // baseline moved but `codeRootForWindow` still returns the old root, and
  // the next unrelated payload tick would evict the live frame. The record's
  // `src` stays the creation src (the frame's identity; the mount-generation
  // rule pins the iframe's src).
  const codeFollowNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!codeFollowSrc || codeFollowSrc.nonce === codeFollowNonceRef.current) return;
    codeFollowNonceRef.current = codeFollowSrc.nonce;
    const followRoot = codeFollowSrc.root;
    const followWindowId = codeFollowSrc.windowId;
    setCodeFrames((prev) =>
      prev.some((r) => r.windowId === followWindowId && r.root !== followRoot)
        ? prev.map((r) => (r.windowId === followWindowId ? { ...r, root: followRoot } : r))
        : prev,
    );
  }, [codeFollowSrc]);

  // A popped code leaf evicts the opener's retained frame for its window
  // (spec surface-layout.md § Verbs → Pop out): the popout boots its own
  // extension host, so a kept hidden frame would double the ~250–320 MB cost
  // the LRU exists to bound. The show-bookkeeping effect never re-creates the
  // record while the leaf is popped — the REDUCED render tree holds no code
  // leaf claiming that window — and popping back in re-mounts fresh (a
  // workbench boot is the accepted cost of the return).
  const poppedCodeWindowsKey = [...poppedSet]
    .filter((id) => leafIdParts(id).kind === "code")
    .map((id) => tileWindowIdOf(id, windowId))
    .join("\n");
  useEffect(() => {
    if (poppedCodeWindowsKey === "") return;
    const evict = new Set(poppedCodeWindowsKey.split("\n"));
    setCodeFrames((prev) => {
      const next = prev.filter((r) => !evict.has(r.windowId));
      return next.length === prev.length ? prev : next;
    });
  }, [poppedCodeWindowsKey]);

  // ⏶ Zoom: one leaf fills the layout area; the shared layout tree is
  // untouched. Per-viewer and PERSISTED as the zoomed LEAF ID under
  // `rk-layout-zoom:{server}:{@N}` — the same key the mobile switch group
  // reads (its kind writes double as a unique bare leaf's id). The leaf id is
  // the identity: a foreign leaf's address survives any restructure, and a
  // bare id (`code`, `tty#2`) falls back to the kind's FIRST leaf in reading
  // order when its exact leaf left the tree, so a shared restructure
  // (promote/swap from any viewer) moves the zoom with its surface. Cleared
  // (state AND key) when the layout can no longer host the zoom: a close
  // collapsed the arity, or the zoomed kind left the tree.
  const [zoomedLeafId, setZoomedLeafId] = useState<string | null>(() => {
    const stored = readStoredZoom(server, windowId);
    return stored ? resolveZoomLeaf(layout, stored) : null;
  });
  const zoomedKindRef = useRef<SurfaceKind | null>(
    zoomedLeafId !== null ? leafIdParts(zoomedLeafId).kind : null,
  );
  // Every zoom flip writes the key through this one seam (the zoomed leaf's
  // id; `null` on unzoom). Flip initiators only: mount with no zoom writes
  // nothing, so the mobile switch group's writes to the same key are never
  // clobbered by a steady-state unzoomed desktop render.
  const zoomedLeafIdRef = useRef(zoomedLeafId);
  zoomedLeafIdRef.current = zoomedLeafId;
  const flipZoom = useCallback(
    (leafId: string | null) => {
      setZoomedLeafId(leafId);
      zoomedKindRef.current = leafId !== null ? leafIdParts(leafId).kind : null;
      writeStoredZoom(server, windowId, leafId);
    },
    [server, windowId],
  );
  // The window the zoom STATE belongs to. On a windowId change this effect
  // runs (flipZoom's identity changes) BEFORE the per-window reset effect
  // below has re-derived the zoom for the new window, so it would otherwise
  // reconcile the OLD window's zoom against the NEW layout and — when the old
  // kind is absent — write `null` under the NEW window's key, destroying a
  // valid stored zoom. Skip reconciliation until the reset effect has handed
  // the state over to the current window.
  const zoomOwnerRef = useRef(`${server}:${windowId}`);
  useEffect(() => {
    if (zoomOwnerRef.current !== `${server}:${windowId}`) return;
    if (zoomedLeafId === null) return;
    if (layoutKinds.length <= 1) {
      flipZoom(null);
      return;
    }
    // The exact leaf survives any restructure — nothing to do.
    if (layoutLeafIds.includes(zoomedLeafId)) return;
    // Its exact leaf left the tree: follow the zoom to the kind's first leaf
    // (the key already holds an id of that kind, so no write), or clear when
    // the kind itself is gone.
    const kind = zoomedKindRef.current;
    const i = kind === null ? -1 : layoutKinds.indexOf(kind);
    if (i < 0) {
      flipZoom(null);
      return;
    }
    setZoomedLeafId(layoutLeafIds[i]);
  }, [zoomedLeafId, layout, flipZoom, server, windowId]);
  // A popped zoomed leaf renders unzoomed: the reduced tree no longer holds
  // its tile, so the zoom would pin a hidden tile full-center. Clearing goes
  // through flipZoom so the persisted key clears too.
  useEffect(() => {
    if (zoomedLeafId !== null && poppedSet.has(zoomedLeafId)) flipZoom(null);
  }, [zoomedLeafId, poppedSet, flipZoom]);
  const zoomed = zoomedLeafId !== null;

  // Zoom flip reporting for the palette seam (T012/R11): the `Layout: Expand`/
  // `Layout: Restore` entries rebuild on every flip. The toggle registration itself
  // lives below the focused-leaf state (it reads the focused leaf).
  useEffect(() => {
    onZoomChange?.(zoomed);
  }, [zoomed, onZoomChange]);

  // Web tile page title (260819-v6y4 R10): reported by IframeWindow's
  // onPageMeta on each same-origin frame load; null (cross-origin, pre-load,
  // or empty) falls the header back to the address's display form. Keyed by
  // the tile's OWN window (a foreign web tile's title never headlines the
  // route window's tile); the reset effect clears the map on a window switch.
  const [webPageTitles, setWebPageTitles] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
  // The gui tile's element-fullscreen state, reported up from GuiSurface
  // (the fullscreen verb targets the TILE): latches the header's ⤢ and
  // suppresses the gui tile's layout verbs while it lasts.
  const [guiTileFullscreen, setGuiTileFullscreen] = useState(false);
  // Tty task progress (260819-1vxq): OSC 9;4 events lifted from the
  // scaffold's `onProgressChange` seam into ONE slot PER TILE WINDOW — tiles
  // of the same window (duplicate bare ttys) share its slot and their firings
  // fold idempotently, while a foreign tty's progress renders on its own tile
  // and never touches the route window's slot.
  // Events reduce immediately (retention semantics need event order) but
  // commit at most once per animation frame, so bursty emitters cannot
  // re-render storm the grid. Per-viewer ephemeral by design: component
  // state only, reset to idle by the per-window reset effect on a window
  // switch — a stale value with no updates is left as-is (the emitter owns
  // lifecycle via state 0).
  const [ttyProgressByWindow, setTtyProgressByWindow] = useState<ReadonlyMap<string, TtyProgress>>(
    () => new Map(),
  );
  const ttyProgressRef = useRef(new Map<string, TtyProgress>());
  const ttyProgressRafRef = useRef<number | null>(null);
  const handleTtyProgress = useCallback((tileWindowId: string, state: number, value: number) => {
    ttyProgressRef.current.set(
      tileWindowId,
      reduceProgress(ttyProgressRef.current.get(tileWindowId) ?? IDLE_PROGRESS, state, value),
    );
    if (ttyProgressRafRef.current !== null) return;
    ttyProgressRafRef.current = requestAnimationFrame(() => {
      ttyProgressRafRef.current = null;
      setTtyProgressByWindow(new Map(ttyProgressRef.current));
    });
  }, []);
  useEffect(
    () => () => {
      if (ttyProgressRafRef.current !== null) {
        cancelAnimationFrame(ttyProgressRafRef.current);
      }
    },
    [],
  );

  // Focused tile (260812-wfic R2) — transient, like zoom: the LEAF that last
  // received pointer/keyboard interaction. Default: the first leaf in reading
  // order; falls back there when the focused leaf leaves the layout (a close
  // removed it). Per-window: the reset effect returns it to the first leaf on
  // a window switch.
  const [focusedLeafId, setFocusedLeafId] = useState(() => leafIds(layout)[0]);
  useEffect(() => {
    setFocusedLeafId((id) => (leafIds(layout).includes(id) ? id : leafIds(layout)[0]));
  }, [layout]);
  // Render-time clamp: the clearing effect lands a beat after the render
  // carrying the tree the focused leaf left.
  const focusedId = layoutLeafIds.includes(focusedLeafId) ? focusedLeafId : layoutLeafIds[0];
  const focusedKind = layoutKinds[layoutLeafIds.indexOf(focusedId)];
  // Interaction seams report SYNCHRONOUSLY (`focusLeaf` below): the shell's
  // `ttyOnly` chord gate consumes the reported kind, and discrete-event
  // flushing guarantees the dispatcher's handler map reflects the click
  // before the next keydown — reporting only via this effect would leave a
  // two-render gap where the focused border shows but the chord still fires.
  // The effect remains for the non-interaction transitions: the first-leaf
  // default on mount and the fallback when the focused leaf leaves. The ref
  // dedupes the two seams — a sync interaction report and the effect firing
  // after the same state update hand up the focus exactly once.
  const lastReportedFocusRef = useRef<{ leafId: string; kind: SurfaceKind } | null>(null);
  const reportFocus = useCallback(
    (leafId: string, kind: SurfaceKind) => {
      const last = lastReportedFocusRef.current;
      if (last !== null && last.leafId === leafId && last.kind === kind) return;
      lastReportedFocusRef.current = { leafId, kind };
      onFocusedKindChange?.(kind);
      onFocusedLeafChange?.(leafId);
    },
    [onFocusedKindChange, onFocusedLeafChange],
  );
  const focusLeaf = (leafId: string) => {
    setFocusedLeafId(leafId);
    const kind = layoutKinds[layoutLeafIds.indexOf(leafId)];
    if (kind) reportFocus(leafId, kind);
  };
  // Focus-memory write seam for `tty` (spec right-panel.md § The code lens).
  // It lives on the POINTERDOWN seam, not in `focusLeaf` and not on the
  // wrapper's `onFocus`: the in-tile compose strip docks INSIDE the tty tile,
  // and a focusin bubbles target-first — the textarea's own `onFocus` (which
  // records `compose`) runs BEFORE the wrapper's, so a tty write there would
  // clobber the compose write. Pointerdown capture fires before any focus
  // event, so a compose click lands its write after this one. `code` is
  // deliberately never recorded here either: a programmatic grab produces no
  // pointerdown (the anti-steal asymmetry — `code` records only via
  // `onInteract`).
  const recordTtyLeaf = (leafId: string) => {
    focusLeaf(leafId);
    if (layoutKinds[layoutLeafIds.indexOf(leafId)] === "tty") recordFocus(focusKey, "tty");
  };
  // The pointerdown variant, event-aware: a press landing INSIDE the docked
  // compose strip is strip interaction, not terminal focus. The record is
  // skipped for it (the textarea's `onFocus` owns the `compose` write) — a
  // re-click on an already-focused textarea fires no focus event, so without
  // this carve-out the tty write would clobber `compose` with no correction.
  // The focused-LEAF highlight still follows the press (the strip is part of
  // the tty tile's frame).
  const focusLeafFromPointer = (leafId: string, target: EventTarget | null) => {
    focusLeaf(leafId);
    if (target instanceof HTMLElement && target.closest("[data-compose-strip]")) {
      return;
    }
    if (layoutKinds[layoutLeafIds.indexOf(leafId)] === "tty") recordFocus(focusKey, "tty");
  };
  useEffect(() => {
    if (focusedKind) reportFocus(focusedId, focusedKind);
  }, [focusedId, focusedKind, reportFocus]);

  // Zoom palette/chord seam (T012/R11 + 260819-qwr7 R7): register the toggle
  // for the parent's `Layout: Expand`/`Restore` palette entries and the ⇧⌘⏎
  // zen chord (flips report via the `onZoomChange` effect above, so those
  // entries rebuild). The toggle zooms the FOCUSED leaf (R7: the chord acts
  // on the tile the user is in) and is a no-op on single-leaf layouts (the
  // clearing effect above immediately unzooms a zoom the tree no longer
  // hosts). Declared after the focused-leaf state — the toggle reads it via a
  // ref.
  const focusedIdRef = useRef(focusedId);
  focusedIdRef.current = focusedId;
  useEffect(() => {
    if (!zoomToggleRef) return;
    zoomToggleRef.current = () =>
      flipZoom(zoomedLeafIdRef.current === null ? focusedIdRef.current : null);
    return () => {
      zoomToggleRef.current = null;
    };
  }, [zoomToggleRef, flipZoom]);

  // Palette focus seam (R10): `Tile: Focus <Surface>` routes through this
  // ref — focus the FIRST leaf of the given kind. No-op for a kind that is
  // not open.
  useEffect(() => {
    if (!focusTileRef) return;
    focusTileRef.current = (kind: SurfaceKind) => {
      const i = leaves(layout).indexOf(kind);
      // An explicit palette choice is a genuine user choice — record it too.
      if (i >= 0) recordTtyLeaf(leafIds(layout)[i]);
    };
    return () => {
      focusTileRef.current = null;
    };
  }, [focusTileRef, layout]);

  // ── Container measure + geometry ─────────────────────────────────────────
  // Tiles are absolutely positioned from `layoutRects` over the measured
  // container; until the first measure (jsdom has no layout) the NOMINAL_BOX
  // proportions render as percentage styles, so an unmeasured mount still
  // lays out sanely.
  const gridRef = useRef<HTMLDivElement>(null);
  const [containerBox, setContainerBox] = useState<Rect | null>(null);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setContainerBox(
        r.width > 0 && r.height > 0 ? { x: 0, y: 0, w: r.width, h: r.height } : null,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const measured = containerBox !== null;
  const box = containerBox ?? NOMINAL_BOX;

  // Sizes: the viewer's stored fractions for this STRUCTURE (keyed by the
  // structure signature — a swap keeps sizes with positions), else the
  // template's own defaults, else equal shares. A drag edits the state live;
  // the persist happens ON RELEASE ONLY. The state carries its signature so a
  // render landing ahead of the reset effect (a restructure beat) falls back
  // instead of misapplying another structure's fractions. The reset keys on
  // the signature STRING — the layout prop's identity changes with every SSE
  // tick, and a same-structure tick must not disturb a live drag.
  const [sizesState, setSizesState] = useState<{ sig: string; sizes: LayoutSizes }>(() => ({
    sig: layoutSig,
    sizes: resolveSizes(layout, readStoredSizes(server, windowId, layout) ?? templateSizes(layout)),
  }));
  useEffect(() => {
    setSizesState({
      sig: layoutSig,
      sizes: resolveSizes(
        layout,
        readStoredSizes(server, windowId, layout) ?? templateSizes(layout),
      ),
    });
    // Keyed on the structure signature, not the layout identity — a
    // same-structure SSE tick must not disturb a live drag.
  }, [server, windowId, layoutSig]);
  const effSizes =
    sizesState.sig === layoutSig ? sizesState.sizes : resolveSizes(layout, templateSizes(layout));
  const sizesRef = useRef(effSizes);
  sizesRef.current = effSizes;
  const sigRef = useRef(layoutSig);
  sigRef.current = layoutSig;

  const rects = layoutRects(layout, box, effSizes, SPLIT_GAP_PX);
  const { dividers, intersections } = layoutDividers(layout, box, effSizes, SPLIT_GAP_PX);
  // Drag frames in `dividers`' enumeration order (the same walk).
  const frames = dividerFrames(layout, box, effSizes, SPLIT_GAP_PX);
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const intersectionsRef = useRef(intersections);
  intersectionsRef.current = intersections;

  // Leaf-rect seam for app.tsx (add + directional swap read real geometry):
  // refilled after EVERY render so the getter always closes over the latest
  // tree, container, and live sizes — the `codeCommandsRef` pattern.
  useEffect(() => {
    if (!layoutRectsRef) return;
    const tree = layout;
    const currentBox = box;
    const currentSizes = effSizes;
    layoutRectsRef.current = () => layoutRects(tree, currentBox, currentSizes, SPLIT_GAP_PX);
    return () => {
      layoutRectsRef.current = null;
    };
  });

  // Absolute placement for a computed rect: px over the measured container,
  // NOMINAL_BOX proportions (percentages) before the first measure.
  const rectStyle = (r: Rect): React.CSSProperties =>
    measured
      ? { left: r.x, top: r.y, width: r.w, height: r.h }
      : {
          left: `${(r.x / NOMINAL_BOX.w) * 100}%`,
          top: `${(r.y / NOMINAL_BOX.h) * 100}%`,
          width: `${(r.w / NOMINAL_BOX.w) * 100}%`,
          height: `${(r.h / NOMINAL_BOX.h) * 100}%`,
        };

  // A divider's style: the 14px hit zone centered on the gutter's seam,
  // spanning the split's extent on the perpendicular axis.
  const dividerStyle = (d: DividerLine): React.CSSProperties => {
    const style = rectStyle(d.rect);
    if (d.dir === "h") {
      // An `h` split's divider is a VERTICAL line: center on x, span y.
      const center = d.rect.x + d.rect.w / 2;
      return {
        ...style,
        left: measured ? center : `${(center / NOMINAL_BOX.w) * 100}%`,
        width: undefined,
      };
    }
    const center = d.rect.y + d.rect.h / 2;
    return {
      ...style,
      top: measured ? center : `${(center / NOMINAL_BOX.h) * 100}%`,
      height: undefined,
    };
  };

  // The first sibling's percentage of the pair — the separator's
  // aria-valuenow.
  const dividerValueNow = (index: number): number => {
    const frame = frames[index];
    const fractions = effSizes[frame.splitIndex];
    const combined = fractions[frame.boundary - 1] + fractions[frame.boundary];
    return Math.round((fractions[frame.boundary - 1] / combined) * 100);
  };

  // Divider drag (R15) — the RightPanel drag-handle pattern, hardened:
  // pointer capture on the handle starts the drag, but mid-drag
  // move/release/cancel are handled by WINDOW-level listeners (the effects
  // below), not the handle's own events — engines can drop element pointer
  // capture while the pointer crosses iframe content (observed on macOS
  // Safari: the seam stops following an up-drag over the web tile), and a
  // window listener still hears every event the parent document gets. Tile
  // content gets `pointer-events: none` mid-drag so iframes can't become the
  // target and steal events into their own document. Tiles stay MOUNTED AND
  // LIVE the whole time (the board pane-resize bug class — no suspension).
  const [draggingDivider, setDraggingDivider] = useState<number | null>(null);
  const dragRef = useRef<{
    index: number;
    el: HTMLElement;
    pointerId: number;
  } | null>(null);

  // The one drag edit: the pointer's axis position maps to the FIRST
  // sibling's fraction of the pair's combined extent, clamped to the 280px
  // floor on both sides; the pair's sum stays constant and no other split or
  // sibling moves. sizesRef is updated SYNCHRONOUSLY (not left for the next
  // render): the intersection drag edits two pairs in one event, and the
  // second edit must compound on the first.
  const applyDividerDrag = (index: number, pointer: number) => {
    const frame = framesRef.current[index];
    if (!frame || frame.len <= 0) return;
    const first = clampSiblingFraction((pointer - frame.start) / frame.len, frame.len);
    const cur = sizesRef.current;
    const arr = cur[frame.splitIndex];
    const combined = arr[frame.boundary - 1] + arr[frame.boundary];
    const next = cur.map((a, i) => (i === frame.splitIndex ? [...a] : a));
    next[frame.splitIndex][frame.boundary - 1] = first * combined;
    next[frame.splitIndex][frame.boundary] = (1 - first) * combined;
    sizesRef.current = next;
    setSizesState({ sig: sigRef.current, sizes: next });
    onRatioChange?.(index, first * 100);
  };

  const onDividerPointerDown =
    (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { index, el: e.currentTarget, pointerId: e.pointerId };
      setDraggingDivider(index);
    };

  const onDividerPointerMove = (e: { clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    const grid = gridRef.current;
    if (!drag || !grid) return;
    const frame = framesRef.current[drag.index];
    if (!frame) return;
    const rect = grid.getBoundingClientRect();
    const axisSize = frame.dir === "h" ? rect.width : rect.height;
    if (axisSize <= 0) return; // unmeasured (jsdom) — no math to do
    applyDividerDrag(drag.index, frame.dir === "h" ? e.clientX - rect.left : e.clientY - rect.top);
  };

  const endDividerDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    // `pointercancel` has already released the capture implicitly — releasing
    // again throws NotFoundError (the RightPanel endDrag lesson).
    if (drag.el.hasPointerCapture(drag.pointerId)) {
      drag.el.releasePointerCapture(drag.pointerId);
    }
    setDraggingDivider(null);
    writeStoredSizes(server, windowId, sigRef.current, sizesRef.current);
    onRatioCommit?.();
  };

  // Latest-closure refs for the window listeners: the effects key on the
  // dragging FLAG only, so without these they would hold the closures from
  // the render the drag started in (stale sizes are already avoided via
  // sizesRef, but writeStoredSizes reads server/windowId props).
  const dividerMoveRef = useRef(onDividerPointerMove);
  dividerMoveRef.current = onDividerPointerMove;
  const dividerEndRef = useRef(endDividerDrag);
  dividerEndRef.current = endDividerDrag;

  useEffect(() => {
    if (draggingDivider === null) return;
    // Window listeners hear EVERY pointer — gate on the captured pointerId so
    // a second touch/pen pointer can't move the seam or end the drag.
    const move = (e: PointerEvent) => {
      if (e.pointerId !== dragRef.current?.pointerId) return;
      dividerMoveRef.current(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== dragRef.current?.pointerId) return;
      dividerEndRef.current();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [draggingDivider]);

  // Intersection zones (260814-011r R3, generalised): one ~20px two-axis
  // handle per point where a divider's end meets a perpendicular divider,
  // z-ordered above the dividers so it wins the junction hit-test. Hover
  // lights BOTH linked sashes (`hotIntersection` → `rk-sash-hot`); drag moves
  // BOTH fraction pairs at once (pointer x/y → each divider on its own axis,
  // each clamped independently), persisted on release via the same
  // writeStoredSizes path. Own pointer handlers — the single-axis machinery
  // above stays untouched — but the same window-level mid-drag routing (and
  // for the same reason).
  const [hotIntersection, setHotIntersection] = useState<number | null>(null);
  const [draggingIntersection, setDraggingIntersection] = useState<number | null>(null);
  const intersectionDragRef = useRef<{
    index: number;
    el: HTMLElement;
    pointerId: number;
  } | null>(null);

  const onIntersectionPointerDown =
    (index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      intersectionDragRef.current = { index, el: e.currentTarget, pointerId: e.pointerId };
      setDraggingIntersection(index);
    };

  const onIntersectionPointerMove = (e: { clientX: number; clientY: number }) => {
    const drag = intersectionDragRef.current;
    const grid = gridRef.current;
    if (!drag || !grid) return;
    const rect = grid.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return; // unmeasured (jsdom)
    const inter = intersectionsRef.current[drag.index];
    if (!inter) return;
    for (const di of inter.dividers) {
      const frame = framesRef.current[di];
      if (!frame) continue;
      applyDividerDrag(di, frame.dir === "h" ? e.clientX - rect.left : e.clientY - rect.top);
    }
  };

  const endIntersectionDrag = (e: { clientX: number; clientY: number }) => {
    const drag = intersectionDragRef.current;
    if (!drag) return;
    intersectionDragRef.current = null;
    // Same pointercancel double-release guard as endDividerDrag.
    if (drag.el.hasPointerCapture(drag.pointerId)) {
      drag.el.releasePointerCapture(drag.pointerId);
    }
    // Capture suppresses the zone's enter/leave for the whole drag, so
    // `hotIntersection` cannot be trusted at release: a drag that clamped
    // (junction stops following the pointer) ends with the pointer off the
    // junction and would strand BOTH sashes hot. Recompute from the release
    // point — an unmeasured rect (jsdom) has no geometry to test.
    const zone = drag.el.getBoundingClientRect();
    if (zone.width > 0 && zone.height > 0) {
      const inside =
        e.clientX >= zone.left &&
        e.clientX <= zone.right &&
        e.clientY >= zone.top &&
        e.clientY <= zone.bottom;
      setHotIntersection(inside ? drag.index : null);
    }
    setDraggingIntersection(null);
    writeStoredSizes(server, windowId, sigRef.current, sizesRef.current);
    onRatioCommit?.();
  };

  // Same latest-closure refs + window routing as the single-axis drag.
  const intersectionMoveRef = useRef(onIntersectionPointerMove);
  intersectionMoveRef.current = onIntersectionPointerMove;
  const intersectionEndRef = useRef(endIntersectionDrag);
  intersectionEndRef.current = endIntersectionDrag;

  useEffect(() => {
    if (draggingIntersection === null) return;
    // Same captured-pointerId gate as the single-axis drag effect.
    const move = (e: PointerEvent) => {
      if (e.pointerId !== intersectionDragRef.current?.pointerId) return;
      intersectionMoveRef.current(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== intersectionDragRef.current?.pointerId) return;
      intersectionEndRef.current(e);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [draggingIntersection]);

  // ── Header drag (drop to snap) ───────────────────────────────────────────
  // A primary-button press on a tile header's BACKGROUND arms a drag; the
  // drag starts only past DRAG_THRESHOLD_PX (below it the press stays the
  // focus click the pointerdown-capture seam already delivered). On start the
  // header captures the pointer and the drag snapshots the tree, the
  // effective sizes, the layout box, and the leaf rects — hit-testing and the
  // resolver run against that snapshot for the drag's duration, with one
  // resolution cached per zone (keyed by hit kind + target + side). Mid-drag
  // routing follows the divider drag's hardening: window-level move/up/cancel
  // gated on the captured pointerId (engines can drop element capture over
  // iframe content), plus a window CAPTURE keydown for Escape. While the drag
  // runs the TileDragContext posture is `move` (the native web guest hides so
  // the overlay can paint over its tile) and tile content goes
  // pointer-events-none.
  const [dragArmedLeaf, setDragArmedLeaf] = useState<string | null>(null);
  const [draggingTile, setDraggingTile] = useState<string | null>(null);
  // The overlay's render input: the latest hit + resolution plus the drag's
  // geometry snapshot (container-relative coordinates).
  const [dropState, setDropState] = useState<{
    hit: DropHit | null;
    result: DropResult;
    rects: Map<string, Rect>;
    box: Rect;
  } | null>(null);
  const tileDragRef = useRef<{
    leafId: string;
    pointerId: number;
    el: HTMLElement;
    startX: number;
    startY: number;
    started: boolean;
    originX: number;
    originY: number;
    box: Rect;
    rects: Map<string, Rect>;
    layout: Layout;
    sizes: LayoutSizes;
    lastKey: string | null;
    result: DropResult;
  } | null>(null);
  // The snapshot reads the CURRENT tree/sizes at threshold-crossing time via
  // refs (the window-listener closures belong to the arming render).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // A drag can start on any desktop, unzoomed, multi-tile render with a fine
  // pointer (the mobile branch renders one tile and never arms) — and only
  // while this viewer has nothing popped: the resolver would run on the
  // reduced tree and the commit would drop the popped leaf from the shared
  // layout for every viewer.
  const canDragTiles =
    !isMobile && !coarsePointer && !zoomed && arity > 1 && poppedSet.size === 0;

  const onTileDragPointerDown = (leafId: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    // Only the header's background arms a drag — buttons, menus, the meta
    // chip, and the pane segment keep their own press behavior.
    if (target.closest("button, [role='menu'], [data-no-tile-drag]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    tileDragRef.current = {
      leafId,
      pointerId: e.pointerId,
      el: e.currentTarget,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      originX: 0,
      originY: 0,
      box: NOMINAL_BOX,
      rects: new Map(),
      layout,
      sizes: [],
      lastKey: null,
      result: { kind: "cancel" },
    };
    setDragArmedLeaf(leafId);
  };

  /** Cross the threshold: snapshot the geometry and enter the drag posture.
   *  False when the container is unmeasured (jsdom) — no geometry to hit-test. */
  const startTileDrag = (d: NonNullable<typeof tileDragRef.current>): boolean => {
    const grid = gridRef.current;
    if (!grid) return false;
    const rect = grid.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    d.layout = layoutRef.current;
    d.sizes = sizesRef.current;
    d.originX = rect.left;
    d.originY = rect.top;
    d.box = { x: 0, y: 0, w: rect.width, h: rect.height };
    d.rects = layoutRects(d.layout, d.box, d.sizes, SPLIT_GAP_PX);
    d.started = true;
    setDraggingTile(d.leafId);
    return true;
  };

  const onTileDragMove = (e: { clientX: number; clientY: number }) => {
    const d = tileDragRef.current;
    if (!d) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD_PX) return;
      if (!startTileDrag(d)) return;
    }
    const point = { x: e.clientX - d.originX, y: e.clientY - d.originY };
    const hit = hitTest(d.rects, d.box, point, d.leafId);
    const key = dropHitKey(hit);
    if (key === d.lastKey) return;
    d.lastKey = key;
    d.result = resolveDrop(d.layout, d.sizes, d.leafId, hit, d.box);
    setDropState({ hit, result: d.result, rects: d.rects, box: d.box });
  };

  /** End the drag: commit only when asked AND the cached resolution is a
   *  `move` (cancel/noop/too-small releases write nothing). Sizes go down
   *  BEFORE the layout write so the first render under the new structure
   *  signature reads them; focus lands on the dragged tile's new position. */
  const endTileDrag = (commit: boolean) => {
    const d = tileDragRef.current;
    if (!d) return;
    tileDragRef.current = null;
    setDragArmedLeaf(null);
    // `pointercancel` has already released the capture implicitly — releasing
    // again throws NotFoundError (the RightPanel endDrag lesson).
    if (d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    if (!d.started) return;
    const result = d.result;
    setDraggingTile(null);
    setDropState(null);
    if (!commit || result.kind !== "move") return;
    writeStoredSizes(server, windowId, structureSig(result.tree), result.sizes);
    onApplyLayout(result.tree);
    focusLeaf(result.destId);
  };

  // Latest-closure refs for the window listeners (the divider drag's
  // pattern): the effect keys on the armed flag only.
  const tileDragMoveRef = useRef(onTileDragMove);
  tileDragMoveRef.current = onTileDragMove;
  const tileDragEndRef = useRef(endTileDrag);
  tileDragEndRef.current = endTileDrag;

  useEffect(() => {
    if (dragArmedLeaf === null) return;
    // Window listeners hear EVERY pointer — gate on the captured pointerId so
    // a second touch/pen pointer can't steer or end the drag.
    const move = (e: PointerEvent) => {
      if (e.pointerId !== tileDragRef.current?.pointerId) return;
      tileDragMoveRef.current(e);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== tileDragRef.current?.pointerId) return;
      tileDragEndRef.current(true);
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== tileDragRef.current?.pointerId) return;
      tileDragEndRef.current(false);
    };
    // Capture phase + stopped propagation: the Escape never reaches the
    // terminal (or any other keydown consumer).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || tileDragRef.current?.started !== true) return;
      e.preventDefault();
      e.stopPropagation();
      tileDragEndRef.current(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, [dragArmedLeaf]);

  // A layout change mid-drag (another viewer's write) makes the snapshot
  // stale — cancel. Compared by SERIALIZED form: the prop's identity turns
  // over with every SSE tick, and a same-structure tick must not disturb a
  // live drag (the sizes effect's signature-keyed precedent).
  useEffect(() => {
    const d = tileDragRef.current;
    if (d?.started && serializeLayoutTree(layout) !== serializeLayoutTree(d.layout)) {
      tileDragEndRef.current(false);
    }
  }, [layout]);

  // ── Sidebar row-drag borrow (drop-catcher) ──────────────────────────────
  // A window-row HTML5 drag (WINDOW_DRAG_MIME — the sidebar's payload is
  // `{server, session, index, windowId, name}` under application/json) arms a
  // transparent catcher overlay above every tile, reusing the header drag's
  // mid-drag seam (tiles pointer-events-none, the native web guest hidden via
  // the TileDragContext `move` posture) and its snapshot discipline: the
  // tree, sizes, layout box and leaf rects are frozen at dragstart, and
  // dragover hit-tests against them with the EXTERNAL-leaf mode of
  // `hitTest`/`resolveDrop` (the dragged tab's `@<windowId>/tty`). The payload
  // is readable at dragstart (sealed only during dragover), so the catcher
  // parses it there. Refused drops preview "no change": the dragged window IS
  // the route window, its `@N/tty` is already in the layout, or the drag's
  // server differs from the route's. The drop writes through `onBorrowDrop`
  // (the parent's borrow helper: plain apply when unheld, the borrow endpoint
  // when held). The sidebar's own consumers (reorder, move-to-session, board
  // pin) are untouched — this only listens.
  const [rowDragActive, setRowDragActive] = useState(false);
  const [rowDropState, setRowDropState] = useState<{
    hit: DropHit | null;
    result: DropResult;
    rects: Map<string, Rect>;
    box: Rect;
  } | null>(null);
  const rowDragRef = useRef<{
    leaf: LayoutLeaf;
    addr: string;
    refused: boolean;
    originX: number;
    originY: number;
    box: Rect;
    rects: Map<string, Rect>;
    layout: Layout;
    sizes: LayoutSizes;
    lastKey: string | null;
    result: DropResult;
  } | null>(null);

  const endRowDrag = () => {
    rowDragRef.current = null;
    setRowDragActive(false);
    setRowDropState(null);
  };
  const rowDragEndRef = useRef(endRowDrag);
  rowDragEndRef.current = endRowDrag;

  useEffect(() => {
    const onDragStart = (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (dt === null || !Array.from(dt.types).includes(WINDOW_DRAG_MIME)) return;
      // While this viewer has a leaf popped the drop would resolve on the
      // REDUCED tree and the commit would drop the popped leaf from the
      // shared layout — the borrow drag stays disarmed (the header drag's
      // rule). The palette's `Tile: Bring … here` remains available — it
      // computes from the full tree.
      if (poppedSetRef.current.size > 0) return;
      const raw = dt.getData("application/json");
      let serverField: string | null = null;
      let windowField: string | null = null;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          if ("server" in parsed && typeof parsed.server === "string") {
            serverField = parsed.server;
          }
          if ("windowId" in parsed && typeof parsed.windowId === "string") {
            windowField = parsed.windowId;
          }
        }
      } catch {
        return; // a foreign JSON payload is not a window row
      }
      if (windowField === null) return;
      const grid = gridRef.current;
      if (!grid) return;
      const rect = grid.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return; // unmeasured (jsdom)
      const tree = layoutRef.current;
      const addr = `${windowField}/tty`;
      rowDragRef.current = {
        leaf: { leaf: "tty", home: windowField },
        addr,
        refused:
          serverField !== server ||
          windowField === windowId ||
          leafIds(tree).includes(addr),
        originX: rect.left,
        originY: rect.top,
        box: { x: 0, y: 0, w: rect.width, h: rect.height },
        rects: layoutRects(tree, { x: 0, y: 0, w: rect.width, h: rect.height }, sizesRef.current, SPLIT_GAP_PX),
        layout: tree,
        sizes: sizesRef.current,
        lastKey: null,
        result: { kind: "cancel" },
      };
      setRowDragActive(true);
    };
    const onDragEnd = () => rowDragEndRef.current();
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [server, windowId]);

  // The row-drag snapshot goes stale on a mid-drag layout change, exactly
  // like the header drag — cancel with no write.
  useEffect(() => {
    const d = rowDragRef.current;
    if (d !== null && serializeLayoutTree(layout) !== serializeLayoutTree(d.layout)) {
      rowDragEndRef.current();
    }
  }, [layout]);

  const onRowDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const d = rowDragRef.current;
    if (!d) return;
    e.preventDefault(); // the catcher accepts the drop — a refused one no-ops
    const point = { x: e.clientX - d.originX, y: e.clientY - d.originY };
    const hit = hitTest(d.rects, d.box, point, d.leaf);
    const result: DropResult = d.refused
      ? hit === null
        ? { kind: "cancel" }
        : { kind: "noop" }
      : resolveDrop(d.layout, d.sizes, d.leaf, hit, d.box);
    d.result = result;
    e.dataTransfer.dropEffect = result.kind === "move" ? "copy" : "none";
    const key = `${d.refused}:${dropHitKey(hit)}`;
    if (key === d.lastKey) return;
    d.lastKey = key;
    setRowDropState({ hit, result, rects: d.rects, box: d.box });
  };

  const onRowDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const d = rowDragRef.current;
    if (!d) return;
    e.preventDefault();
    const result = d.result;
    const addr = d.addr;
    endRowDrag();
    if (result.kind !== "move") return;
    // Sizes go down BEFORE the layout write so the first render under the
    // new structure signature reads them (the header drag's commit order).
    writeStoredSizes(server, windowId, structureSig(result.tree), result.sizes);
    onBorrowDrop?.(addr, result.tree);
    focusLeaf(result.destId);
  };

  // The result-preview overlay: the drop's OUTCOME drawn in the layout
  // container's coordinate space (a same-arrangement drop would lie as a
  // half-tile highlight whenever siblings reshape). `move` draws every leaf
  // rect of the result tree at the result sizes, the dragged tile's
  // destination filled accent-green; `noop`/`too-small` highlight the hovered
  // zone's region; `cancel` draws nothing. One renderer serves both drag
  // species — the tile header drag's state and the sidebar row-drag's.
  const dropOverlay = (() => {
    const state = draggingTile !== null ? dropState : rowDropState;
    if (state === null || state.result.kind === "cancel") {
      return null;
    }
    const { hit, result, rects: snapRects, box: snapBox } = state;
    if (result.kind === "move") {
      const resultRects = layoutRects(result.tree, snapBox, result.sizes, SPLIT_GAP_PX);
      const resultIds = leafIds(result.tree);
      const resultKinds = leaves(result.tree);
      return (
        <div
          data-testid="tile-drop-overlay"
          className="absolute inset-0 z-30 pointer-events-none"
        >
          {resultIds.map((id, i) => {
            const r = resultRects.get(id);
            if (!r) return null;
            const dest = id === result.destId;
            return (
              <div
                key={id}
                data-testid={dest ? "tile-drop-dest" : undefined}
                className={`absolute flex items-center justify-center rounded-md border font-mono text-[11px] ${
                  dest
                    ? "border-accent-green bg-accent-green/15 text-accent-green"
                    : "border-border bg-bg-primary/60 text-text-secondary"
                }`}
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              >
                {SURFACE_GLYPH[resultKinds[i]]} {SURFACE_LABEL[resultKinds[i]]}
              </div>
            );
          })}
        </div>
      );
    }
    const region = zoneRegion(hit, snapRects, snapBox);
    if (!region) return null;
    const tooSmall = result.kind === "too-small";
    return (
      <div
        data-testid="tile-drop-overlay"
        className="absolute inset-0 z-30 pointer-events-none"
      >
        <div
          data-testid={tooSmall ? "tile-drop-too-small" : "tile-drop-noop"}
          className={`absolute flex items-center justify-center rounded-md border font-mono text-[11px] ${
            tooSmall
              ? "border-signal-red bg-signal-red/10 text-signal-red"
              : "border-border bg-bg-inset/60 text-text-secondary"
          }`}
          style={{ left: region.x, top: region.y, width: region.w, height: region.h }}
        >
          {tooSmall ? "Too small" : "No change"}
        </div>
      </div>
    );
  })();

  // ── Per-window transient-state reset ─────────────────────────────────────
  // The parent keys this component by SERVER (a same-server window switch
  // re-renders the mounted grid with a new `windowId` prop — the tty tile's
  // TerminalClient and its xterm instance must survive so the relay's
  // same-session ride applies). Every piece of transient PER-WINDOW state
  // therefore resets HERE, in one effect keyed on [server, windowId], guarded
  // against first mount (the useState initializers already seed the first
  // window's values — re-running them would double-report the focused kind).
  // Sizes keep their own keyed effect (they key on the structure signature,
  // not the window alone); the web-tab override's cleanup runs on dep change.
  const prevWindowKeyRef = useRef(`${server}:${windowId}`);
  useEffect(() => {
    const key = `${server}:${windowId}`;
    if (prevWindowKeyRef.current === key) return; // first mount
    prevWindowKeyRef.current = key;

    // Hide-never-unmount set: exactly the new window's layout leaf ids.
    setEverOpened(leafIds(layout));

    // Zoom: re-derived from the new window's stored key — the same derivation
    // as the useState initializer, WITHOUT writing the key back (it already
    // holds this leaf id; the old window keeps its own zoom).
    const storedZoom = readStoredZoom(server, windowId);
    const zoomLeaf = storedZoom ? resolveZoomLeaf(layout, storedZoom) : null;
    setZoomedLeafId(zoomLeaf);
    zoomedKindRef.current = zoomLeaf !== null ? leafIdParts(zoomLeaf).kind : null;
    // Hand the zoom state over to this window — the reconciliation effect
    // above stays inert until this runs.
    zoomOwnerRef.current = key;

    // Focused leaf: back to the first leaf in reading order, re-reported
    // through the deduped seam — the ref clear makes the report fire even
    // when the kind is unchanged (the parent's mirror was reset on the
    // switch).
    lastReportedFocusRef.current = null;
    focusLeaf(leafIds(layout)[0]);

    // Web page titles (reported up from the iframes on each load): the old
    // window's titles must not headline the new window's web tiles.
    setWebPageTitles(new Map());

    // Tty progress: every slot idle, and cancel a pending rAF commit so a
    // stale value can't land after the reset.
    if (ttyProgressRafRef.current !== null) {
      cancelAnimationFrame(ttyProgressRafRef.current);
      ttyProgressRafRef.current = null;
    }
    ttyProgressRef.current.clear();
    setTtyProgressByWindow(new Map());

    // Find state: closed and cleared. The SearchAddon instance persists with
    // the terminal across the ride, so the old window's decorations must be
    // dropped explicitly. No focus grab — that is the user-close affordance;
    // a switch leaves focus to the shell's focus-restore logic.
    searchAddon?.clearDecorations();
    setFindOpen(false);
    setFindQuery("");
    setFindResults(null);
    setFindRan(false);

    // Interaction state mid-gesture belongs to the window it started on: a
    // divider or intersection drag in flight would otherwise persist its
    // release under the NEW window's sizes key, and an open ⇩ export menu
    // would offer the old window's buffer.
    dragRef.current = null;
    setDraggingDivider(null);
    intersectionDragRef.current = null;
    setDraggingIntersection(null);
    setExportMenuPos(null);
    // An armed or in-flight tile drag belongs to the window it started on —
    // the normal end path (capture release included), never a commit.
    tileDragEndRef.current(false);
  }, [server, windowId, layout]);

  /** A tile's renderer, unchanged from the legacy lens/panel mounts. The
   *  iframe tiles (code, web) also wire the focus seam (260812-wfic R2):
   *  in-frame pointerdowns/keydowns stay in the frame's document and moving
   *  focus into a frame fires NO focusin in the parent, so each iframe
   *  surface reports its own interaction via `onInteract` (contentDocument
   *  listeners same-origin; `IframeWindow` adds a window-blur fallback for
   *  cross-origin content). Every per-tile read/write targets the tile's OWN
   *  window (`tileWindowIdOf` — a foreign leaf's home): the tty tile's relay
   *  stream, focus registration and progress slot; the web tile's tab family;
   *  the code tile's root and frame record. */
  const renderContent = (
    tile: TileModel,
    hidden: boolean,
  ) => {
    const { kind, leafId, visible } = tile;
    const tileWinId = tileWindowIdOf(leafId, windowId);
    const foreign = leafIdParts(leafId).home !== undefined;
    switch (kind) {
      case "tty": {
        const primaryTty = visible && leafId === firstBareTtyLeafId;
        // The FOCUSED tty tile (bare or foreign) registers as the shell's
        // focused terminal with its own server/session/window/wsRef bucket, so
        // the compose strip's send target, the bottom bar's keys, and focus
        // memory follow it. While a non-tty tile is focused the primary bare
        // tty holds the slot (the pre-cross-tab behavior — the strip keeps a
        // target); a foreign tty never takes the shared wsRef/focusRef holder.
        const registersFocus =
          visible && (focusedKind === "tty" ? leafId === focusedId : primaryTty);
        return (
          <div className="flex-1 min-h-0 py-0.5 px-1 flex flex-col">
            <TerminalClient
              sessionName={tileSessionFor(tileWinId)}
              windowId={tileWinId}
              server={server}
              // A foreign tile's stream opens isolated (its home window's
              // `_rk-iso-*` session) so it never fights the home tab's own
              // attach; bare streams omit the flag. A POPOUT's stream
              // isolates too (popoutTile): the popout keeps its window while
              // the opener's session switches windows. Fixed per mount — a
              // tile retargeting remounts (the leaf's home is in its React
              // key).
              isolate={foreign || popoutTile}
              switchReceiptSource={primaryTty}
              clearOnRide={clearOnWindowChange}
              hidden={hidden}
              wsRef={primaryTty ? wsRef : ttyWsRefFor(leafId)}
              onSessionNotFound={primaryTty ? onSessionNotFound : undefined}
              focusRef={primaryTty ? focusRef : undefined}
              searchAddonRef={primaryTty ? searchAddonRef : undefined}
              serializeAddonRef={primaryTty ? serializeAddonRef : undefined}
              terminalRef={primaryTty ? ttyTerminalRef : undefined}
              scrollLocked={scrollLocked}
              registerFocus={registersFocus}
              // Every tty mount feeds its TILE WINDOW's progress slot:
              // duplicates of one window fold idempotently into it, and a
              // foreign tty's progress renders on its own tile.
              onProgressChange={(state, value) => handleTtyProgress(tileWinId, state, value)}
            />
          </div>
        );
      }
      case "web":
        return (
          <WebTileContent
            server={server}
            sessionName={tileSessionFor(tileWinId)}
            windowId={tileWinId}
            win={windowRecordFor(tileWinId)}
            visible={visible}
            webCapture={webCapture}
            onInteract={() => focusLeaf(leafId)}
            onPageTitle={(title) =>
              setWebPageTitles((prev) => {
                if (prev.get(tileWinId) === title) return prev;
                const next = new Map(prev);
                next.set(tileWinId, title);
                return next;
              })
            }
            // Web-kind reclaim predicate (260819-ie2i R3): the single
            // renderContent site is the ONLY IframeWindow mount path, so every
            // leaf/zoom rendering inherits the wiring with no fork.
            shouldReclaimChord={shouldReclaimChord?.("web")}
          />
        );
      case "code": {
        const frame = tile.frame;
        const frameWindowId = frame?.windowId ?? tileWinId;
        const isTileWindowFrame = frameWindowId === tileWinId;
        // The code root (`codeRootFor`): the shared `@rk_win_code_root` when
        // set, the derived gitRoot pre-seed — a pane switch can neither null
        // this tile nor retarget the editor; the live derivation only ever
        // seeds it (the parent's seed effect, on first code-tile render). A
        // retained frame keeps ITS window's baseline root. A foreign code
        // tile reads its HOME window's record.
        const codeRoot = frame ? frame.root : codeRootFor(windowRecordFor(tileWinId));
        return codeRoot ? (
          <CodeSurface
            gitRoot={codeRoot}
            // The mount src comes from the frame RECORD once one exists —
            // fixed at creation (the mount-generation rule). Before the
            // record exists the tile pends (null), exactly the pre-retention
            // pending state.
            workspaceSrc={frame ? frame.src : null}
            // The follow override only ever targets the frame of the window
            // the follow was issued for (carried on the payload).
            followSrc={
              isTileWindowFrame && codeFollowSrc && codeFollowSrc.windowId === frameWindowId
                ? codeFollowSrc
                : null
            }
            // The Reload editor verb's nonce reaches only the frame it
            // targeted — every other frame receives undefined, and a frame
            // created later pre-sees the current value at mount (CodeSurface
            // owns that rule), so nothing ever replays a reload.
            reloadNonce={
              frame && frame.windowId === codeReload?.windowId ? codeReload.nonce : undefined
            }
            // Per-frame rescue fetcher: a retained frame's verdict can fire
            // after its window stopped being active — it reads ITS window's
            // bridge status.
            fetchBridgeStatus={fetchBridgeStatusFor?.(frameWindowId)}
            reachable={codeReachable}
            onRestart={onCodeServerRestart}
            shouldReclaimChord={shouldReclaimChord?.("code")}
            onInteract={
              visible
                ? () => {
                    focusLeaf(leafId);
                    // An in-frame keydown/pointerdown is GENUINE interaction
                    // — the only seam allowed to record `code` (a
                    // programmatic grab never produces one) — and it ends
                    // the protected post-switch window.
                    recordFocus(focusKey, "code");
                    disarmGuard(focusKey);
                  }
                : undefined
            }
            // A retained (other-tile-window) frame is display-hidden and can
            // neither receive focus nor navigate — its focus/follow seams
            // stay unbound so nothing can ever record against the ROUTE
            // window's focus-memory key from a hidden frame.
            onProgrammaticFocus={isTileWindowFrame ? onProgrammaticFocus : undefined}
            onFolderNavigated={
              isTileWindowFrame
                ? // The shared follow wrapper records the pending target
                  // synchronously with the report — the eviction effect's
                  // read of it decides follow-vs-external-divergence.
                  (folder) => void requestCodeFollow(frameWindowId, folder, onCodeFolderNavigated)
                : undefined
            }
          />
        ) : null;
      }
      case "review": {
        // PR-backed only: availability upstream guarantees a prUrl, so a
        // missing one renders nothing rather than an empty-state the toggle
        // should never have offered. A foreign review tile reads its HOME
        // window's PR and digest.
        const reviewWin = windowRecordFor(tileWinId);
        const prUrl = reviewWin?.prUrl ?? "";
        if (!prUrl) return null;
        return (
          <ReviewSurface
            server={server}
            windowId={tileWinId}
            prUrl={prUrl}
            // The SSE tick's revalidation signal (pushed, never polled).
            digestUnhandled={reviewWin?.prReviewUnhandled ?? 0}
            // The palette's `Review:` verbs and the surface toggle's dot are
            // the ROUTE window's: only the bare tile binds them, so a foreign
            // review tile can never clobber the seams.
            commandsRef={foreign ? undefined : reviewCommandsRef}
            onUnhandledChange={foreign ? undefined : onReviewUnhandledChange}
            onListeningChange={foreign ? undefined : onReviewListeningChange}
          />
        );
      }
      case "diff": {
        // Repo-backed only: availability upstream guarantees a gitRoot, so a
        // missing one renders nothing rather than an empty state the toggle
        // should never have offered. A foreign working tile reads its HOME
        // window's repo, which is the tree that window is actually sitting in.
        const diffWin = windowRecordFor(tileWinId);
        const gitRoot = diffWin?.gitRoot ?? "";
        if (!gitRoot) return null;
        return <WorkingSurface server={server} windowId={tileWinId} gitRoot={gitRoot} />;
      }
      case "gui": {
        // The gui tile mirrors the code seam grammar, minus the steal guard
        // (noVNC grabs focus only on click, never programmatically). The tile
        // stays MOUNTED when closed/zoomed away (hide-never-unmount) —
        // `visible` is a prop; GuiSurface's 15s hidden-disconnect owns the
        // framebuffer traffic. `null` gui (no event yet) renders nothing —
        // availability gating upstream should already have kept the tile out.
        if (!gui || !onGuiConnection || !onGuiRestart || !onGuiOpenLogs) {
          return null;
        }
        return (
          <Suspense
            fallback={
              <div
                data-testid="gui-surface-pending"
                className="flex-1 min-h-0 flex items-center justify-center text-text-secondary text-xs font-mono select-none"
              >
                opening…
              </div>
            }
          >
            <GuiSurface
              gui={gui}
              visible={!hidden && tile.visible}
              focused={tile.visible && leafId === focusedId}
              coarsePointer={coarsePointer}
              zoom={guiZoom}
              pointerMode={guiPointerMode ?? (coarsePointer ? "trackpad" : "touch")}
              onZoomChange={onGuiZoomChange ?? (() => {})}
              onPointerModeChange={onGuiPointerModeChange ?? (() => {})}
              hidpi={guiHidpi}
              keyBarVisible={guiKeyBarVisible}
              onKeyBarVisibleChange={onGuiKeyBarVisibleChange ?? (() => {})}
              onFullscreenChange={setGuiTileFullscreen}
              resizeLocked={guiResizeLocked}
              quality={guiQuality}
              statsVisible={guiStatsVisible}
              onQualityChange={onGuiQualityChange ?? (() => {})}
              onStatsVisibleChange={onGuiStatsVisibleChange ?? (() => {})}
              onConnectionChange={onGuiConnection}
              onRestart={onGuiRestart}
              onOpenLogs={onGuiOpenLogs}
              commandsRef={guiCommandsRef}
              shouldReclaimChord={shouldReclaimChord?.("gui")}
              onInteract={
                tile.visible
                  ? () => {
                      focusLeaf(leafId);
                      // Canvas pointerdown/keydown is GENUINE interaction —
                      // the same seam that records `code` records `gui`.
                      recordFocus(focusKey, "gui");
                      disarmGuard(focusKey);
                    }
                  : undefined
              }
            />
          </Suspense>
        );
      }
    }
  };

  // Tile models: every VISIBLE leaf plus every ever-opened leaf id that is
  // currently closed (hidden), plus every RETAINED code frame (a record no
  // mounted code tile claims). The React key is stable per leaf id across the
  // visible↔hidden transition — THAT is what makes hide-never-unmount survive
  // React reconciliation. A bare tty tile's key is additionally
  // WINDOW-INDEPENDENT: it must survive a same-server window switch (the grid
  // is keyed by server) so the terminal's same-session ride keeps its xterm
  // instance and stream; a FOREIGN tty tile's key carries its home window — a
  // retargeted leaf remounts (its isolated stream's window is fixed at
  // mount). The code tile is likewise window-independent, keyed by its frame
  // record (`code:<windowId>:<src>` — the src is fixed at creation; the
  // window id rides along because the `?folder=` degrade form is
  // folder-keyed, so src alone is not unique): a same-server switch re-renders
  // the mounted frame instead of unmounting it (an iframe unmount is a page
  // unload — code-server kills the workbench). A code tile with no record yet
  // (src pending) keys as `code:pending:<window>` — no iframe exists to lose
  // on the pending→resolved remount. web/gui tiles keep their TILE window in
  // the key (per-url iframes, the gui RFB session — content identity changes
  // with the tile's window).
  const visibleTiles: TileModel[] = layoutLeafIds.map((leafId, i) => {
    const kind = layoutKinds[i];
    return {
      kind,
      leafId,
      occ: leafIdParts(leafId).occ,
      visible: true,
      frame: kind === "code" ? frameForWindow(tileWindowIdOf(leafId, windowId)) : undefined,
    };
  });
  const ttyLeafIds = layoutLeafIds.filter((id) => leafIdParts(id).kind === "tty");
  // The primary tty — the shared wsRef/focusRef/find/export seams' holder — is
  // the first BARE tty leaf; a foreign tty opens its own isolated stream and
  // never takes the holder.
  const firstBareTtyLeafId =
    ttyLeafIds.find((id) => leafIdParts(id).home === undefined) ?? null;
  // The in-tile compose dock's host: the first bare tty when one exists, else
  // the first tty leaf — a layout of only foreign tty tiles still docks the
  // strip in-tile (its send target follows the focused terminal).
  const dockTtyLeafId = firstBareTtyLeafId ?? ttyLeafIds[0] ?? null;
  const hiddenTiles: TileModel[] = hiddenLeafIds
    .filter((id) => !layoutLeafIds.includes(id))
    // A popped code leaf renders NO hidden tile: its retained frame is
    // evicted (the popout boots its own extension host), so there is nothing
    // to keep mounted. A popped web leaf under a shell with the popout
    // channel unmounts the same way: its native guest PARKS on unmount and
    // the popout window adopts the live guest — a mounted-hidden tile would
    // keep the guest's tabKey binding and block the move, and its hide
    // would stale the guest's visibility record. Other popped leaves keep
    // the hide-never-unmount posture (the hidden gui tile's RFB disconnects
    // via its visibility gate).
    .filter(
      (id) =>
        !(
          poppedSet.has(id) &&
          (leafIdParts(id).kind === "code" ||
            (leafIdParts(id).kind === "web" && canShellPopout()))
        ),
    )
    .map((leafId) => ({
      kind: leafIdParts(leafId).kind,
      leafId,
      occ: leafIdParts(leafId).occ,
      visible: false,
      frame:
        leafIdParts(leafId).kind === "code"
          ? frameForWindow(tileWindowIdOf(leafId, windowId))
          : undefined,
    }));
  // Retained frames render as display-hidden tiles through the same flat
  // list — closing the code tile in a window keeps its frame retained (it
  // keeps counting toward the cap), and a switch away demotes the visible
  // tile to here WITHOUT a key change.
  const retainedCodeTiles: TileModel[] = codeFrames
    .filter((r) => !mountedCodeWindowIds.includes(r.windowId))
    .map((record) => ({ kind: "code", leafId: "code", occ: 0, visible: false, frame: record }));

  const renderTile = (
    tile: TileModel,
    hidden: boolean,
    mobile: boolean,
  ) => {
    const { kind, leafId, occ } = tile;
    const leafHome = leafIdParts(leafId).home;
    const tileWinId = tileWindowIdOf(leafId, windowId);
    const tileWin = windowRecordFor(tileWinId);
    // A bare leaf whose surface is live in another tab renders the away
    // placeholder INSTEAD of the surface — the mount itself is gated here, so
    // an away tty opens no relay stream.
    const awayHolderId =
      tile.visible && leafHome === undefined ? awayHolderFor(kind) : undefined;
    // A revealed popped leaf renders the popped placeholder under the same
    // mount gate: no header, no relay stream, no code frame, no web guest —
    // the popout owns the live surface.
    const poppedPlaceholder = tile.visible && revealedPoppedSet.has(leafId);
    // The foreign tile's home tab: its record (dead when absent from the map)
    // and display name — the header identifies the home by it.
    const homeWindow = leafHome !== undefined ? (windowsById?.get(leafHome) ?? null) : null;
    const homeName = leafHome === undefined ? "" : (homeWindow?.name ?? leafHome);
    // The home-tab identification chip (R14): a foreign tile's header names
    // the tab its surface belongs to.
    const homeChip =
      leafHome === undefined ? null : (
        <span
          data-no-tile-drag
          data-testid="tile-home"
          className="shrink-0 truncate rounded px-1.5 text-[10px] bg-bg-card text-text-secondary"
        >
          {homeName}
        </span>
      );
    // Locator/testid suffix: a foreign leaf carries its home (`-@3`); a
    // duplicate bare tty its occurrence (`-2`). Never both — foreign
    // addresses are unique per layout.
    const suffix = leafHome !== undefined ? `-${leafHome}` : occ > 0 ? `-${occ + 1}` : "";
    // A retained (unclaimed-window) code frame must NOT share a mounted
    // tile's testid — `surface-tile-code` stays unique for locators; the
    // retained wrapper disambiguates by `data-window-id`.
    const retainedCode =
      kind === "code" && tile.frame !== undefined && !mountedCodeWindowIds.includes(tile.frame.windowId);
    const testId = retainedCode ? "surface-tile-code-retained" : `surface-tile-${kind}${suffix}`;
    const label = SURFACE_LABEL[kind];
    // The keyboard-capture latch swaps the gui meta chip to its CONSEQUENCE
    // label — words, not hue alone: green wash + ink, no ring (a label, not
    // a control).
    const guiCaptured = kind === "gui" && guiCapture;
    const meta = guiCaptured ? "keys → desktop" : tileMeta(kind, tileWin, gui);
    // The web capture latch renders its own consequence chip (`keys → page`)
    // — the web header's meta slot doubles as the page-title fallback, so the
    // gui's meta-swap can't carry it; same styling (a label, not a control).
    const webCaptured = kind === "web" && webCapture;
    // The tile window's progress slot (a foreign tty's chip/line render on
    // its own tile, never the route window's).
    const tileProgress =
      kind === "tty" ? (ttyProgressByWindow.get(tileWinId) ?? IDLE_PROGRESS) : IDLE_PROGRESS;
    // The header chip renders only for the value-carrying states (1/2/4) —
    // indeterminate sweeps with no percentage, idle removes it.
    const ttyChip = isValuedProgress(tileProgress)
      ? { value: tileProgress.value, cls: PROGRESS_CHIP_CLASS[tileProgress.kind] }
      : null;
    // The tty header's status dot reads the TILE window's record (a foreign
    // tty shows its home window's status).
    const tileStatusWindow: WindowInfo | null =
      kind !== "tty" ? null : tileWinId === windowId ? (statusWindow ?? null) : (windowsById?.get(tileWinId) ?? null);
    // Web tile header (260819-v6y4 R10): a kind badge (hues per the approved
    // design study — green=present, amber=proxied port, blue=external) plus
    // the page title reported up from the iframe, falling back to the
    // address's display form. The `relative` kind renders no badge (the plain
    // label + meta fallback below covers it). An ONBOARDING web tile
    // (empty/whitespace active web tab, 260821-zqlq) renders the plain
    // `://  Web` label — no badge, no page title, no meta chip; the badge
    // derivation is trimmed-keyed so empty input never reaches
    // classifyAddress. All inputs read the TILE window's record.
    const webUrl = activeWebUrl(tileWin).trim();
    // The code tile's per-window verb predicates (the tile window's own
    // drift/frame state — a foreign code tile reads its home window).
    const tileCodeFollowTarget = kind === "code" ? codeFollowTargetFor(tileWinId) : null;
    const tileCodeFrameMounted = kind === "code" && codeFrameMountedFor(tileWinId);
    const webBadge: { text: string; cls: string } | null = (() => {
      if (kind !== "web" || webUrl === "") return null;
      const kindOf = classifyAddress(webUrl);
      if (kindOf === "present") {
        return { text: "present", cls: "text-accent-green border-accent-green/40 bg-accent-green/10" };
      }
      if (kindOf === "proxy") {
        const port = proxyPortOf(webUrl);
        return {
          text: `:${port ?? "?"} proxy`,
          cls: "text-signal-yellow border-signal-yellow/40 bg-signal-yellow/10",
        };
      }
      if (kindOf === "external") {
        return { text: "external", cls: "text-signal-blue border-signal-blue/40 bg-signal-blue/10" };
      }
      return null;
    })();
    const isZoomed = zoomed && tile.visible && leafId === zoomedLeafId;
    // The fullscreened gui tile suppresses its layout verbs (the zoomed-tile
    // precedent) — ⤢ latched green is the exit.
    const showVerbs = !mobile && arity > 1 && tile.visible && !(kind === "gui" && guiTileFullscreen);
    // Pop out (spec surface-layout.md § Verbs → Pop out): a content-verb
    // family member rendered ahead of the layout-verb cluster, at ANY arity —
    // popping the only tile lands the opener on the all-popped placeholder.
    // Fine pointers only, and LIVE tiles only — the away placeholder renders
    // no header at all (the mount gate above), and a foreign tile whose home
    // window died has nothing to pop (the read-time prune drops it on the
    // next payload). A shell without the `windows.popout` channel gates
    // upstream (the caller omits onPopOut): the shell's window.open policy
    // sends everything to the system browser, which shares neither
    // localStorage nor the BroadcastChannel with the opener.
    const canPopOutTile =
      !popoutTile &&
      !mobile &&
      tile.visible &&
      !(kind === "gui" && guiTileFullscreen) &&
      !coarsePointer &&
      onPopOut !== undefined &&
      !(leafHome !== undefined && homeWindow === null);
    // Focused-tile highlight (260812-wfic R2): accent-green border + kind
    // glyph, suppressed at arity 1 (no verbs, no highlight — the tmux
    // active-pane metaphor). Focus assignment: the wrapper's pointerdown
    // (capture) + focusin seams hear parent-DOM interaction ONLY — no
    // parent-document event fires when the user clicks or types inside an
    // iframe — so the iframe tiles (code, web) report in-frame interaction
    // via their `onInteract` callbacks.
    const isFocused = !mobile && arity > 1 && tile.visible && leafId === focusedId;
    // The header ⤢ fires the palette's `gui-fullscreen` row by id (D9 — no
    // header-only action).
    const guiFullscreenRow =
      kind === "gui" ? guiActions.find((a) => a.id === "gui-fullscreen") : undefined;
    // Absolute placement from the leaf's rect; a zoomed render fills the
    // container. Mobile tiles are flex-sized instead (see the className).
    const rect = rects.get(leafId);
    const positionStyle: React.CSSProperties | undefined =
      hidden || mobile
        ? undefined
        : isZoomed
          ? { left: 0, top: 0, width: "100%", height: "100%" }
          : rectStyle(rect ?? box);
    return (
      <div
        key={
          kind === "tty"
            ? // A bare tty's key is window-independent (the same-session ride
              // survives a window switch); a foreign tty's carries its home —
              // a retargeted leaf remounts, since the isolated stream's
              // window is fixed at mount.
              leafHome !== undefined
              ? `tty:${leafHome}`
              : `${kind}${suffix}`
            : kind === "code"
              ? // The frame's window id is in the key: `?workspace=` srcs are
                // tab-keyed but the `?folder=` degrade form is FOLDER-keyed —
                // two windows rooted at the same folder whose derivations both
                // degrade would otherwise produce identical keys. No leaf
                // suffix: one frame per window, so a borrowed code tile keeps
                // the home window's retained frame mounted (no remount).
                `code:${tile.frame ? `${tile.frame.windowId}:${tile.frame.src}` : `pending:${tileWinId}`}`
              : `${kind}${suffix}:${tileWinId}`
        }
        data-testid={testId}
        {...(retainedCode ? { "data-window-id": tile.frame?.windowId } : {})}
        // Mobile tiles MUST carry flex-1: the single visible leaf fills the
        // column. Without it the tile is content-sized — xterm's own canvas
        // becomes the measure, a stable fixed point (canvas sizes tile sizes
        // fit sizes canvas) that pins the terminal at its 80×24 default and
        // makes it deaf to every viewport change (iOS keyboard collapse).
        // Desktop tiles are absolutely positioned from their leaf rects.
        className={`group min-w-0 min-h-0 flex-col overflow-hidden ${hidden ? "hidden" : "flex"}${
          mobile
            ? " flex-1"
            : // Gap-seam card (260814-011r R1): 6px radius; the REST border is
              // the dimmed 55% `rk-card-border` (the gap separates, the border
              // defines the card edge) — the focused tile keeps the full
              // accent-green frame (260812-wfic R2, suppressed at arity 1).
              ` absolute border rounded-md ${isFocused ? "border-accent-green" : "rk-card-border"}${
                // The dragged tile dims for the drag's duration — the overlay
                // previews where it lands.
                draggingTile === leafId ? " opacity-50" : ""
              }`
        }`}
        style={positionStyle}
        onPointerDownCapture={
          tile.visible ? (e) => focusLeafFromPointer(leafId, e.target) : undefined
        }
        onFocus={
          tile.visible
            ? () => {
                // Steal guard (no-flip half): Chromium fires NO parent-side
                // iframe event for a script `focus()` grab, but engines that
                // do would flip the focused leaf to `code` here — while the
                // guard is armed and the remembered kind is not `code`, an
                // iframe focusin is the grab, not a user choice, so skip the
                // flip (the `onProgrammaticFocus` revert restores the
                // remembered focus). A genuine click-in arrives via
                // onPointerDownCapture first and the in-frame `onInteract`
                // disarms the guard, so real editor focus is never blocked.
                if (
                  kind === "code" &&
                  isGuardArmed(focusKey) &&
                  recallFocus(focusKey) !== "code"
                ) {
                  return;
                }
                focusLeaf(leafId);
              }
            : undefined
        }
      >
        {/* Header px-1.5: the rail divider is a MINOR seam with ~6px air on
            both sides (the rail's chips hug it at the same distance on their
            side) — only the window edge carries the 12px major-seam inset.
            h-[35px] = 32px content + the 3px bottom rule: the sidebar's icon
            rail is 32px tall and the panel below it opens with border-t-[3px],
            so both horizontal rules start 32px below the card top at the same
            chrome-rule weight (top bar, bottom bar, and sidebar panels all use
            3px rules). The background is the drag-to-snap grip surface:
            cursor-grab when a drag can arm, grabbing mid-drag. */}
        {!mobile && awayHolderId === undefined && !poppedPlaceholder && (
          <div
            onPointerDown={canDragTiles ? onTileDragPointerDown(leafId) : undefined}
            className={`flex items-center gap-1.5 px-1.5 h-[35px] shrink-0 border-b-[3px] border-border bg-bg-primary font-mono text-[11px] text-text-secondary select-none ${
              draggingTile === leafId
                ? "cursor-grabbing"
                : canDragTiles
                  ? "cursor-grab"
                  : ""
            }`}
          >
            {kind === "tty" && tileStatusWindow && <StatusDot win={tileStatusWindow} />}
            {kind === "tty" && ttyChip && (
              <span
                data-testid="progress-chip"
                className={`shrink-0 rounded border px-1.5 text-[10px] tabular-nums ${ttyChip.cls}`}
              >
                {ttyChip.value}%
              </span>
            )}
            <span
              aria-hidden="true"
              className={`shrink-0 ${isFocused ? "text-accent-green" : ""}`}
            >
              {SURFACE_GLYPH[kind]}
            </span>
            {webBadge ? (
              <>
                <span
                  data-testid="web-kind-badge"
                  className={`shrink-0 rounded border px-1.5 text-[10px] ${webBadge.cls}`}
                >
                  {webBadge.text}
                </span>
                <span className="min-w-0 truncate text-text-primary">
                  {webPageTitles.get(tileWinId) ?? meta}
                </span>
                {homeChip}
              </>
            ) : (
              <>
                <span className="shrink-0 text-text-primary">{label}</span>
                {homeChip}
                {meta && (
                  <span
                    data-no-tile-drag
                    className={`min-w-0 truncate rounded px-1.5 text-[10px] ${
                      guiCaptured
                        ? "bg-accent-green/15 text-accent-green"
                        : "bg-bg-card text-text-secondary"
                    }`}
                  >
                    {meta}
                  </span>
                )}
              </>
            )}
            {webCaptured && (
              <span
                data-testid="web-capture-chip"
                data-no-tile-drag
                className="shrink-0 rounded px-1.5 text-[10px] bg-accent-green/15 text-accent-green"
              >
                keys → page
              </span>
            )}
            {/* rk-slot: gui-fold — the gui tile's session controls live in
                the header spring as a measured priority fold (gui-toolbar.tsx,
                the tty branch's sibling slot). The cluster owns the whole
                spring (its root is the fold's measured budget). */}
            {kind === "gui" && gui ? (
              <GuiToolbar
                actions={guiActions}
                coarsePointer={coarsePointer}
                quality={guiQuality}
                statsVisible={guiStatsVisible}
                capture={guiCapture}
                geometry={gui.geometry}
                width={gui.width}
                height={gui.height}
                locked={gui.locked}
                toolbarVisible={guiToolbarVisible}
                onToolbarVisibleChange={onGuiToolbarVisibleChange ?? (() => {})}
              />
            ) : (
              <span className="flex-1" />
            )}
            {/* The gui fullscreen verb (⤢) rides the header rail like the tty
                find button — any arity, latched green while the tile is
                fullscreen (the layout verbs suppress instead). One hairline
                separates the session cluster from the tile verbs. */}
            {kind === "gui" && gui && tile.visible && (
              <>
                <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                <Tip label={guiTileFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
                  <button
                    type="button"
                    aria-label={guiTileFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                    aria-pressed={guiTileFullscreen}
                    disabled={!guiFullscreenRow}
                    onClick={() => guiFullscreenRow?.onSelect()}
                    className={controlClass({
                      variant: "toggle",
                      base: VERB_BUTTON_BASE,
                      rest: "hover:bg-bg-card hover:text-text-primary",
                      ringed: true,
                      pressed: guiTileFullscreen,
                      disabled: !guiFullscreenRow,
                    })}
                  >
                    <FullscreenGlyph />
                  </button>
                </Tip>
              </>
            )}
            {/* rk-slot: find-button — ⌕ opens the tty find bar (the web ⌕
                vocabulary: aria-pressed + accent-green while open). Primary
                tty leaf only — duplicate tty tiles and other kinds render no
                find affordance (the wsRef/focusRef primary-only precedent). */}
            {kind === "tty" && leafId === firstBareTtyLeafId && (
              <Tip label="Find in terminal">
                <button
                  type="button"
                  aria-label="Find in terminal"
                  aria-pressed={findOpen}
                  onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
                  className={controlClass({
                    variant: "toggle",
                    base: VERB_BUTTON_BASE,
                    rest: "hover:bg-bg-card hover:text-text-primary",
                    ringed: true,
                    pressed: findOpen,
                  })}
                >
                  <FindGlyph />
                </button>
              </Tip>
            )}
            {kind === "tty" && tile.visible && leafId === firstBareTtyLeafId && (
              <>
                <Tip label="Export terminal output">
                  <button
                    type="button"
                    ref={exportButtonRef}
                    aria-label="Export terminal output"
                    aria-haspopup="menu"
                    aria-expanded={exportMenuPos !== null}
                    onClick={toggleExportMenu}
                    className={controlClass({
                      variant: "toggle",
                      base: VERB_BUTTON_BASE,
                      rest: "hover:bg-bg-card hover:text-text-primary",
                      ringed: true,
                      pressed: exportMenuPos !== null,
                    })}
                  >
                    <ExportGlyph />
                  </button>
                </Tip>
                {exportMenuPos && (
                  <div
                    ref={exportMenuRef}
                    role="menu"
                    aria-label="Export terminal output"
                    data-testid="export-menu"
                    className="fixed z-50 flex flex-col w-max bg-bg-card border border-border rounded-md rk-popup-elev px-2 py-1.5 text-[11px] font-mono select-none"
                    style={{ top: exportMenuPos.top, right: exportMenuPos.right }}
                  >
                    <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-text-secondary">
                      This view — client buffer
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={pickExport("snapshot")}
                      className="flex items-center justify-between gap-6 rounded px-1.5 py-1 text-left text-text-primary hover:bg-bg-inset"
                    >
                      <span>Download snapshot</span>
                      <span className="text-text-secondary">.html · colors kept</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={pickExport("transcript")}
                      className="flex items-center justify-between gap-6 rounded px-1.5 py-1 text-left text-text-primary hover:bg-bg-inset"
                    >
                      <span>Download transcript</span>
                      <span className="text-text-secondary">.txt · buffer text</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={pickExport("copy-visible")}
                      className="flex items-center justify-between gap-6 rounded px-1.5 py-1 text-left text-text-primary hover:bg-bg-inset"
                    >
                      <span>Copy visible screen</span>
                    </button>
                    <div aria-hidden="true" className="my-1 h-px bg-border" />
                    <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-text-secondary">
                      Full history — server capture
                    </div>
                    {/* Honest row (260820-4le0): an alt-screen active pane holds
                        no tmux scrollback, so the capture would return a
                        near-empty artifact — disable with the reason instead of
                        silently shipping it. */}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={statusWindow?.altScreen === true}
                      aria-disabled={statusWindow?.altScreen === true}
                      onClick={pickExport("history")}
                      className="flex items-center justify-between gap-6 rounded px-1.5 py-1 text-left text-text-primary hover:bg-bg-inset disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <span>Download pane history</span>
                      <span className="text-text-secondary">
                        {statusWindow?.altScreen === true
                          ? "agent TUI on alternate screen — tmux holds no scrollback"
                          : ".txt · capture-pane -S -"}
                      </span>
                    </button>
                  </div>
                )}
              </>
            )}
            {/* Pane segment (260813-w1lf content verbs): tty tiles carry a
                bordered group of PANE verbs — Split H · Split V · Close Pane —
                at ANY arity (including the bare `tty` leaf, which renders no
                layout verbs), visible while zoomed. A hairline separates it
                from the layout-verb cluster when that renders (arity > 1). */}
            {!mobile && kind === "tty" && tile.visible && onSplitPane && onClosePane && (
              <>
                <div
                  data-testid="pane-segment"
                  data-no-tile-drag
                  className="inline-flex items-center h-[26px] rounded border border-border"
                >
                  <Tip label="Split pane horizontally">
                    <button
                      type="button"
                      aria-label="Split pane horizontally"
                      onClick={() => onSplitPane(true, tileWinId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                    >
                      <SplitHorizontalGlyph />
                    </button>
                  </Tip>
                  <Tip label="Split pane vertically">
                    <button
                      type="button"
                      aria-label="Split pane vertically"
                      onClick={() => onSplitPane(false, tileWinId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                    >
                      <SplitVerticalGlyph />
                    </button>
                  </Tip>
                  <Tip label="Close pane — kills the tmux pane">
                    <button
                      type="button"
                      aria-label="Close pane"
                      onClick={() => onClosePane(tileWinId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-signal-red`}
                    >
                      <ClosePaneBoxedGlyph />
                    </button>
                  </Tip>
                </div>
                {showVerbs && (
                  <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                )}
              </>
            )}
            {/* Code-tile content verbs (the gui fullscreen verb's per-kind
                structure, any arity): Follow terminal renders ONLY while the
                latched root drifts from the tile window's live derivation —
                its presence IS the drift indicator; Reload editor renders
                while the tile window's frame is mounted. One hairline
                separates them from the layout-verb cluster when that
                renders. */}
            {kind === "code" && tile.visible && (tileCodeFollowTarget !== null || tileCodeFrameMounted) && (
              <>
                {tileCodeFollowTarget !== null && (
                  <Tip
                    label={`Follow terminal — reopen the editor at ${tileCodeFollowTarget.split("/").filter(Boolean).pop() ?? tileCodeFollowTarget}`}
                  >
                    <button
                      type="button"
                      aria-label="Follow terminal"
                      disabled={codeFollowInFlight}
                      onClick={() => followCodeTerminal(tileWinId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                    >
                      <FollowTerminalGlyph />
                    </button>
                  </Tip>
                )}
                {tileCodeFrameMounted && (
                  <Tip label="Reload editor — reboots this tab's workbench">
                    <button
                      type="button"
                      aria-label="Reload editor"
                      onClick={() => reloadCodeFrame(tileWinId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                    >
                      <RefreshGlyph />
                    </button>
                  </Tip>
                )}
                {showVerbs && (
                  <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                )}
              </>
            )}
            {/* Web-tile keyboard capture (the gui header's pinned capture
                verb, mirrored): while latched every chord but the release
                binding reaches the page on both engines. Renders only with
                page content (an onboarding tile has nothing to capture for —
                the chord and palette verb share the gate) and never on
                mobile (touch input never reaches the reclaim the verb
                toggles). A hairline separates it from the layout verbs. */}
            {!mobile && kind === "web" && tile.visible && webUrl !== "" && onWebCaptureChange && (
              <>
                <Tip label="Keyboard capture" kbd={webCaptureKbd}>
                  <button
                    type="button"
                    data-testid="web-capture-toggle"
                    data-no-tile-drag
                    aria-label="Keyboard capture"
                    aria-pressed={webCapture}
                    onClick={() => onWebCaptureChange(!webCapture)}
                    className={controlClass({
                      variant: "toggle",
                      base: VERB_BUTTON_BASE,
                      rest: "hover:bg-bg-card hover:text-text-primary",
                      ringed: true,
                      pressed: webCapture,
                    })}
                  >
                    <KeyboardGlyph />
                  </button>
                </Tip>
                {showVerbs && (
                  <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                )}
              </>
            )}
            {/* Pop out (content-verb family, ahead of the layout-verb
                cluster — at arity 1 it renders alone): hands the leaf id +
                the tile's rendered rect to the parent's popOut (the popup's
                size); the mark lands optimistically before window.open
                returns. The hairline renders only when the layout-verb
                cluster follows. */}
            {canPopOutTile && (
              <>
                <Tip label={`Pop out ${label}`}>
                  <button
                    type="button"
                    aria-label={`Pop out ${label}`}
                    onClick={() => onPopOut?.(leafId, rects.get(leafId))}
                    className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                  >
                    <PopOutGlyph />
                  </button>
                </Tip>
                {showVerbs && (
                  <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                )}
              </>
            )}
            {showVerbs && !popoutTile && (
              <>
                {/* ↩ send home (R14): FOREIGN leaves only, whose home ≠ the
                    route window (a self-address is grammar-invalid, guarded
                    anyway); disabled while the home window is dead — the
                    transient between a kill and the read-time prune. */}
                {leafHome !== undefined && leafHome !== windowId && (
                  <Tip label={`Send ${label} back to ${homeName}`}>
                    <button
                      type="button"
                      aria-label={`Send ${label} back to ${homeName}`}
                      disabled={homeWindow === null || !onSendHome}
                      onClick={() => onSendHome?.(windowId, leafId)}
                      className={`${VERB_BUTTON_CLASS} hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
                    >
                      <SendHomeGlyph />
                    </button>
                  </Tip>
                )}
                <Tip label={isZoomed ? `Restore ${label}` : `Expand ${label}`}>
                  <button
                    type="button"
                    aria-label={isZoomed ? `Restore ${label}` : `Expand ${label}`}
                    aria-pressed={isZoomed}
                    onClick={() => flipZoom(isZoomed ? null : leafId)}
                    className={controlClass({
                      variant: "toggle",
                      base: VERB_BUTTON_BASE,
                      rest: "hover:bg-bg-card hover:text-text-primary",
                      ringed: true,
                      pressed: isZoomed,
                    })}
                  >
                    <ZoomGlyph />
                  </button>
                </Tip>
                {/* A 1px hairline separates the destructive ✕ from the safe
                    verbs; its hover turns signal-red. */}
                <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-border" />
                <Tip label={`Close ${label}`}>
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    onClick={() => onClose(leafId)}
                    className={`${VERB_BUTTON_CLASS} hover:text-signal-red`}
                  >
                    <TileCloseGlyph />
                  </button>
                </Tip>
              </>
            )}
            {/* The popout window's one layout verb: Pop back in replaces the
                whole layout-verb cluster (zoom/↩/✕/Pop out) — the popout
                renders one tile, so the layout verbs are meaningless here.
                The content-verb families (pane segment, code verbs, find)
                keep rendering. */}
            {popoutTile && (
              <Tip label={`Pop ${label} back in`}>
                <button
                  type="button"
                  aria-label={`Pop ${label} back in`}
                  onClick={() => onPopBackIn?.()}
                  className={`${VERB_BUTTON_CLASS} hover:text-text-primary`}
                >
                  <SendHomeGlyph />
                </button>
              </Tip>
            )}
          </div>
        )}
        {/* rk-slot: find-bar-row — the tty find bar below the header (the web
            tile's below-URL-row pattern), shared FindBar with terminal-native
            Aa / .* toggles and the client-buffer scope note once a search has
            run. Primary tty leaf only. */}
        {kind === "tty" && awayHolderId === undefined && !poppedPlaceholder && leafId === firstBareTtyLeafId && findOpen && (
          <FindBar
            query={findQuery}
            matchIndex={
              findResults && findResults.resultIndex >= 0 ? findResults.resultIndex : 0
            }
            matchCount={findResults?.resultCount ?? 0}
            onQueryChange={setFindQuery}
            onNext={() => stepFind(1)}
            onPrev={() => stepFind(-1)}
            onClose={closeFind}
            toggles={
              <>
                <button
                  type="button"
                  onClick={() => setFindCaseSensitive((v) => !v)}
                  className={controlClass({
                    variant: "toggle",
                    base: "shrink-0 w-7 h-7 flex items-center justify-center rounded",
                    rest: "text-text-secondary hover:bg-bg-card",
                    ringed: true,
                    pressed: findCaseSensitive,
                  })}
                  aria-label="Match case"
                  aria-pressed={findCaseSensitive}
                >
                  <span className="text-xs font-mono">Aa</span>
                </button>
                <button
                  type="button"
                  onClick={() => setFindRegex((v) => !v)}
                  className={controlClass({
                    variant: "toggle",
                    base: "shrink-0 w-7 h-7 flex items-center justify-center rounded",
                    rest: "text-text-secondary hover:bg-bg-card",
                    ringed: true,
                    pressed: findRegex,
                  })}
                  aria-label="Match regex"
                  aria-pressed={findRegex}
                >
                  <span className="text-xs font-mono">.*</span>
                </button>
              </>
            }
            scopeNote={findRan ? TERMINAL_FIND_SCOPE_NOTE : undefined}
            placeholder="Find in terminal"
            testId="terminal-find-bar"
          />
        )}
        {/* Progress line (260819-1vxq R2): a zero-height wrapper whose
            absolute 2px bar OVERLAYS the content's top edge — an in-flow
            strip would resize the terminal container and fire fit → PTY
            resize churn on every task start/stop. The tile window's slot. */}
        {kind === "tty" && awayHolderId === undefined && !poppedPlaceholder && tileProgress.kind !== "idle" && (
          <div
            className="rk-tty-progress"
            data-testid="progress-line"
            role="progressbar"
            aria-label="Task progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              tileProgress.kind === "indeterminate" ? undefined : tileProgress.value
            }
          >
            {tileProgress.kind === "indeterminate" ? (
              <span className="rk-tty-progress-bar rk-tty-progress-indeterminate" />
            ) : (
              <span
                className={`rk-tty-progress-bar ${PROGRESS_BAR_CLASS[tileProgress.kind]}`}
                style={{ width: `${tileProgress.value}%` }}
              />
            )}
          </div>
        )}
        {awayHolderId !== undefined ? (
          <SurfacePlaceholder
            kind={kind}
            holderName={windowsById?.get(awayHolderId)?.name ?? awayHolderId}
            statusWindow={statusWindow ?? null}
            showClose={arity > 1}
            onBringBack={() => onSendHome?.(awayHolderId, `${windowId}/${kind}`)}
            onGoTo={() => onGoToWindow?.(awayHolderId)}
            onClose={() => onClose(leafId)}
          />
        ) : poppedPlaceholder ? (
          <SurfacePlaceholder
            variant="popped"
            kind={kind}
            statusWindow={tileStatusWindow}
            showClose={arity > 1}
            onBringBack={() => onPopIn?.(leafId)}
            onGoTo={() => onFocusPopout?.(leafId)}
            onClose={() => onHidePopped?.(leafId)}
          />
        ) : (
        <div
          // Mid-drag the iframe/xterm content must not swallow pointermove
          // (the drag would stall at the iframe boundary). Applies to every
          // drag posture — divider, intersection, tile header drag, and the
          // sidebar row-drag (its drop-catcher overlay sits above all tiles).
          className={`flex-1 min-h-0 flex flex-col ${draggingDivider !== null || draggingIntersection !== null || draggingTile !== null || rowDragActive ? "pointer-events-none" : ""}`}
        >
          {renderContent(tile, hidden)}
          {/* In-tile compose-strip dock (260813-j3jb): desktop only, in the
              dock tty tile (the first BARE tty, else the first tty leaf) —
              the strip sits below the terminal body, inside the tile frame. */}
          {!mobile && leafId === dockTtyLeafId ? ttyDockContent : null}
        </div>
        )}
      </div>
    );
  };

  // Mobile (R13): ONE leaf only, full-width, no verb chrome, no dividers.
  // Which leaf is `mobileActiveSlot` (a reading-order index) — the top-bar
  // switch group swaps the shown surface via the per-viewer zoom key,
  // touching the shared layout only when the target surface is not open (an
  // `addSurface` growth). All resolved surfaces stay mounted-hidden so
  // switching loses no state.
  //
  // IMPORTANT (both branches): visible + hidden + retained tiles render from
  // ONE flat array. Two separate `{arr1}{arr2}` expression slots reconcile
  // POSITIONALLY, so a keyed tile moving between them would UNMOUNT/remount —
  // silently breaking hide-never-unmount (P3/R6) on close (the e2e
  // element-identity assertion caught exactly this). Retained code frames ride
  // the same rule: the switch demotes the visible code tile to a hidden
  // retained entry with an unchanged key.
  if (isMobile) {
    const mobileSlot =
      mobileActiveSlot !== undefined &&
      mobileActiveSlot >= 0 &&
      mobileActiveSlot < layoutLeafIds.length
        ? mobileActiveSlot
        : 0;
    const allTiles = [
      ...visibleTiles.map((tile, i) => ({
        tile,
        hidden: i !== mobileSlot || (poppedSet.has(tile.leafId) && !revealedPoppedSet.has(tile.leafId)),
      })),
      ...hiddenTiles.map((tile) => ({ tile, hidden: true })),
      ...retainedCodeTiles.map((tile) => ({ tile, hidden: true })),
    ];
    return (
      // The drag posture crosses to the native web engine as a context (the
      // mobile branch drags nothing, but the provider stays uniform).
      <TileDragContext.Provider value="idle">
        <div
          data-testid="surface-layout"
          className="flex-1 min-h-0 min-w-0 flex flex-col"
        >
          {allTiles.map(({ tile, hidden }) => renderTile(tile, hidden, true))}
        </div>
      </TileDragContext.Provider>
    );
  }

  const allTiles = [
    ...visibleTiles.map((tile) => ({
      tile,
      // A popped leaf never renders live: the parent usually hands the
      // REDUCED tree (the leaf is absent), but the all-popped placeholder
      // render passes the full tree and hides every tile through this flag.
      // A REVEALED popped leaf stays visible — its slot renders the popped
      // placeholder instead of the surface.
      hidden:
        (zoomed && tile.leafId !== zoomedLeafId) ||
        (poppedSet.has(tile.leafId) && !revealedPoppedSet.has(tile.leafId)),
    })),
    ...hiddenTiles.map((tile) => ({ tile, hidden: true })),
    ...retainedCodeTiles.map((tile) => ({ tile, hidden: true })),
  ];
  return (
    // The same expression that drives the tiles' mid-drag pointer-events-none
    // class also feeds the native web engine's posture (live-resize on
    // `resize`, hide on `move`).
    <TileDragContext.Provider
      value={
        draggingTile !== null || rowDragActive
          ? "move"
          : draggingDivider !== null || draggingIntersection !== null
            ? "resize"
            : "idle"
      }
    >
    <div
      ref={gridRef}
      data-testid="surface-layout"
      // Flat rect-positioned leaf container: every tile is an absolutely
      // positioned card placed from its `layoutRects` rect — the GAP between
      // sibling rects (SPLIT_GAP_PX) is the separation, so the tile borders
      // dim (rk-card-border). The outer inset + ground moved OUT to the Shell
      // stage in 260814-ldbs: the stage provides the 6px ground inset at
      // every edge, so net tile geometry is unchanged. The absolutely
      // positioned dividers sit in the gutters; their 14px hit zones cover
      // the 6px gutter plus slop.
      className="relative flex-1 min-h-0 min-w-0"
    >
      {allTiles.map(({ tile, hidden }) => renderTile(tile, hidden, false))}
      {!zoomed &&
        dividers.map((d, i) => {
          // rk-divider + the gap-seam children (rk-sash pill, rk-grips dots)
          // carry the rest/hover/drag treatment — see globals.css.
          // `rk-sash-lit` = the zero-delay JS-lit state (this divider
          // mid-drag, or EITHER linked divider while its intersection zone is
          // dragged); `rk-sash-hot` = the intersection-HOVER state — both
          // sashes light together with the same 150ms anti-flicker delay as
          // a direct seam hover.
          const lit =
            draggingDivider === i ||
            (draggingIntersection !== null &&
              (intersections[draggingIntersection]?.dividers.includes(i) ?? false));
          const hot =
            !lit &&
            hotIntersection !== null &&
            (intersections[hotIntersection]?.dividers.includes(i) ?? false);
          return (
            <div
              key={`${d.splitPath.join(".")}:${d.boundary}`}
              role="separator"
              aria-orientation={d.dir === "h" ? "vertical" : "horizontal"}
              aria-label="Resize tiles"
              aria-valuenow={dividerValueNow(i)}
              data-testid={`surface-divider-${i}`}
              // Move/up/cancel are window-level while dragging (see the drag
              // effect) — only the drag START binds here.
              onPointerDown={onDividerPointerDown(i)}
              className={`rk-divider absolute z-10 ${
                d.dir === "h"
                  ? "w-3.5 -translate-x-1/2 cursor-col-resize"
                  : "h-3.5 -translate-y-1/2 cursor-row-resize"
              } ${lit ? "rk-sash-lit" : hot ? "rk-sash-hot" : ""}`}
              style={{ ...dividerStyle(d), touchAction: "none" }}
            >
              <span
                aria-hidden="true"
                className={`rk-sash pointer-events-none ${d.dir === "h" ? "rk-sash-v" : "rk-sash-h"}`}
              />
              <span
                aria-hidden="true"
                className={`rk-grips pointer-events-none ${d.dir === "h" ? "rk-grips-v" : "rk-grips-h"}`}
              >
                <i />
                <i />
                <i />
              </span>
            </div>
          );
        })}
      {/* Intersection zones: one ~20px two-axis handle per point where a
          divider's end meets a perpendicular divider, z-20 so it wins the
          hit-test over both dividers. Desktop-only by branch, never zoomed. */}
      {!zoomed &&
        intersections.map((inter, i) => (
          <div
            key={i}
            data-testid="surface-divider-intersection"
            aria-label="Resize tiles (both directions)"
            onPointerDown={onIntersectionPointerDown(i)}
            onPointerEnter={() => setHotIntersection(i)}
            onPointerLeave={() => setHotIntersection((h) => (h === i ? null : h))}
            className="absolute z-20 w-5 h-5 -translate-x-1/2 -translate-y-1/2 cursor-move"
            style={{
              left: measured ? inter.x : `${(inter.x / NOMINAL_BOX.w) * 100}%`,
              top: measured ? inter.y : `${(inter.y / NOMINAL_BOX.h) * 100}%`,
              touchAction: "none",
            }}
          />
        ))}
      {/* The header/row drag's result preview — z-30, above tiles and
          dividers, never a pointer target. */}
      {dropOverlay}
      {/* The sidebar row-drag's drop catcher — z-40, above the preview (which
          is pointer-events-none), the ONLY drop target while a window-row
          drag is in flight over the tiles. */}
      {rowDragActive && (
        <div
          data-testid="row-drop-catcher"
          className="absolute inset-0 z-40"
          onDragOver={onRowDragOver}
          onDrop={onRowDrop}
        />
      )}
    </div>
    </TileDragContext.Provider>
  );
}
