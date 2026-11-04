/**
 * Pure drop resolver for the surface-layout header drag (spec
 * docs/specs/surface-layout.md § Verbs; the executable reference is the
 * design study docs/wiki/surface-drop-zone-studies.html §3/§5 — `hit`,
 * `band`, `dropEdge`, `resolveHit` ported onto the typed tree).
 *
 * A header drag hit-tests the pointer against the snapshotted leaf rects and
 * the layout box: the outer ROOT_EDGE_PX of the box are four layout-edge
 * bands (span a side) that WIN over tile bands; inside a tile, per-side bands
 * of clamp(25 % of the axis, 28, 110) px are split zones and the rest is the
 * center (swap). The resolution itself is ONE generic edit — wrap the target
 * with the dragged leaf's clone (insert BEFORE remove is load-bearing:
 * removing first can collapse the target's parent), remove the dragged leaf,
 * normalise — covering center swaps, tile-edge splits, and layout-edge spans
 * (a root drop wraps at path [], so the dragged tile takes 50 % of that axis).
 * An EXTERNAL leaf — one not yet in the tree, passed as a full `LayoutLeaf`
 * instead of an id — runs the insert half only (wrap with the new leaf,
 * normalise) and treats the center zone as a no-op.
 *
 * Sizes ride along: the resolver runs on the tree with the viewer's effective
 * sizes attached (`attachSizes`), so a drop carries fractions through the
 * wrap/remove/normalise arithmetic and returns the result's pre-order
 * `LayoutSizes` for the new structure signature.
 *
 * Everything here is DOM-free and reuses `lib/layout-tree.ts` primitives —
 * never reimplemented.
 */

import {
  attachSizes,
  extractSizes,
  getAt,
  insertBeside,
  isLeaf,
  isSplit,
  leafAddress,
  leafIds,
  layoutRects,
  normalise,
  pathOf,
  removeNodeAt,
  serializeLayoutTree,
  sizesOf,
  stripSizes,
  swapLeaves,
  SPLIT_GAP_PX,
  type DropSide,
  type LayoutLeaf,
  type LayoutNode,
  type LayoutSizes,
  type LayoutSplit,
  type Rect,
  type SplitDir,
} from "./layout-tree";

/** Movement (px) before a header press becomes a drag; below it the press is
 *  a plain focus click. */
export const DRAG_THRESHOLD_PX = 4;
/** The layout-edge band: the outer 18 px of the layout box, on all four
 *  sides, at any tile count. */
export const ROOT_EDGE_PX = 18;
/** A tile-edge band is 25 % of the tile's axis… */
export const EDGE_BAND_FRACTION = 0.25;
/** …clamped to [28, 110] px. */
export const EDGE_BAND_MIN_PX = 28;
export const EDGE_BAND_MAX_PX = 110;
/** The per-viewport size floor gating drops: no drop may leave a leaf
 *  narrower than MIN_TILE_W or shorter than MIN_TILE_H in THIS viewer. */
export const MIN_TILE_W = 150;
export const MIN_TILE_H = 100;

/** A point in layout-box coordinates. */
export interface DropPoint {
  x: number;
  y: number;
}

/** The tile-edge band width for an axis length. */
export function edgeBand(dim: number): number {
  return Math.min(EDGE_BAND_MAX_PX, Math.max(EDGE_BAND_MIN_PX, dim * EDGE_BAND_FRACTION));
}

/**
 * The layout-edge zone at a point: the side whose distance from the box edge
 * is < ROOT_EDGE_PX (a corner goes to the NEAREST side), else null. These
 * bands win over tile bands — `hitTest` consults them first.
 */
export function rootZoneAt(box: Rect, point: DropPoint): DropSide | null {
  const dists: [DropSide, number][] = [
    ["left", point.x - box.x],
    ["right", box.x + box.w - point.x],
    ["top", point.y - box.y],
    ["bottom", box.y + box.h - point.y],
  ];
  let best: DropSide | null = null;
  let bestDist = ROOT_EDGE_PX;
  for (const [side, dist] of dists) {
    if (dist < bestDist) {
      best = side;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * The zone inside one tile's rect: each side's band is `edgeBand` of that
 * axis; a point in no band is `center`; a corner (two bands) goes to the side
 * the pointer is DEEPEST into — the smallest distance/band ratio. Trees have
 * no diagonal splits, so a corner resolves to one axis.
 */
export function zoneAt(rect: Rect, point: DropPoint): "center" | DropSide {
  const bands: [DropSide, number, number][] = [
    ["left", point.x - rect.x, edgeBand(rect.w)],
    ["right", rect.x + rect.w - point.x, edgeBand(rect.w)],
    ["top", point.y - rect.y, edgeBand(rect.h)],
    ["bottom", rect.y + rect.h - point.y, edgeBand(rect.h)],
  ];
  let zone: "center" | DropSide = "center";
  let bestRatio = 1;
  for (const [side, dist, band] of bands) {
    const ratio = dist / band;
    if (dist < band && ratio < bestRatio) {
      zone = side;
      bestRatio = ratio;
    }
  }
  return zone;
}

/** Where a mid-drag pointer sits: a layout-edge band, a tile's center or
 *  edge band, the dragged tile itself (no zone — release cancels), or null
 *  (outside the layout box, or in a gutter between tiles). */
export type DropHit =
  | { kind: "root"; side: DropSide }
  | { kind: "center"; targetId: string }
  | { kind: "edge"; targetId: string; side: DropSide }
  | { kind: "self" };

/**
 * Hit-test a point (layout-box coordinates) against the layout box and the
 * leaf rects: null outside the box or in a gutter; a `root` hit in a
 * layout-edge band (winning over tile bands); `self` over the dragged tile's
 * own rect; otherwise the center/edge zone of the tile under the point.
 * `dragged` is the dragged leaf's id, or the full `LayoutLeaf` for an
 * external leaf not yet in the tree — its address is no rect key, so an
 * external drag never hits `self`.
 */
export function hitTest(
  rects: Map<string, Rect>,
  box: Rect,
  point: DropPoint,
  dragged: string | LayoutLeaf,
): DropHit | null {
  const draggedId = typeof dragged === "string" ? dragged : leafAddress(dragged);
  if (point.x < box.x || point.x > box.x + box.w || point.y < box.y || point.y > box.y + box.h) {
    return null;
  }
  const root = rootZoneAt(box, point);
  if (root !== null) return { kind: "root", side: root };
  for (const [id, rect] of rects) {
    if (
      point.x < rect.x ||
      point.x > rect.x + rect.w ||
      point.y < rect.y ||
      point.y > rect.y + rect.h
    ) {
      continue;
    }
    if (id === draggedId) return { kind: "self" };
    const zone = zoneAt(rect, point);
    return zone === "center"
      ? { kind: "center", targetId: id }
      : { kind: "edge", targetId: id, side: zone };
  }
  return null;
}

/** The resolution of a drop: `move` carries the canonical result tree, its
 *  pre-order sizes, and the dragged tile's leaf id AT ITS NEW POSITION;
 *  `noop` is a result identical to the current tree (serialized form — a
 *  size-only rebalance still reads "no change"); `too-small` breaks the
 *  size floor and is never offered; `cancel` writes nothing. */
export type DropResult =
  | { kind: "move"; tree: LayoutNode; sizes: LayoutSizes; destId: string }
  | { kind: "noop" }
  | { kind: "too-small" }
  | { kind: "cancel" };

/** The child-index path of a node located by IDENTITY — the drop pipeline
 *  tracks the dragged leaf (and its inserted clone) by reference because a
 *  kind-derived id is ambiguous mid-edit (the clone shares the kind). */
function pathOfNode(root: LayoutNode, target: LayoutNode): number[] | null {
  if (root === target) return [];
  if (isLeaf(root)) return null;
  for (let i = 0; i < root.children.length; i++) {
    const sub = pathOfNode(root.children[i], target);
    if (sub !== null) return [i, ...sub];
  }
  return null;
}

/** Leaf count of a subtree — the reading-order index math below. */
function countLeaves(node: LayoutNode): number {
  return isLeaf(node) ? 1 : node.children.reduce((a, c) => a + countLeaves(c), 0);
}

/** The reading-order leaf index of the node at `path`. */
function leafIndexAtPath(root: LayoutNode, path: number[]): number {
  let index = 0;
  let node = root;
  for (const step of path) {
    if (isLeaf(node)) break;
    for (let i = 0; i < step; i++) index += countLeaves(node.children[i]);
    node = node.children[step];
  }
  return index;
}

/** Rewrite a root split's fractions so the child at `destIndex` holds half
 *  the axis and the survivors keep their relative shares of the other half.
 *  Identity when the destination already holds half (the no-merge case). */
function rootDestHalf(split: LayoutSplit, destIndex: number): LayoutSplit {
  const fractions = sizesOf(split);
  const rest = fractions.reduce((a, f, i) => (i === destIndex ? a : a + f), 0);
  if (rest <= 0) return split;
  const scale = 0.5 / rest;
  return {
    dir: split.dir,
    children: split.children,
    sizes: fractions.map((f, i) => (i === destIndex ? 0.5 : f * scale)),
  };
}

/**
 * Resolve a drop to its outcome. `dragged` is the dragged leaf's id for an
 * internal drag (a leaf already in the tree — behaviour unchanged), or the
 * full `LayoutLeaf` for an EXTERNAL leaf not yet in the tree (a sidebar-row
 * borrow): center hits are `noop` there, and edge/root hits run the generic
 * edit's insert half with no removal. Internal center hits swap (sizes stay
 * with POSITIONS). Edge and root hits run the generic edit on the
 * sizes-attached
 * tree: wrap the target (path [] for a layout edge) in a split on the side's
 * axis with a CLONE of the dragged leaf at 50/50 inside the wrap (the wrap
 * takes the target's share), remove the original dragged leaf (its share
 * redistributes to its siblings in proportion), normalise. A same-axis ROOT
 * drop merges the wrap into the root split and the removal's renormalization
 * would inflate the clone, so the root split's fractions are then restored to
 * the contract: destination 50% of the axis, survivors splitting the rest in
 * proportion. The result is
 * `noop` when its serialized form equals the input's, `too-small` when any
 * result leaf rect breaks the floor, else `move` with the sizes-stripped
 * canonical tree and the result's pre-order sizes.
 */
export function resolveDrop(
  tree: LayoutNode,
  sizes: LayoutSizes | undefined,
  dragged: string | LayoutLeaf,
  hit: DropHit | null,
  box: Rect,
): DropResult {
  if (hit === null || hit.kind === "self") return { kind: "cancel" };
  if (typeof dragged !== "string") return resolveExternalDrop(tree, sizes, dragged, hit, box);
  const draggedId = dragged;
  const ids = leafIds(tree);
  if (!ids.includes(draggedId)) return { kind: "cancel" };

  let resultTree: LayoutNode;
  let resultSizes: LayoutSizes;
  let destId: string;

  if (hit.kind === "center") {
    const targetIndex = ids.indexOf(hit.targetId);
    if (targetIndex < 0) return { kind: "cancel" };
    resultTree = swapLeaves(tree, draggedId, hit.targetId);
    // Sizes stay with positions — the swap permutes leaves only.
    resultSizes = extractSizes(attachSizes(tree, sizes));
    destId = leafIds(resultTree)[targetIndex];
  } else {
    const sized = attachSizes(tree, sizes);
    const draggedPath = pathOf(sized, draggedId);
    const targetPath = hit.kind === "root" ? [] : pathOf(sized, hit.targetId);
    if (draggedPath === null || targetPath === null) return { kind: "cancel" };
    const draggedNode = getAt(sized, draggedPath);
    if (!isLeaf(draggedNode)) return { kind: "cancel" };
    // Insert MUST precede remove: removing first breaks when the removal
    // collapses the target's parent. The clone IS the placeholder — tracked
    // by identity, so no sentinel value ever escapes the resolver — and it
    // carries the whole leaf (a foreign leaf keeps its home).
    const clone: LayoutLeaf = { ...draggedNode };
    const wrapped = insertBeside(sized, targetPath, hit.side, clone);
    const originalPath = pathOfNode(wrapped, draggedNode);
    if (originalPath === null) return { kind: "cancel" };
    const removed = removeNodeAt(wrapped, originalPath);
    if (removed === null) return { kind: "cancel" };
    // A same-axis ROOT drop merges the wrap into the root split, so the
    // removal's renormalization inflates the clone past its half — restore
    // the contract: the destination keeps 50% of the axis and the surviving
    // siblings split the rest in proportion.
    const normedPre = normalise(removed);
    const destPathPre = pathOfNode(normedPre, clone);
    if (destPathPre === null) return { kind: "cancel" };
    const dropDir: SplitDir = hit.side === "left" || hit.side === "right" ? "h" : "v";
    const normed =
      hit.kind === "root" && destPathPre.length === 1 && isSplit(normedPre) && normedPre.dir === dropDir
        ? rootDestHalf(normedPre, destPathPre[0])
        : normedPre;
    const destPath = destPathPre;
    resultSizes = extractSizes(normed);
    resultTree = stripSizes(normed);
    // Leaf references survive stripSizes, so the clone's id is its
    // reading-order index in the result.
    destId = leafIds(resultTree)[leafIndexAtPath(normed, destPath)];
  }

  if (serializeLayoutTree(resultTree) === serializeLayoutTree(tree)) return { kind: "noop" };
  const resultRects = layoutRects(resultTree, box, resultSizes, SPLIT_GAP_PX);
  for (const rect of resultRects.values()) {
    if (rect.w < MIN_TILE_W || rect.h < MIN_TILE_H) return { kind: "too-small" };
  }
  return { kind: "move", tree: resultTree, sizes: resultSizes, destId };
}

/**
 * The external-leaf half of `resolveDrop`: `leaf` is NOT in the tree, so the
 * edit is the generic one's insert half — wrap the target (path [] for a
 * layout edge) with the new leaf at 50/50 and normalise. With no removal
 * following, a same-axis root merge already leaves the new leaf at half the
 * axis (survivors split the rest in proportion), so no fraction restore is
 * needed. The inserted object rides insertBeside/stripSizes by reference, so
 * its result id is its reading-order index. Center is a `noop` by contract
 * (only edge zones insert); the floor rule is the internal path's. An
 * already-present address is the caller's refusal, not the resolver's.
 */
function resolveExternalDrop(
  tree: LayoutNode,
  sizes: LayoutSizes | undefined,
  leaf: LayoutLeaf,
  hit: Exclude<DropHit, { kind: "self" }>,
  box: Rect,
): DropResult {
  if (hit.kind === "center") return { kind: "noop" };
  const sized = attachSizes(tree, sizes);
  const targetPath = hit.kind === "root" ? [] : pathOf(sized, hit.targetId);
  if (targetPath === null) return { kind: "cancel" };
  const inserted = insertBeside(sized, targetPath, hit.side, leaf);
  const resultSizes = extractSizes(inserted);
  const resultTree = stripSizes(inserted);
  const destPath = pathOfNode(inserted, leaf);
  if (destPath === null) return { kind: "cancel" };
  const destId = leafIds(resultTree)[leafIndexAtPath(inserted, destPath)];
  const resultRects = layoutRects(resultTree, box, resultSizes, SPLIT_GAP_PX);
  for (const rect of resultRects.values()) {
    if (rect.w < MIN_TILE_W || rect.h < MIN_TILE_H) return { kind: "too-small" };
  }
  return { kind: "move", tree: resultTree, sizes: resultSizes, destId };
}

/**
 * The overlay's zone region for a `noop`/`too-small` hit, in layout-box
 * coordinates: the target rect for a center, that half of the target for an
 * edge, that third of the layout box for a root edge. Null for null/self
 * hits (no overlay).
 */
export function zoneRegion(
  hit: DropHit | null,
  rects: Map<string, Rect>,
  box: Rect,
): Rect | null {
  if (hit === null || hit.kind === "self") return null;
  if (hit.kind === "root") {
    switch (hit.side) {
      case "left":
        return { x: box.x, y: box.y, w: box.w / 3, h: box.h };
      case "right":
        return { x: box.x + (2 * box.w) / 3, y: box.y, w: box.w / 3, h: box.h };
      case "top":
        return { x: box.x, y: box.y, w: box.w, h: box.h / 3 };
      case "bottom":
        return { x: box.x, y: box.y + (2 * box.h) / 3, w: box.w, h: box.h / 3 };
    }
  }
  const rect = rects.get(hit.targetId);
  if (!rect) return null;
  if (hit.kind === "center") return rect;
  switch (hit.side) {
    case "left":
      return { ...rect, w: rect.w / 2 };
    case "right":
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top":
      return { ...rect, h: rect.h / 2 };
    case "bottom":
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
  }
}
