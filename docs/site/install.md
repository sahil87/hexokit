# Install & access

How to install HexoKit, keep it up to date, check your runtime, set up a development environment, and reach the dashboard over HTTPS.

## Install

Install via the [shll toolkit](https://shll.ai) bootstrap:

```bash
curl -fsSL https://hexokit.com/install | sh -s -- hexokit
```

This installs HexoKit (plus the shll meta-CLI) via Homebrew, handling tap trust automatically, and puts the `hexokit` binary on your `PATH`. The formula also installs `rk` as a fully interchangeable short alias, so every command below works the same whether you type `hexokit` or `rk`. The legacy `sh -s -- run-kit` bootstrap argument still works — shll ≥ v0.1.34 resolves `run-kit` as an alias for `hexokit`, and shll ≤ v0.1.33 knows `run-kit` natively. From there, a clean install to a working dashboard with one agent running is:

```bash
shll setup agent                # optional, once per machine: agent busy/waiting/idle in the dashboard
rk daemon start                 # start the dashboard daemon on :6123
open http://localhost:6123      # open the dashboard in your browser

# in a tmux session (tmux new -s work if you aren't in one):
rk riff                         # spawn an agent workspace (--skill /name picks the slash-command)
```

The daemon listens on port **6123** by default. To move it durably, set `port: 4000` in `~/.config/hexokit/config.yaml` and run `rk daemon restart` — `RK_PORT` still wins when set (precedence: default 6123 < config.yaml < `RK_PORT`). Re-point any Tailscale Serve mapping or bookmarks after a move.

> **Upgrading from before the HexoKit rename?** Your install keeps its pinned port — the one-time home migration wrote `port: 3000` into `~/.config/hexokit/config.yaml`, so nothing you pointed at it breaks. `rk doctor` shows a `port pin` row while you're pinned, with the steps to move to 6123 whenever you choose.

On macOS and Linux, the [desktop app](#desktop-app) is an alternative front door: `rk desktop install`, then open the app — its welcome page starts the daemon for you (one **Start & connect** click) and can also connect to HexoKit on other machines over SSH or a URL, so the `daemon start` and `open` steps above collapse into opening the app.

The last step also needs [`wt`](https://github.com/sahil87/wt) and your agent CLI on `PATH` — see [Prerequisites](#prerequisites) below.

`shll setup agent` (which delegates to `rk agent setup`, and runs automatically at the end of a toolkit install) installs agent-harness hooks into your user-global agent configs — Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, Kimi Code, OpenCode, and Antigravity CLI, each wired when its binary is on `PATH` — so windows running an agent report live **active/waiting/idle** state in the dashboard. It shows the diff and asks before writing; re-running is idempotent, and `rk agent setup --uninstall` removes exactly the HexoKit-owned entries. Codex additionally needs its native trust review (`/hooks` inside `codex`) before its hooks run. Until the setup has run (and agent sessions are restarted so new sessions pick up the hooks), agent state shows `—`. See the [agent hook integrations](agent-hooks.md) page for the per-harness capability matrix and [Agent state in the README](https://github.com/sahil87/hexokit/blob/main/README.md#agent-state) for how the hooks work.

## tmux version (≥ 3.4)

HexoKit requires **tmux 3.4 or newer**. The version is checked at runtime against whatever `tmux` your `PATH` resolves: `rk daemon start` prints a one-line warning below the floor (and still starts), `rk doctor` reports the version on its tmux row, and `rk remote connect` refuses outright below 3.4 — its tunnel windows pass remote host input as tmux argv, which only ≥ 3.4 executes without going through a shell.

The recommended upgrade path is Homebrew on **both** platforms:

```bash
brew upgrade tmux     # macOS
brew install tmux     # Linux — your distro's tmux is too old on older LTS releases
```

Two caveats:

- **PATH order matters.** On Linux, `brew shellenv` must put Homebrew's bin **before** `/usr/bin`, or the distro tmux keeps winning and the runtime check keeps warning — it probes the `tmux` your `PATH` actually resolves, which is exactly the binary HexoKit uses.
- **Upgrades are latent.** An upgraded binary takes effect only at the next `tmux kill-server` — the running tmux server keeps its old binary, and the upgrade itself never kills your sessions.

## Upgrade

```bash
rk update
```

`rk update` pulls the latest version via Homebrew and restarts the daemon so the new binary takes effect immediately. It covers the CLI and daemon only — the desktop app updates separately, via `rk desktop update` or the app's **Restart to Update** menu item (see [Desktop app](#desktop-app)).

> **Upgrading from an earlier HexoKit?** Older installs had the agent-hook *logic* inlined in `~/.claude/settings.json`. Run `rk agent setup` once more to swap in the new delegating wrapper, then restart your agent sessions. Future hook fixes ship in the binary and track `rk update` with no re-setup.

> **Coming from an older formula name?** HexoKit was published as `sahil87/tap/rk`, then `sahil87/tap/run-kit`, and is now `sahil87/tap/hexokit`; the tap's rename map carries `brew upgrade` across both renames. If brew warns that `sahil87/tap/rk` or `sahil87/tap/run-kit` `was renamed to` a newer name, you have a keg installed under the old name — remove it with a benign `brew uninstall` of that old name (your config and the `rk` command are unaffected), then `brew install sahil87/tap/hexokit` if `rk` is no longer on your `PATH`.

## Desktop app

The optional desktop shell wraps your dashboard in a native window and frees the browser-reserved `⌘` keyboard tier. Install and update it with the CLI (macOS and Linux):

```bash
rk desktop install    # fetch the latest release and install it
rk desktop update     # same, but a no-op when already current
rk desktop status     # installed vs latest version (read-only)
```

The CLI path is the primary one for a reason. On macOS the DMGs are ad-hoc signed (no notarization), so a browser download is stamped with `com.apple.quarantine` and Gatekeeper blocks the app on every install and update; quarantine comes from the *downloading application* — command-line tools don't apply it — so the CLI produces a quarantine-free install that opens cleanly every time, verifying the download itself (SHA256 against the release digest, plus `codesign --verify --deep --strict`) before installing. Use `--path <dir>` to install somewhere other than `/Applications` (macOS) or `~/.rk/desktop` (Linux), and `--version <tag>` to pin a specific release.

On Linux the recommended path is the toolkit installer followed by the CLI:

```bash
curl -fsSL https://hexokit.com/install | sh -s -- hexokit   # installs the CLI
rk desktop install                                          # installs the app
```

`rk desktop install` downloads the AppImage for your architecture, verifies its release digest (a release without one is refused), extracts it once into `~/.rk/desktop/<version>/` with an atomically-flipped `current` symlink, and writes a launcher entry, the icon, and a `hexokit-desktop` symlink in `~/.local/bin`. Updates arrive via `rk desktop update` or the app's **Restart to Update** menu item — the running app is quit gracefully, swapped, and relaunched. `rk desktop uninstall` removes the install and its desktop integration (your app settings under `~/.config/HexoKit` are kept).

Without the CLI on Linux, the fallback is manual: download the AppImage for your architecture (`x86_64` or `arm64`) from [GitHub Releases](https://github.com/sahil87/hexokit/releases), `chmod +x` it, and run it — with `./hexokit-desktop-<version>-<arch>.AppImage --appimage-extract-and-run` when libfuse2 is missing. The manual path gets no launcher entry and no update notice. On macOS without the CLI: download the DMG, drag **HexoKit.app** into Applications, and clear quarantine via System Settings → Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine "/Applications/HexoKit.app"`) — repeated on every manual update.

Inside the app, the welcome page offers three ways to connect, in descending order of "already have it here": **This Mac** / **This Machine** (detects the local install and daemon state; one **Start & connect** button starts the daemon when needed — post-connect control lives under **Hosts → Local Daemon** in the menu), **over SSH** (`rk remote` under the hood: registers the machine, installs HexoKit there if missing, starts its daemon, opens a tunnel), and **a URL** (any reachable `rk serve` instance, e.g. the Tailscale HTTPS endpoint below). The app never starts or stops the daemon on its own — every daemon action is an explicit click, and your tmux sessions survive all of them.

## code-server (the code lens)

The daemon starts a managed **code-server** beside it (its own `rk-code-server` tmux session on the same socket), powering the dashboard's `code` lens and CODE panel surface — a full editor at the window's git root, served same-origin behind the stable `/code/` route.

HexoKit owns the install: on first daemon start with no code-server anywhere, a `code-server-install` window in the `rk-jobs` session downloads the latest digest-verified standalone release into `~/.rk/code-server-bin/`. The manual equivalent is `rk code-server install`; `rk code-server update` upgrades, and `rk update` runs that leg automatically. A code-server you installed yourself on `PATH` is respected and never touched.

It binds loopback-only on `RK_PORT+2`; set `RK_CODE_SERVER_PORT` only to point HexoKit at an externally managed instance instead. `rk daemon stop` deliberately leaves code-server running; `rk doctor` reports its presence and reachability.

## Prerequisites

`rk riff` requires:

- A running tmux session (`$TMUX` set).
- [`wt`](https://github.com/sahil87/wt) on your `PATH` — included with the [full-toolkit install](https://shll.ai), or `shll install wt`.
- The launcher (default `claude --dangerously-skip-permissions`) available.
- Optional — the GUI tile (the host's desktop in the dashboard) needs a VNC X server and a window manager: `sudo apt install --no-install-recommends tigervnc-standalone-server icewm` on Debian/Ubuntu; `rk gui status` prints the line for your package manager. Desktops, resolution, and troubleshooting: the [GUI guide](gui.md). See the [GUI guide](gui.md).

When something breaks, run:

```bash
rk doctor
```

`rk doctor` checks tmux, `wt`, the launcher binary, port availability, and prints per-dependency status. Run this first when something isn't working.

## Development

Run `just doctor` to check development prerequisites (Node 20+, pnpm, tmux, just, Go 1.22+, air, direnv), then:

```bash
just setup             # one-time: frontend deps, Playwright browsers, .env.local, tmux.conf embed staging
just dev               # watch mode (Go backend + Vite dev server) on this worktree's derived port
just dev --port 4000   # same, on an explicit port (Vite on 4000, backend on 4001, code-server on 4002)
just prod              # run from built binary
```

`just dev` defaults to the worktree's derived e2e port triple, so parallel worktrees never collide; pass `--port` only when you need a specific port. Re-run `just setup` after pulling dependency changes.

## Tailscale HTTPS

HexoKit binds to `127.0.0.1` by default. Some browser features (e.g., copy to clipboard, and Web Push notifications — see below) require a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts), and accessing HexoKit from other machines on your tailnet does too. Tailscale Serve handles both with zero TLS config.

> **Web Push & secure contexts**: the `rk notify` command pushes OS-level
> notifications to subscribed browsers (opt in via the `Cmd+K` palette →
> **Notifications: Enable push**). Web Push requires a secure context — **HTTPS
> or `localhost`**. Reaching HexoKit on `localhost:6123` directly, or over the
> Tailscale HTTPS endpoint below, both qualify; plain HTTP to a remote host does
> not, and the browser will silently refuse to register the service worker.

### Prerequisites

Enable HTTPS on your tailnet in the [Tailscale admin console](https://login.tailscale.com/admin/dns) under **DNS > HTTPS Certificates**.

Then let your user manage Tailscale without sudo (one-time — `tailscale serve` needs root or the designated operator):

```sh
sudo tailscale set --operator=$USER
```

### Quickstart

```sh
tailscale serve --bg http://localhost:6123
```

HexoKit is now available at:

```
https://<machine>.<tailnet>.ts.net
```

To check status or stop:

```sh
tailscale serve status
tailscale serve off
```

### Advanced: Custom hostname

Serve HexoKit under a stable hostname like `runner1.<tailnet>.ts.net` instead of the machine name — the URL survives moving HexoKit to another host.

Services need a tagged node. Do these in order:

1. **Define the `tag:server` tag.** In [Access controls](https://login.tailscale.com/admin/acls), Visual editor → **Tags** → add a tag named `server`. Owners can be left empty.

2. **Re-register the node with the tag.** Tags can only be requested via `tailscale up` (there is no `tailscale set --advertise-tags`), and `up` errors unless every non-default pref is re-stated — so `--operator` is repeated here, not newly set:

   ```sh
   sudo tailscale up --advertise-tags=tag:server --operator=$USER
   ```

3. **Add the HTTPS endpoint.** In the [machines console](https://login.tailscale.com/admin/machines), open the `svc:runner1` service and add `tcp:443`. Skip this and you'll get "required ports are missing" even while the service advertises.

4. **Serve:**

   ```sh
   tailscale serve --bg --service=svc:runner1 http://localhost:6123
   ```

5. **Approve the service.** Open the [Services](https://login.tailscale.com/admin/services) page, find the pending `svc:runner1` advertisement under **Service hosts**, and click **Approve**. The service is inactive until you do.

HexoKit is now at `https://runner1.<tailnet>.ts.net`.

> **Note:** Tagging a node drops its user-identity association — user-based ACL grants stop applying. Make sure your ACLs grant the tag what it needs.

> **Tip:** If you advertise services often, you can skip the manual approval in step 5. In the [Access controls](https://login.tailscale.com/admin/acls) **JSON editor**, add an `autoApprovers` block as a top-level key (there's no Visual editor control for service approval), then save — leave the existing `grants` block untouched:
>
> ```jsonc
> "autoApprovers": {
>   "services": {
>     "svc:runner1": ["tag:server"]
>   }
> },
> ```

### Advanced: Public access (Funnel)

To expose HexoKit to the public internet (not just your tailnet):

```sh
tailscale funnel --bg http://localhost:6123
```

> **Warning:** Funnel makes your terminal relay publicly accessible. Only use this if you understand the security implications.
