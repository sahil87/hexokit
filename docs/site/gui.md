# GUI — the host's desktop in a tile

> [← Back to the README](https://github.com/sahil87/hexokit/blob/main/README.md)

## What it is

The GUI surface runs the host's desktop as a fourth tile beside `tty`/`code`/`web` — off by default, shared by every viewer and every agent.

## Turning it on

```sh
rk gui on
```

That starts a VNC X server (Xvnc) on a private display, a window manager, and the `rk-gui` supervisor tmux session, and reveals the 4th tile button (⌘4) in the dashboard. `rk gui status` prints the one-line state (`gui: on (Xtigervnc, :10, 1920x1080 fixed, 0 viewers, icewm-session)`), and `rk gui off` tears it all down.

## Desktops

rk knows seven desktops. IceWM is the default and needs no desktop environment; LXQt and IceWM get a seeded profile (terminal/browser shortcuts, dark theme); the rest run stock. The alias is what you pass to `rk gui wm`:

| Desktop | Alias | Starter | Debian/Ubuntu install line |
|---------|-------|---------|----------------------------|
| IceWM (default, seeded) | `icewm` | `icewm-session` | `sudo apt install --no-install-recommends icewm` |
| LXQt (seeded) | `lxqt` | `startlxqt` | `sudo apt install --no-install-recommends lxqt-core` |
| XFCE | `xfce` | `startxfce4` | `sudo apt install --no-install-recommends xfce4` |
| Plasma | `plasma` | `startplasma-x11` | `sudo apt install --no-install-recommends plasma-desktop` |
| LXDE | `lxde` | `startlxde` | `sudo apt install --no-install-recommends lxde-core` |
| MATE | `mate` | `mate-session` | `sudo apt install --no-install-recommends mate-desktop-environment-core` |
| Cinnamon | `cinnamon` | `cinnamon-session` | `sudo apt install --no-install-recommends cinnamon-core` |

The table's install lines are the apt wording — `rk gui wm --list` prints the same table worded for *your* package manager (apt, dnf, pacman), with `INSTALLED yes/no` per row. One caveat: Fedora 40 and newer ship no Plasma X11 session, so there is no dnf install line for Plasma — pick another desktop there.

## Choosing one

Three doors, one setting (`gui.wm`):

- **Settings → All settings → `gui.wm`** — a select listing the installed desktops; known-but-missing ones show as disabled `— not installed` rows, and an `Install more ▾` disclosure beneath lists their install lines.
- **`Cmd+K` → `GUI: Desktop…`** — the same list as a palette sub-list; missing desktops render disabled with the install line as their description.
- **The CLI** — `rk gui wm xfce --restart` pins and restarts in one step.

A restart closes every app on the display, so the UI doors ask before restarting; choosing `Later` keeps the pin for the next `rk gui on` / `rk gui restart`. `rk gui wm` with no argument prints the current pin and what's actually running; `rk gui wm auto` clears the pin back to the ladder.

## Running something rk does not know

`rk gui wm <binary>` accepts any window-manager binary name — install it yourself (`sudo apt install <pkg>`), then `rk gui wm <starter> --restart`. One caveat: a binary outside the known list runs **bare**, without the D-Bus session the known desktops get, so the panels and trays of an unlisted full desktop may fail on the headless display. Ask for it to be added, or run `rk gui wm --list` to see the known set. A name not on PATH is refused with the install hint; `--force` pins it anyway (the supervisor logs the miss and falls back to the ladder).

## Resolution

The desktop is a fixed `1920x1080` by default (`gui.geometry`). Pick another fixed size from the palette's `GUI: Resolution →` presets or with `rk gui resize 1600x900`, or set it to `auto` (`rk gui resize auto`) so the desktop follows the focused viewer's tile. An agent driving the desktop can pin the resolution against viewer resizes with `rk gui lock` (`rk gui unlock` releases; the pin dies with the session).

## Watching and driving

On a **phone** the tile gets a toolbar pill with pointer modes (trackpad or touch), a key bar for modifiers and special keys, and fullscreen. On a **laptop**: `Ctrl+=` / `Ctrl+-` / `Ctrl+0` zoom the tile, `GUI: Fullscreen` maximizes it, and the `GUI: Quality →` presets (`Sharp` / `Balanced` / `Smooth`) trade detail for bytes on slow links — `Smooth` is the default on touch devices.

## Agents

Agents drive the same display through the CLI — `rk gui exec`/`shot`/`windows`/`click`/`type`/`key`, gated on the user's `gui.enabled` switch. The full briefing is `rk skill gui`.

## macOS is view-only

On a Mac the GUI mirrors your live Screen Sharing session instead of starting its own display — you can watch, but input is dropped. Enable it under System Settings › General › Sharing › Screen Sharing, then `rk gui on`.

## Troubleshooting

- `rk gui status` prints the state and, when the desktop is not running, the reason (`no VNC backend: <install line>`, session absent, backend exited).
- `rk doctor` has a GUI row with the same summary.
- `Cmd+K` → `GUI: Open supervisor logs` opens the `rk-gui` pane, where the supervisor logs what it started and what failed.
- **"no VNC backend"** — nothing is installed for you: install TigerVNC and a window manager (`rk gui status` prints the line for your package manager), then `rk gui restart`.
