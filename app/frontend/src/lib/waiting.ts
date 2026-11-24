import type { ProjectSession, WindowInfo } from "@/types";

/**
 * Attention rollup helpers (260706-y1ar; status-pyramid.md § Attention
 * Propagation). The `waiting` overlay rolls up the hierarchy as a COUNT of
 * waiting windows — session row → server tile → board header. A window is
 * "waiting" when its server-side rolled-up `agentState` is `"waiting"` (the
 * window-level rollup already applies `waiting > active > idle` across panes;
 * see docs/specs/agent-state.md). These are pure derivations over the existing
 * SSE session data already in the client — no new endpoint, no polling
 * (Constitution II / code-quality anti-patterns).
 *
 * Single source of truth so every surface counts identically and a rule change
 * touches one place.
 */

/** True when the window's rolled-up agent state is `waiting`. */
export function isWaiting(win: Pick<WindowInfo, "agentState">): boolean {
  return win.agentState === "waiting";
}

/** Count of waiting windows in a flat window list. */
export function countWaitingWindows(windows: Pick<WindowInfo, "agentState">[]): number {
  let n = 0;
  for (const w of windows) if (isWaiting(w)) n++;
  return n;
}

/** Count of waiting windows across a server's sessions (Host server tile). */
export function countWaitingInSessions(sessions: ProjectSession[]): number {
  let n = 0;
  for (const s of sessions) n += countWaitingWindows(s.windows);
  return n;
}

/** Instance-wide count: waiting windows across every attached server's
 *  sessions (the desktop shell's dock/taskbar badge — everything the
 *  connected instance's SSE stream covers). */
export function countWaitingAcrossServers(
  sessionsByServer: ReadonlyMap<string, ProjectSession[]>,
): number {
  let n = 0;
  for (const sessions of sessionsByServer.values()) n += countWaitingInSessions(sessions);
  return n;
}

/** True when the window carries any rolled-up agent state (busy, waiting or
 *  idle) — an agent is present, whatever it is doing. */
export function hasAgent(win: Pick<WindowInfo, "agentState">): boolean {
  return win.agentState !== undefined && win.agentState !== "";
}

/** Agent count across every attached server's sessions: windows (tabs) with
 *  an agent in any state — the host nameplate's `N agents`. Derived from the
 *  SSE session data already in the client. */
export function countAgentsAcrossServers(
  sessionsByServer: ReadonlyMap<string, ProjectSession[]>,
): number {
  let n = 0;
  for (const sessions of sessionsByServer.values()) {
    for (const s of sessions) for (const w of s.windows) if (hasAgent(w)) n++;
  }
  return n;
}
