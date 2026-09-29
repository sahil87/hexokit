import { useState, useMemo, memo } from "react";
import type { ProjectSession } from "@/types";
import type { MergedSession } from "@/contexts/optimistic-context";
import type { RowTint } from "@/themes";
import { UNCOLORED_SELECTED_KEY } from "@/themes";
import { SwatchPopover } from "@/components/swatch-popover";
import { FlairOverlay } from "@/components/flair-overlay";
import { WaitingBadge } from "@/components/waiting-badge";
import { countWaitingWindows } from "@/lib/waiting";
import { toSafeSessionName } from "@/lib/names";
import { abbreviateHomePath, formatDuration } from "@/lib/format";
import { PaletteIcon, BotIcon, PlusIcon, CloseIcon, NotePencilIcon, PlugIcon } from "./icons";
import { PopupTitleBar, PopupTitleBarSecondary } from "./popup-title-bar";
import {
  useRowFlyout,
  useRailScrub,
  CardActionList,
  CardActionRow,
  STATUS_RAIL_WIDTH_PX,
  railRestBand,
  railHeldBand,
  RAIL_HELD_SEAM,
} from "./row-flyout-card";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";

type SessionRowProps = {
  /** Tmux server this session belongs to — bound into the identity-arg
   *  handlers below so a single stable handler reference serves every row.
   *  This is what makes React.memo on SessionRow effective across SSE ticks. */
  server: string;
  session: ProjectSession | MergedSession;
  /** Color value descriptor: "4" for a single ANSI index, "1+3" for a blend. */
  sessionColor?: string;
  rowTints?: Map<string, RowTint>;
  /** Guarded per-family border colors (contrast-adjusted) — the tint source
   *  for the tinted flairs (rain/scan read --rk-flair-color). */
  rowBorders?: Map<string, string>;
  isCollapsed: boolean;
  isSessionDropTarget: boolean;
  editingSession: string | null;
  editingSessionName: string;
  sessionInputRef: React.RefObject<HTMLInputElement | null>;
  draggable?: boolean;
  isDragSource?: boolean;
  /** Group-scoped ordered session names — stable (memoized) in ServerGroup;
   *  passed straight through and bound into the reorder-start/over closures. */
  orderedNames: string[];
  onDragStart?: (e: React.DragEvent, server: string, name: string, orderedNames: string[]) => void;
  onDragEnd?: () => void;
  onToggleCollapse: (server: string, name: string) => void;
  onSelectFirstWindow: (server: string, session: string, windowId: string) => void;
  onCreateWindow: (server: string, session: string) => void;
  onKillClick: (server: string, name: string, windowCount: number, ctrl: boolean) => void;
  onDoubleClickName: (server: string, name: string) => void;
  onSessionNameChange: (value: string) => void;
  onSessionRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onSessionRenameBlur: () => void;
  /** Cross-session window drag-over (its own server/name binding) AND session
   *  reorder-over (needs orderedNames). The row invokes both. */
  onDragOver: (e: React.DragEvent, server: string, name: string) => void;
  onReorderOver: (e: React.DragEvent, server: string, targetName: string, naturalNames: string[]) => void;
  onDragLeave: (e: React.DragEvent, server: string, name: string) => void;
  onDrop: (e: React.DragEvent, server: string, name: string) => void;
  onColorChange?: (server: string, name: string, color: string | null) => void;
  /** Persist a flair state for this session. The picker's flair section passes
   *  the EXACT picked state here ("" mapped to null clears). Optional (mirrors
   *  `onColorChange`): omitted ⇒ the picker renders no flair section. */
  onFlairChange?: (server: string, name: string, flair: string | null) => void;
  /** Optional waiting-badge click (260714-r7rq): navigate to the next waiting
   *  window in this session (the target renders its own stored layout).
   *  Absent ⇒ the badge stays display-only. */
  onWaitingBadgeClick?: (server: string, session: string) => void;
  /** Open the spawn-agent dialog targeting THIS row's session. Optional (mirrors
   *  `onColorChange`): the card's Spawn agent… row renders only when supplied —
   *  the board-route sidebar passes no handler, so the row is hidden there. */
  onSpawnAgent?: (server: string, session: string) => void;
  /** Fire the update-annotations operator request scoped to THIS row's session
   *  (260827-8n6k). Optional (mirrors `onSpawnAgent`): the card row renders only
   *  when supplied — the consumer also gates on the server having an operator
   *  window, so no operator ⇒ no row (degrade to absent, never disabled). */
  onUpdateAnnotations?: (server: string, session: string) => void;
  /** Roving-tabindex value: `0` for the single roving-focused tree row, `-1`
   *  otherwise. Defaults to `-1`. Only the two affected rows change this per
   *  arrow keypress, preserving the Wave-2 memo tree. */
  tabIndex?: number;
  /** W3C-APG tree node metadata. Session rows are level-1 nodes. `ariaSetSize`
   *  is the count of sibling sessions in the group; `ariaPosInSet` the row's
   *  1-based position among them. `windowGroupId` is the `id` of the
   *  `role="group"` window-list container, referenced by `aria-controls`
   *  ONLY while expanded (the group is unmounted when collapsed).
   *  Omitted ⇒ not announced (e.g. unit tests rendering a bare row). */
  ariaSetSize?: number;
  ariaPosInSet?: number;
  windowGroupId?: string;
  /** Stable DOM handle for the roving-focus effect to query — analogous to the
   *  window row's `data-window-id`. Value is the `${server}:${name}` key. */
  sessionRowKey?: string;
};

function SessionRowInner({
  server,
  session,
  sessionColor,
  rowTints,
  rowBorders,
  isCollapsed,
  isSessionDropTarget,
  editingSession,
  editingSessionName,
  sessionInputRef,
  draggable,
  isDragSource,
  orderedNames,
  onDragStart,
  onDragEnd,
  onToggleCollapse,
  onSelectFirstWindow,
  onCreateWindow,
  onKillClick,
  onDoubleClickName,
  onSessionNameChange,
  onSessionRenameKeyDown,
  onSessionRenameBlur,
  onDragOver,
  onReorderOver,
  onDragLeave,
  onDrop,
  onColorChange,
  onFlairChange,
  onWaitingBadgeClick,
  onSpawnAgent,
  onUpdateAnnotations,
  tabIndex = -1,
  ariaSetSize,
  ariaPosInSet,
  windowGroupId,
  sessionRowKey,
}: SessionRowProps) {
  const name = session.name;
  const [showColorPicker, setShowColorPicker] = useState(false);
  const coarse = useCoarsePointer();
  // Ghost (optimistic, mid-create) sessions get no rail and a suppressed card
  // — the window row's ghost-row rule.
  const ghost = "optimistic" in session && session.optimistic === true;
  // Count this session's waiting windows once (used for both the badge count and
  // its aria label below).
  const waitingCount = countWaitingWindows(session.windows);

  // The card's facts line: tmux `$N` id, window count, root path — the facts
  // the row itself can't show. sessionId/sessionPath are absent on old
  // payloads — the line omits the segments it cannot derive.
  const windowCount = session.windows.length;
  const factsLine = [
    session.sessionId,
    `${windowCount} tab${windowCount === 1 ? "" : "s"}`,
    session.sessionPath ? abbreviateHomePath(session.sessionPath) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  // Attached-viewer signal: the count chip and the card's per-viewer rows
  // render only at ≥2 sized viewers — the 1-viewer case is the norm and adds
  // zero chrome. Informational channel, not an attention overlay: the neutral
  // count-chip idiom (no signal-yellow), non-interactive, no new props — the
  // input is `session.viewers`, already on the row's session prop. Each row
  // names the viewer: device tag · grid · peer · age · idle · narrowest (the
  // clamping client, min width, ties all marked). Age/idle derive from
  // absolute unix-second timestamps at render (no ticker — every sessions
  // push re-renders); an old-backend payload (width/height only) still
  // renders the grid rows.
  const viewers = session.viewers ?? [];
  const showViewers = viewers.length >= 2;
  const viewerRows: string[] = [];
  if (showViewers) {
    const now = Date.now() / 1000;
    const minWidth = Math.min(...viewers.map((v) => v.width));
    for (const v of viewers) {
      const segments: string[] = [];
      if (v.kind === "rk" && v.device) segments.push(v.device);
      else if (v.kind === "tty") segments.push("tty");
      segments.push(`${v.width}×${v.height}`);
      if (v.peer) segments.push(v.peer);
      if (v.createdAt) segments.push(formatDuration(now - v.createdAt));
      if (v.lastActiveAt) segments.push(`idle ${formatDuration(now - v.lastActiveAt)}`);
      if (v.width === minWidth) segments.push("narrowest");
      viewerRows.push(segments.join(" · "));
    }
  }

  // The session card: the SAME shared card shell as the window flyout (one
  // placement/containment/held implementation), on BOTH pointer classes —
  // fine-pointer hover/focus at the sidebar's right edge, and the coarse
  // rail's tap/scrub (`openNow`). Title + one facts line + the action rows.
  const flyout = useRowFlyout({
    suppressed: ghost || showColorPicker,
    content: ({ close }) => (
      <>
        <PopupTitleBar>
          <PopupTitleBarSecondary>Session </PopupTitleBarSecondary>
          {name}
        </PopupTitleBar>
        {factsLine && <span className="text-text-secondary break-words">{factsLine}</span>}
        {showViewers && (
          <span data-testid="row-flyout-viewers" className="text-text-secondary break-words flex flex-col">
            <span>{viewers.length} viewers</span>
            {viewerRows.map((row, i) => (
              <span key={i} data-testid="row-flyout-viewer">
                {row}
              </span>
            ))}
          </span>
        )}
        <CardActionList>
          {onColorChange && (
            <CardActionRow
              icon={<PaletteIcon />}
              label="Change color…"
              testid="row-flyout-color-action"
              // Close-then-open (the Pin-row idiom): the card closes BEFORE the
              // row's color popover opens; `suppressed` includes
              // `showColorPicker`, so popover-over-card precedence holds.
              onClick={() => {
                close();
                setShowColorPicker(true);
              }}
            />
          )}
          {onSpawnAgent && (
            <CardActionRow
              icon={<BotIcon />}
              label="Spawn agent…"
              testid="row-flyout-spawn-action"
              onClick={() => onSpawnAgent(server, name)}
            />
          )}
          {onUpdateAnnotations && (
            <CardActionRow
              icon={<NotePencilIcon />}
              label="Update annotations"
              hint="asks the operator"
              testid="row-flyout-annotate-session-action"
              onClick={() => onUpdateAnnotations(server, name)}
            />
          )}
          <CardActionRow
            icon={<PlusIcon />}
            label="New tab"
            testid="row-flyout-create-action"
            onClick={() => onCreateWindow(server, name)}
          />
          <CardActionRow
            icon={<CloseIcon />}
            label="Kill session"
            hint="confirms first"
            danger
            testid="row-flyout-kill-action"
            // The existing kill-dialog path — never a force-kill (no modifier
            // on touch).
            onClick={() => onKillClick(server, name, windowCount, false)}
          />
        </CardActionList>
      </>
    ),
  });
  const scrub = useRailScrub(flyout.openNow);

  const tint = useMemo(() => {
    if (sessionColor == null || !rowTints) return null;
    return rowTints.get(sessionColor) ?? null;
  }, [sessionColor, rowTints]);

  // The guarded family color — the tint source for the rain/scan flairs
  // (they read --rk-flair-color; the sprite flairs ignore it). Uncolored rows
  // fall back to the gray sentinel, matching the window row's marker color.
  const flairColor = useMemo(() => {
    if (!rowBorders) return undefined;
    if (sessionColor != null) return rowBorders.get(sessionColor) ?? undefined;
    return rowBorders.get(UNCOLORED_SELECTED_KEY) ?? undefined;
  }, [sessionColor, rowBorders]);

  // Rail band: the session's family tint mixed into the inset base (the shared
  // rail-tint idiom); while the row's card is open the band steps up one shade
  // and the seam brightens (the held treatment, R8).
  const railStyle = useMemo(() => {
    if (!coarse || ghost) return undefined;
    if (flyout.open) {
      return {
        backgroundColor: railHeldBand(tint?.hover ?? "var(--color-bg-card)"),
        borderColor: RAIL_HELD_SEAM,
      };
    }
    if (tint) return { backgroundColor: railRestBand(tint.base) };
    return undefined;
  }, [coarse, ghost, tint, flyout.open]);

  const rowStyle = useMemo(() => {
    if (isSessionDropTarget) {
      return { boxShadow: "inset 0 0 0 2px var(--color-accent)", borderRadius: "4px" };
    }
    if (tint) {
      return { backgroundColor: tint.base };
    }
    return undefined;
  }, [isSessionDropTarget, tint]);

  return (
    <div
      // W3C-APG tree node (level 1). `aria-expanded` mirrors the chevron's own
      // (lifted onto the treeitem); `aria-controls` points at the window-list
      // group's id. The roving model in index.tsx threads `tabIndex` + set/pos.
      role="treeitem"
      aria-level={1}
      aria-expanded={!isCollapsed}
      // Reference the window-list group ONLY while expanded — the role="group"
      // list is mounted (index.tsx) only when !isCollapsed, so a collapsed row
      // pointing aria-controls at an unmounted id would be invalid ARIA.
      aria-controls={isCollapsed ? undefined : windowGroupId}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      tabIndex={tabIndex}
      data-session-row={sessionRowKey}
      // The shared rail-row hit-test handle (260817-ve5m) — the scrub
      // gesture's both ends resolve row roots via the IDENTICAL
      // `RAIL_ROW_SELECTOR` across all three tier DOM shapes. Non-ghost only.
      data-rail-row={ghost ? undefined : ""}
      // `coarse:pr-[56px]` reserves the rail's column on coarse so the name
      // and badge truncate before it (the literal matches
      // STATUS_RAIL_WIDTH_PX — Tailwind scans literal classes only); ghost
      // rows have no rail and no reserve.
      // The row carries NO left padding: the collapse chevron is the gutter,
      // occupying the same left column as the window row's marker well (see
      // the chevron below).
      className={`flex items-center justify-between group${ghost ? "" : " coarse:pr-[56px]"} relative${tint ? "" : " hover:bg-bg-chrome-raised"} transition-colors${isDragSource ? " opacity-50" : ""}`}
      // Suspended while renaming so a pointer drag in the input selects text
      // instead of dragging the row (the window row's guard).
      draggable={draggable && editingSession !== session.name}
      onDragStart={
        onDragStart
          ? (e) => {
              // An active touch scrub must not escalate into an HTML5 row
              // drag (the window row's guard).
              if (scrub.scrubActiveRef.current) {
                e.preventDefault();
                return;
              }
              // A drag gesture must not leave (or race) an open card.
              flyout.close();
              onDragStart(e, server, name, orderedNames);
            }
          : undefined
      }
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        onDragOver(e, server, name);
        onReorderOver(e, server, name, orderedNames);
      }}
      onDragLeave={(e) => onDragLeave(e, server, name)}
      onDrop={(e) => onDrop(e, server, name)}
      style={rowStyle}
      // The row root is the flyout card's floating REFERENCE: fine-pointer
      // placement "right" → the sidebar's right edge; the coarse card's
      // bottom-start. getReferenceProps CHAINS the card's hover/focus wiring
      // with the row's own tint mouse-enter/leave (floating-ui merges them).
      ref={flyout.setReference}
      {...flyout.getReferenceProps({
        onMouseEnter: tint ? (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = tint.hover; } : undefined,
        onMouseLeave: tint ? (e) => { (e.currentTarget as HTMLElement).style.backgroundColor = tint.base; } : undefined,
      })}
    >
      {/* Flair overlay (decoration-only channel): an always-on ambient
          CSS-only animation mounted whenever the session carries a flair
          value — in every row state. Same overlay discipline as the window
          row's marker textures (dedicated clipped inner element, never the
          root, pointer-events-none, z-5); composes with the color tint. The
          guarded family color rides as `color` so the tinted flairs
          (rain/scan) match the row's family. Hidden entirely under
          prefers-reduced-motion (globals.css § Flair
          overlays) and while this row is the drag source (cube/warp animate
          transforms on child spans — the drag ghost rule). */}
      <FlairOverlay flair={session.flair} hidden={isDragSource} color={flairColor} />
      {/* `gap-2` is the 8px well→content gap the window row holds between its
          marker well and its label; matching it here lands the session name on
          the same content-start column as its own window rows. */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {/* The chevron IS the left gutter. Its width literals track
            MARKER_WELL_WIDTH (window-row.tsx) at both pointer classes —
            22px fine, 36px coarse — so the chevron square and the marker
            squares below it share one column, and the name columns align.
            Tailwind scans literal classes only, hence no shared constant.
            Width is load-bearing for touch: without a floor the button is
            only as wide as the ▼ glyph (~7px). */}
        <button
          onClick={() => onToggleCollapse(server, name)}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors shrink-0 min-w-[22px] min-h-[24px] coarse:min-w-[36px] coarse:min-h-[36px] flex items-center justify-center"
          aria-expanded={!isCollapsed}
          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${session.name}`}
        >
          <span
            className="inline-block transition-transform duration-150"
            style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
            aria-hidden="true"
          >
            &#x25BC;
          </span>
        </button>
        <button
          onClick={() => onSelectFirstWindow(server, name, session.windows[0]?.windowId ?? "")}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (editingSession !== name) onDoubleClickName(server, name);
          }}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors py-px min-h-[24px] coarse:min-h-[36px] min-w-0 flex-1"
          aria-label={`Navigate to ${session.name}`}
        >
          {editingSession === session.name ? (
            <input
              ref={sessionInputRef}
              type="text"
              value={editingSessionName}
              onChange={(e) => onSessionNameChange(toSafeSessionName(e.target.value))}
              onKeyDown={onSessionRenameKeyDown}
              onBlur={onSessionRenameBlur}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-xs font-medium bg-transparent border border-accent-green rounded px-0.5 outline-none truncate w-full"
              aria-label="Rename session"
            />
          ) : (
            <span className="font-medium truncate">
              {session.name}
            </span>
          )}
        </button>
        {/* Attached-viewer count chip (informational, neutral — the muted
            sibling of WaitingBadge's geometry WITHOUT the signal-yellow
            attention treatment): shown only at ≥2 sized viewers. Display-only
            decoration; the row's card is the detail surface. */}
        {showViewers && (
          <span
            data-testid="viewer-badge"
            // The plug glyph disambiguates the count from the bare
            // window-count-number vocabulary the server tiles use — a bare "2"
            // beside a session name reads as "2 windows". Plug = the literal
            // tmux semantics: an attached client.
            className="shrink-0 flex items-center gap-0.5 text-xs leading-none px-1.5 py-0.5 rounded text-text-secondary font-medium tabular-nums"
            aria-label={`${viewers.length} viewers attached`}
          >
            <PlugIcon size={11} />
            {viewers.length}
          </span>
        )}
        {/* Attention rollup (260706-y1ar): count of this session's waiting
            windows. Hidden at 0 (WaitingBadge renders null). */}
        <WaitingBadge
          count={waitingCount}
          label={`${waitingCount} tab(s) in ${session.name} waiting for input`}
          onClick={
            onWaitingBadgeClick
              ? () => onWaitingBadgeClick(server, name)
              : undefined
          }
        />
      </div>
      {/* Right-edge status rail — COARSE pointers, non-ghost rows only
          (260817-ve5m): the SAME 56px recessed inset band the window row
          ships, forming ONE continuous strip down the tree. The band tints
          from the session's family tint (railRestBand); while this row's card
          is open it carries the held treatment (`railStyle`). The 16px glyph
          slot is ALWAYS an empty span on this tier (session rows own no PR
          glyph) so the 12px chevron column-aligns with the window rails. It
          is the card's tap/scrub target (the shared `useRailScrub` trio); the
          click stopPropagation keeps a rail tap from toggling the row. */}
      {coarse && !ghost && (
        <span
          data-testid="status-rail"
          className="absolute right-0 top-0 bottom-0 z-10 flex items-center justify-end gap-0.5 border-l border-border bg-bg-inset pr-1 touch-none"
          style={{ width: STATUS_RAIL_WIDTH_PX, ...railStyle }}
          {...scrub.handlers}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 16px glyph slot — always empty on session rows; it exists so the
              chevron never shifts sideways between tiers. */}
          <span className="flex w-4 shrink-0 items-center justify-center" />
          {/* 12px chevron hint — aria-hidden decoration, muted at ~55%. */}
          <span
            aria-hidden="true"
            className="flex w-3 shrink-0 items-center justify-center text-text-secondary opacity-55"
          >
            ›
          </span>
        </span>
      )}
      {showColorPicker && onColorChange && (
        <div className="absolute right-0 top-full z-50">
          <SwatchPopover
            selectedColor={sessionColor}
            rowName={name}
            // Selection does NOT close (the picker's dismissal contract).
            onSelect={(c) => onColorChange(server, name, c)}
            selectedFlair={session.flair}
            onSelectFlair={
              onFlairChange
                ? (f) => onFlairChange(server, name, f === "" ? null : f)
                : undefined
            }
            onClose={() => setShowColorPicker(false)}
          />
        </div>
      )}
      {/* The session card — portalled to document.body, mounted ONLY while
          open (the shared shell's perf contract). */}
      {flyout.card}
    </div>
  );
}

/** Memoized session row. With the parent passing identity-arg handlers + a
 *  stable `orderedNames`, an SSE session tick that does not change THIS row's
 *  inputs no longer re-renders it. */
export const SessionRow = memo(SessionRowInner);
