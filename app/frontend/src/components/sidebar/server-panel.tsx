import { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { CollapsiblePanel } from "./collapsible-panel";
import { LogoSpinner } from "@/components/logo-spinner";
import { UNCOLORED_SELECTED_KEY, type RowTint } from "@/themes";
import { isExternalServer, isInfraServer, DAEMON_SERVER, type ServerInfo } from "@/api/client";
import { ExternalGlyph, ShieldGlyph } from "@/components/top-bar-icons";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useServerReorder, type ServerTileDragProps } from "@/hooks/use-server-reorder";
import { useToast } from "@/components/toast";
import { WaitingBadge } from "@/components/waiting-badge";
import { FlairOverlay } from "@/components/flair-overlay";
import { SwatchPopover } from "@/components/swatch-popover";
import { useRowFlyout } from "./row-flyout-card";
import { ServerCardContent, useAnchoredPopoverPos } from "./server-card";

type ServerPanelProps = {
  server: string;
  servers: ServerInfo[];
  /** server name → color value descriptor ("4" / "1+3"). */
  serverColors: Record<string, string>;
  /** server name → flair token (universal set). */
  serverFlairs?: Record<string, string>;
  /** server name → count of waiting windows (from countWaitingInSessions).
   *  Attached-server-only by construction: an unattached server has no windows
   *  streamed, so its count is 0 and the tile's badge is simply absent. */
  waitingCounts?: Map<string, number>;
  rowTints?: Map<string, RowTint>;
  /** Contrast-adjusted full-saturation border color per color value. */
  rowBorders?: Map<string, string>;
  onSwitchServer: (name: string) => void;
  onCreateServer: () => void;
  onRefreshServers: () => void;
  /** Server color write seam for the tile card's `Change color…` popover.
   *  Optional (the optional-handler gate): unwired ⇒ no color row. */
  onServerColorChange?: (server: string, color: string | null) => void;
  /** Routed by the tile card's New session row. */
  onCreateSession?: (server: string) => void;
  /** Routes to the parent's kill-server confirmation dialog; never kills
   *  directly. */
  onKillServer?: (name: string) => void;
  /** Protect toggle for the tile card's switch row, called with the NEW
   *  state. */
  onToggleServerProtect?: (server: string, next: boolean) => void;
  /** Forwarded to CollapsiblePanel's corner affordance. When supplied, a corner
   *  element renders at the bottom-right of the drag handle and initiates a
   *  sidebar-width drag in addition to the panel's vertical resize. */
  onSidebarResizeStart?: (e: React.PointerEvent<HTMLDivElement>) => void;
};

export function ServerPanel({
  server,
  servers,
  serverColors,
  serverFlairs,
  waitingCounts,
  rowTints,
  rowBorders,
  onSwitchServer,
  onCreateServer,
  onRefreshServers,
  onServerColorChange,
  onCreateSession,
  onKillServer,
  onToggleServerProtect,
  onSidebarResizeStart,
}: ServerPanelProps) {
  const [refreshing, setRefreshing] = useState(false);
  const isMobile = useIsMobile();
  const activeTileRef = useRef<HTMLButtonElement>(null);
  const { addToast } = useToast();
  // Drag-reorder for regular server tiles (shared with the Host grid).
  // `servers` is already effective-sorted upstream; the hook returns the
  // transient optimistic order to render while a drag is in progress.
  const { orderedServers, getTileProps, isDragging, draggingName } = useServerReorder(servers, addToast);

  const handleToggle = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        setRefreshing(true);
        Promise.resolve(onRefreshServers()).finally(() => setRefreshing(false));
      }
    },
    [onRefreshServers],
  );

  // Scroll the active tile into view on mount and on server change — both
  // layouts: `block: "nearest"` handles the vertical desktop tile grid (which
  // scrolls internally inside the resizable CollapsiblePanel), `inline:
  // "nearest"` the horizontal mobile single-row strip. The `typeof` guard
  // covers jsdom, which lacks scrollIntoView.
  useEffect(() => {
    const el = activeTileRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [server]);

  // The active server's name is NOT repeated here — the highlighted tile and
  // the top-bar page heading already show it. Only the refresh spinner rides
  // the header-right slot.
  const headerRight = <>{refreshing && <LogoSpinner size={10} />}</>;

  const gridStyle: React.CSSProperties = isMobile
    ? {
        gridAutoFlow: "column",
        gridAutoColumns: "72px",
        overflowX: "auto",
        overflowY: "hidden",
        scrollSnapType: "x mandatory",
      }
    : {
        // 72px floor (matching the mobile column width): the tile's count row
        // holds a bare window-count number plus the waiting rollup badge — the
        // old 88px floor existed only to fit the wider "N sess" text beside
        // the badge.
        gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
      };

  return (
    <CollapsiblePanel
      title="Servers"
      storageKey="hexokit-panel-server"
      defaultOpen={true}
      onToggle={handleToggle}
      headerRight={headerRight}
      contentClassName="px-1.5 sm:px-2 pt-1.5 pb-1.5"
      headerAction={
        <button
          onClick={onCreateServer}
          aria-label="New tmux server"
          className="text-text-secondary hover:text-text-primary transition-colors text-[13px] px-1 min-w-[24px] min-h-[24px] coarse:min-w-[40px] coarse:min-h-[40px] -my-1 coarse:-my-3 flex items-center justify-center"
        >
          +
        </button>
      }
      resizable
      defaultHeight={50}
      minHeight={50}
      mobileHeight={50}
      onCornerPointerDown={onSidebarResizeStart}
    >
      {servers.length === 0 ? (
        <span className="block text-xs text-text-secondary py-1">No servers</span>
      ) : (
        <div
          className="grid gap-1.5"
          style={gridStyle}
          role="listbox"
          aria-label="Tmux servers"
        >
          {orderedServers.map((info) => {
            const { name, sessionCount, windowCount } = info;
            const color = serverColors[name];
            const tint = color != null && rowTints ? rowTints.get(color) ?? null : null;
            const uncoloredSelectedTint = rowTints?.get(UNCOLORED_SELECTED_KEY) ?? null;
            const isActive = name === server;
            // Stripe mirrors window-row's left-border treatment: colored only when active;
            // transparent otherwise (height reserved to avoid text shift between states).
            // Border color is the contrast-adjusted full-saturation hex from rowBorders.
            const stripeBg = !isActive
              ? "transparent"
              : color != null && rowBorders
              ? rowBorders.get(color) ?? "var(--color-border)"
              : rowBorders
              ? rowBorders.get(UNCOLORED_SELECTED_KEY) ?? "var(--color-border)"
              : "var(--color-border)";
            const external = isExternalServer(info);
            // An external server with no assigned color gets a hatched stripe
            // placeholder in place of the color signature; an assigned color
            // still wins the solid stripe above.
            const hatchStripe = external && color == null && isActive ? "var(--color-border)" : undefined;
            return (
              <ServerTile
                key={name}
                name={name}
                sessionCount={sessionCount}
                windowCount={windowCount ?? 0}
                color={color}
                waitingCount={waitingCounts?.get(name) ?? 0}
                tint={tint}
                uncoloredSelectedTint={uncoloredSelectedTint}
                stripeBg={stripeBg}
                hatchStripe={hatchStripe}
                flair={serverFlairs?.[name]}
                flairColor={color != null && rowBorders ? rowBorders.get(color) : undefined}
                isActive={isActive}
                isMobile={isMobile}
                isProtected={name === DAEMON_SERVER || info.protected === true}
                isExternal={external}
                dragProps={getTileProps(name)}
                isDragSource={isDragging && draggingName === name}
                tileRef={isActive ? activeTileRef : undefined}
                onClick={() => onSwitchServer(name)}
                onServerColorChange={onServerColorChange}
                onCreateSession={onCreateSession}
                onKillServer={onKillServer}
                onToggleServerProtect={onToggleServerProtect}
              />
            );
          })}
        </div>
      )}
    </CollapsiblePanel>
  );
}

type ServerTileProps = {
  name: string;
  sessionCount: number;
  /** Total windows across the server's sessions — the tile's count number. */
  windowCount: number;
  /** The server's color value descriptor — the tile popover's selectedColor. */
  color?: string;
  /** Count of waiting windows on this server; 0 renders no badge. */
  waitingCount: number;
  tint: RowTint | null;
  uncoloredSelectedTint: RowTint | null;
  stripeBg: string;
  /** Hatched-stripe color: set (instead of stripeBg being meaningful) when an
   *  external server has no assigned color — a repeating-linear-gradient
   *  placeholder fills the color-signature slot. Border stays solid. */
  hatchStripe?: string;
  /** The server-class glyph predicates (system-owned leading slot, never the
   *  style channel): shield for protected/daemon, ↗ for external. Both render
   *  when both apply, shield first. */
  isProtected: boolean;
  isExternal: boolean;
  /** The server's flair token, or undefined when unset. */
  flair?: string;
  /** The guarded stripe color source (rowBorders-derived) — the tint for
   *  rain/scan flairs. */
  flairColor?: string;
  isActive: boolean;
  isMobile: boolean;
  /** HTML5 drag-reorder props (from useServerReorder). Infra tiles receive
   *  `{ draggable: false }` with no handlers. */
  dragProps: ServerTileDragProps;
  /** True while THIS tile is the active drag source — dims it (`opacity-50`)
   *  as drag-source feedback, matching the session-reorder treatment. */
  isDragSource: boolean;
  tileRef?: React.Ref<HTMLButtonElement>;
  onClick: () => void;
  /** The tile card's seams (the same shared identity-arg callbacks the
   *  sessions-pane group header binds). Optional per the card's
   *  optional-handler gate. */
  onServerColorChange?: (server: string, color: string | null) => void;
  onCreateSession?: (server: string) => void;
  onKillServer?: (name: string) => void;
  onToggleServerProtect?: (server: string, next: boolean) => void;
};

function ServerTile({
  name,
  sessionCount,
  windowCount,
  color,
  waitingCount,
  tint,
  uncoloredSelectedTint,
  stripeBg,
  hatchStripe,
  isProtected,
  isExternal,
  flair,
  flairColor,
  isActive,
  isMobile,
  dragProps,
  isDragSource,
  tileRef,
  onClick,
  onServerColorChange,
  onCreateSession,
  onKillServer,
  onToggleServerProtect,
}: ServerTileProps) {
  // Body background follows the window-row convention:
  //   - Colored: tint.selected (active) or tint.base (not active)
  //   - Uncolored active: borrow the gray UNCOLORED_SELECTED_ANSI tint
  //   - Uncolored non-active: no background, subtle hover via Tailwind class
  const bodyBg = isActive
    ? tint?.selected ?? uncoloredSelectedTint?.selected
    : tint?.base;
  const uncoloredHoverClass = !tint && !isActive ? "hover:bg-bg-chrome-raised" : "";
  // De-emphasize infrastructure servers (daemon + test sockets) and external
  // servers alike: grey the name, not disabled. Hover/click/active-selection
  // stay unchanged so the tile remains fully attachable and never reads as
  // dead/disconnected.
  const nameClass = isInfraServer(name) || isExternal ? "text-text-secondary" : "text-text-primary";

  // The tile hosts the SAME server card as the sessions-pane group header
  // (the shared shell + the shared ServerCardContent), opened on fine-pointer
  // hover/focus of the tile. No rail and no coarse trigger: the card is
  // suppressed outright on coarse pointers, where the sessions-pane header
  // card remains the server surface. The tile-anchored color popover is
  // portalled to document.body (the sessions list's overflow would clip it)
  // and opened only from the card's Change color… row; its open state
  // suppresses the card (popover-over-card precedence).
  const coarse = useCoarsePointer();
  const [showColorPicker, setShowColorPicker] = useState(false);
  const tileAnchorRef = useRef<HTMLElement | null>(null);
  const popoverPos = useAnchoredPopoverPos(showColorPicker, tileAnchorRef);
  const flyout = useRowFlyout({
    suppressed: coarse || showColorPicker,
    // Tiles sit in a multi-column grid, not full-bleed like rows: without the
    // edge anchor the card opens mid-panel over sibling tiles, and the pointer
    // path to it would hover-steal across them.
    edgeAnchor: true,
    content: ({ close }) => (
      <ServerCardContent
        server={name}
        sessionCount={sessionCount}
        external={isExternal}
        serverProtected={isProtected}
        onToggleProtect={
          onToggleServerProtect ? () => onToggleServerProtect(name, !isProtected) : undefined
        }
        // Close-then-open (the Pin-row idiom): the card closes BEFORE the
        // tile's color popover opens.
        onChangeColorAction={
          onServerColorChange
            ? () => {
                close();
                setShowColorPicker(true);
              }
            : undefined
        }
        onCreateSession={onCreateSession}
        onKillServer={onKillServer}
      />
    ),
  });

  // The tile wrapper is the card's floating reference AND the popover's
  // anchor — one stable callback sets both (the group header's idiom).
  const setTileRefs = useCallback(
    (node: HTMLElement | null) => {
      flyout.setReference(node);
      tileAnchorRef.current = node;
    },
    [flyout.setReference],
  );

  return (
    <div
      className={`relative${isDragSource ? " opacity-50" : ""}`}
      style={{ scrollSnapAlign: isMobile ? "start" : undefined }}
      ref={setTileRefs}
      {...flyout.referenceProps}
      draggable={dragProps.draggable}
      onDragStart={
        dragProps.onDragStart
          ? (e) => {
              // A drag gesture must not leave an open hover card behind.
              flyout.close();
              dragProps.onDragStart!(e);
            }
          : undefined
      }
      onDragOver={dragProps.onDragOver}
      onDragEnd={dragProps.onDragEnd}
      onDrop={dragProps.onDrop}
    >
      <button
        ref={tileRef}
        onClick={onClick}
        aria-current={isActive ? "true" : undefined}
        role="option"
        aria-selected={isActive}
        className={`relative block w-full text-left border border-border overflow-hidden transition-colors hover:border-text-secondary ${uncoloredHoverClass}`}
        style={bodyBg ? { backgroundColor: bodyBg } : undefined}
      >
        {/* Flair overlay (decoration-only channel): mounted whenever the
            server carries a flair value — same overlay discipline as the
            sidebar rows (clipped, pointer-events-none, z-5). Hidden while this
            tile is the drag source (cube/warp animate transforms on child
            spans — the drag ghost rule) and under prefers-reduced-motion. */}
        <FlairOverlay flair={flair} hidden={isDragSource} color={flairColor} />
        {/* Top color stripe — the server signature/active marker (top border =
            server, left border = window rows). External+uncolored renders a
            hatched placeholder in the signature slot instead of a solid fill. */}
        <div
          className="h-0.5"
          style={
            hatchStripe
              ? { backgroundImage: `repeating-linear-gradient(45deg, ${hatchStripe} 0 2px, transparent 2px 5px)` }
              : { backgroundColor: stripeBg }
          }
        />
        {/* Body */}
        <div className="px-1.5 pt-0.5 pb-1.5">
          <div className={`text-[11px] leading-tight font-medium ${nameClass} whitespace-nowrap overflow-hidden text-ellipsis`}>
            {isProtected && (
              <span
                role="img"
                aria-label={`${name} is protected`}
                className="inline-flex align-[-2px] mr-0.5"
                data-testid={`shield-${name}`}
              >
                <ShieldGlyph />
              </span>
            )}
            {isExternal && (
              <span
                role="img"
                aria-label={`${name} is external`}
                className="inline-flex align-[-2px] mr-0.5"
                data-testid={`external-${name}`}
              >
                <ExternalGlyph />
              </span>
            )}
            {name}
          </div>
          {/* Window count + waiting rollup (260708-4li7): a bare window-count
              number with the badge right-aligned on the same flex row — the
              count row is the badge's home. WaitingBadge renders null at
              count <= 0, so the common (nothing-waiting) layout is
              unchanged. */}
          {/* h-3.5 reserves the badge's full height even when no badge renders:
              the pill is taller than the count text, so without the reserve the
              tile (and its whole grid row) would jump in height every time an
              agent starts/stops waiting. */}
          <div className="flex h-3.5 items-center justify-between mt-0.5">
            <div className="text-[10px] leading-tight text-text-secondary">
              {windowCount}
            </div>
            <WaitingBadge count={waitingCount} />
          </div>
        </div>
      </button>
      {/* The tile-anchored color popover — portalled to body so it escapes
          the panel's overflow clip, positioned by the shared flip heuristic.
          Opened ONLY from the card's Change color… row. */}
      {showColorPicker && onServerColorChange && popoverPos && createPortal(
        <div
          style={{
            position: "fixed",
            top: popoverPos.top,
            right: popoverPos.right,
            zIndex: 100,
          }}
        >
          <SwatchPopover
            selectedColor={color}
            rowName={name}
            // Selection does NOT close (the picker's dismissal contract).
            onSelect={(c) => onServerColorChange(name, c)}
            onClose={() => setShowColorPicker(false)}
          />
        </div>,
        document.body,
      )}
      {/* The server card — portalled to document.body, mounted ONLY while
          open (the shared shell's perf contract). */}
      {flyout.card}
    </div>
  );
}
