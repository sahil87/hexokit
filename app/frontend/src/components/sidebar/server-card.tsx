import { useLayoutEffect, useState, type RefObject } from "react";
import { DAEMON_SERVER } from "@/api/client";
import { CloseIcon, PaletteIcon, PlusIcon } from "./icons";
import { PopupTitleBar, PopupTitleBarSecondary } from "./popup-title-bar";
import { ACTION_ROW_CLASS, CardActionList, CardActionRow } from "./row-flyout-card";
import {
  SWITCH_KNOB_OFF,
  SWITCH_KNOB_ON,
  SWITCH_TRACK_OFF,
  SWITCH_TRACK_ON,
} from "@/components/controls";

/**
 * The server tier's flyout-card content — ONE implementation consumed by both
 * server surfaces (the sessions-pane group header and the SERVER panel tile)
 * so the two mounts cannot drift: the `Server <name>` title bar, the
 * `tmux -L <name> · N sessions` facts line (external servers append the
 * provenance suffix), and the fixed Change color… → New session → Protect
 * toggle → Kill server rows, each bound to the caller's seams. A row whose
 * seam the consumer did not wire renders nothing (the optional-handler gate).
 */
export function ServerCardContent({
  server,
  sessionCount,
  external = false,
  serverProtected = false,
  onChangeColorAction,
  onCreateSession,
  onKillServer,
  onToggleProtect,
}: {
  server: string;
  sessionCount: number;
  /** External (not HexoKit-managed) servers append the provenance suffix to
   *  the facts line. */
  external?: boolean;
  serverProtected?: boolean;
  /** The card's `Change color…` row — first on every tier's card. The
   *  consumer closes the card BEFORE opening its SwatchPopover mount (the
   *  close-then-open idiom) and holds popover-over-card precedence via the
   *  flyout's `suppressed` gate. Optional: no color seam ⇒ no row. */
  onChangeColorAction?: () => void;
  onCreateSession?: (server: string) => void;
  /** Routes through the parent's killServerTarget confirmation dialog —
   *  never kills directly. */
  onKillServer?: (server: string) => void;
  /** Pre-bound to this server and its next state. rk-daemon's protection is
   *  derived (not unmarkable), so its toggle renders disabled. */
  onToggleProtect?: () => void;
}) {
  return (
    <>
      <PopupTitleBar>
        <PopupTitleBarSecondary>Server </PopupTitleBarSecondary>
        {server}
      </PopupTitleBar>
      {/* Server names ARE socket names, so the `tmux -L` handle composes
          frontend-side. */}
      <span className="text-text-secondary break-words">
        {`tmux -L ${server} · ${sessionCount} session${sessionCount === 1 ? "" : "s"}`}
        {external && " · external — not started by HexoKit"}
      </span>
      <CardActionList>
        {onChangeColorAction && (
          <CardActionRow
            icon={<PaletteIcon />}
            label="Change color…"
            testid="row-flyout-color-action"
            onClick={onChangeColorAction}
          />
        )}
        {onCreateSession && (
          <CardActionRow
            icon={<PlusIcon />}
            label="New session"
            testid="row-flyout-create-action"
            onClick={() => onCreateSession(server)}
          />
        )}
        {onToggleProtect && (
          <button
            type="button"
            role="switch"
            aria-checked={serverProtected}
            aria-label={`Protection for ${server}`}
            disabled={server === DAEMON_SERVER}
            data-testid="row-flyout-protect-toggle"
            onClick={(e) => {
              e.stopPropagation();
              onToggleProtect();
            }}
            className={`${ACTION_ROW_CLASS} hover:text-text-primary hover:border-l-accent-green disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-text-secondary disabled:hover:border-l-transparent`}
          >
            <span className="shrink-0">{serverProtected ? "Unprotect" : "Protect"}</span>
            <span
              aria-hidden="true"
              className={`ml-auto w-7 h-4 rounded-full border relative ${serverProtected ? SWITCH_TRACK_ON : SWITCH_TRACK_OFF}`}
            >
              <span
                className={`absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${serverProtected ? `right-0.5 ${SWITCH_KNOB_ON}` : `left-0.5 ${SWITCH_KNOB_OFF}`}`}
              />
            </span>
          </button>
        )}
        {onKillServer && (
          <CardActionRow
            icon={<CloseIcon />}
            label="Kill server"
            hint="confirms first"
            danger
            testid="row-flyout-kill-action"
            onClick={() => onKillServer(server)}
          />
        )}
      </CardActionList>
    </>
  );
}

/**
 * Fixed-position anchor resolver for a portalled SwatchPopover: below the
 * anchor element, flipping above it when the popover wouldn't fit. The portal
 * escapes the sidebar lists' overflow clip. Shared by the server group
 * header's and the server tile's picker mounts so both anchor at their
 * header/tile element with the one flip heuristic.
 */
export function useAnchoredPopoverPos(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
): { top: number; right: number } | null {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!open || !anchor) {
      setPos(null);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const approxPopoverHeight = 100; // rough; fine for the flip heuristic
    const below = rect.bottom + 4;
    const fitsBelow = below + approxPopoverHeight <= window.innerHeight;
    setPos({
      top: fitsBelow ? below : Math.max(4, rect.top - approxPopoverHeight - 4),
      right: Math.max(4, window.innerWidth - rect.right),
    });
  }, [open, anchorRef]);
  return pos;
}
