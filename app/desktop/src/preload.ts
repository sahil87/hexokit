/**
 * Sandboxed preload — the only bridge between renderer pages and the main
 * process. Exposes `window.runkitShell`:
 *
 *   - `version` / `platform`: readable by EVERY page (including pages loaded
 *     from registered rk servers) — this is the SPA's shell-detection seam
 *     (`app/frontend/src/lib/shell.ts`).
 *   - `servers`: list/switch/add/addDirect/reorder/remove/rename invokers for
 *     the SPA command palette and titlebar-strip host switcher. The group
 *     name and its `servers:*` channels are the web SPA's contract and keep
 *     their server naming (the entries are hosts — rk instances — shell-side).
 *     Privileged for registered host origins AND the welcome page — main.ts
 *     gates every `servers:*` handler on the sender frame (the navigation
 *     allowlist), so any other sender gets a rejection.
 *   - `badge`: the SPA's waiting-agent-count report (`badge:set`) driving the
 *     dock/taskbar badge. Gated exactly like `servers:*` (registered host
 *     origins + welcome) main-side; payloads are validated in main.
 *   - `windows`: `newWindow()`/`close()` invokers for `shell:new-window`
 *     (duplicates the sender's window) and `shell:close-window` (closes the
 *     sender's window), plus `popout({route, width?, height?})` for
 *     `shell:popout` (opens the `?pop=` route as a same-host shell window —
 *     the SPA's Pop out verb; additive, so older shells narrow to no-Pop-out
 *     via `canShellPopout`). Gated like `servers:*`.
 *   - `accent`: the SPA's raw instance-accent report (`accent:set`, a strict
 *     hex string) persisted per host for the switcher's edge bars — the
 *     full-strength color the theme-color meta's 35% titlebar blend cannot
 *     carry. Gated and validated exactly like `badge:*` main-side.
 *   - `web`: the web tile's native engine — create/destroy/park/bounds/
 *     visible/load/reload plus the parity invokers back/forward/find/
 *     stopFind/zoom/chords/devtools for the `web:*` channels, the per-host
 *     load-mode query `mode` (`web:mode` — additive; the SPA narrows it
 *     separately, so older shells without it read as `legacy`), and
 *     `onEvent` on the `web:event` relay. `create` takes an optional
 *     retention identity — an SPA-computed opaque string naming "this web
 *     tab as shown in this desktop window"; main ADOPTS a parked guest whose
 *     identity matches instead of creating a new view — and `park`
 *     (`web:park`) retains the guest hidden on tile unmount instead of
 *     destroying it; both are additive within the group, and an SPA that
 *     never sends an identity simply never parks. Additive: older SPAs never
 *     call it; the SPA narrows the group's presence before use. Privileged
 *     main-side for registered-host views only (isHostsSender + a host view +
 *     tabKey membership under the sender).
 *   - `__welcome`: IPC invokers used by the welcome page only. They are
 *     exposed everywhere but privileged NOWHERE except the welcome page —
 *     every `welcome:*` handler in main.ts verifies `event.senderFrame.url`
 *     against the welcome file:// URL, so host-loaded pages calling these
 *     get a rejection, never a privileged action.
 *   - `__daemon`: local-daemon invokers (status/start/restart/stop) for the
 *     welcome and dead-host pages — exposed everywhere but privileged only
 *     for those shell-owned pages by main-side sender-frame checks. Every
 *     daemon action is explicit; the shell never auto-starts anything.
 *   - `__interstitial`: the dead-host page's argument-less Retry invoker.
 *     Main resolves its host and kind from the sender view, never renderer
 *     query parameters.
 *   - `__remote`: the welcome page's "or over SSH" rung — `connect` invokes
 *     the main-side `rk remote add` + `rk remote connect` flow (gated
 *     exactly like `__welcome`), `onProgress` subscribes to the streamed
 *     `remote:progress` chatter lines main relays while connect runs.
 *
 * The shell version arrives via `additionalArguments` (sandboxed preloads
 * read `process.argv`), keeping `app.getVersion()` out of renderer reach.
 */
import { contextBridge, ipcRenderer } from "electron";

const VERSION_ARG_PREFIX = "--runkit-shell-version=";

function shellVersion(): string {
  const arg = process.argv.find((a) => a.startsWith(VERSION_ARG_PREFIX));
  return arg ? arg.slice(VERSION_ARG_PREFIX.length) : "0.0.0";
}

contextBridge.exposeInMainWorld("runkitShell", {
  version: shellVersion(),
  platform: process.platform,
  servers: {
    list: (): Promise<unknown> => ipcRenderer.invoke("servers:list"),
    switch: (id: string): Promise<unknown> => ipcRenderer.invoke("servers:switch", id),
    add: (): Promise<unknown> => ipcRenderer.invoke("servers:add"),
    // addDirect: the SPA's in-place Add Host dialog — main pings and persists
    // in one invoke and returns the structured error the dialog renders
    // inline. Additive like every sibling: older SPAs never call it.
    addDirect: (name: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("servers:add-direct", { name, url }),
    reorder: (id: string, toIndex: number): Promise<unknown> =>
      ipcRenderer.invoke("servers:reorder", { id, toIndex }),
    remove: (id: string): Promise<unknown> => ipcRenderer.invoke("servers:remove", id),
    removeConfirmed: (id: string): Promise<unknown> =>
      ipcRenderer.invoke("servers:remove-confirmed", id),
    setUrl: (id: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("servers:set-url", { id, url }),
    rename: (id: string, name: string): Promise<unknown> =>
      ipcRenderer.invoke("servers:rename", { id, name }),
  },
  badge: {
    set: (count: number): Promise<unknown> => ipcRenderer.invoke("badge:set", count),
  },
  windows: {
    // shell:new-window — duplicates the sender's window (same host, same
    // route, fresh independent view). Consumed by the SPA's ⌘N binding.
    // Gated main-side exactly like `servers:*` (registered host origins +
    // welcome).
    newWindow: (): Promise<unknown> => ipcRenderer.invoke("shell:new-window"),
    // shell:close-window — closes the SENDER's window (the SPA's ⇧⌘W
    // binding; NOT the focused-window seam the menu's Close Window rides).
    // Gated exactly like `shell:new-window`.
    close: (): Promise<unknown> => ipcRenderer.invoke("shell:close-window"),
    // shell:popout — opens a validated `?pop=` route as a same-host shell
    // window and resolves its window id. Gated exactly like
    // `shell:new-window`; the payload shape is validated main-side.
    popout: (payload: { route: string; width?: number; height?: number }): Promise<unknown> =>
      ipcRenderer.invoke("shell:popout", payload),
  },
  accent: {
    set: (hex: string): Promise<unknown> => ipcRenderer.invoke("accent:set", hex),
  },
  web: {
    // create: `identity` is the optional retention identity (see the group
    // doc above) — undefined is dropped by the IPC clone, so older call
    // shapes stay intact.
    create: (tabKey: string, url: string, identity?: string): Promise<unknown> =>
      ipcRenderer.invoke("web:create", { tabKey, url, identity }),
    destroy: (tabKey: string): Promise<unknown> =>
      ipcRenderer.invoke("web:destroy", { tabKey }),
    park: (tabKey: string): Promise<unknown> => ipcRenderer.invoke("web:park", { tabKey }),
    bounds: (tabKey: string, x: number, y: number, width: number, height: number): Promise<unknown> =>
      ipcRenderer.invoke("web:bounds", { tabKey, x, y, width, height }),
    visible: (tabKey: string, visible: boolean): Promise<unknown> =>
      ipcRenderer.invoke("web:visible", { tabKey, visible }),
    load: (tabKey: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("web:load", { tabKey, url }),
    reload: (tabKey: string): Promise<unknown> => ipcRenderer.invoke("web:reload", { tabKey }),
    back: (tabKey: string): Promise<unknown> => ipcRenderer.invoke("web:back", { tabKey }),
    forward: (tabKey: string): Promise<unknown> =>
      ipcRenderer.invoke("web:forward", { tabKey }),
    find: (tabKey: string, text: string, forward: boolean, findNext: boolean): Promise<unknown> =>
      ipcRenderer.invoke("web:find", { tabKey, text, forward, findNext }),
    stopFind: (tabKey: string): Promise<unknown> =>
      ipcRenderer.invoke("web:stop-find", { tabKey }),
    zoom: (tabKey: string, factor: number): Promise<unknown> =>
      ipcRenderer.invoke("web:zoom", { tabKey, factor }),
    chords: (tabKey: string, chords: unknown): Promise<unknown> =>
      ipcRenderer.invoke("web:chords", { tabKey, chords }),
    devtools: (tabKey: string): Promise<unknown> =>
      ipcRenderer.invoke("web:devtools", { tabKey }),
    // The host's web-tile load mode (`direct`/`proxy`/`legacy`). Additive:
    // the SPA narrows this invoker's presence separately from the group, so
    // an older shell without it reads as `legacy` — today's behavior.
    mode: (): Promise<unknown> => ipcRenderer.invoke("web:mode"),
    // Returns the unsubscribe — a subscription that cannot be dropped leaks a
    // listener per engine mount, and every relayed event then fires N times.
    onEvent: (handler: (payload: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on("web:event", listener);
      return () => ipcRenderer.removeListener("web:event", listener);
    },
  },
  __welcome: {
    testHost: (url: string): Promise<unknown> =>
      ipcRenderer.invoke("welcome:test-host", url),
    addHost: (name: string, url: string): Promise<unknown> =>
      ipcRenderer.invoke("welcome:add-host", { name, url }),
    cancel: (): Promise<unknown> => ipcRenderer.invoke("welcome:cancel"),
  },
  __daemon: {
    status: (): Promise<unknown> => ipcRenderer.invoke("daemon:status"),
    start: (): Promise<unknown> => ipcRenderer.invoke("daemon:start"),
    restart: (): Promise<unknown> => ipcRenderer.invoke("daemon:restart"),
    stop: (): Promise<unknown> => ipcRenderer.invoke("daemon:stop"),
  },
  __interstitial: {
    retry: (): Promise<unknown> => ipcRenderer.invoke("interstitial:retry"),
  },
  __remote: {
    connect: (target: string): Promise<unknown> =>
      ipcRenderer.invoke("remote:connect", target),
    onProgress: (handler: (line: string) => void): void => {
      ipcRenderer.on("remote:progress", (_event, line: unknown) => {
        if (typeof line === "string") handler(line);
      });
    },
  },
});
