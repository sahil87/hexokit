import { useCallback, useEffect, useReducer, useRef } from "react";
import { isInfraServer, setServerOrder, type ServerInfo } from "@/api/client";
import { pinDragImage } from "@/lib/drag-image";

/** Debounce for the reorder POST, mirroring the sidebar session-reorder
 *  SESSION_ORDER_DEBOUNCE_MS (250ms) — coalesces a rapid drag-over sweep into
 *  one write. */
const SERVER_ORDER_DEBOUNCE_MS = 250;
/** Custom MIME so a server-reorder drag never collides with the session-reorder
 *  (`application/x-session-reorder`) or window-move (default JSON) payloads. */
const SERVER_REORDER_MIME = "application/x-server-reorder";

function namesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export type ServerTileDragProps = {
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
};

export type UseServerReorder = {
  /** The effective display order of servers — the transient drag override when
   *  a drag is in progress, else the authoritative `servers` prop. Consumers
   *  render THIS instead of `servers` so reordering is instant/optimistic. */
  orderedServers: ServerInfo[];
  /** Drag props for a given tile. Infra tiles get `{ draggable: false }` with no
   *  drop handlers — they are neither draggable nor valid drop targets. */
  getTileProps: (name: string) => ServerTileDragProps;
  /** True while a drag is active (for optional drag-affordance styling). */
  isDragging: boolean;
  /** The name of the tile currently being dragged, or null when no drag is
   *  active. Consumers dim this tile (`opacity-50`) as drag-source feedback,
   *  matching the sidebar session-reorder `isDragSource` treatment. */
  draggingName: string | null;
};

/** Shared HTML5 drag-reorder for the two server-tile grids (sidebar ServerPanel
 *  + Host TMUX SERVERS). Mirrors the sidebar session-reorder pattern
 *  (sidebar/index.tsx): custom MIME, insert-before semantics, and the
 *  derive-over-store optimistic override (a ref, not state) cleared by a
 *  render-time equality reconcile against the authoritative order — no
 *  whole-array watcher effect, no snap-back on drag-end.
 *
 *  Only REGULAR servers participate: infra servers (`isInfraServer`) stay pinned
 *  last as a class, are not draggable, and are not drop targets. The reorder POST
 *  carries the full regular-class order (rank i → i-th regular server); infra
 *  servers ignore rank server-side, so omitting them is correct.
 *
 *  `servers` must be the already-effective-sorted list (from
 *  `ctx.servers`, sorted by `compareServersRanked`). */
export function useServerReorder(
  servers: ServerInfo[],
  onError?: (message: string) => void,
): UseServerReorder {
  // Transient drag override: the full display order of REGULAR server names.
  // A ref (not state) so writing it does not itself re-render; a minimal
  // forceRender nudge drives the optimistic repaint, matching the sidebar.
  const overrideRef = useRef<string[] | null>(null);
  const dragNameRef = useRef<string | null>(null);
  const putTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  // Clear a pending debounced POST on unmount so a drag that ends right before
  // the grid unmounts never fires a stray post-unmount write. Mirrors the
  // sidebar session-reorder cleanup (sidebar/index.tsx:258-262).
  useEffect(() => {
    return () => {
      if (putTimerRef.current) clearTimeout(putTimerRef.current);
    };
  }, []);

  const regularNames = servers.filter((s) => !isInfraServer(s.name)).map((s) => s.name);

  // Render-time reconcile: once the authoritative regular order element-wise
  // equals the stored override, the round-trip has landed — drop the override
  // so we read the authoritative order. Mutating the ref during render is safe
  // (it is not state) and the displayed output is unchanged, so no nudge.
  let effectiveRegular = overrideRef.current;
  if (effectiveRegular && namesEqual(effectiveRegular, regularNames)) {
    overrideRef.current = null;
    effectiveRegular = null;
  }

  // Build the ordered display list. When an override is active, reorder the
  // regular ServerInfos by the override names (dropping any name no longer
  // present) and keep infra servers pinned last in their existing order.
  let orderedServers: ServerInfo[];
  if (effectiveRegular) {
    const byName = new Map(servers.map((s) => [s.name, s]));
    const regulars: ServerInfo[] = [];
    for (const name of effectiveRegular) {
      const s = byName.get(name);
      if (s && !isInfraServer(s.name)) regulars.push(s);
    }
    // Any regular server missing from the override (e.g. created mid-drag)
    // appends after, preserving its authoritative relative order.
    for (const s of servers) {
      if (!isInfraServer(s.name) && !effectiveRegular.includes(s.name)) regulars.push(s);
    }
    const infra = servers.filter((s) => isInfraServer(s.name));
    orderedServers = [...regulars, ...infra];
  } else {
    orderedServers = servers;
  }

  const onDragStart = useCallback((e: React.DragEvent, name: string) => {
    if (isInfraServer(name)) return;
    pinDragImage(e);
    dragNameRef.current = name;
    e.dataTransfer.setData(SERVER_REORDER_MIME, name);
    e.dataTransfer.effectAllowed = "move";
    // Seed the override with the current regular order so subsequent dragOver
    // splices operate on a stable base.
    overrideRef.current = servers.filter((s) => !isInfraServer(s.name)).map((s) => s.name);
    forceRender();
  }, [servers]);

  const onDragOver = useCallback((e: React.DragEvent, targetName: string) => {
    const dragName = dragNameRef.current;
    if (!dragName) return; // drag from another hook instance — not ours
    if (isInfraServer(targetName)) return; // infra tiles are not drop targets
    if (!e.dataTransfer.types.includes(SERVER_REORDER_MIME)) return;
    // Accept the drop BEFORE the self-target check: HTML5 DnD only registers a
    // release as accepted when the last dragover was preventDefault()ed. Because
    // insert-before splicing lands the dragged tile under the cursor, the final
    // dragover fires on the dragged tile's OWN element — bailing early there
    // would leave the drop uncancelled and play the native cancelled-drag
    // snap-back animation to the origin (and starve the onDrop flush path).
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragName === targetName) return; // …then bail: nothing to reorder

    const base = overrideRef.current ?? servers.filter((s) => !isInfraServer(s.name)).map((s) => s.name);
    const fromIdx = base.indexOf(dragName);
    const toIdx = base.indexOf(targetName);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const next = [...base];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, dragName); // insert-before semantics

    if (putTimerRef.current) clearTimeout(putTimerRef.current);
    const orderToPut = next.slice();
    putTimerRef.current = setTimeout(() => {
      putTimerRef.current = null;
      setServerOrder(orderToPut).catch((err: Error) => {
        onError?.(err.message || "Failed to save workspace order");
      });
    }, SERVER_ORDER_DEBOUNCE_MS);

    overrideRef.current = next;
    forceRender();
  }, [servers, onError]);

  const onDragEnd = useCallback(() => {
    // No snap-back: the override outlives the debounced POST until the SSE echo
    // (server-order) re-sorts ctx.servers to match, which clears it via the
    // render-time reconcile above. Just drop the active-drag marker.
    dragNameRef.current = null;
    forceRender();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(SERVER_REORDER_MIME)) return;
    e.preventDefault();
    // The dragOver handler already computed + scheduled the order; the drop just
    // finalizes. Flush any pending debounced POST immediately so the write is
    // not lost if the SSE echo races the timer.
    if (putTimerRef.current && overrideRef.current) {
      clearTimeout(putTimerRef.current);
      putTimerRef.current = null;
      const orderToPut = overrideRef.current.slice();
      setServerOrder(orderToPut).catch((err: Error) => {
        onError?.(err.message || "Failed to save workspace order");
      });
    }
    dragNameRef.current = null;
  }, [onError]);

  const getTileProps = useCallback((name: string): ServerTileDragProps => {
    if (isInfraServer(name)) return { draggable: false };
    return {
      draggable: true,
      onDragStart: (e) => onDragStart(e, name),
      onDragOver: (e) => onDragOver(e, name),
      onDragEnd,
      onDrop,
    };
  }, [onDragStart, onDragOver, onDragEnd, onDrop]);

  return {
    orderedServers,
    getTileProps,
    isDragging: dragNameRef.current !== null,
    draggingName: dragNameRef.current,
  };
}
