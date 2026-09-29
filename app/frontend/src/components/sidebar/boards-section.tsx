import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useBoards } from "@/hooks/use-boards";
import { useBoardListReorder } from "@/hooks/use-board-list-reorder";
import { usePinActions } from "@/hooks/use-pin-actions";
import { useActiveBoardName } from "@/hooks/use-active-board";
import { useToast } from "@/components/toast";
import { PinIcon } from "@/components/pin-icon";
import { CollapsiblePanel } from "./collapsible-panel";

/** Marker MIME the window-row drag start (sidebar/index.tsx) sets alongside
 *  its generic application/json payload, so foreign drop targets (these board
 *  rows) can gate on `dataTransfer.types` during dragover — payload data stays
 *  sealed until drop, and application/json is too generic to gate on. Mirrors
 *  the dedicated-MIME convention of the reorder hooks. */
export const WINDOW_DRAG_MIME = "application/x-window-drag";

/**
 * BoardsSection renders the cross-server boards list at the top of the
 * sidebar. Visibility:
 *   - Always visible (regardless of route or board count). When zero boards
 *     exist, the body shows a `Pin a window to start a board` hint instead
 *     of board rows.
 *
 * Click a row → navigate to /board/<name>. Rows are also drag-to-pin drop
 * targets: a window-row drag (WINDOW_DRAG_MIME) hovered over a row gets a copy
 * cursor + drop-target ring, and dropping pins the window to that board via
 * the shared usePinActions.pin (toast + last-used persistence + SSE reconcile
 * inherited unchanged). The two drag species dispatch by MIME, so the
 * board-list reorder handlers are untouched fall-through paths.
 *
 * Self-contained via hooks — no props needed; safe to render inside
 * SessionProvider since useBoards() fetches /api/boards directly (cross-server,
 * not server-scoped).
 *
 * The previous "hide entirely when zero boards exist AND not on a board route"
 * rule from 4vuv §5 was replaced when the section moved to the top of the
 * sidebar (17m3) — hide-when-empty would shift Servers into and out of the
 * top slot whenever the first/last board materialised.
 */
export function BoardsSection() {
  const { boards } = useBoards();
  const { addToast } = useToast();
  const { orderedBoards, getTileProps, isDragging, draggingName } = useBoardListReorder(
    boards,
    addToast,
  );
  const navigate = useNavigate();
  const activeBoardName = useActiveBoardName();
  const { pin } = usePinActions();
  // Board name currently highlighted as the window-drag drop target (drag-to-
  // pin), or null. Local hover feedback only — set on marker-gated dragover,
  // cleared on dragleave/drop.
  const [windowDropTarget, setWindowDropTarget] = useState<string | null>(null);

  const isHintMode = boards.length === 0;

  return (
    <CollapsiblePanel
      title="Boards"
      storageKey="hexokit-panel-boards"
      // Default open once boards exist so a fresh pin surfaces where it landed.
      // useLocalStorageBoolean only consults this default when no stored key
      // exists and resyncs on default change, so the panel opens live when the
      // first board appears while an explicit user toggle always wins.
      defaultOpen={boards.length > 0}
      contentClassName=""
      headerRight={
        // The shared PinIcon visually links the window-row pin affordance to
        // where pins land; leads the count and stays in zero-board hint mode.
        <span className="flex items-center gap-1.5 text-text-secondary">
          <PinIcon />
          {boards.length > 0 ? <span className="text-xs">{boards.length}</span> : null}
        </span>
      }
    >
      {isHintMode ? (
        <div className="pl-5 pr-2 py-2 text-xs text-text-secondary">
          Pin a window to start a board
        </div>
      ) : (
        <ul className="flex flex-col">
          {orderedBoards.map((b) => {
            const isActive = b.name === activeBoardName;
            const drag = getTileProps(b.name);
            const isDragSource = isDragging && draggingName === b.name;
            const isWindowDropTarget = windowDropTarget === b.name;
            // Full-bleed rows: the former 12px `ml-3` list indent lives in the
            // button's left padding (pl-5 = 12 + the old px-2's 8), so the
            // active/hover fills span the sidebar edge-to-edge while the board
            // name keeps its x-position.
            return (
              <li key={b.name}>
                <button
                  type="button"
                  draggable={drag.draggable}
                  onDragStart={drag.onDragStart}
                  onDragOver={(e) => {
                    // Window drag (drag-to-pin): accept with a copy cursor (pin
                    // LINKS the window — dual presence, not a move) and ring
                    // the row. Otherwise fall through to board-list reorder.
                    if (!e.dataTransfer.types.includes(WINDOW_DRAG_MIME)) {
                      drag.onDragOver(e);
                      return;
                    }
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setWindowDropTarget(b.name);
                  }}
                  onDragEnd={drag.onDragEnd}
                  onDragLeave={() => {
                    setWindowDropTarget((prev) => (prev === b.name ? null : prev));
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes(WINDOW_DRAG_MIME)) {
                      drag.onDrop(e);
                      return;
                    }
                    e.preventDefault();
                    setWindowDropTarget(null);
                    // Payload shape mirrors the window drag start's JSON. No
                    // client-side gating (cross-server, already-pinned): the
                    // backend's re-stamp/no-op semantics decide, matching the
                    // popover path.
                    let parsed: unknown;
                    try {
                      parsed = JSON.parse(e.dataTransfer.getData("application/json"));
                    } catch {
                      return; // malformed payload — ignore, mirroring handleDrop
                    }
                    // JSON.parse can legally yield null/primitives — narrow
                    // before reading properties so those are ignored too.
                    if (
                      typeof parsed === "object" &&
                      parsed !== null &&
                      "server" in parsed &&
                      typeof parsed.server === "string" &&
                      "windowId" in parsed &&
                      typeof parsed.windowId === "string"
                    ) {
                      pin(parsed.server, parsed.windowId, b.name);
                    }
                  }}
                  onClick={() => navigate({ to: "/board/$name", params: { name: b.name } })}
                  aria-current={isActive ? "page" : undefined}
                  className={`w-full flex items-center justify-between gap-2 pl-5 pr-2 py-px text-left transition-colors min-h-[24px] coarse:min-h-[36px] ${
                    isActive
                      ? "bg-bg-chrome-raised text-text-primary font-medium"
                      : "text-text-secondary hover:text-text-primary hover:bg-bg-chrome-raised"
                  }${isDragSource ? " opacity-50" : ""}`}
                  // Drop-target ring mirrors the session cross-move highlight
                  // in session-row.tsx (isSessionDropTarget).
                  style={
                    isWindowDropTarget
                      ? { boxShadow: "inset 0 0 0 2px var(--color-accent)", borderRadius: "4px" }
                      : undefined
                  }
                >
                  <span className="truncate text-xs">{b.name}</span>
                  <span className="text-xs text-text-secondary shrink-0">{b.pinCount}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsiblePanel>
  );
}
