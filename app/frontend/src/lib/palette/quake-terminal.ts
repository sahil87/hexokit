import {
  QUAKE_GEOMETRY_DEFAULT,
  requestQuakeTerminal,
  setQuakeMachineState,
  setQuakePinned,
  writeQuakeGeometry,
} from "@/lib/quake-terminal";
import { ApiError, postOperatorWake, startOperator, type OperatorStartResult } from "@/api/client";
import type { QuakeSegment } from "@/components/terminal-activity-tabs";

/**
 * Pure builder for the palette's `Operator: Open quake terminal` entry —
 * extracted so the shape is unit-testable without mounting the shell,
 * mirroring `lib/palette/zen.ts`. The entry id IS the `quake-terminal`
 * registry actionId, so `withShortcutHints` attaches the effective chord. The
 * action lands on open+focused on the desktop machine (an explicit "Open quake
 * terminal" pick always opens, where the chord toggles); on mobile it
 * navigates to the operator window's terminal route.
 */
export type QuakeTerminalPaletteAction = {
  id: string;
  label: string;
  shortcut?: string;
  onSelect: () => void;
};

export function buildQuakeTerminalAction(): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal",
    label: "Operator: Open quake terminal",
    onSelect: () => requestQuakeTerminal({ action: "open" }),
  };
}

/**
 * The `Operator: Show cron` entry — the quake terminal opened straight onto its
 * Cron segment (the registry stacked over the deliveries). No registry chord:
 * the segment is a view inside the quake terminal, one Tab-reachable click past
 * ⌘J; the palette entry is its keyboard-parity path (Constitution V). Cron
 * needs no operator: the desktop segment renders whenever a server resolves. On
 * mobile the seam maps it to the operator route's `?tab=cron`, or — with no
 * operator window on the server — to the tmux Server page's Cron section
 * (`/$server#cron`).
 */
export function buildQuakeTerminalCronAction(): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-cron",
    label: "Operator: Show cron",
    onSelect: () => requestQuakeTerminal({ action: "open", segment: "cron" }),
  };
}

/**
 * The `Operator: Show tasks` entry — the quake terminal opened straight onto
 * its Tasks segment (the operator watchlist). No registry chord: the
 * segment is a view inside the quake terminal, one Tab-reachable click past
 * ⌘J; the palette entry is its keyboard-parity path (Constitution V). On
 * mobile the seam maps it to the operator route's `?tab=tasks`.
 */
export function buildQuakeTerminalTasksAction(): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-tasks",
    label: "Operator: Show tasks",
    onSelect: () => requestQuakeTerminal({ action: "open", segment: "tasks" }),
  };
}

/**
 * The `Operator: Show activity` entry — the quake terminal opened straight
 * onto its Activity segment (the operator loop's fires). No registry chord, the
 * Tasks twin's gating and mobile mapping (`?tab=activity`).
 */
export function buildQuakeTerminalActivityAction(): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-activity",
    label: "Operator: Show activity",
    onSelect: () => requestQuakeTerminal({ action: "open", segment: "activity" }),
  };
}

/**
 * The `Operator: Check now` entry — the palette twin of the Activity header's
 * Check now button (Constitution V): the trigger door's POST for `server`, so
 * the next cron tick runs one check. Needs no operator window; the
 * registration site lists it whenever a server resolves.
 */
export function buildOperatorCheckNowAction(
  server: string,
  onQueued: () => void,
  onError: (message: string) => void,
): QuakeTerminalPaletteAction {
  return {
    id: "operator-check-now",
    label: "Operator: Check now",
    onSelect: () => {
      void postOperatorWake(server)
        .then(onQueued)
        .catch((err: unknown) => onError(err instanceof Error ? err.message : "Check now failed"));
    },
  };
}

/**
 * The `Operator: Reset quake terminal size` entry — the palette twin of the
 * grips' double-click reset (Constitution V: every UI-control action is
 * registered here). It writes the default geometry straight to the per-viewer
 * store, which applies live to an open drawer through the store's same-tab
 * notify and to the next open otherwise; it never opens the drawer itself.
 * Always listed like its siblings — where no drawer renders (mobile) the
 * write is inert.
 */
export function buildQuakeTerminalResetSizeAction(): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-reset-size",
    label: "Operator: Reset quake terminal size",
    onSelect: () => writeQuakeGeometry(QUAKE_GEOMETRY_DEFAULT),
  };
}

/**
 * The `Operator: Pin quake terminal` / `Operator: Unpin quake terminal` entry
 * — the palette twin of the header row's ⌖ button (Constitution V): while
 * pinned, the outside-click collapse is suspended (the chord, Esc, and ▼
 * still collapse). No chord. The label toggles on the ephemeral pin slot.
 * Listed only while the desktop machine is `open` — pinning a closed drawer
 * has no meaning, so the registration site gates the listing; the builder
 * itself is open-agnostic.
 */
export function buildQuakeTerminalPinAction(pinned: boolean): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-pin",
    label: pinned ? "Operator: Unpin quake terminal" : "Operator: Pin quake terminal",
    onSelect: () => {
      setQuakePinned(!pinned);
      // A MOUSE pick races the drawer's outside-click capture listener: the
      // palette closes around the same click, and the pending settle would
      // see no open dialog and collapse the drawer (taking the fresh pin with
      // it). Re-asserting the open state bumps the machine's activity counter
      // even as a same-value no-op — exactly the signal the settle backs off
      // on. The entry is listed only while the machine is open, so the
      // re-assert can never open a closed drawer.
      setQuakeMachineState("open");
    },
  };
}

/** The navigate shape the open-as-tab action needs — the router's navigate
 *  narrowed to the operator window's terminal route. */
export type OpenAsTabNavigate = (opts: {
  to: "/$server/$window";
  params: { server: string; window: string };
  search: { tab?: QuakeSegment };
}) => void;

/**
 * The `Operator: Open as tab` entry — the palette twin of the drawer header's
 * ⤢ control (Constitution V): navigate to the operator window's own terminal
 * route (a non-terminal segment rides `?tab=`) and rest the machine. Listed
 * only while the desktop machine is `open` with a resolved target — the
 * registration site gates the listing (the pin entry's precedent). The
 * palette arm carries no segment: the drawer's segment is its local state,
 * out of the palette's reach, so a palette pick lands on the terminal.
 */
export function buildQuakeTerminalOpenAsTabAction(
  target: { server: string; windowId: string },
  navigate: OpenAsTabNavigate,
  segment?: QuakeSegment,
): QuakeTerminalPaletteAction {
  return {
    id: "quake-terminal-open-as-tab",
    label: "Operator: Open as tab",
    onSelect: () => {
      navigate({
        to: "/$server/$window",
        params: { server: target.server, window: target.windowId },
        search: segment !== undefined && segment !== "terminal" ? { tab: segment } : {},
      });
      setQuakeMachineState("rest");
    },
  };
}

/**
 * The `Operator: Start operator` entry — the palette arm of the drawer's
 * Start operator button (and the only Start path on mobile, where no drawer
 * exists): POST /api/operator/start, then navigate to the new operator
 * window's route. `viewedWindow` is the Terminal route's window when the
 * operator starts on the route's server (else undefined) — the daemon derives
 * its pane cwd server-side, so the operator opens where the user is. A 409
 * `operator_exists` carries the racing window's id and IS the success path
 * (the operator appeared between the listing gate and the launch). Listed
 * only while the resolved server has NO operator window (degrade to absent,
 * never disabled) — the registration site gates the listing; the builder
 * itself is gate-agnostic.
 */
export function buildOperatorStartAction(
  server: string,
  viewedWindow: string | undefined,
  onStarted: (result: OperatorStartResult) => void,
  onError: (message: string) => void,
): QuakeTerminalPaletteAction {
  return {
    id: "operator-start",
    label: "Operator: Start operator",
    onSelect: () => {
      void startOperator(server, viewedWindow)
        .then(onStarted)
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.code === "operator_exists" && err.windowId) {
            onStarted({ windowId: err.windowId, server });
            return;
          }
          onError(err instanceof Error ? err.message : "Operator start failed");
        });
    },
  };
}
