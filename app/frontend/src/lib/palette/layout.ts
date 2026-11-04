/**
 * Pure builder for the command-palette surface-layout actions (spec
 * docs/specs/surface-layout.md § Verbs: "every verb is also a palette
 * entry", Constitution V). Extracted from app.tsx so the per-state gating
 * (which adds/closes/verbs/templates are offered) is unit-testable without
 * mounting the shell — mirroring `lib/palette/view.ts` (`buildViewActions`).
 *
 * Entries, per current layout state:
 *  - `Tile: Show <Surface>`     — per AVAILABLE surface not open as a bare
 *                                 leaf (a kind present only as a foreign tile
 *                                 still gets its row — the add lands the bare
 *                                 slot); omitted when
 *                                 no split of the current tree fits the size
 *                                 floor (the rail's disabled buttons are the
 *                                 mouse mirror). "Show" is the honest
 *                                 verb: the entry reveals a renderer, it does
 *                                 not rearrange the layout. The split lands on
 *                                 the FOCUSED tile when the caller passes
 *                                 `focusedLeafId`; its direction resolves
 *                                 against the LIVE leaf rects when the caller
 *                                 passes them (desktop), the nominal box
 *                                 otherwise; the floor check estimates from the
 *                                 stored sizes when `layoutSizes` is threaded.
 *  - `Tile: Bring <window> <Surface> here` — per OTHER window on the route
 *                                 server × each of its lendable surfaces
 *                                 (never `gui`) not already in this layout,
 *                                 gated by the same floor as Show (the generic
 *                                 add rule inserts the foreign leaf). The write
 *                                 rides the caller's `onBring` seam (a plain
 *                                 apply or a borrow, by held state).
 *  - `Tile: Send Back to <home window>` — for the focused FOREIGN tile only;
 *                                 disabled when the home window is dead. The
 *                                 write rides the caller's `onSendBack` seam
 *                                 (the return endpoint recomputes both trees).
 *  - `Tile: Bring Back <Surface>` — the HOME tab's half of the return verb
 *                                 (the placeholder's bring back, palette
 *                                 form): one row per bare leaf whose kind is
 *                                 away (`awayIn[kind]` naming a LIVE holder).
 *                                 The write rides the caller's `onBringBack`
 *                                 seam with the holder window and the leaf
 *                                 address `@<this window>/<kind>`.
 *  - `Tile: Hide <Surface>`     — per open bare kind; omitted on a single-tile
 *                                 layout (the last tile never hides).
 *  - `Layout: Expand` / `Layout: Restore` — the transient focused-tile zoom
 *                                 toggle (desktop multi-tile only). Exactly one
 *                                 renders, keyed on the caller's `zoomed` state.
 *                                 "Zoom" is the CONTENT-magnification verb —
 *                                 tile-maximize's labels say Expand/Restore;
 *                                 the ids stay layout-zoom / layout-unzoom
 *                                 (they persist in user macros/overrides).
 *  - `Tile: Focus <Surface>`    — per open, not-currently-focused kind;
 *                                 keyboard parity for the pointer's
 *                                 click-to-focus. Desktop multi-tile only (the
 *                                 caller passes `onFocus` only then). Duplicate
 *                                 kinds (two tty tiles) yield one entry — the
 *                                 seam focuses the first leaf of the kind.
 *  - `Layout: Promote <Surface>` — per open leaf except slot A (promoting
 *                                 the template's main tile is a no-op, so its
 *                                 entry is omitted). Bare kinds dedupe to one
 *                                 row (the kind is the first leaf's id); a
 *                                 foreign tile gets its own row labelled by
 *                                 its `@N/<kind>` address.
 *  - `Tile: Swap Left|Right|Up|Down` — for the FOCUSED tile, one row per
 *                                 direction in which a geometric neighbour
 *                                 exists. Desktop multi-tile only: the caller
 *                                 passes `leafRects` and `focusedLeafId` only
 *                                 then.
 *  - `Tile: Pop Out <Surface>`   — per open, not-popped, live leaf at any
 *                                 rendered arity (the caller omits `onPopOut`
 *                                 on mobile and in a desktop shell without
 *                                 the `windows.popout` channel); foreign
 *                                 leaves disambiguate with the home window's
 *                                 name. `Tile: Pop Back In <Surface>` — per
 *                                 popped leaf of this layout. While any leaf
 *                                 is popped, the template rows and cycle
 *                                 entry below gate OFF.
 *  - `Layout: <Template>`       — one per `templatesFor(n)` at the current
 *                                 tile count (the ▦ chip rows' palette form);
 *                                 a template whose result lands under the size
 *                                 floor is not offered.
 *  - `Layout: Cycle Template`   — the ⌘; chord's palette body; its id
 *                                 `layout-cycle` IS the registry actionId, so
 *                                 `withShortcutHints` decorates it with the
 *                                 effective combo (shortcuts are documented in
 *                                 the palette registration). Omitted at one
 *                                 tile (the template ring is empty).
 *
 * The `code-toggle` chord (⌘2/⇧Ctrl+2) toggles the code surface's tile; that
 * surface's Show/Hide entry carries its effective combo
 * (`toggleTarget`/`toggleShortcut`, generalised to `toggleHints`) so the
 * chord stays discoverable.
 */

import {
  addSurface,
  applyTemplate,
  bareLeaves,
  boundingBox,
  closeSurface,
  fitsFloor,
  swapDirectional,
  leafIds,
  leaves,
  slotOrder,
  templatesFor,
  zoomLeafKind,
  NOMINAL_BOX,
  SURFACE_LABEL,
  TEMPLATE_LABEL,
  type Layout,
  type LayoutSizes,
  type Rect,
  type SurfaceKind,
  type SwapDirection,
  type TemplateName,
} from "../surface-layout";
import { leafAddress, parseLeafAddress, type LayoutLeaf } from "../layout-tree";
import { popoutToggleTarget } from "../popout";

export type LayoutPaletteAction = {
  id: string;
  label: string;
  shortcut?: string;
  /** Renders the row disabled (no-op on select) — the switch group's
   *  full-layout affordance (`addSurface` → null). */
  disabled?: boolean;
  onSelect: () => void;
};

const SWAP_DIRECTIONS: SwapDirection[] = ["left", "right", "up", "down"];

const SWAP_DIRECTION_LABEL: Record<SwapDirection, string> = {
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
};

/** A `Tile: Bring … here` candidate: another window on the route server and
 *  the surfaces it can lend. The caller excludes the route window itself and
 *  computes availability per window; `gui` is never lendable (one desktop per
 *  host) and is skipped here even when listed. */
export type BringWindow = {
  id: string;
  name: string;
  surfaces: SurfaceKind[];
};

export type LayoutPaletteOptions = {
  /** Transient zoom state (app.tsx observes SurfaceLayout's zoom flips). */
  zoomed: boolean;
  /** Desktop + multi-tile — zoom is desktop-only (mobile renders slot A). */
  zoomEnabled: boolean;
  /** The single mutation path (persist + URL mirror) — Show/Hide run their
   *  pure mutation through it UNLESS `onToggleSurface` is set (the guarded
   *  shared toggle owns the decision then). */
  onApply: (next: Layout) => void;
  /** The shared surface toggle (app.tsx's `togglePanel`): when present, the
   *  Show/Hide rows DELEGATE to it instead of running their inline
   *  addSurface/closeSurface + `onApply` — its popped-close-target guard (a
   *  popped leaf's toggle reveals/hides the popped placeholder, never a
   *  shared layout write) then covers the palette rows too. The offer gates
   *  (floor fit, open-bare presence, tile count) are unaffected. */
  onToggleSurface?: (kind: SurfaceKind) => void;
  /** Toggle the transient slot-A zoom (SurfaceLayout's registered seam). */
  onZoomToggle: () => void;
  /** The `code-toggle` chord's target surface and its effective combo —
   *  stamped on that surface's Show/Hide entry. */
  toggleTarget?: SurfaceKind | null;
  toggleShortcut?: string;
  /** Effective toggle-chord combos by surface kind — the multi-chord form of
   *  the toggleTarget/toggleShortcut pair (the gui-toggle ⌘4 hint on the
   *  `Tile: Show/Hide GUI` rows). */
  toggleHints?: Partial<Record<SurfaceKind, string>>;
  /** Focused-tile palette parity: the currently focused kind (omitted from
   *  the Focus entries) and the focus-by-kind callback (app.tsx routes it
   *  through SurfaceLayout's `focusTileRef` seam). `onFocus` absent ⇒ no
   *  Focus entries (mobile; the top-bar switch group is the switcher
   *  there). */
  focusedKind?: SurfaceKind | null;
  onFocus?: (kind: SurfaceKind) => void;
  /** Template jump — rebuilds the tree as the named template from the
   *  current slot order. */
  onApplyTemplate: (name: TemplateName) => void;
  /** The ⌘; chord's body — the next template in the ring. */
  onCycleTemplate: () => void;
  /** Promote a leaf to slot A (swaps it with the template's main tile). */
  onPromoteLeaf: (leafId: string) => void;
  /** Directional swap of the focused leaf with its geometric neighbour. */
  onSwapDirection: (direction: SwapDirection) => void;
  /** The focused tile's leaf id — the directional swaps' origin AND the tile
   *  a Show/Bring add splits. Absent ⇒ no directional rows and adds split
   *  the last leaf in reading order. */
  focusedLeafId: string | undefined;
  /** Live leaf rects from the desktop render seam — the directional swaps'
   *  geometry AND the Show entries' split direction. Absent ⇒ mobile ⇒ the
   *  nominal box decides and no directional rows render. */
  leafRects: (() => Map<string, Rect>) | undefined;
  /** The viewer's stored divider fractions for the current structure — the
   *  Show/Bring floor check estimates candidate rects from them (the split
   *  tile halves) instead of default fractions. Absent ⇒ default fractions. */
  layoutSizes?: () => LayoutSizes | undefined;
  /** The route server's OTHER windows and their lendable surfaces — the
   *  `Tile: Bring … here` candidates. Absent ⇒ no Bring rows. */
  bringWindows?: BringWindow[];
  /** The Bring rows' write seam (app.tsx's borrowInto): called with the
   *  leaf's address (`@N/<kind>`) and the grown tree. */
  onBring?: (leafAddress: string, tree: Layout) => void;
  /** The Send Back row's write seam (app.tsx's sendHome → returnLayout);
   *  absent ⇒ no Send Back row. */
  onSendBack?: (leafAddress: string) => void;
  /** Resolve a window id to its display name; undefined ⇒ the window is
   *  dead (the Send Back row renders disabled). */
  windowNameFor?: (windowId: string) => string | undefined;
  /** The route window's away map (kind → holder window id) and its own id —
   *  the Bring Back rows' inputs. Absent ⇒ no Bring Back rows. */
  awayIn?: Partial<Record<SurfaceKind, string>>;
  routeWindowId?: string;
  /** The Bring Back rows' write seam (app.tsx's sendHome → returnLayout —
   *  the same return the placeholder's bring back runs): called with the
   *  holder window and the leaf address `@<routeWindowId>/<kind>`. */
  onBringBack?: (holderWindowId: string, leafAddress: string) => void;
  /** The viewer's popped leaf ids (spec surface-layout.md § Verbs → Pop
   *  out): one `Tile: Pop Back In <Surface>` row per popped leaf, and the
   *  `Layout: <Template>` / cycle rows gate OFF while any leaf is popped (a
   *  template resolved on the viewer's reduced render would strand the
   *  popped leaf). Absent/empty ⇒ nothing popped. */
  poppedIds?: string[];
  /** The revealed subset of `poppedIds` (leaves whose slot renders the popped
   *  placeholder). A kind whose toggle close target is popped and NOT
   *  revealed reads as closed, matching the top-bar toggle: it gets a Show
   *  row (the guarded toggle reveals the placeholder) and no Hide row. */
  revealedIds?: string[];
  /** The Pop Out rows' seam — per open, not-popped, eligible leaf. Absent ⇒
   *  no Pop Out rows (the desktop shell and mobile/coarse gate at the
   *  caller). */
  onPopOut?: (leafId: string) => void;
  /** The Pop Back In rows' seam — tells the popout to close and clears the
   *  viewer's mark. Absent ⇒ no Pop Back In rows. */
  onPopIn?: (leafId: string) => void;
};

export function buildLayoutActions(
  layout: Layout,
  available: SurfaceKind[],
  opts: LayoutPaletteOptions,
): LayoutPaletteAction[] {
  const actions: LayoutPaletteAction[] = [];
  const kinds = leaves(layout);
  const tileCount = kinds.length;
  const ids = leafIds(layout);
  const openKinds = [...new Set(kinds)];
  // Bare-only presence: a kind open solely as foreign leaves still gets its
  // Show row (the toggle adds the bare slot) and no Hide row (a foreign
  // tile's exit verb is Send Back).
  const openBareKinds = [...new Set(bareLeaves(layout))];
  // A popped, unrevealed close target is off screen for this viewer: its
  // Show/Hide rows follow the guarded toggle (reveal), never a layout close.
  const poppedHidden = (kind: SurfaceKind): boolean => {
    if (!opts.onToggleSurface) return false;
    const target = popoutToggleTarget(layout, kind);
    return (
      target !== undefined &&
      (opts.poppedIds ?? []).includes(target) &&
      !(opts.revealedIds ?? []).includes(target)
    );
  };

  /** The toggle chord's hint for a chord-target surface's Show/Hide entry. */
  const toggleHint = (kind: SurfaceKind) => {
    if (opts.toggleTarget === kind && opts.toggleShortcut) {
      return { shortcut: opts.toggleShortcut };
    }
    const hint = opts.toggleHints?.[kind];
    return hint ? { shortcut: hint } : {};
  };

  // The offer box: the live rects' bounding box on desktop, the nominal box
  // otherwise — the same box addSurface checks the floor against.
  const gateRects = opts.leafRects?.();
  const gateSizes = opts.layoutSizes?.();
  const offerBox = (gateRects !== undefined ? boundingBox(gateRects) : null) ?? NOMINAL_BOX;

  // Shows — available AND not open as a bare leaf AND a split of the current
  // tree fits the size floor (addSurface's refusal is the gate). The add
  // splits the FOCUSED tile when the caller passes `focusedLeafId`.
  for (const kind of available) {
    const reveal = poppedHidden(kind);
    if (!reveal && openBareKinds.includes(kind)) continue;
    if (!reveal && addSurface(layout, kind, gateRects, undefined, gateSizes) === null) continue;
    actions.push({
      id: `tile-show-${kind}`,
      label: `Tile: Show ${SURFACE_LABEL[kind]}`,
      ...toggleHint(kind),
      onSelect: () => {
        if (opts.onToggleSurface) {
          opts.onToggleSurface(kind);
          return;
        }
        const next = addSurface(
          layout,
          kind,
          opts.leafRects?.(),
          opts.focusedLeafId,
          opts.layoutSizes?.(),
        );
        if (next) opts.onApply(next);
      },
    });
  }

  // Bring — another window's surface as a foreign leaf, inserted by the
  // generic add rule. addSurface's refusal covers both gates: an address
  // already in the tree and a split that breaks the floor.
  if (opts.bringWindows && opts.onBring) {
    for (const win of opts.bringWindows) {
      for (const kind of win.surfaces) {
        if (kind === "gui") continue;
        const candidate: LayoutLeaf = { leaf: kind, home: win.id };
        if (addSurface(layout, candidate, gateRects, undefined, gateSizes) === null) continue;
        actions.push({
          id: `tile-bring-${win.id}-${kind}`,
          label: `Tile: Bring ${win.name} ${SURFACE_LABEL[kind]} here`,
          onSelect: () => {
            const next = addSurface(
              layout,
              candidate,
              opts.leafRects?.(),
              opts.focusedLeafId,
              opts.layoutSizes?.(),
            );
            if (next) opts.onBring?.(leafAddress(candidate), next);
          },
        });
      }
    }
  }

  // Hides — one per open bare kind; the last tile never hides.
  if (tileCount > 1) {
    for (const kind of openBareKinds) {
      if (poppedHidden(kind)) continue;
      actions.push({
        id: `tile-hide-${kind}`,
        label: `Tile: Hide ${SURFACE_LABEL[kind]}`,
        ...toggleHint(kind),
        onSelect: () => {
          if (opts.onToggleSurface) {
            opts.onToggleSurface(kind);
            return;
          }
          const next = closeSurface(layout, kind);
          if (next) opts.onApply(next);
        },
      });
    }
  }

  // Expand / Restore — the transient focused-tile toggle. Exactly one form
  // renders, keyed on the live zoom state.
  if (opts.zoomEnabled) {
    actions.push(
      opts.zoomed
        ? { id: "layout-unzoom", label: "Layout: Restore", onSelect: opts.onZoomToggle }
        : { id: "layout-zoom", label: "Layout: Expand", onSelect: opts.onZoomToggle },
    );
  }

  // Focus — keyboard parity for click-to-focus: one entry per OPEN,
  // not-currently-focused kind. Desktop multi-tile only: at one tile there is
  // nothing to move focus to, and the caller passes no `onFocus` on mobile.
  if (tileCount > 1 && opts.onFocus && opts.focusedKind) {
    for (const kind of openKinds) {
      if (kind === opts.focusedKind) continue;
      actions.push({
        id: `tile-focus-${kind}`,
        label: `Tile: Focus ${SURFACE_LABEL[kind]}`,
        onSelect: () => opts.onFocus?.(kind),
      });
    }
  }

  // Send Back — offered when the FOCUSED tile is a foreign leaf (its id is
  // its address). A dead home window renders the row DISABLED, not absent:
  // the read-time prune drops the leaf on the next payload anyway, and a
  // row that vanishes mid-session reads as a glitch.
  const sendBackLeafId = opts.focusedLeafId;
  const sendBackAddress =
    sendBackLeafId !== undefined ? parseLeafAddress(sendBackLeafId) : null;
  if (sendBackAddress !== null && sendBackLeafId !== undefined && opts.onSendBack) {
    const homeName = opts.windowNameFor?.(sendBackAddress.home);
    actions.push({
      id: "tile-send-back",
      label: `Tile: Send Back to ${homeName ?? sendBackAddress.home}`,
      disabled: homeName === undefined,
      onSelect: () => opts.onSendBack?.(sendBackLeafId),
    });
  }

  // Bring Back — one row per BARE leaf whose kind is away (the placeholder's
  // bring back, palette form). A dead holder yields no row: the server prunes
  // the away entry on the next payload, and the placeholder is the dead
  // holder's affordance meanwhile.
  const awayIn = opts.awayIn;
  const routeWindowId = opts.routeWindowId;
  if (awayIn !== undefined && routeWindowId !== undefined && opts.onBringBack) {
    for (const kind of openBareKinds) {
      const holder = awayIn[kind];
      if (holder === undefined) continue;
      if (opts.windowNameFor?.(holder) === undefined) continue;
      actions.push({
        id: `tile-bring-back-${kind}`,
        label: `Tile: Bring Back ${SURFACE_LABEL[kind]}`,
        onSelect: () => opts.onBringBack?.(holder, `${routeWindowId}/${kind}`),
      });
    }
  }

  // Promote — one entry per promotable LEAF ID except slot A (promoting the
  // main tile is a no-op, so its entry is omitted). Candidates are leaf ids,
  // not kinds, because promote() resolves by id: a kind present only as a
  // foreign tile would otherwise register a guaranteed no-op row. Bare kinds
  // dedupe to their first leaf (the kind IS that leaf's id — duplicate tty
  // tiles share one row); a foreign entry is labelled by its address.
  if (tileCount > 1) {
    // Slot A's id derives exactly as promote() derives it — the slot-order
    // kind's first leaf in reading order.
    const slotAId = ids[leaves(layout).indexOf(slotOrder(layout)[0])];
    const seenBare = new Set<SurfaceKind>();
    for (const id of ids) {
      if (id === slotAId) continue;
      const kind = zoomLeafKind(id);
      if (kind === undefined) continue;
      if (parseLeafAddress(id) === null) {
        if (seenBare.has(kind)) continue;
        seenBare.add(kind);
        actions.push({
          id: `layout-promote-${kind}`,
          label: `Layout: Promote ${SURFACE_LABEL[kind]}`,
          onSelect: () => opts.onPromoteLeaf(id),
        });
        continue;
      }
      actions.push({
        id: `layout-promote-${id}`,
        label: `Layout: Promote ${SURFACE_LABEL[kind]} (${id})`,
        onSelect: () => opts.onPromoteLeaf(id),
      });
    }
  }

  // Directional swaps — one row per direction in which the FOCUSED tile has
  // a geometric neighbour. Desktop multi-tile only: the caller passes the
  // live rects and the focused leaf id only then. A no-op result (the SAME
  // tree object back) means no neighbour in that direction.
  const focusedLeafId = opts.focusedLeafId;
  if (tileCount > 1 && opts.leafRects && focusedLeafId !== undefined) {
    const rects = opts.leafRects();
    for (const direction of SWAP_DIRECTIONS) {
      if (swapDirectional(layout, focusedLeafId, direction, rects) === layout) continue;
      actions.push({
        id: `tile-swap-${direction}`,
        label: `Tile: Swap ${SWAP_DIRECTION_LABEL[direction]}`,
        onSelect: () => opts.onSwapDirection(direction),
      });
    }
  }

  // Pop out / Pop back in — the popout verbs (spec surface-layout.md § Verbs
  // → Pop out). `Tile: Pop Out <Surface>` is offered per open, not-popped,
  // LIVE leaf at any rendered arity (popping the last tile lands the opener
  // on the all-popped placeholder): an away bare kind (its surface is live in
  // another tab) and a dead-home foreign leaf have nothing to pop. Foreign
  // leaves disambiguate with the home window's name (the `Tile: Bring
  // <window> <Surface> here` convention). `Tile: Pop Back In <Surface>` is
  // offered per popped leaf still in the shared tree.
  const poppedSet = new Set((opts.poppedIds ?? []).filter((id) => ids.includes(id)));
  const popLabel = (id: string): string | null => {
    const kind = zoomLeafKind(id);
    if (kind === undefined) return null;
    const foreign = parseLeafAddress(id);
    if (foreign === null) return SURFACE_LABEL[kind];
    const homeName = opts.windowNameFor?.(foreign.home);
    return homeName !== undefined ? `${homeName} ${SURFACE_LABEL[kind]}` : null;
  };
  if (opts.onPopOut) {
    for (const id of ids) {
      if (poppedSet.has(id)) continue;
      const kind = zoomLeafKind(id);
      if (kind === undefined) continue;
      if (parseLeafAddress(id) === null && opts.awayIn?.[kind] !== undefined) continue;
      const label = popLabel(id);
      if (label === null) continue; // a dead home window's tile has nothing to pop
      actions.push({
        id: `tile-pop-out-${id}`,
        label: `Tile: Pop Out ${label}`,
        onSelect: () => opts.onPopOut?.(id),
      });
    }
  }
  if (opts.onPopIn) {
    for (const id of opts.poppedIds ?? []) {
      if (!poppedSet.has(id)) continue;
      const label = popLabel(id);
      if (label === null) continue;
      actions.push({
        id: `tile-pop-in-${id}`,
        label: `Tile: Pop Back In ${label}`,
        onSelect: () => opts.onPopIn?.(id),
      });
    }
  }

  // Template jumps — one per structurally distinct template at the current
  // tile count whose result fits the size floor in the offer box. Gated OFF
  // while this viewer has a leaf popped (with the ▦ chip and the cycle
  // chord): a template rebuilds from the slot order, and resolving one over
  // the reduced render would drop the popped leaf from the shared layout for
  // every viewer.
  const templates = poppedSet.size === 0 ? templatesFor(tileCount) : [];
  for (const name of templates) {
    const next = applyTemplate(layout, name);
    if (next === null || !fitsFloor(next, undefined, offerBox)) continue;
    actions.push({
      id: `layout-template-${name}`,
      label: `Layout: ${TEMPLATE_LABEL[name]}`,
      onSelect: () => opts.onApplyTemplate(name),
    });
  }

  // The cycle chord's palette parity entry — id `layout-cycle` IS the
  // registry actionId, so `withShortcutHints` decorates it with the
  // effective combo. Omitted at one tile (the ring is empty).
  if (templates.length > 1) {
    actions.push({
      id: "layout-cycle",
      label: "Layout: Cycle Template",
      onSelect: opts.onCycleTemplate,
    });
  }

  return actions;
}

/**
 * Build the mobile switch-to-tile palette actions (`Tile: Switch to
 * <Surface>`) — the keyboard twin of the top-bar switch group (Constitution
 * V). One entry per AVAILABLE surface that is not the currently visible one —
 * the palette shows the destination, never the current tile (the
 * `buildViewActions` pattern). A single-surface window yields an empty array —
 * there is nothing to switch to. On mobile these supersede the `View:`
 * entries; the bodies invoke the caller's switch-to-tile verb. A destination
 * whose growth the layout cannot host (`addSurface` → null, reported via
 * `isDisabled`) renders DISABLED — the switch group's full-layout affordance.
 */
export function buildTileSwitchActions(
  available: SurfaceKind[],
  visible: SurfaceKind,
  onSwitch: (surface: SurfaceKind) => void,
  isDisabled?: (surface: SurfaceKind) => boolean,
): LayoutPaletteAction[] {
  return available
    .filter((kind) => kind !== visible)
    .map((kind) => ({
      id: `tile-switch-${kind}`,
      label: `Tile: Switch to ${SURFACE_LABEL[kind]}`,
      disabled: isDisabled?.(kind) ?? false,
      onSelect: () => onSwitch(kind),
    }));
}
