# HexoKit skill: gui

Depth for one job: **driving and screenshotting the host GUI display** — the host's desktop, run by the `rk-gui` session and rendered for the human as the GUI tile: they see the same pixels you act on. This is a static topic page (`rk skill gui`); the [core bundle](../skill.md) covers when to reach for HexoKit at all; the human-facing guide (desktops, resolution, phone controls) is [gui](../gui.md). Everything here is byte-identical on every invocation.

Reach for it when the job needs a real display: chromium, `xdg-open`, Playwright headed mode, or a computer-use loop. One screen per host (`id = host`), shared with the human.

Gate first — HexoKit is optional, and the GUI surface exists **only when the user turned it on**:

```sh
command -v rk >/dev/null 2>&1 || exit 0
rk gui status    # "gui: off" / "gui: on (…)" / "gui: on — not running (…)"
```

- `gui: off` → **stop. Tell the user `rk gui on` is theirs to run — never run it yourself.** The switch is the user's (it starts a desktop on their host).
- `gui: on — not running (…)` → the reason names the fix; `rk gui restart` is reasonable to suggest, still the user's call.
- `gui: on (<backend>, :N, …)` → the display is live; `:N` is its DISPLAY. A trailing `, locked` means the resolution is pinned (§ `rk gui lock` below).

Every `rk gui` verb below refuses with exit 1 and the same hints when the gate fails, so a missed check fails loudly, not silently.

## `rk gui env` / `rk gui exec` — DISPLAY into your shell, any command on the display

```sh
eval "$(rk gui env)"    # exports DISPLAY=:N and RK_GUI_SOCKET=<path>
rk gui exec xterm                                  # foreground: rk is replaced by the app
rk gui exec --detach chromium https://example.com  # launch and return
rk gui exec -- xdotool key --clearmodifiers minus  # `--` ends flag parsing
```

`env` prints the two export lines when the display is live (exit 1 with the hint otherwise); `rk agent setup` installs exactly this eval into the user's shell startup files (gated on `$TMUX_PANE` and an unset `DISPLAY`), so **new shells inside panes land on the display automatically once the user runs `rk gui on`** — a shell started before that needs the eval run by hand. `exec` runs a command with `DISPLAY` pointed at the rk display (an existing `DISPLAY` is **overridden** — the rk display is the point) and `RK_GUI_SOCKET` set: foreground is a process-replacing passthrough (the app's tty, signals, and exit status are its own), `--detach` (`-d`) starts it as its own session with stdio on `/dev/null` and prints `started <pid> on :N` (`--json` — which requires `--detach`, since the foreground path replaces the process and can print no receipt — prints `{"pid","display"}`); unknown program → `error: <cmd>: not found on PATH`, exit 1. Prefer the dedicated verbs below over `exec xdotool …` — they gate, guard, and name windows for you.

## Windows: `rk gui windows` / `rk gui focus`

```sh
rk gui windows          # ID PID GEOMETRY TITLE rows, sorted by X id; the active row ends in " *"
rk gui windows --json   # {"ok":true,"result":[{id, pid, x, y, width, height, title, active, app}]}
rk gui focus --title Terminal   # or: rk gui focus <id>
```

`windows` is the inventory: stable X ids, geometry as `WxH+X+Y`, `app` from /proc (pid 0 and empty app when the client sets no `_NET_WM_PID` — not an error). `focus` raises + focuses: a unique `--title` substring (case-sensitive) or a numeric id; zero matches → `no window matches "<substr>"`, several → the `ambiguous` line naming every match (both exit 1). Resolve once, then reuse the id — titles drift.

## Input: `rk gui click` / `move` / `scroll` / `type` / `key`

```sh
rk gui click 960 540                 # move + left click; --right/--middle/--double; --window <id> makes x y window-relative
rk gui move 100 200
rk gui scroll down --n 5 --at 960 540
rk gui type "echo hi"                # unicode-safe; newline = Return (a trailing one included)
rk gui type --stdin < payload.txt
rk gui key ctrl+l Return             # xdotool keysym spelling
```

Coordinates are **display pixels**, integers ≥ 0. Typed text rides stdin to `xdotool type --file -`, never argv. All five wrap xdotool: not installed → `xdotool not found — sudo apt install xdotool`, exit 1.

**The human's pointer wins.** These five verbs (and `focus`) refuse with `human input <N>s ago — retry or pass --force` (exit 1) when the human drove the display within the last 3s (input relayed through a GUI tile viewer). Retry shortly, or pass `--force` when you know the human stepped away. Reads and launches (`windows`, `shot`, `wait`, `clip`, `open`, `launch`, `lock`) never refuse on it. If the daemon is unreachable the guard fails open — with no daemon there is no relay viewer, so nobody can be driving.

## `rk gui shot` — screenshot the display

```sh
rk gui shot [--out x.png]                # full-res; default prints an absolute temp PNG path
rk gui shot --scale 0.5                  # 960x540 on a 1920x1080 display — the loop's cheap look (--max-width derives the scale)
rk gui shot --window <id>                # one window (id from `windows`)
rk gui shot --json                       # {"ok":true,"result":{path,width,height,scale,display[,window]}}
```

stdout is **only the absolute PNG path** — read that file to *look* at the display; under `--json` stdout is the envelope instead, `result` carrying the `path` plus the source `width`/`height`, the applied `scale`, the `display`, and `window` only with `--window`. stderr always carries `geometry WxH scale S` (the source geometry and applied scale — the same three facts `result` carries under `--json`): divide shot coordinates by S to get the display pixels the input verbs take. Tool ladder: `import`, then `scrot`, then `xwd`+`convert`; none installed → the apt hint, exit 1. Scaling and `--window` need ImageMagick (`--scale needs imagemagick — sudo apt install imagemagick`; scrot has no by-id capture, so `--window` refuses on that rung). `--scale` (0, 1] with `--max-width` is usage (exit 2).

## `rk gui wait` — stop guessing sleeps

```sh
rk gui wait --window Terminal            # prints the first matching window id, exit 0
rk gui wait --stable                     # exit 0 once two consecutive 0.25-scale captures are pixel-identical
rk gui wait --stable --interval 250ms --timeout 20s
```

`--window` polls a title substring every 250ms; `--stable` hashes decoded pixels (never PNG bytes — encoder date chunks differ per capture). Expiry → `timed out after 10s` (the configured duration), exit 1. Exactly one of the two flags is required (usage otherwise).

## `rk gui clip` / `rk gui open` — clipboard and opener

```sh
rk gui clip set --stdin < paragraph.txt   # then: rk gui key ctrl+v
rk gui clip get                           # the CLIPBOARD selection, verbatim on stdout
rk gui open https://example.com           # xdg-open, detached: started <pid> on :N
rk gui open ./report.pdf
```

`clip` rides xclip (xsel fallback; neither → `no clipboard tool found (tried xclip, xsel) — sudo apt install xclip`); `set` prints nothing and leaves xclip's forked child alive on purpose — on this desktop that child IS the clipboard. `open` treats an argument with a URL scheme as a URL; anything else is a file made absolute (missing → `open: <path>: no such file`). Without xdg-open a URL falls back to the browser ladder; a file refuses with `xdg-open not found — sudo apt install xdg-utils`.

## `rk gui launch` — the allowlisted terminal/browser launcher

```sh
rk gui launch terminal              # started x-terminal-emulator (pid 12345) on :10
rk gui launch browser --cdp         # + a second line: cdp http://127.0.0.1:9222
```

The argument is a **role, never an arbitrary command** (that is `rk gui exec`). Each role resolves through a fixed ladder of known binaries — terminal `x-terminal-emulator, xterm, uxterm, lxterm, foot, alacritty, kitty, gnome-terminal, xfce4-terminal`; browser `chromium, chromium-browser, google-chrome, google-chrome-stable, firefox, x-www-browser` — first on PATH wins, dangling Debian alternatives skipped. Nothing on the ladder → exit 1 with the install line (`no browser on the GUI host — sudo apt install chromium-browser`); the HTTP twin returns `200 {"ok":false,"app","hint"}` instead, so the dashboard toasts the hint through the success path. A bad role is usage (exit 2). `--cdp [--port 9222]` is browser-only and Chromium-family only (Firefox refuses, exit 1): it adds `--remote-debugging-port` with a dedicated profile dir (so it works while another instance runs), waits ≤5s for the port, and prints the `cdp http://127.0.0.1:<N>` endpoint — feed it to Playwright's `connectOverCDP`.

## `rk gui lock` / `unlock` — pin the resolution for a loop

`rk gui lock` sets a host-side pin (the `@rk_gui_lock` option on the rk-gui session): while set, no viewer's tile may resize the desktop, so every coordinate you computed from the last shot stays valid. `rk gui status` shows `, locked`; `unlock` clears it; both are idempotent. The pin dies with the rk-gui session (`rk gui restart`/`off` clear it). The palette's `GUI: Lock resolution` row stays viewer-local; the host pin is the loop-safe one.
`rk gui resize 1600x900` sets the desktop's size itself — live, persisted as `gui.geometry` (default `1920x1080`, fixed; `auto` follows the focused tile) — and a fixed desktop is what keeps `shot`/`click` coordinates stable.

## The IceWM profile directory

With IceWM (the window-manager ladder head) the desktop runs off a seeded profile at `$XDG_STATE_HOME/hexokit/gui/icewm/` (dir 0700, files 0600), passed to icewm as `ICEWM_PRIVCFG`. Two file classes: `preferences` is **write-once** — seeded when absent, the user's edits persist, delete it to re-seed; `toolbar` and `menu` are **regenerated on every `rk gui supervise` start** from the launcher ladders — edit `preferences` instead. Deleting the whole directory restores every default on the next start.

## Recipe: the agent loop

```sh
rk gui env >/dev/null 2>&1 || { echo "ask the user to run: rk gui on"; exit 0; }   # env exits 1 when off/not running (status always exits 0, so it cannot gate)
rk gui lock                                 # pin the resolution for the loop's duration
# Browser work: drive it over CDP, not pixels
rk gui launch browser --cdp                 # → playwright.chromium.connect_over_cdp("http://127.0.0.1:9222")
# Everything else: inventory → act → wait → look
rk gui windows                              # find the target (or `open`/`launch` it, then `wait --window <title>`)
rk gui focus --title xterm                  # or `focus <id>` with an id from `windows` / `wait --window`
rk gui type "echo hello"; rk gui key Return
rk gui wait --stable                        # let it settle — never a guessed sleep
rk gui shot --scale 0.5                     # the cheap look; stderr: geometry 1920x1080 scale 0.5
rk gui clip set --stdin < long.txt; rk gui key ctrl+v   # paste paragraphs instead of typing them
rk gui unlock                               # when the loop ends
rk notify "docs page is up on the GUI tile" --title gui   # optional heads-up
```

Pairing: `rk notify` for out-of-band pings, `rk present` when the content is HTML/URL-shaped and a web tile suits it better than the desktop (see `rk skill display`).

## Exit codes

- `0` success — stdout carries only the datum (`shot`: the PNG path; `wait --window`: the window id; `exec --detach` / `open`: `started <pid> on :N`; `launch`: `started <name> (pid <n>) on :N`, plus the `cdp` line with `--cdp`; `env`: the export lines; `windows`: the inventory; `clip get`: the clipboard; `lock`/`unlock`: `locked`/`unlocked`; `resize`: `resized :10 to 1600x900 (was 1920x1080)`). Diagnostics go to stderr.
- `1` operational — the gate refusals (`gui is off — turn it on with 'rk gui on'` / `gui is on but not running — see 'rk gui status'`), the human-input guard, a missing X tool (the apt hints), `not found on PATH`, a launch ladder miss (the install line), no/ambiguous window match, a `wait` timeout, a failed capture tool (`error: <tool> failed: <stderr tail>`).
- `2` usage — missing command word, stray arg, unknown flag, a launch role other than `terminal`/`browser`, a bad flag combo (`--scale` with `--max-width`, `wait` with neither/both flags, `type` with an argument and `--stdin`, `--cdp` on `terminal`, a bad `scroll` direction). A literal `--` ends flag parsing for `exec`.

## Gotchas

- **macOS is view-only** — the surface mirrors the user's live session; every drive/look verb refuses with a not-supported message. Nothing runs under rk's control there.
- **DISPLAY lands in new shells** — the installed block runs at shell start; a shell opened before `rk gui on` keeps its old env. `eval "$(rk gui env)"` covers it.
- **The display is shared with the human** — they may be watching or driving the same pointer. The guard refuses your input verbs for 3s after their last relayed input; don't `--force` past an active human — announce big moves with `rk notify`.
- **Coordinates are display pixels** — a click computed from a `--scale 0.5` shot multiplies by 2 (stderr's `geometry WxH scale S` carries S). `rk gui lock` keeps the geometry from shifting mid-loop.
- **Apps you start die with `rk gui off`** — the switch kills the `rk-gui` session and everything on the display (the user confirms first). Detached apps survive your shell, not the switch.
- **Nothing is installed for you** — xdotool, ImageMagick, xclip/xsel, xdg-utils are probed at run time; a miss refuses with the apt hint.
- **The desktop may be a full DE** — IceWM is the default; the user may pin any known desktop (`rk gui wm --list` names them, `rk gui wm lxqt` pins one); every verb on this page works identically regardless. On a full desktop `rk gui windows` also lists the DE's panel as a window — filter by `app` when looking for user apps.
