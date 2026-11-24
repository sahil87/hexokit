/**
 * Application menu — the keyboard-tier seam (the point of this shell).
 *
 * Electron steals a key from the page only via menu accelerators,
 * `globalShortcut` (we register NONE), or the OS. So the seam is simply:
 * DO NOT bind accelerators on keys the page should own. Every key not listed
 * below already reaches the loaded SPA — no `before-input-event` interception
 * exists in v1, and none should be added: if the SPA later needs page-first
 * handling of a key that IS menu-bound here, the fix is to REMOVE that menu
 * item's accelerator, never to intercept input events.
 *
 * Two-tier rule (the governing contract — the RULE is platform-neutral, the
 * shell tier's modifier pair is not):
 *   - Page tier — unshifted `CmdOrCtrl+<any>`: the shell NEVER binds it, on
 *     any platform. This is the shell's premise: the tier a browser reserves
 *     (macOS: ⌘; Windows/Linux: Ctrl) belongs to the SPA.
 *   - Shell tier — ⌥⌘ on mac, ⇧Ctrl on win/linux: shell chrome MAY claim
 *     keys here, sparingly. The mac claims are the Hosts switcher (1–9) and
 *     host cycling (←/→); the win/linux claims are ⇧Ctrl+R force-reload and
 *     ⇧Ctrl+I devtools. The win/linux Hosts switcher (Alt+1–9) and host
 *     cycling (Alt+PageUp/PageDown) sit on plain Alt, outside this tier.
 *     On mac, ⇧⌘ therefore also belongs to the page (the SPA's own shifted
 *     action tier lives there), with the documented carve-outs ⇧⌘R
 *     (forceReload role) and ⇧⌘Z (Edit redo role). On win/linux the SPA
 *     owns the rest of ⇧Ctrl — the surface tile chords bind ⇧Ctrl+1/2/3
 *     there, which is why the switcher left the tier for Alt+digits.
 *
 * Why the mac shell tier is ⌥⌘, not ⇧⌘: ⇧⌘3/⇧⌘4/⇧⌘5 are macOS system-wide
 * screenshot shortcuts, and system shortcuts intercept BEFORE app menu
 * accelerators — with 3+ hosts configured, keyboard-switching to hosts 3–5
 * took screenshots instead of switching. ⌥⌘ is territory the page will
 * never claim: the SPA keybinding registry deliberately excludes Option
 * from every chord tier (macOS composes characters with it — see
 * `app/frontend/src/lib/keybindings.ts`), and the shell's only other ⌥⌘
 * bindings are the ⌥⌘H hideOthers and ⌥⌘I devtools roles and the ⌥⌘←/⌥⌘→
 * Previous/Next Host items. Windows/Linux reach the same unclaimability
 * with plain Alt+digits: the registry
 * excludes Alt from every chord tier too, while Ctrl+Alt stays off the
 * table (AltGr on many European layouts — Ctrl+Alt+digit would steal
 * character typing in a terminal app). A menu accelerator wins over the
 * page unconditionally, so the switcher could not stay on ⇧Ctrl once the
 * SPA's tile chords bound ⇧Ctrl+1/2/3.
 *
 * The menu is applied PER PLATFORM — symmetry of rule, not symmetry of
 * accelerator table. Carve-outs the rule tolerates (documented, never
 * silently violated): the macOS Edit roles and the conventional View/App
 * shell chrome, itemized per platform below.
 *
 * macOS — bound accelerators (exhaustive): ⌘Q quit, ⌘H/⌥⌘H hide; Edit roles
 * ⌘Z/⇧⌘Z/⌘X/⌘C/⌘V/⌘A (a macOS carve-out, NOT part of the cross-platform
 * rule — clipboard in web content is dead on macOS without them); View
 * ⌘R/⇧⌘R reload, ⌥⌘I devtools, ⌘+/⌘−/⌘0 zoom, ⌃⌘F fullscreen (conventional
 * shell chrome, predating the rule — explicit items over the focused
 * webContents, since the equivalent roles are window-bound and would act on
 * the hidden welcome underlay instead of the attached host view); Hosts radios
 * ⌥⌘1–⌥⌘9 (the shell tier — the same modifier family as the ⌥⌘H/⌥⌘I roles
 * above); Hosts cycle ⌥⌘← / ⌥⌘→ (Previous/Next Host — the same shell tier);
 * Window ⌘M minimize. Guaranteed fall-through set (never bind
 * these): ⌘T ⌘W ⌘N ⌘L ⌘K ⌘F ⌘P ⌘1–9 ⌘[ ⌘], plus the freed ⇧⌘1–9 (future
 * page real estate — though ⇧⌘3/4/5 are macOS screenshot system claims the
 * page can't receive either) — the unshifted ⌘ tier is inviolable; the
 * shell tier is ⌥⌘. ⌘W is unbound BY DESIGN — it falls through for future
 * tab-close semantics; mouse users get the accelerator-less "Close Window"
 * item (which is also why the Window menu is a custom template and NOT
 * `role: 'windowMenu'` — that role auto-binds ⌘W). New Window is likewise
 * accelerator-less BY DESIGN — ⌘N stays in the fall-through set for the
 * SPA registry's new-app-window binding (shell:new-window). The Window menu also carries a
 * manual per-window list section (the custom template forgoes AppKit's
 * automatic window list), rebuilt on window open/close/focus/title changes.
 *
 * Windows/Linux — NOTHING in the unshifted Ctrl tier is bound; the page tier
 * is completely clean. Chromium handles Ctrl+C/V/X/A/Z natively there, so
 * there is no Edit menu; File carries an accelerator-less New Window plus a
 * plain Quit item (the `quit` role default-binds Ctrl+Q on Linux), and on
 * Linux the detection-gated accelerator-less Restart-to-Update group above
 * Quit (win32 never caches an update — `rk desktop` does not exist there);
 * there is no Window menu (native window chrome covers minimize/close; the
 * `minimize` role default-binds Ctrl+M); View items whose former role defaults sit in
 * the unshifted Ctrl tier (reload Ctrl+R, zoom Ctrl+0/±) are
 * accelerator-less plain items, and the shifted-tier pair (force-reload,
 * devtools) is explicit too so it targets the focused view's webContents.
 * Bound there (exhaustive): Alt+1–9 Hosts switcher, Alt+PageUp/Alt+PageDown
 * host cycling, ⇧Ctrl+R force-reload, ⇧Ctrl+I devtools, F11 fullscreen.
 * ⇧Ctrl+digits fall through to the page, where the SPA's surface tile chords
 * bind ⇧Ctrl+1/2/3.
 *
 * Why host cycling is Alt+PageUp/PageDown on win/linux, not Alt+←/→: an
 * accelerator steals its key from every page and terminal, and Alt+←/→ is
 * word-jump in shells and the focused-square reorder chord (⌥←/→); Ctrl+Alt
 * is AltGr on European layouts. Alt+PageUp/PageDown is unused by shells and
 * stays in the Alt+1–9 family. The mac ⌥⌘←/→ never collides with the
 * ⌥←/→ reorder chord (no ⌘). Arrows and paging keys are named keys, not
 * character-resolved digits, so the hardware-verify caveat below does not
 * apply to them.
 *
 * Hardware-verify caveat: digit accelerators are the flakiest accelerator
 * class (Electron resolves accelerators by character, not scancode; AZERTY
 * digits already require Shift, and Option composes characters). ⌥⌘1–9 /
 * Alt+1–9 switching on a non-US layout is a manual-verify item; no scancode
 * workaround in v1.
 */
import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  webContents,
  WebContents,
} from "electron";
import { hostCycleMenuItems, type CycleDirection } from "./host-cycle";
import { HostEntry } from "./hosts";
import { daemonMenuModel, type DaemonMenuInfo } from "./local-daemon";
import { updateMenuItems, type UpdateMenuInfo } from "./update-check";

export type { DaemonMenuInfo } from "./local-daemon";
export type { UpdateMenuInfo } from "./update-check";

export interface MenuCallbacks {
  onSwitchHost: (id: string) => void;
  onAddHost: () => void;
  onRemoveHost: (id: string) => void;
  /** Hosts → Previous/Next Host — main resolves the target at click time (the menu reads no view state). */
  onCycleHost: (direction: CycleDirection) => void;
  /** Window/File → New Window — duplicates the focused window (accelerator-less). */
  onNewWindow: () => void;
  /** mac Window menu's manual per-window list — focus the clicked window. */
  onFocusWindow: (windowId: number) => void;
  /** Daemon menu — starts the daemon when stopped, then connects. */
  onDaemonStart: () => void;
  onDaemonRestart: () => void;
  /** Full restart — kills the whole rk-daemon tmux server (sibling sessions included). */
  onDaemonRestartFull: () => void;
  onDaemonStop: () => void;
  /** App-menu "Restart to Update" — spawns `rk desktop update` detached. */
  onRestartToUpdate: () => void;
}

/**
 * One row of the mac Window menu's manual per-window list — the window's
 * current title as the label, checked on the focused window. Derived from
 * main's window registry on every rebuild.
 */
export interface WindowMenuEntry {
  windowId: number;
  title: string;
  focused: boolean;
}

const MAX_SWITCHER_ACCELERATORS = 9;

const isMac = process.platform === "darwin";

const separator: MenuItemConstructorOptions = { type: "separator" };

/**
 * The webContents the View items act on. Host pages render in per-host
 * WebContentsViews (see main.ts § Host views), so the focused window's OWN
 * webContents is the hidden welcome/blank underlay whenever a host is
 * showing — the truly focused webContents (the attached view, focused by the
 * switch seam) is the right target, with the window's own contents as the
 * welcome-page fallback.
 */
function focusedWebContents(): WebContents | undefined {
  return (
    webContents.getFocusedWebContents() ??
    BrowserWindow.getFocusedWindow()?.webContents
  );
}

function zoomBy(delta: number): void {
  const contents = focusedWebContents();
  if (contents) contents.setZoomLevel(contents.getZoomLevel() + delta);
}

/**
 * Render the pure update item-group model (update-check.ts) — the single
 * source of the Restart-to-Update item, consumed by both platform menus so
 * they cannot drift. Accelerator-less on every platform (the keyboard-tier
 * seam is untouched).
 */
function renderUpdateItems(
  update: UpdateMenuInfo | null,
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions[] {
  return updateMenuItems(update).map((m): MenuItemConstructorOptions => {
    if (m.kind === "separator") return separator;
    return m.enabled
      ? { label: m.label, click: () => callbacks.onRestartToUpdate() }
      : { label: m.label, enabled: false };
  });
}

/**
 * macOS App menu (⌘Q/⌘H/⌥⌘H) — a mac-only shape. When an update is cached
 * (`update` non-null), a detection-gated, accelerator-less "Restart to
 * Update (vX.Y.Z available)…" item sits in its own group directly above
 * Quit. While the spawn is in flight it reads "Updating…" and is disabled;
 * the detached CLI drives the quit → swap → relaunch from there.
 */
function macAppMenu(
  update: UpdateMenuInfo | null,
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions {
  return {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" }, // ⌘H
      { role: "hideOthers" }, // ⌥⌘H
      { role: "unhide" },
      { type: "separator" },
      ...renderUpdateItems(update, callbacks),
      { role: "quit" }, // ⌘Q
    ],
  };
}

/**
 * Windows/Linux conventional minimal File menu — New Window + quit,
 * accelerator-less. The detection-gated Restart-to-Update group sits directly
 * above Quit exactly as in the mac App menu; on win32 the update cache is
 * always null (`rk desktop` does not exist there), so the item renders only
 * on Linux.
 */
function fileMenu(
  update: UpdateMenuInfo | null,
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions {
  return {
    label: "File",
    submenu: [
      {
        // Accelerator-less by design — ⌘N is the SPA registry's new-app-window
        // binding (shell:new-window); the shell claims no accelerator for New Window.
        label: "New Window",
        click: () => callbacks.onNewWindow(),
      },
      { type: "separator" },
      ...renderUpdateItems(update, callbacks),
      {
        // Plain item, NOT `role: 'quit'` — that role default-binds Ctrl+Q on
        // Linux, which is the page tier there.
        label: process.platform === "win32" ? "Exit" : "Quit",
        click: () => app.quit(),
      },
    ],
  };
}

/** macOS Edit menu — mandatory roles; clipboard in web content is dead on macOS without them. */
function macEditMenu(): MenuItemConstructorOptions {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" }, // ⌘Z
      { role: "redo" }, // ⇧⌘Z
      { type: "separator" },
      { role: "cut" }, // ⌘X
      { role: "copy" }, // ⌘C
      { role: "paste" }, // ⌘V
      { role: "selectAll" }, // ⌘A
    ],
  };
}

function viewMenu(): MenuItemConstructorOptions {
  // Every webContents-bound item is an EXPLICIT item over focusedWebContents()
  // on both platforms: Electron's `reload` / `forceReload` / `toggleDevTools`
  // roles are window-bound (they act on the focused window's OWN webContents),
  // which under per-host views is the hidden welcome/blank underlay — ⌘R would
  // reload the wrong surface. Accelerator strings are byte-identical to the
  // former role defaults, so the keyboard-tier seam is untouched. Only
  // `togglefullscreen` (a genuine window-level action) stays a role.
  if (isMac) {
    return {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => focusedWebContents()?.reload() }, // ⌘R
        {
          label: "Force Reload",
          accelerator: "Shift+CmdOrCtrl+R", // ⇧⌘R
          click: () => focusedWebContents()?.reloadIgnoringCache(),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: "Alt+Cmd+I", // ⌥⌘I
          click: () => focusedWebContents()?.toggleDevTools(),
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0", // ⌘0
          click: () => focusedWebContents()?.setZoomLevel(0),
        },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => zoomBy(0.5) }, // ⌘+
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => zoomBy(-0.5) }, // ⌘−
        { type: "separator" },
        { role: "togglefullscreen" }, // ⌃⌘F
      ],
    };
  }
  // Windows/Linux: item parity with the mac View menu. Reload/zoom stay
  // accelerator-LESS plain items — their former role defaults sit in the
  // unshifted Ctrl tier (Ctrl+R, Ctrl+0, Ctrl+±), which is page territory —
  // while the shifted-tier items keep their accelerators explicitly.
  return {
    label: "View",
    submenu: [
      { label: "Reload", click: () => focusedWebContents()?.reload() },
      {
        label: "Force Reload",
        accelerator: "Shift+Ctrl+R", // shifted tier, shell-claimable
        click: () => focusedWebContents()?.reloadIgnoringCache(),
      },
      {
        label: "Toggle Developer Tools",
        accelerator: "Shift+Ctrl+I", // shifted tier
        click: () => focusedWebContents()?.toggleDevTools(),
      },
      { type: "separator" },
      { label: "Actual Size", click: () => focusedWebContents()?.setZoomLevel(0) },
      { label: "Zoom In", click: () => zoomBy(0.5) },
      { label: "Zoom Out", click: () => zoomBy(-0.5) },
      { type: "separator" },
      { role: "togglefullscreen" }, // F11
    ],
  };
}

/**
 * "Daemon" menu — the persistent post-connect control surface for the
 * machine's own daemon (the welcome page's "This Mac" section covers
 * pre-connect). A top-level menu beside Hosts; hidden entirely when rk is
 * not installed (and on win32). Every item is accelerator-less by design
 * (like Remove) — the keyboard-tier seam is untouched. Start keeps the
 * existing start-and-connect tail; Restart is a plain `rk daemon restart`,
 * while Restart Full runs `rk daemon restart --full` (kills the whole
 * rk-daemon tmux server, sibling sessions included, and reconnects
 * previously-up remote tunnels). Labels and enablement come from the pure
 * decision in local-daemon.ts so the state matrix is node:test covered.
 */
function daemonMenu(
  daemon: DaemonMenuInfo,
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions {
  const model = daemonMenuModel(daemon);
  return {
    label: "Daemon",
    submenu: [
      { label: model.statusLabel, enabled: false },
      separator,
      {
        label: model.start.label,
        enabled: model.start.enabled,
        click: () => callbacks.onDaemonStart(),
      },
      {
        label: model.restart.label,
        enabled: model.restart.enabled,
        click: () => callbacks.onDaemonRestart(),
      },
      {
        label: model.restartFull.label,
        enabled: model.restartFull.enabled,
        click: () => callbacks.onDaemonRestartFull(),
      },
      {
        label: model.stop.label,
        enabled: model.stop.enabled,
        click: () => callbacks.onDaemonStop(),
      },
    ],
  };
}

function hostsMenu(
  hosts: HostEntry[],
  focusedHostId: string | null,
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions {
  const switcherItems: MenuItemConstructorOptions[] = hosts.map((host, index) => ({
    label: host.name,
    type: "radio",
    // The FOCUSED window's active host — switching is per-window, so the
    // check mark follows focus (main rebuilds the menu on window-focus).
    checked: host.id === focusedHostId,
    // Keys the page can never claim (the SPA registry excludes Option AND
    // Alt from every chord tier): ⌥⌘1–9 (mac) / Alt+1–9 (win/linux) switches
    // hosts while the unshifted Cmd/Ctrl digits fall through to the page on
    // every platform. Deliberately NOT one `CmdOrCtrl` expression: ⇧⌘3/4/5
    // are macOS screenshot system shortcuts (they intercept before menu
    // accelerators), and Ctrl+Alt is AltGr on many European layouts, so
    // neither platform may borrow the other's modifier pair. The win/linux
    // switcher sits on Alt — not the ⇧Ctrl shell tier — because the SPA's
    // surface tile chords bind ⇧Ctrl+1/2/3 there and an accelerator wins
    // over the page unconditionally.
    accelerator:
      index < MAX_SWITCHER_ACCELERATORS
        ? isMac
          ? `Alt+Cmd+${index + 1}`
          : `Alt+${index + 1}`
        : undefined,
    click: () => callbacks.onSwitchHost(host.id),
  }));

  // Omitted (not disabled) below 2 hosts — nothing to cycle to.
  const cycleItems: MenuItemConstructorOptions[] = hostCycleMenuItems(isMac, hosts.length).map(
    (item) => ({
      label: item.label,
      accelerator: item.accelerator,
      click: () => callbacks.onCycleHost(item.direction),
    }),
  );

  // Accelerator-less by design — the keyboard-tier seam is untouched.
  const removeItems: MenuItemConstructorOptions[] = hosts.map((host) => ({
    label: `Remove "${host.name}"…`,
    click: () => callbacks.onRemoveHost(host.id),
  }));

  return {
    label: "Hosts",
    submenu: [
      ...switcherItems,
      ...(switcherItems.length > 0 ? [separator] : []),
      ...(cycleItems.length > 0 ? [...cycleItems, separator] : []),
      { label: "Add Host…", click: () => callbacks.onAddHost() },
      ...removeItems,
    ],
  };
}

/** macOS Window menu — custom template, NOT `role: 'windowMenu'` (auto-binds ⌘W). */
function macWindowMenu(
  windows: WindowMenuEntry[],
  callbacks: MenuCallbacks,
): MenuItemConstructorOptions {
  return {
    label: "Window",
    submenu: [
      { role: "minimize" }, // ⌘M
      { role: "zoom" },
      { type: "separator" },
      {
        // Accelerator-less by design: ⌘N is the SPA registry's new-app-window
        // binding via shell:new-window (the shell claims no accelerator here).
        label: "New Window",
        click: () => callbacks.onNewWindow(),
      },
      {
        // Accelerator-less by design: ⌘W falls through to the page (see header comment).
        label: "Close Window",
        click: () => BrowserWindow.getFocusedWindow()?.close(),
      },
      // The manual per-window list: the custom template forgoes AppKit's
      // automatic window list, so open windows are enumerated here — rebuilt
      // by main on every window open/close/focus/title change.
      ...(windows.length > 0
        ? [
            { type: "separator" } as MenuItemConstructorOptions,
            ...windows.map(
              (w): MenuItemConstructorOptions => ({
                label: w.title,
                type: "checkbox",
                checked: w.focused,
                click: () => callbacks.onFocusWindow(w.windowId),
              }),
            ),
          ]
        : []),
    ],
  };
}

/**
 * Build the full application menu; call again (and re-set) on every
 * host-list change, whenever the cached daemon or update state changes, and
 * whenever the focused window's active host or the window set/titles change.
 * `focusedHostId` is the FOCUSED window's active host (switching is
 * per-window — the radio check marks follow focus); `windows` feeds the mac
 * Window menu's manual per-window list. `daemon` null hides the Daemon
 * menu (not installed / win32); `update` null hides the Restart-to-Update
 * item (win32, rk missing, status failure, or up to date — on darwin it
 * renders in the App menu, on linux in the File menu, both above Quit).
 */
export function buildMenu(
  hosts: HostEntry[],
  focusedHostId: string | null,
  windows: WindowMenuEntry[],
  callbacks: MenuCallbacks,
  daemon: DaemonMenuInfo | null,
  update: UpdateMenuInfo | null,
): Menu {
  const template: MenuItemConstructorOptions[] = [
    isMac ? macAppMenu(update, callbacks) : fileMenu(update, callbacks),
    ...(isMac ? [macEditMenu()] : []),
    viewMenu(),
    hostsMenu(hosts, focusedHostId, callbacks),
    // Hidden when rk is not installed (and on win32) — daemon is null then.
    ...(daemon !== null ? [daemonMenu(daemon, callbacks)] : []),
    ...(isMac ? [macWindowMenu(windows, callbacks)] : []),
  ];

  return Menu.buildFromTemplate(template);
}
