import { createContext, useContext } from "react";

/** Which layout drag (if any) is in progress. A sash/intersection drag is
 *  `resize` (the native engine live-resizes its guest every frame); a tile
 *  header drag is `move` (the drop overlay must paint over the tile, so the
 *  composited guest hides). */
export type TileDragPosture = "idle" | "resize" | "move";

/** The layout's drag posture. A React context rather than an engine prop: the
 *  posture is a layout fact the chrome has no business threading, and only the
 *  native engine consumes it. Default `idle` — an engine mounted outside
 *  SurfaceLayout never drags. */
export const TileDragContext = createContext<TileDragPosture>("idle");

export function useTileDragPosture(): TileDragPosture {
  return useContext(TileDragContext);
}
