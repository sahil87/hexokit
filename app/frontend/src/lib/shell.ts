/**
 * Desktop-shell detection seam. The Electron viewer shell (`app/desktop`)
 * exposes `window.runkitShell` from its sandboxed preload via contextBridge;
 * the SPA uses this module to detect it, read shell metadata, and drive the
 * shell's `servers` bridge group (list/switch the shell-registered rk
 * servers — the command palette's `Server: Switch to "<name>"` entries, the
 * first real shell-gated consumer). Future ⌘-tier keyboard bindings likewise
 * gate on `isShell()` (the browser-reserved ⌘ namespace is reachable only
 * inside the shell). The bridge is runtime-injected, so it is validated
 * structurally (type narrowing, no assertions) rather than trusted from a
 * type declaration; the bridge's privileged welcome namespace is never
 * leaked, and `servers:*` privilege is enforced shell-side (main process
 * sender gating), not here.
 */

import type { WebNativeMode } from "./web-url";

export interface RunkitShell {
  version: string;
  platform: string;
}

/** A shell-registered rk server, as reported by the `servers:list` bridge call. */
export interface ShellServer {
  id: string;
  name: string;
  url: string;
  active: boolean;
  /** The host's persisted instance accent color (newer shells; absent on
   *  older shells and for never-visited hosts). */
  accentColor?: string;
  /** The host's cached waiting-agent count (newer shells; absent when the
   *  host has no live view or a zero count). */
  waiting?: number;
}

/** The bridge's `servers` group — thin IPC invokers resolving unknown shapes. */
interface ShellServersBridge {
  list: () => Promise<unknown>;
  switch: (id: string) => Promise<unknown>;
}

/** A `servers` group that also carries the optional `add` invoker (newer shells). */
interface ShellServersAddBridge extends ShellServersBridge {
  add: () => Promise<unknown>;
}

/** A `servers` group that also carries the optional `reorder` invoker (newer shells). */
interface ShellServersReorderBridge extends ShellServersBridge {
  reorder: (id: string, toIndex: number) => Promise<unknown>;
}

declare global {
  interface Window {
    /** Injected by the desktop shell's preload; absent in plain browsers. */
    runkitShell?: unknown;
  }
}

function isRunkitShell(value: unknown): value is RunkitShell {
  if (typeof value !== "object" || value === null) return false;
  if (!("version" in value) || !("platform" in value)) return false;
  return typeof value.version === "string" && typeof value.platform === "string";
}

/**
 * Shell metadata when running inside the desktop shell, `null` in a plain
 * browser (or when the bridge is malformed). Returns a plain object — the
 * bridge's extra members (e.g. its welcome-page IPC namespace) are not leaked.
 */
export function shellInfo(): RunkitShell | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (!isRunkitShell(candidate)) return null;
  return { version: candidate.version, platform: candidate.platform };
}

/** True when the SPA is running inside the desktop shell. */
export function isShell(): boolean {
  return shellInfo() !== null;
}

function isServersBridge(value: unknown): value is ShellServersBridge {
  if (typeof value !== "object" || value === null) return false;
  if (!("list" in value) || !("switch" in value)) return false;
  return typeof value.list === "function" && typeof value.switch === "function";
}

/** The `servers` group when the bridge carries one — absent on older shells. */
function serversBridge(): ShellServersBridge | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("servers" in candidate)) return null;
  return isServersBridge(candidate.servers) ? candidate.servers : null;
}

function isShellServer(value: unknown): value is ShellServer {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || !("name" in value) || !("url" in value) || !("active" in value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    typeof value.active === "boolean" &&
    // Optional fields are strict-when-present: the response comes from our
    // own shell, which omits fields rather than mistyping them — absence is
    // always valid (older shells), a wrong-typed present field rejects.
    (!("accentColor" in value) || typeof value.accentColor === "string") &&
    (!("waiting" in value) || typeof value.waiting === "number")
  );
}

function isServersListOk(value: unknown): value is { ok: true; servers: ShellServer[] } {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || value.ok !== true) return false;
  if (!("servers" in value)) return false;
  return Array.isArray(value.servers) && value.servers.every(isShellServer);
}

/**
 * The shell-registered servers, or `null` in a plain browser, on an older
 * shell without the `servers` group, or on a rejected/malformed/denied
 * response. Never throws.
 */
export async function listShellServers(): Promise<ShellServer[] | null> {
  const bridge = serversBridge();
  if (!bridge) return null;
  let result: unknown;
  try {
    result = await bridge.list();
  } catch {
    return null;
  }
  return isServersListOk(result) ? result.servers : null;
}

/**
 * Switch the shell to a registered server (the shell then loads that server's
 * URL — a full page swap). Resolves `false` outside the shell or when the
 * shell rejects/denies the call. Never throws.
 */
export async function switchShellServer(id: string): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge) return false;
  let result: unknown;
  try {
    result = await bridge.switch(id);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/**
 * The `add` invoker is additive to the `servers` group (shells older than the
 * dropdown's `+ Add Host…` footer expose only list/switch), so it is narrowed
 * separately from `isServersBridge` — the group stays usable without it.
 */
function isServersAddBridge(bridge: ShellServersBridge): bridge is ShellServersAddBridge {
  return "add" in bridge && typeof Reflect.get(bridge, "add") === "function";
}

/** True when the shell can open its Add Host flow (`servers.add` present). */
export function canAddShellHost(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersAddBridge(bridge);
}

/**
 * Ask the shell to open its Add Host flow — the welcome page in add mode, a
 * full page swap away from the SPA (the same path as the native
 * `Hosts → Add Host…` menu item). Resolves `false` in a plain browser, on an
 * older shell whose `servers` group lacks the `add` invoker, or when the
 * shell rejects/denies the call. Never throws.
 */
export async function addShellHost(): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersAddBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.add();
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** A `servers` group that also carries the optional `addDirect` invoker
 *  (shells newer than the SPA's in-place Add Host dialog). */
interface ShellServersAddDirectBridge extends ShellServersBridge {
  addDirect: (name: string, url: string) => Promise<unknown>;
}

/** The structured add-direct result — the dialog renders `error` inline. */
export type AddShellHostDirectResult = { ok: true } | { ok: false; error: string };

/**
 * `addDirect` is additive like its siblings (`setUrl`/`removeConfirmed`):
 * shells older than the in-place Add Host dialog lack it, and the strip's
 * `+ Add Host…` footer falls back to the `servers.add` welcome-page swap.
 * Narrowed separately from `isServersBridge` — the group stays usable
 * without it.
 */
function isServersAddDirectBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersAddDirectBridge {
  return "addDirect" in bridge && typeof Reflect.get(bridge, "addDirect") === "function";
}

/** True when the shell can add a host in place (`servers.addDirect` present). */
export function canAddShellHostDirect(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersAddDirectBridge(bridge);
}

/**
 * Add a host in place — the shell validates the URL, pings `/api/health`,
 * persists (a blank `name` derives from the ping's hostname), and switches
 * to the new host, all main-side in one invoke. Unlike the boolean siblings
 * this resolves a STRUCTURED result so the dialog can render the main-side
 * ping/validation error inline; a plain browser, an older shell, a malformed
 * response, and a rejected invoke all resolve `{ ok: false }` with a generic
 * error. Never throws.
 */
export async function addShellHostDirect(
  name: string,
  url: string,
): Promise<AddShellHostDirectResult> {
  const bridge = serversBridge();
  if (!bridge || !isServersAddDirectBridge(bridge)) {
    return { ok: false, error: "This desktop app cannot add hosts in place" };
  }
  let result: unknown;
  try {
    result = await bridge.addDirect(name, url);
  } catch {
    return { ok: false, error: "The desktop app did not answer" };
  }
  if (typeof result === "object" && result !== null && "ok" in result) {
    if (result.ok === true) return { ok: true };
    if ("error" in result && typeof result.error === "string" && result.error !== "") {
      return { ok: false, error: result.error };
    }
  }
  return { ok: false, error: "The desktop app could not add the host" };
}

/**
 * The `reorder` invoker is additive to the `servers` group (shells older
 * than the host-switcher's drag/⌥↑⌥↓ reorder expose only list/switch/add),
 * so it is narrowed separately from `isServersBridge` — the group stays
 * usable without it.
 */
function isServersReorderBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersReorderBridge {
  return "reorder" in bridge && typeof Reflect.get(bridge, "reorder") === "function";
}

/** True when the shell can reorder its host list (`servers.reorder` present). */
export function canReorderShellHosts(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersReorderBridge(bridge);
}

/**
 * Move a host to `toIndex` in the shell's host list — the switcher menu's
 * order IS the ⌥⌘1–9/Alt+1–9 accelerator map, so the shell rebuilds its
 * native menu on commit. Resolves `false` in a plain browser, on an older
 * shell whose `servers` group lacks the `reorder` invoker, or when the shell
 * rejects/denies the call. Never throws.
 */
export async function reorderShellHosts(id: string, toIndex: number): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersReorderBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.reorder(id, toIndex);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** A `servers` group that also carries the optional `remove` invoker (newer shells). */
interface ShellServersRemoveBridge extends ShellServersBridge {
  remove: (id: string) => Promise<unknown>;
}

/** A `servers` group that also carries the optional `setUrl` invoker
 *  (shells newer than the Edit Host dialog's URL field). */
interface ShellServersSetUrlBridge extends ShellServersBridge {
  setUrl: (id: string, url: string) => Promise<unknown>;
}

/**
 * `setUrl` is additive like its siblings: the Edit Host dialog enables its
 * URL field only when the shell carries the invoker, so an older shell edits
 * names but never silently drops a URL change.
 */
function isServersSetUrlBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersSetUrlBridge {
  return "setUrl" in bridge && typeof Reflect.get(bridge, "setUrl") === "function";
}

/** True when the shell can re-point a host at a new URL (`servers.setUrl` present). */
export function canSetShellHostUrl(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersSetUrlBridge(bridge);
}

/**
 * Re-point a registered host at a new origin (the shell normalizes and
 * validates the URL, drops the old-origin lastPath, and reloads the host's
 * view). Resolves `false` in a plain browser, on a shell without the
 * `setUrl` invoker, on an invalid URL, or on a rejected/denied call.
 * Never throws.
 */
export async function setShellHostUrl(id: string, url: string): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersSetUrlBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.setUrl(id, url);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** A `servers` group that also carries the optional `rename` invoker (newer shells). */
interface ShellServersRenameBridge extends ShellServersBridge {
  rename: (id: string, name: string) => Promise<unknown>;
}

/**
 * The `remove` invoker is additive to the `servers` group (shells older than
 * the host-switcher's per-row Disconnect expose only list/switch/add/reorder),
 * so it is narrowed separately from `isServersBridge` — the group stays
 * usable without it.
 */
function isServersRemoveBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersRemoveBridge {
  return "remove" in bridge && typeof Reflect.get(bridge, "remove") === "function";
}

/** True when the shell can disconnect a registered host (`servers.remove` present). */
export function canRemoveShellHost(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersRemoveBridge(bridge);
}

/**
 * Disconnect a registered host — the shell runs its native Cancel-default
 * confirm dialog and, on confirm, removes the registration and destroys the
 * host's view (an active host falls back to the first remaining or welcome).
 * The SPA adds no second confirmation; cancel resolves `true` as a successful
 * no-op. Resolves `false` in a plain browser, on an older shell whose
 * `servers` group lacks the `remove` invoker, or when the shell
 * rejects/denies the call. Never throws.
 */
export async function removeShellHost(id: string): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersRemoveBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.remove(id);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** A `servers` group that also carries the optional `removeConfirmed` invoker
 *  (shells newer than the SPA-drawn disconnect confirm). */
interface ShellServersRemoveConfirmedBridge extends ShellServersBridge {
  removeConfirmed: (id: string) => Promise<unknown>;
}

/**
 * `removeConfirmed` is additive on top of `remove`: `servers:remove` shipped
 * with shell-side native confirmation and its meaning is frozen, so the
 * already-confirmed variant is a separate invoker. The SPA confirms with its
 * own themed dialog only when this one is present, and falls back to the
 * native-confirm `remove` path on shells that predate it — both skew
 * directions keep exactly one confirmation.
 */
function isServersRemoveConfirmedBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersRemoveConfirmedBridge {
  return (
    "removeConfirmed" in bridge &&
    typeof Reflect.get(bridge, "removeConfirmed") === "function"
  );
}

/** True when the shell accepts an already-confirmed disconnect
 *  (`servers.removeConfirmed` present) — the gate for the SPA's own dialog. */
export function canConfirmedRemoveShellHost(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersRemoveConfirmedBridge(bridge);
}

/**
 * Disconnect a registered host the SPA has ALREADY confirmed (its themed
 * dialog) — the shell shows no dialog and removes immediately. Resolves
 * `false` in a plain browser, on a shell whose `servers` group lacks the
 * `removeConfirmed` invoker, or when the shell rejects/denies the call.
 * Never throws.
 */
export async function confirmedRemoveShellHost(id: string): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersRemoveConfirmedBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.removeConfirmed(id);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/**
 * The `rename` invoker is additive to the `servers` group (shells older than
 * the host-switcher's inline row rename lack it), so it is narrowed
 * separately from `isServersBridge` — the group stays usable without it.
 */
function isServersRenameBridge(
  bridge: ShellServersBridge,
): bridge is ShellServersRenameBridge {
  return "rename" in bridge && typeof Reflect.get(bridge, "rename") === "function";
}

/** True when the shell can rename a registered host (`servers.rename` present). */
export function canRenameShellHost(): boolean {
  const bridge = serversBridge();
  return bridge !== null && isServersRenameBridge(bridge);
}

/**
 * Rename a registered host — names are display-only (entries key on the
 * immutable id) and appear in the shell's native menu, which the shell
 * rebuilds on commit. Resolves `false` in a plain browser, on an older shell
 * whose `servers` group lacks the `rename` invoker, or when the shell
 * rejects/denies the call. Never throws.
 */
export async function renameShellHost(id: string, name: string): Promise<boolean> {
  const bridge = serversBridge();
  if (!bridge || !isServersRenameBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.rename(id, name);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}
/** The bridge's `windows` group — the multi-window bridge invokers. `close`
 *  is additive on top of `newWindow` (shells older than the ⇧⌘W binding
 *  expose only `newWindow`), so it is narrowed separately. */
interface ShellWindowsBridge {
  newWindow: () => Promise<unknown>;
}

interface ShellWindowsCloseBridge extends ShellWindowsBridge {
  close: () => Promise<unknown>;
}

/** A `windows` group that also carries the optional `popout` invoker
 *  (shells predating the shell-hosted popout windows expose only
 *  newWindow/close). */
interface ShellWindowsPopoutBridge extends ShellWindowsBridge {
  popout: (payload: { route: string; width?: number; height?: number }) => Promise<unknown>;
}

function isWindowsBridge(value: unknown): value is ShellWindowsBridge {
  if (typeof value !== "object" || value === null) return false;
  if (!("newWindow" in value)) return false;
  return typeof value.newWindow === "function";
}

function isWindowsCloseBridge(bridge: ShellWindowsBridge): bridge is ShellWindowsCloseBridge {
  return "close" in bridge && typeof Reflect.get(bridge, "close") === "function";
}

/**
 * The `popout` invoker is additive to the `windows` group (shells predating
 * the shell-hosted popout windows expose only newWindow/close), so it is
 * narrowed separately from `isWindowsBridge` — the group stays usable without
 * it.
 */
function isWindowsPopoutBridge(
  bridge: ShellWindowsBridge,
): bridge is ShellWindowsPopoutBridge {
  return "popout" in bridge && typeof Reflect.get(bridge, "popout") === "function";
}

function isPopoutOk(value: unknown): value is { ok: true; windowId: number } {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || value.ok !== true) return false;
  if (!("windowId" in value)) return false;
  return typeof value.windowId === "number" && Number.isFinite(value.windowId);
}

/** The `windows` group when the bridge carries one — absent on older shells. */
function windowsBridge(): ShellWindowsBridge | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("windows" in candidate)) return null;
  return isWindowsBridge(candidate.windows) ? candidate.windows : null;
}

/** True when the shell can open a new app window (`windows.newWindow` present). */
export function canNewShellWindow(): boolean {
  return windowsBridge() !== null;
}

/** True when the shell can close its own window (`windows.close` present). */
export function canCloseShellWindow(): boolean {
  const bridge = windowsBridge();
  return bridge !== null && isWindowsCloseBridge(bridge);
}

/** True when the shell can open a shell-hosted popout window
 *  (`windows.popout` present). */
export function canShellPopout(): boolean {
  const bridge = windowsBridge();
  return bridge !== null && isWindowsPopoutBridge(bridge);
}

/**
 * Ask the shell to open a new app window — a duplicate of the current one
 * (same host, same route, fresh independent view; `shell:new-window`).
 * Resolves `false` in a plain browser, on an older shell without the
 * `windows` group, or when the shell rejects/denies the call. Never throws.
 */
export async function newShellWindow(): Promise<boolean> {
  const bridge = windowsBridge();
  if (!bridge) return false;
  let result: unknown;
  try {
    result = await bridge.newWindow();
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/**
 * Ask the shell to close the app window this SPA is displayed in
 * (`shell:close-window` — the SENDER's window, not the focused one; closing
 * the last window quits nothing — window lifecycle is the shell's).
 * Resolves `false` in a plain browser, on an older shell whose `windows`
 * group lacks the `close` invoker, or when the shell rejects/denies the
 * call. Never throws.
 */
export async function closeShellWindow(): Promise<boolean> {
  const bridge = windowsBridge();
  if (!bridge || !isWindowsCloseBridge(bridge)) return false;
  let result: unknown;
  try {
    result = await bridge.close();
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/**
 * Ask the shell to open a shell-hosted popout window for `route` (a
 * pathname+search remainder like `/rk-dev/@12?pop=web`). `rect` sizes the
 * window: positive `w`/`h` are rounded into the payload's `width`/`height`;
 * absent or non-positive, the keys are omitted and the shell applies its
 * 1200×800 fallback. Resolves the shell's window id on success, `null` in a
 * plain browser, on an older shell whose `windows` group lacks the `popout`
 * invoker, on a rejected invoke, on `{ ok: false }`, and on any result that
 * is not structurally `{ ok: true, windowId: <finite number> }`. Never
 * throws.
 */
export async function shellPopout(
  route: string,
  rect?: { w: number; h: number },
): Promise<{ windowId: number } | null> {
  const bridge = windowsBridge();
  if (!bridge || !isWindowsPopoutBridge(bridge)) return null;
  const payload: { route: string; width?: number; height?: number } = { route };
  if (rect !== undefined && rect.w > 0 && rect.h > 0) {
    payload.width = Math.round(rect.w);
    payload.height = Math.round(rect.h);
  }
  let result: unknown;
  try {
    result = await bridge.popout(payload);
  } catch {
    return null;
  }
  return isPopoutOk(result) ? { windowId: result.windowId } : null;
}

/** The bridge's `badge` group — thin IPC invoker resolving unknown shapes. */
interface ShellBadgeBridge {
  set: (count: number) => Promise<unknown>;
}

function isBadgeBridge(value: unknown): value is ShellBadgeBridge {
  if (typeof value !== "object" || value === null) return false;
  if (!("set" in value)) return false;
  return typeof value.set === "function";
}

/** The `badge` group when the bridge carries one — absent on older shells. */
function badgeBridge(): ShellBadgeBridge | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("badge" in candidate)) return null;
  return isBadgeBridge(candidate.badge) ? candidate.badge : null;
}

/**
 * Report the waiting-agent count to the shell's dock/taskbar badge (`0`
 * clears). Resolves `false` in a plain browser, on an older shell without the
 * `badge` group, or when the shell rejects/denies the call. Never throws.
 */
export async function setShellBadge(count: number): Promise<boolean> {
  const bridge = badgeBridge();
  if (!bridge) return false;
  let result: unknown;
  try {
    result = await bridge.set(count);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** The bridge's `accent` group — thin IPC invoker resolving unknown shapes. */
interface ShellAccentBridge {
  set: (hex: string) => Promise<unknown>;
}

function isAccentBridge(value: unknown): value is ShellAccentBridge {
  if (typeof value !== "object" || value === null) return false;
  if (!("set" in value)) return false;
  return typeof value.set === "function";
}

/** The `accent` group when the bridge carries one — absent on older shells. */
function accentBridge(): ShellAccentBridge | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("accent" in candidate)) return null;
  return isAccentBridge(candidate.accent) ? candidate.accent : null;
}

/**
 * Report the instance's raw accent (the full-strength contrast-guarded
 * stripe hex) for the shell to persist per host — the host-switcher's edge
 * bars read it; the theme-color meta carries only a 35% titlebar blend.
 * Resolves `false` in a plain browser, on an older shell without the
 * `accent` group, or when the shell rejects/denies the call. Never throws.
 */
export async function setShellAccent(hex: string): Promise<boolean> {
  const bridge = accentBridge();
  if (!bridge) return false;
  let result: unknown;
  try {
    result = await bridge.set(hex);
  } catch {
    return false;
  }
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/** One reclaimable chord spec uploaded to a guest (`web:chords`) — the
 *  SPA-enumerated reclaim predicate (lib/web-chord-table.ts); main matches
 *  `before-input-event` against it with exact modifier equality. */
export interface ShellWebChord {
  code: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/** The bridge's `web` group — the web tile's native-engine channels. Shipped
 *  whole in one shell release, so all fourteen members are required together:
 *  a bridge missing any of them narrows to null and the chrome falls back to
 *  the iframe engine rather than mounting controls the shell cannot drive.
 *  `create`'s third parameter is the retention identity (additive — an older
 *  shell's create ignores the extra argument; its guest simply never parks). */
interface ShellWebBridge {
  create: (tabKey: string, url: string, identity?: string) => Promise<unknown>;
  destroy: (tabKey: string) => Promise<unknown>;
  bounds: (tabKey: string, x: number, y: number, width: number, height: number) => Promise<unknown>;
  visible: (tabKey: string, visible: boolean) => Promise<unknown>;
  load: (tabKey: string, url: string) => Promise<unknown>;
  reload: (tabKey: string) => Promise<unknown>;
  back: (tabKey: string) => Promise<unknown>;
  forward: (tabKey: string) => Promise<unknown>;
  find: (tabKey: string, text: string, forward: boolean, findNext: boolean) => Promise<unknown>;
  stopFind: (tabKey: string) => Promise<unknown>;
  zoom: (tabKey: string, factor: number) => Promise<unknown>;
  chords: (tabKey: string, chords: readonly ShellWebChord[]) => Promise<unknown>;
  devtools: (tabKey: string) => Promise<unknown>;
  onEvent: (handler: (payload: unknown) => void) => () => void;
}

function isWebBridge(value: unknown): value is ShellWebBridge {
  if (typeof value !== "object" || value === null) return false;
  return (
    "create" in value &&
    typeof value.create === "function" &&
    "destroy" in value &&
    typeof value.destroy === "function" &&
    "bounds" in value &&
    typeof value.bounds === "function" &&
    "visible" in value &&
    typeof value.visible === "function" &&
    "load" in value &&
    typeof value.load === "function" &&
    "reload" in value &&
    typeof value.reload === "function" &&
    "back" in value &&
    typeof value.back === "function" &&
    "forward" in value &&
    typeof value.forward === "function" &&
    "find" in value &&
    typeof value.find === "function" &&
    "stopFind" in value &&
    typeof value.stopFind === "function" &&
    "zoom" in value &&
    typeof value.zoom === "function" &&
    "chords" in value &&
    typeof value.chords === "function" &&
    "devtools" in value &&
    typeof value.devtools === "function" &&
    "onEvent" in value &&
    typeof value.onEvent === "function"
  );
}

/** The `web` group when the bridge carries one — absent on older shells. */
function webBridge(): ShellWebBridge | null {
  const candidate = typeof window === "undefined" ? undefined : window.runkitShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  if (!("web" in candidate)) return null;
  return isWebBridge(candidate.web) ? candidate.web : null;
}

/** True when the shell can host web-tile guests (`runkitShell.web` present). */
export function canShellWeb(): boolean {
  return webBridge() !== null;
}

/** A `web` group that also carries the optional `mode` invoker (newer shells). */
interface ShellWebModeBridge extends ShellWebBridge {
  mode: () => Promise<unknown>;
}

/**
 * The `mode` invoker is additive to the `web` group (shells predating the
 * native engine's remote-native loading lack it), so it is narrowed separately
 * from `isWebBridge` — the fourteen-member set stays the engine gate and the
 * group stays usable without it.
 */
function isWebModeBridge(bridge: ShellWebBridge): bridge is ShellWebModeBridge {
  return "mode" in bridge && typeof Reflect.get(bridge, "mode") === "function";
}

function isWebModeOk(value: unknown): value is { ok: true; mode: WebNativeMode } {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value) || value.ok !== true) return false;
  if (!("mode" in value)) return false;
  return value.mode === "direct" || value.mode === "proxy" || value.mode === "legacy";
}

/**
 * The host's web-tile load mode (`direct`/`proxy`/`legacy`) as reported by
 * the shell — the renderer cannot derive it from `window.location.origin`
 * (an SSH host and the local daemon are both loopback). Resolves `"legacy"`
 * in a plain browser, on an older shell whose `web` group lacks the `mode`
 * invoker, on a rejected invoke, and on a malformed/denied result — today's
 * `toProxySrc` behavior. Never throws.
 */
export async function shellWebMode(): Promise<WebNativeMode> {
  const bridge = webBridge();
  if (!bridge || !isWebModeBridge(bridge)) return "legacy";
  let result: unknown;
  try {
    result = await bridge.mode();
  } catch {
    return "legacy";
  }
  return isWebModeOk(result) ? result.mode : "legacy";
}

/** A `web` group that also carries the optional `park` invoker (shells
 *  predating native-guest retention lack it — their tile-unmount path is
 *  destroy). */
interface ShellWebParkBridge extends ShellWebBridge {
  park: (tabKey: string) => Promise<unknown>;
}

/**
 * The `park` invoker is additive to the `web` group (the `mode` precedent),
 * so it is narrowed separately from `isWebBridge` — the fourteen-member set
 * stays the engine gate and the group stays usable without it.
 */
function isWebParkBridge(bridge: ShellWebBridge): bridge is ShellWebParkBridge {
  return "park" in bridge && typeof Reflect.get(bridge, "park") === "function";
}

/** True when the shell can retain guests across tile unmounts
 *  (`web.park` present); on an older shell the unmount path stays destroy. */
export function canParkShellWebView(): boolean {
  const bridge = webBridge();
  return bridge !== null && isWebParkBridge(bridge);
}

export interface ShellWebRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isOkResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "ok" in result && result.ok === true
  );
}

/**
 * Ask the shell to create the guest view for a web tab, loading `url`.
 * `identity` is the retention identity — an opaque string naming "this web
 * tab as shown in this desktop window" (the SPA-side tuple is the tmux
 * server + tmux window id + slot URL; main prefixes the desktop window and
 * host id from the sender's host view). A shell holding a parked guest with
 * a matching identity ADOPTS it instead of creating a new view; omitted (or
 * on an older shell, which ignores the extra argument) the guest can never
 * park. Resolves `false` outside the shell, on an older shell without the
 * `web` group, or when the shell rejects/denies the call. Never throws.
 */
export async function createShellWebView(
  tabKey: string,
  url: string,
  identity?: string,
): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.create(tabKey, url, identity));
  } catch {
    return false;
  }
}

/**
 * Destroy a web tab's guest view. Resolves `false` outside the shell, on an
 * older shell, or when the shell rejects/denies the call. Never throws.
 */
export async function destroyShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.destroy(tabKey));
  } catch {
    return false;
  }
}

/**
 * Park a web tab's guest view — the tile-unmount retention path: the shell
 * hides the guest and retains it keyed by the identity given at create,
 * where a later `createShellWebView` with the same identity adopts it. An
 * identity-less guest is destroyed instead. Resolves `false` outside the
 * shell, on an older shell whose `web` group lacks the `park` invoker, or
 * when the shell rejects/denies the call (an unknown tabKey included — a
 * guest the chrome already destroyed parks as a no-op). Never throws.
 */
export async function parkShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge || !isWebParkBridge(bridge)) return false;
  try {
    return isOkResult(await bridge.park(tabKey));
  } catch {
    return false;
  }
}

/**
 * Position a guest view over its tile's content rect (viewport coordinates —
 * the host view fills the window content area, so no offset applies). The
 * shell parks bounds sent while the guest is hidden and applies them on show.
 * Resolves `false` outside the shell, on an older shell, or when the shell
 * rejects/denies the call. Never throws.
 */
export async function setShellWebViewBounds(
  tabKey: string,
  rect: ShellWebRect,
): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.bounds(tabKey, rect.x, rect.y, rect.width, rect.height));
  } catch {
    return false;
  }
}

/**
 * Show or hide a guest view. Resolves `false` outside the shell, on an older
 * shell, or when the shell rejects/denies the call. Never throws.
 */
export async function setShellWebViewVisible(
  tabKey: string,
  visible: boolean,
): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.visible(tabKey, visible));
  } catch {
    return false;
  }
}

/**
 * Navigate a guest view to `url`. Resolves `false` outside the shell, on an
 * older shell, or when the shell rejects/denies the call. Never throws.
 */
export async function loadShellWebView(tabKey: string, url: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.load(tabKey, url));
  } catch {
    return false;
  }
}

/**
 * Reload a guest view. Resolves `false` outside the shell, on an older shell,
 * or when the shell rejects/denies the call. Never throws.
 */
export async function reloadShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.reload(tabKey));
  } catch {
    return false;
  }
}

/**
 * Step a guest view's history back. A call at the boundary is a main-side
 * no-op. Resolves `false` outside the shell, on an older shell, or when the
 * shell rejects/denies the call. Never throws.
 */
export async function goBackShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.back(tabKey));
  } catch {
    return false;
  }
}

/**
 * Step a guest view's history forward. Same never-throw shape as
 * `goBackShellWebView`.
 */
export async function goForwardShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.forward(tabKey));
  } catch {
    return false;
  }
}

/**
 * Start or step a find-in-page search in a guest view; match ordinals arrive
 * on the `find` relay. Resolves `false` outside the shell, on an older shell,
 * or when the shell rejects/denies the call. Never throws.
 */
export async function findShellWebView(
  tabKey: string,
  text: string,
  opts: { forward: boolean; findNext: boolean },
): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.find(tabKey, text, opts.forward, opts.findNext));
  } catch {
    return false;
  }
}

/**
 * Stop a guest view's active find and clear its highlights. Same never-throw
 * shape as `findShellWebView`.
 */
export async function stopFindShellWebView(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.stopFind(tabKey));
  } catch {
    return false;
  }
}

/**
 * Apply the SPA's zoom bucket to a guest view's renderer. The shell applies
 * what it is handed and stores nothing — Chromium's per-host zoom store in
 * the guest partition fights the bucket, so the engine re-sends on every
 * navigation. Resolves `false` outside the shell, on an older shell, or when
 * the shell rejects/denies the call. Never throws.
 */
export async function setShellWebViewZoom(tabKey: string, factor: number): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.zoom(tabKey, factor));
  } catch {
    return false;
  }
}

/**
 * Upload a guest's reclaimable chord table (the SPA-enumerated reclaim
 * predicate — main matches `before-input-event` against it). Resolves `false`
 * outside the shell, on an older shell, or when the shell rejects/denies the
 * call. Never throws.
 */
export async function setShellWebViewChords(
  tabKey: string,
  chords: readonly ShellWebChord[],
): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.chords(tabKey, chords));
  } catch {
    return false;
  }
}

/**
 * Open detached DevTools for a guest view. Resolves `false` outside the
 * shell, on an older shell, or when the shell rejects/denies the call. Never
 * throws.
 */
export async function openShellWebViewDevTools(tabKey: string): Promise<boolean> {
  const bridge = webBridge();
  if (!bridge) return false;
  try {
    return isOkResult(await bridge.devtools(tabKey));
  } catch {
    return false;
  }
}

/** One relayed guest event, demuxed SPA-side by `tabKey`. Mirrors the shell's
 *  `web:event` relay table; a newer shell may relay kinds this SPA does not
 *  know — those parse to null and are dropped. */
export type ShellWebEvent =
  | { tabKey: string; kind: "title"; title: string }
  | { tabKey: string; kind: "favicon"; favicons: string[] }
  | { tabKey: string; kind: "loading"; loading: boolean }
  | { tabKey: string; kind: "failed"; code: number; description: string; url: string }
  | { tabKey: string; kind: "url"; url: string; canGoBack: boolean; canGoForward: boolean; httpStatus?: number }
  | { tabKey: string; kind: "focus" }
  | { tabKey: string; kind: "zoom"; direction: "in" | "out" }
  | { tabKey: string; kind: "find"; active: number; total: number; final: boolean }
  | { tabKey: string; kind: "chord"; key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/** Structural parse of one relay payload; null for anything malformed or an
 *  unknown kind (a newer shell may relay kinds this SPA does not know). */
export function parseShellWebEvent(payload: unknown): ShellWebEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!("tabKey" in payload) || typeof payload.tabKey !== "string") return null;
  if (!("kind" in payload) || typeof payload.kind !== "string") return null;
  const tabKey = payload.tabKey;
  switch (payload.kind) {
    case "title":
      if (!("title" in payload) || typeof payload.title !== "string") return null;
      return { tabKey, kind: "title", title: payload.title };
    case "favicon": {
      if (!("favicons" in payload) || !Array.isArray(payload.favicons)) return null;
      // One bad entry drops only itself — the rest of the list still parses.
      const favicons = payload.favicons.filter(
        (favicon): favicon is string => typeof favicon === "string",
      );
      return { tabKey, kind: "favicon", favicons };
    }
    case "loading":
      if (!("loading" in payload) || typeof payload.loading !== "boolean") return null;
      return { tabKey, kind: "loading", loading: payload.loading };
    case "failed":
      if (!("code" in payload) || typeof payload.code !== "number") return null;
      if (!("description" in payload) || typeof payload.description !== "string") return null;
      if (!("url" in payload) || typeof payload.url !== "string") return null;
      return { tabKey, kind: "failed", code: payload.code, description: payload.description, url: payload.url };
    case "url":
      if (!("url" in payload) || typeof payload.url !== "string") return null;
      if (!("canGoBack" in payload) || typeof payload.canGoBack !== "boolean") return null;
      if (!("canGoForward" in payload) || typeof payload.canGoForward !== "boolean") return null;
      // httpStatus rides did-navigate only (in-page navigation omits it); a
      // present-but-wrong-typed field is malformed, like every kind.
      if ("httpStatus" in payload && payload.httpStatus !== undefined) {
        if (typeof payload.httpStatus !== "number") return null;
        return { tabKey, kind: "url", url: payload.url, canGoBack: payload.canGoBack, canGoForward: payload.canGoForward, httpStatus: payload.httpStatus };
      }
      return { tabKey, kind: "url", url: payload.url, canGoBack: payload.canGoBack, canGoForward: payload.canGoForward };
    case "focus":
      return { tabKey, kind: "focus" };
    case "zoom":
      if (!("direction" in payload)) return null;
      if (payload.direction !== "in" && payload.direction !== "out") return null;
      return { tabKey, kind: "zoom", direction: payload.direction };
    case "find":
      if (!("active" in payload) || typeof payload.active !== "number") return null;
      if (!("total" in payload) || typeof payload.total !== "number") return null;
      if (!("final" in payload) || typeof payload.final !== "boolean") return null;
      return { tabKey, kind: "find", active: payload.active, total: payload.total, final: payload.final };
    case "chord":
      if (!("key" in payload) || typeof payload.key !== "string") return null;
      if (!("code" in payload) || typeof payload.code !== "string") return null;
      if (!("ctrlKey" in payload) || typeof payload.ctrlKey !== "boolean") return null;
      if (!("metaKey" in payload) || typeof payload.metaKey !== "boolean") return null;
      if (!("shiftKey" in payload) || typeof payload.shiftKey !== "boolean") return null;
      if (!("altKey" in payload) || typeof payload.altKey !== "boolean") return null;
      return { tabKey, kind: "chord", key: payload.key, code: payload.code, ctrlKey: payload.ctrlKey, metaKey: payload.metaKey, shiftKey: payload.shiftKey, altKey: payload.altKey };
    default:
      return null;
  }
}

/** Subscribe to the relay. Returns the unsubscribe — ALWAYS, including the
 *  no-op disposer outside the shell — so a mount effect can return it
 *  unconditionally. Malformed payloads are dropped before `handler`. */
export function onShellWebEvent(handler: (event: ShellWebEvent) => void): () => void {
  const bridge = webBridge();
  if (!bridge) return () => {};
  return bridge.onEvent((payload: unknown) => {
    const event = parseShellWebEvent(payload);
    if (event) handler(event);
  });
}
