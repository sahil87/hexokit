/**
 * Pure host-cycling model — electron-free so `node --test` covers it
 * (menu.ts imports `electron` and cannot run under plain node).
 *
 * `adjacentHostId` is the wrap-around order logic main resolves at menu-click
 * time; `hostCycleMenuItems` is the per-platform Hosts-menu item model that
 * menu.ts renders. The SPA carries its own copy of the wrap math
 * (`adjacentShellServer` in app/frontend/src/lib/shell-strip.ts) because the
 * SPA bundle and Electron main cannot import each other.
 */

/** 1 = next host, -1 = previous host. */
export type CycleDirection = 1 | -1;

export interface HostCycleMenuItem {
  label: "Previous Host" | "Next Host";
  /** Electron accelerator string. */
  accelerator: string;
  direction: CycleDirection;
}

/**
 * The host to switch to when cycling from `currentId` in host-list order,
 * wrapping at both ends. null when fewer than 2 hosts (nothing to cycle to).
 * A `currentId` absent from the list (welcome page, dangling id) starts from
 * "before the first": next → first, previous → last.
 */
export function adjacentHostId(
  hostIds: readonly string[],
  currentId: string | null,
  direction: CycleDirection,
): string | null {
  const count = hostIds.length;
  if (count < 2) return null;
  const index = currentId === null ? -1 : hostIds.indexOf(currentId);
  if (index === -1) return direction === 1 ? hostIds[0] : hostIds[count - 1];
  return hostIds[(index + direction + count) % count];
}

/**
 * The Hosts-menu cycle items: `[]` below 2 hosts, otherwise Previous then
 * Next. mac ⌥⌘←/→; win/linux Alt+PageUp/PageDown (Alt+←/→ is shell word-jump
 * and the square-reorder chord; Ctrl+Alt is AltGr — see menu.ts header).
 */
export function hostCycleMenuItems(isMac: boolean, hostCount: number): HostCycleMenuItem[] {
  if (hostCount < 2) return [];
  return isMac
    ? [
        { label: "Previous Host", accelerator: "Alt+Cmd+Left", direction: -1 },
        { label: "Next Host", accelerator: "Alt+Cmd+Right", direction: 1 },
      ]
    : [
        { label: "Previous Host", accelerator: "Alt+PageUp", direction: -1 },
        { label: "Next Host", accelerator: "Alt+PageDown", direction: 1 },
      ];
}
