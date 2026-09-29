---
type: memory
description: "run-kit config: fixed root $HOME/.config/hexokit/ via internal/apphome's dual-read rule (legacy run-kit dir for one release; RK_CONFIG_DIR wins); release-start homemigrate copy + atomic publish w/ legacy-port pin; settings registry's 20-key inventory; override order code default < config.yaml < env < CLI flag; ports.env policy (daemon default 6123, legacy pin 3000, live `port pin` doctor row); managed tmux.conf; localStorage hexokit- prefix + marker-guarded legacy copy; breadcrumb migrations."
---
# Configuration

**Domain**: run-kit

## Overview

run-kit's configuration story: one fixed config root, one registry-driven settings file, one stated override order, and stated boundaries for which kind of value lives in which home. The store is `internal/settings`; the web surface is the single registry-driven settings surface carved out by Constitution §IV (no second settings surface may be added).

## Config Root

The config root is `$HOME/.config/hexokit/`, built with `filepath.Join` from `os.UserHomeDir()`. One package owns both home names and their resolution: `internal/apphome` (`Name = "hexokit"`, `LegacyName = "run-kit"`), exposing `ConfigDir()` (`$HOME/.config/<resolved>`) and `StateDir()` (`${XDG_STATE_HOME:-$HOME/.local/state}/<resolved>`). The config root never consults `$XDG_CONFIG_HOME` and never uses `os.UserConfigDir` — only `$HOME` moves it, and a test pins that env vars cannot. Every resolver goes through apphome — `settings.Dir()` (the settings root), `tmux.DefaultConfigPath`, cron, snapshot, prstatus, gui, codeworkspace, codebridge, and the transcript opencode-export dir — so the rule can never drift. Leaf names are unchanged (`config.yaml`, `tmux.conf`, `tmux.d/`, `cron/`, `snapshots/`, `gui/`, `code/`, `cb/`, `prstatus.json`, `opencode-export/`). The settings file is `~/.config/hexokit/config.yaml` (the settings UI displays it via the `CONFIG_YAML_PATH` constant in `settings-all-panel.tsx`); the root also holds the rk-managed `tmux.conf` and the `tmux.d/` drop-in dir (§ Managed tmux.conf). (li54)

Both homes apply the same dual-read rule for one release after the rename: the `hexokit` dir when it exists (migrated or fresh install), else the legacy `run-kit` dir when it exists (an existing install not yet migrated), else the `hexokit` dir. Nothing but the migration's atomic publish (§ Home Migration) may create the new dir while the legacy dir is the active one, so "new dir exists" needs no marker file. The legacy dirs stay in place, byte-unchanged, for the window — deleting them is next release's cleanup.

One test-only carve-out relocates the root: `RK_CONFIG_DIR` (const `settings.ConfigDirEnv`), read in-package via `os.Getenv` at `Dir()` — the same class of unset-means-production-identical escape as `RK_SERVER_ALLOWLIST` and `RK_TMUX_CONF`, never user-facing deployment configuration. The override wins over the dual-read rule: unset or whitespace-only ⇒ behavior byte-identical to the fixed root; set ⇒ `Dir()` returns the value verbatim, `configPath()` follows (`{value}/config.yaml`), and `Save`'s existing `MkdirAll` creates the relocated root. While the override is active the legacy `~/.rk/settings.yaml` fallback-read and breadcrumb rename are suppressed (`configRootOverridden` gates both), and the same gate skips the home migration and the virtual port pin (§ Port Policy), so an isolated run never reads or writes the real `$HOME` and behaves as a fresh install. Every consumer of `Dir()`/`configPath()` (`/api/settings`, board persistence, PWA accent read) inherits the override together; the managed tmux.conf path (`tmux.DefaultConfigPath`) is computed independently in `internal/tmux` and deliberately does NOT move. The e2e harness is the consumer — see [test-sockets](/run-kit/test-sockets.md) § Per-Run Config-Root Isolation. (y60c)

## Home Migration

`internal/homemigrate`'s `Migrate()` performs the one-time home copy at release daemon start: it is called at the top of `serve`'s RunE — before `config.Load()` and `tmux.EnsureConfig()` read anything — followed by `tmux.RefreshDefaultConfigPath()` so the post-publish boot classifies and refreshes the new home's tmux.conf (`tmux.DefaultConfigPath` otherwise resolves at init time). Dev builds (`version == "dev"` — `just dev`/air, e2e rigs) skip it entirely, as does any run under `RK_CONFIG_DIR`; `rk daemon start`/`restart` never call it (the virtual port pin, § Port Policy, covers their pre-serve port resolution), and no generic CLI invocation triggers it. The publish is also deferred while the resolved daemon port is already bound (`daemon.PortBusy()` — pre-migration, `config.Load` resolves the virtually pinned port, exactly the one a still-running old-binary daemon holds; the old and new binaries share the `rk-daemon` session name, so a session probe cannot tell them apart): that live daemon still reads and writes the legacy home, which a publish would hide behind the new home's win in the dual-read rule. `rk daemon restart` stops the old serve before the new one starts, so the normal upgrade path finds the port free; a foreground `serve` racing a live daemon defers (and fails its bind anyway), and the next clean start migrates.

For each home where the legacy dir exists and the new one does not, `Migrate()` copies the migrated set into a temp sibling (`.hexokit-migrate-*` next to the target), applies the port pin (config home only, § Port Policy), then publishes with one atomic `os.Rename`. A rename that loses a race — the target appeared mid-copy — discards the temp copy; the existing target wins. Every failure is best-effort and non-fatal: log, remove the temp dir, and leave the legacy home active per the dual-read rule. The legacy trees are left byte-unchanged, so a downgrade keeps working.

The config home copies its whole tree, symlinks carried as symlinks — never dropped, never dereferenced: a contained link (target resolves inside the legacy tree) keeps its verbatim target so it points into the new copy; an escaping link (a dotfiles-managed `config.yaml` or `tmux.d/*.conf`) is recreated with its absolute target, a relative target rewritten to its absolute resolution. When the staged `config.yaml` is itself a symlink, the port pin is appended through the link into its target — the user's one config file, shared by both homes, which the still-running old binary reads with `port: 3000` as its own default. The state home copies only `cron/`, `snapshots/`, and the GUI's write-once seeded files (`gui.WriteOnceSeedFiles` — the user-editable `gui/icewm/preferences` and LXQt etc defaults), which are user data; `prstatus.json`, the rest of `gui/` (sockets, CDP profiles), `code/`, `cb/`, and `opencode-export/` are droppable caches or runtime rendezvous and cold-start.

## Managed tmux.conf

The default tmux.conf at `~/.config/hexokit/tmux.conf` (the resolved config home — `tmux.DefaultConfigPath` goes through apphome's dual-read rule) is **rk-owned**, declared in-band by a hash-stamped first line:

```
# rk-managed sha256:<hex> — DO NOT EDIT; overrides go in ~/.config/hexokit/tmux.d/
```

where `<hex>` is the SHA-256 lowercase-hex digest of the body (everything after the header line). Every rk write of the file goes through one shared managed write path (`writeManagedConfig` in `internal/tmux/managedconf.go`, riding named header prefix/suffix constants) and stamps the hash of what it wrote. A pure classifier (`ClassifyManagedConf` over content; `ClassifyConfigFile` over a path — shared by the ensure path and the doctor row so both agree on every state) sorts the on-disk file against the embedded default into four states: **missing** (stat NotExist) → write header + embed; **managed & current** (header present, body hashes to its own stamp, body == embed) → no-op; **managed & stale** (stamp verifies, body ≠ embed) → force-write the new embed; **hand-edited** (no header, or stamp mismatch) → hands off — never written, never auto-migrated. The classifier also accepts the legacy `run-kit` header suffix (kept as a named constant) when its stamp verifies — as **managed & stale**, never hand-edited — so a managed conf written by a pre-rename release is force-refreshed rather than frozen.

The refresh runs at **daemon start only** — `tmux.EnsureConfig()` at the `cmd/rk/serve.go` serve site; no timer, no watcher (updates restart the daemon). Only a stale→force-write transition triggers the **reload sweep** (`tmux.RefreshSweep`): enumerate servers via `tmux.ListServers` (live-socket-probed — load-bearing, since a tmux command on a dead socket resurrects a server) and `ReloadConfig` each, per-server failures logging and continuing, the sweep never failing daemon start. **Every managed-conf apply path gates on the `@rk_srv_managed` provenance mark** ([tmux-sessions](/run-kit/tmux-sessions.md) § Server-Scoped User Options) — rk never sources its conf into an external (unmarked) server: the sweep checks `IsManagedServer` per server (the `sweepIsManaged` seam beside `sweepListServers`/`sweepReloadConfig`; a skipped external logs at debug, the sweep continues), the WS-attach reload (`api/terminals_ws.go` `reloadConfigForAttach`, seams `attachIsManaged`/`attachReloadConfig`) reloads only for managed servers, at most once per server per daemon lifetime, and fully async — a synchronous per-server once-guard on the `Server` struct admits one goroutine that runs the managed check + reload + legacy sweep off the attach path (zero execs under the terminal switch mask); a read failure skips with a debug log AND releases the guard so a later attach retries, an external verdict skips and consumes it (adopt sources the conf itself), and the attach is unchanged either way (`-f` still applies the conf at client birth for servers rk starts) (260904-71yx) — and `POST /api/tmux/reload-config` (`api/tmux_config.go`, seam `reloadIsManaged`) returns `200 {"status":"skipped","reason":"external"}` for an external target or a failed managed check — a report, never an error, never a 5xx. The adopt verb (`POST /api/servers/adopt`, `rk mux adopt`) is the one path that sources the conf into an external server — by stamping the mark first (see [tmux-sessions](/run-kit/tmux-sessions.md)). Caveat: `history-limit`-class options apply only to panes created after the reload — existing panes keep their old values.

When the resolved config path is not `DefaultConfigPath` (the `tmux_conf` key or `RK_TMUX_CONF` is set), the file is user-owned: rk performs **no ensure/refresh/doctor** on it ("you own everything" mode — `EnsureConfig` gates on this explicitly).

Every scaffold path — `EnsureConfig`, `ForceWriteConfig`, `rk mux init-conf` (both cobra instances), `POST /api/tmux/init-conf` — also ensures `tmux.d/` exists and scaffolds `tmux.d/user.conf` as a commented starter (purpose, one commented `set -g` example, the `10-*.conf` numeric-ordering pointer) when absent; an existing `user.conf` is never overwritten, including under `--force`. (0tu6)

The embedded conf sources its drop-ins through one `if-shell` that mirrors the config-home dual-read rule at tmux load time: `~/.config/hexokit/tmux.d/*.conf` when the hexokit config dir exists (or neither does), else `~/.config/run-kit/tmux.d/*.conf` — exactly one tmux.d dir is ever sourced, so an unmigrated install whose tmux.conf was rewritten with the new embed keeps sourcing its legacy drop-ins, and there is no double-sourcing once both dirs exist. `tmux.DefaultConfigPath` resolves at init time; serve calls `tmux.RefreshDefaultConfigPath()` right after the home migration's publish so the first post-upgrade boot classifies and refreshes the new home's tmux.conf (§ Home Migration). A user-owned `tmux_conf` setting / `RK_TMUX_CONF` never moves.

The embedded conf's `pane-border-format` renders, in both the active and inactive arms, a conditional pane-index prefix `#{?#{e|>:#{window_panes},1},#P · ,}` immediately before the path segment, followed by the worktree badge, git branch, and `pane_current_command` segments with per-state color arms: a single-pane window shows the bare path, a multi-pane window shows `N · <path>`. The raw `%N` pane id appears nowhere in the border — it stays reachable via the web status bar's `Copy tmux pane id` affordance and `tmux display-message -p '#{pane_id}'`. (qt7k)

The embedded conf's **multi-viewer sizing** section sets `window-size smallest` and `aggressive-resize on`: a window is never wider than the narrowest size-participating client whose current window it is, and a client viewing a different window of a grouped `_rk-pin-*` session does not constrain it. This is a correctness guard for the tmux ≤3.7c pane-status draw defect (§ Design Decisions → Multi-viewer sizing guard), not a preference; `TestDefaultConfigMultiViewerSizingGuard` pins the two lines and `TestManagedConfSplitUnderNarrowerClientDoesNotWedge` (`internal/tmux/pane_status_wedge_test.go`) reproduces the two-client geometry against a real server and asserts the split completes without a stall. Observable consequence: with two viewers on one window, both see the narrower viewer's grid (the wider one gets the `·` margin fill) instead of the window following whichever viewer acted last. (3cp9)

The path segment, worktree badge, and git branch are **read from daemon-stamped pane user-options** — `#{@rk_pane_pathtail}`, `#{@rk_pane_git_worktree}`, `#{@rk_pane_git_branch}` — so the format contains **no `#()` shell jobs**: drawing a pane border forks no subprocess. The daemon (snapshotter) stamps those options; the values match the web sidebar's git branch because both derive from the same `internal/gitinfo` resolver. See [agent-state](/run-kit/agent-state.md) § the `@rk_pane_git_*` options for the stamping contract. An unstamped pane (brand-new, or a server the daemon just began covering) renders those segments empty until the next stamp — no fork, no fallback. (s9fw)

## Settings Registry

`internal/settings` defines one registry — a `[]registryEntry` table — that is the single source of truth for every settings key and drives both `parse()` and `serialize()`. Each entry carries **key, kind (type), default, description, category, `ui` flag, `live` flag**; enum kinds additionally carry **`options`** — the entry's legal values in display order (`theme`: `system`/`dark`/`light`; `log_level`: `info`/`debug`), display metadata for generated controls (the apply hook keeps owning enforcement), nil on non-enum kinds. Scalar entries carry parse/serialize hooks, nested entries (maps, lists) carry a section built by `mapSection`/`listSection`. Slice order IS serialization order: scalar keys first, then nested sections. Adding a key is one registry entry — no new scanner branches.

Serialization stays hand-rolled (line-scanner parse + string-builder serialize — no yaml.v3) and byte-stable: tolerant reads per key (quote-strip, `validate.NormalizeColorValue`, flair-set membership, `strconv.ParseBool`, malformed-entry skip), omit-when-default/empty (the `port` pin excepted — it serializes whenever set, including at the default; § Design Decisions → Serialize-when-set for the port pin), nested sections with sorted map keys and quoted values. An untouched settings file round-trips byte-identically.

The 20-key inventory:

| key | type | default | category | ui | live | notes |
|---|---|---|---|---|---|---|
| `theme` | enum/string | `system` | appearance | yes | yes | UI color mode |
| `theme_dark` | string | `default-dark` | appearance | yes | yes | dark-mode theme |
| `theme_light` | string | `default-light` | appearance | yes | yes | light-mode theme |
| `instance_color` | color descriptor | `""` | appearance | yes | yes | tolerant read via `validate.NormalizeColorValue` |
| `instance_name` | string | `""` | identity | yes | yes | display-name override |
| `ssh_host` | string | `""` | connectivity | yes | yes | the ONLY ssh-host surface — no env form exists |
| `port` | port | `6123` | connectivity | no | no | the daemon listen port pin — the one deployment binding with a config.yaml home; 0 = unset; tolerant parse (quote-strip + `strconv.Atoi`, kept only when 1–65535, never errors); serialize-when-set INCLUDING a value equal to the default (a `port: 3000` pin survives whole-file `Save` rewrites and any later default flip — § Design Decisions → Serialize-when-set for the port pin); read as a JSON number (`null` when unset); strict JSON-integer apply in 1–65535, `null` unsets; `RK_PORT` wins over it when set to a valid port; applies on the next daemon restart; the default text derives from `portpolicy.DaemonDefault` (the `ports.env` port policy), the same source `internal/config`'s defaults read (v1r0); the migration's pin comment (`PortPinComment`) round-trips through whole-file saves via `PortPinNote` — parse sets it on the exact line, the serializer re-emits it above `port: N`, any registry write to `port` (set or null) clears it (§ Port Policy) |
| `server_colors` | map[string]string | `{}` | appearance | yes | yes | mapSection with color normalize |
| `server_flairs` | map[string]string | `{}` | appearance | yes | yes | mapSection with flair-set membership normalize |
| `board_order` | []string | `[]` | layout | yes | yes | listSection |
| `riff_presets` | map[string]string | the three built-ins | behavior | no | yes | preset name → skill invocation for `rk riff <name>`; the user tier stores overrides/additions only (nil default — the section omits, so a file without it round-trips byte-identically); the built-ins (`discuss` → `/fab-discuss`, `incognito` → `/fab-incognito`, `blank` → `""` bare agent) live in the `BuiltinRiffPresets` code tier; the merged never-empty view is `RiffPresets`/`LoadRiffPresets` (built-ins first in canonical order, an override keeping `BuiltIn: true`, additions sorted); a name must be a strict identifier (`validate.ValidateIdentifier`) — skipped on parse, 400 on apply; empty value = bare agent (file-only — `mapValue`'s trimmed-empty-unsets contract makes override-to-bare inexpressible over HTTP) (see [rk-riff](/run-kit/rk-riff.md) § Presets) |
| `auto_name` | bool | `false` | behavior | yes | yes | a settings POST rewires the hub's auto-name tracker live (see [architecture](/run-kit/architecture.md) § SSE Hub) |
| `cron_ticker` | bool | `true` | behavior | yes | yes | gates the daemon cron ticker per iteration (see [cron](/run-kit/cron.md) § Daemon Ticker Invoker) |
| `pr_review_listener` | bool | `true` | behavior | yes | yes | gates the PR-review comment listener on every SSE tick — armed tabs (`@rk_win_pr_listen`) have their unhandled review threads dispatched into their own agent. Shaped exactly like `cron_ticker` (tolerant `strconv.ParseBool` read, anything unparseable keeps the default ON — the safe direction for a loop with its own per-window arm switch; the line is omitted at the default so a file without it round-trips byte-identically). The tracker reads it through an injected `enabled func() bool` closing over `settings.Load()`, so a flip takes effect with no daemon restart (see [pr-review](/run-kit/pr-review.md) § Settings, Palette, and Chord) |
| `easter_eggs` | bool | `true` | behavior | yes | yes | gates the screen-break eggs' AUTOMATIC occasions — read by the frontend on page load and mirrored live in the browser that flips it; the palette's Easter egg entries ignore it (see [screen-break-eggs](/run-kit/ui/screen-break-eggs.md)) (hn6s) |
| `gui.enabled` | bool | `false` | behavior | yes | yes | the GUI surface switch — flat dotted YAML line, no env form; a settings POST ensures/kills the `rk-gui` session and flips the stream synchronously (see [gui](/run-kit/gui.md)) |
| `gui.wm` | string | `""` | behavior | yes | no | pins the window manager the GUI supervisor starts; empty picks the first installed ladder rung (icewm-session → openbox → xfwm4 → i3 → kwin_x11 → x-session-manager); a session-starter pin (startlxqt, lxqt-session, startxfce4, xfce4-session, startplasma-x11, startlxde, mate-session, cinnamon-session, x-session-manager) runs under `dbus-run-session`; takes effect on `rk gui restart`; the registry description ends `Run rk gui wm --list for installed and installable desktops.`; settable three ways — the `rk gui wm` CLI verb (aliases `auto`/`icewm`/`lxqt`/`xfce`/`plasma`/`lxde`/`mate`/`cinnamon`, PATH check, `--restart` chaining, `--list`/`--json`), the Settings dialog, or hand-edited YAML; no env form (see [gui](/run-kit/gui.md)) (2jl3) (zsui) (91px) |
| `gui.geometry` | string | `1920x1080` | behavior | yes | yes | the GUI desktop's pixel size — a fixed `WxH` (each side 320–7680) keeps windows where they are, `auto` follows the focused desktop viewer's tile; validated by `gui.ValidateGeometry` (an invalid value is a 400 carrying the range message; `null`/trimmed-empty restores the default); the serialized line is omitted at the default; a settings POST carrying a fixed value applies it live via xrandr, best-effort (see [gui](/run-kit/gui.md)) (zuci) |
| `tmux_conf` | path string | `""` | advanced | yes | no | user owns the file; rk performs no ensure/refresh/doctor on it |
| `log_level` | enum (`info`/`debug`) | `info` | advanced | yes | no | read at serve startup |

`live: false` keys (`port`, `tmux_conf`, `log_level`) are restart-bound (read once at tmux/serve startup); `live: true` keys apply on next read — `auto_name`'s one read-once consumer (the hub's tracker) is re-applied live by the settings POST. The exported accessor surface (`Load`, `Save`, `Stamp` — a path+mtime+size change fingerprint of the file `Load` would read (legacy fallback mirrored, `RK_CONFIG_DIR` honoured), the stat gate re-parse-on-change consumers such as the hub's `guiTick` use, `Default`, `Get/SetServerColor`, `Get/SetServerFlair`, `Get/SetInstanceColor`, `Get/SetSSHHost`, `Get/SetInstanceName`, `Get/SetBoardOrder`) sits over the registry, plus the riff-preset surface: the `BuiltinRiffPresets` code-tier table, the `RiffDiscussSkill` constant (the one source of the `/fab-discuss` literal, aliased by `riff.DefaultRiffSkill`), and the merged-view accessors `RiffPresets(Settings)`, `LoadRiffPresets()`, and the `RiffPresetMap` projection. (li54)

## Settings HTTP API

The entire settings HTTP surface is one registry-driven endpoint pair in `api/settings.go` (see [architecture](/run-kit/architecture.md) § REST API for the endpoint rows). The registry exports its metadata read-side (`KeyInfo` + `Registry()`, registry slice order) plus generic per-key JSON value read/apply hooks (`ReadValue`/`ApplyValue`) — value normalization and value-shape validation live with the registry entry, reusing `internal/validate`; board-order **name** validity (`tmux.ValidBoardName`) and duplicate rejection stay in the API handler (`internal/tmux` imports `internal/settings`, so settings calling into tmux would be an import cycle).

- **`GET /api/settings`** → `{"settings": [{key, kind, default, description, category, ui, live, options?, value}]}` — one object per registry entry, in registry order, snake_case registry key names verbatim, values in natural JSON types: `null` for unset string scalars, maps as objects (possibly `{}`), `board_order` as an array (possibly `[]`), `auto_name` as a bool, `port` as a JSON number (`null` when unset — the registry `default` text tells the client what unset means). `options` is present only on enum kinds (`theme`, `log_level`) and omitted otherwise.
- **`POST /api/settings`** — a flat JSON object of registry keys, partial merge per Constitution §IX: present keys set, absent keys untouched, `null` unsets (resets to the registry default). String scalars are trimmed, trimmed-to-empty treated as `null` (except `theme`/`theme_dark`/`theme_light`, whose defaults are non-empty — a trimmed-to-empty non-null value is a 400). Map keys merge **per entry** (an entry `null` unsets that entry, other entries untouched; a top-level `null` clears the whole map); `board_order` replaces wholesale (top-level `null` ≡ `[]`). The whole body is validated before a single `Load → apply-all → Save` — an unknown key, malformed body, or any per-key validation failure is a 400 with nothing persisted. Success is `200 {"status": "ok"}` with three keyed side effects: a successful body containing `board_order` broadcasts the server-global `board-order` SSE event (see architecture § SSE Hub); one containing `auto_name` (set or `null`-unset) re-applies the post-merge value to the running hub's auto-name tracker through the hub's apply seam (`sseHub.setAutoName` — see [architecture](/run-kit/architecture.md) § SSE Hub), so the live key takes effect without a daemon restart; and one containing `gui.enabled` (set or `null`-unset) drives the GUI supervisor — `true` calls `daemon.EnsureGUI()` best-effort (a failure logs a warning and the response stays 200; the stream's `reachable:false` + `reason` is the user-visible outcome), `false` calls `daemon.KillGUISession()` — then both flip the hub synchronously via `sseHub.setGUIEnabled(v)` so `event: gui` reflects the new value within one state event (see [gui](/run-kit/gui.md)). A body containing `gui.geometry` gets one more side effect (zuci): after the save, a fixed `WxH` value on an enabled, reachable display is applied live via xrandr — best-effort, so a failure logs a warning (`gui.geometry: live resize failed (the setting is saved; rk gui restart applies it)`) and the response stays 200; `auto` needs no action (the stream's `geometry` flips the tiles' resize behavior — see [gui](/run-kit/gui.md) § The `gui.geometry` key). No other key has a side effect. (f1ot) (5r41) (fkh1)

## Override Order & Env Inventory

Override order: **code default < config.yaml < env < CLI flag**. Env forms exist ONLY for deployment-bootstrap keys: `RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT` (`.env` committed, `.env.local` for overrides — the bootstrap vehicle; the committed `.env` binds `RK_HOST=127.0.0.1`, the same loopback as the code default, with all-interfaces binding a commented opt-in). The daemon port is the one bootstrap binding that is also a config.yaml key: its rungs are code default (`portpolicy.DaemonDefault` = 6123 — `portpolicy.DaemonLegacy` for an unmigrated existing install, the virtual pin of § Port Policy) < config.yaml `port` < `RK_PORT` (an invalid `RK_PORT` — non-numeric or out of range — is ignored, so the lower rung applies; no port CLI flag exists, so the generic top rung stays unoccupied for it). `RK_HOST` and `RK_CODE_SERVER_PORT` stay env-only; `RK_CODE_SERVER_PORT`'s fallback stays the resolved port + 2 (a config.yaml `port: 4000` yields code-server on 4002). The only other env reads are three **undocumented per-process escapes** that win over their config.yaml keys but are never user-facing: `RK_TMUX_CONF` (over `tmux_conf`), `LOG_LEVEL` (over `log_level` — the dev rig depends on it via `justfile`/`scripts/dev.sh`), and `RK_CONFIG_DIR` (relocates the whole config root — § Config Root). Preference keys have no env form. `rk doctor` flags a set-but-ignored `RK_SSH_HOST` (no reader remains; the hint points at the `ssh_host` key). (li54) (v1r0)

## Port Policy

The reserved/default port values live in one committed data file, `app/backend/internal/portpolicy/ports.env` — bash-sourceable `PORTPOLICY_*=integer` lines with `#` comments. The keys are shell variables in a sourced file, never exported env vars and never `RK_`-prefixed, so they are not an env-var surface and add nothing to the env inventory above. `internal/portpolicy` embeds the file via `//go:embed` and parses it once at package init (a missing/malformed key panics — a programmer error in the committed file); `scripts/e2e-env.sh` and `scripts/test-e2e.sh` source it; the Playwright `_harness.ts` helper parses it. The values: daemon default 6123 (dev backend 6124, code-server 6125 by the +1/+2 convention), the pre-rename daemon default `PORTPOLICY_DAEMON_LEGACY=3000` (exposed as `portpolicy.DaemonLegacy` — the one source of the rename port pin below, never `RK_PORT` or `DaemonDefault`), the e2e rig block 21000–21299 (100 triples), the `rk remote` SSH-tunnel block 3100–3199 (persisted in remotes.yaml — the rule P target 21500–21599 is deferred, recorded in a ports.env comment: `local_port` is immutable by design as the key of per-origin browser state and desktop view identity, live `ssh -L` tunnels would orphan, and `remote.Load` range-checks entries), and the Playwright fail-closed sentinel 21999. `internal/config`'s default port and `internal/remote`'s tunnel range both read from the policy; `rk ports` (and `rk ports --json`) is the user-facing view of it.

**The rename port pin.** During the config-home migration of an existing install — `apphome.UnmigratedExistingInstall()`: new config dir absent AND (legacy config dir OR legacy state dir present) — when the staged `config.yaml` sets no port, the migration appends the named `settings.PortPinComment` line plus `port: <DaemonLegacy>` to the copied bytes: a byte-preserving append (newline-terminated first when needed), never a re-serialize, so user comments and ordering survive. A file that already sets `port:` is left untouched; a missing file gets the pin as its only content (a state-only existing install gets a config home holding just the pin, through the same temp + rename publish); fresh installs get no pin. The comment round-trips through settings saves: `parse` sets `Settings.PortPinNote` on the exact comment line, the port serializer re-emits it directly above `port: N` while the note holds, and any registry write to `port` (set or null) clears it — a user-chosen port is no longer the migration pin.

Until the migration writes the real pin, the same predicate drives a **virtual pin**: `config.Load`'s code-default rung is `DaemonLegacy` for an unmigrated existing install, so every caller — including `rk daemon start`/`restart`, which never run the migration — resolves the port the still-running old daemon binds. `RK_PORT` and a config.yaml `port:` still win above it; `RK_CONFIG_DIR` suppresses it (an isolated run behaves as a fresh install); fresh and migrated installs keep `DaemonDefault`. Because the real pin and the virtual pin share the one existing-install predicate, they can never disagree.

`rk doctor` carries a conditional `port pin` advisory row — OK-shaped with a Note, verdict-neutral, placed after `ports`, following the `removedEnvCheck` "(check, bool)" shape where a false second return emits no row. It fires only when config.yaml's port equals `DaemonLegacy`, `DaemonDefault != DaemonLegacy`, and `RK_PORT` is not set to a valid port; the note names the pinned port, the new default, and the move recipe (set `port: <DaemonDefault>` in `~/.config/hexokit/config.yaml`, `rk daemon restart`, then re-point Tailscale Serve, bookmarks/phone shortcuts, and MCP clients at `…/mcp`). The constants differ (`DaemonDefault` 6123, `DaemonLegacy` 3000), so the row is live for installs pinned at 3000; the check function is pure over its inputs for table tests.

**Reserved-block collisions warn, never refuse.** The daemon footprint (the effective port plus its resolved code-server port, `port+2` by convention or the explicit `RK_CODE_SERVER_PORT`) is checked against the reserved blocks (rig, tunnel, and the sentinel as a one-port block) by `portpolicy.Collisions`, surfaced through the one shared `cmd/rk` helper `reservedCollisions(cfg)` so the three surfaces never disagree: `rk serve` logs one `slog.Warn` per collision at startup and starts anyway; the doctor `ports` row is always OK-shaped with the collision leading its note (never a verdict flipper); `rk ports` reports them and always exits 0. A dev build (`version == "dev"` — `just dev`/air and the e2e rig's un-ldflagged builds) exempts only the rig block, where worktree dev servers and e2e rigs live by design; tunnel and sentinel hits warn on every build. `portpolicy.Summary()` is the single reserved-block formatter shared by the `rk ports` output and the doctor note. See [backend-packages](/run-kit/architecture/backend-packages.md) § `internal/portpolicy` and [cli](/run-kit/architecture/cli.md) § `ports`.

## Boundaries

| Kind of value | Home |
|---|---|
| Per-instance behavior / prefs | `~/.config/hexokit/config.yaml` (the resolved config home) |
| Per-entity (server/session/window/pane) | `@rk_*` tmux options |
| Per-viewer / device | localStorage under the `hexokit-`/`hexokit:` prefixes (substrate `rk-*` keys are never renamed) |
| Per-editor-profile (the managed code-server profile) | code-server's own `settings.json` — e.g. `rk.bridge.enabled` (the code bridge's off switch, seeded `true` by the daemon's write-once `codeServerSeedSettings`; it lives in the editor profile, NOT `config.yaml`, and has no env form — see [code-bridge](/run-kit/code-bridge.md)) |
| Deployment binding | env (`RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT`); the port ALSO has a config home — config.yaml `port` sits one rung below `RK_PORT` (v1r0) |
| State (snapshots, caches — droppable only) | `$XDG_STATE_HOME/hexokit/` (the resolved state home) — incl. the `code/` derived-workspace tenant beside `cb/`: one per-tab `.code-workspace` file per (server, tab, code root) carrying `rk.tab`/`rk.server` into the code-bridge extension host (dir `0700`, files `0600`, derived-not-stored — a deleted file is simply regenerated, never read as truth; no GC — see [code-bridge](/run-kit/code-bridge.md)); and the `gui/` tenant holding the GUI supervisor's `host.sock` RFB socket (dir `0700`, socket `0600` — see [gui](/run-kit/gui.md)) |

Per-viewer prefs live under the `hexokit-`/`hexokit:` localStorage prefixes. At boot, before any app module evaluates — the router chain hydrates the compose stores from localStorage at module scope — `main.tsx`'s FIRST import, the side-effect module `lib/legacy-storage-boot.ts` (import graph free of app modules; ESM evaluates imports in source order), runs `lib/legacy-storage-migration.ts`'s one-shot copy. The router import stays static so the first render stays synchronous with module evaluation (an `await import()` there pushed the mount past the load event and broke reload-then-assert e2e flows). The copy: unless the marker key `hexokit-storage-migrated` is present, each legacy `runkit-*`/`runkit:*` value is copied to its absent hexokit counterpart, the legacy keys are kept in place (one-release window — a downgrade keeps working), and storage errors are swallowed so blocked storage never breaks boot. The marker is load-bearing: many prefs delete their key to mean "default", so an unguarded re-run would resurrect dropped values. The copy excludes the retired-key translators (`runkit-window-view:`, `runkit-window-panel:`, `runkit-code-folder:`, `runkit-operator-console-`, `runkit-panel-sessions`) — their readers stay on the legacy names directly — and `index.html`'s pre-paint script reads `hexokit-theme`/`hexokit-instance-color` first, falling back to the runkit keys. The UI domain files own the per-key detail.

## Migrations & Breadcrumbs

Migrations follow one pattern: fallback-read from the old path, migrate on first write, leave a breadcrumb so nothing silently forks. (The run-kit → hexokit home migration is the exception — a copy + atomic publish at release daemon start, no breadcrumb; § Home Migration.) Three have landed:

- **Settings file**: `Load()` reads the resolved config home's `config.yaml` (`~/.config/hexokit/config.yaml` on a migrated or fresh install, the legacy `run-kit` path during the one-release window), fallback-reading the legacy `~/.rk/settings.yaml` (same format) when the resolved file is absent; `Save()` writes the resolved path and then renames a still-present legacy `~/.rk` file to `~/.rk/settings.yaml.migrated` (best-effort — a rename failure never fails the save). A read-only instance keeps fallback-reading the old file indefinitely, losslessly.
- **State dir**: `$XDG_STATE_HOME/hexokit/` (snapshots at `…/hexokit/snapshots`, prstatus cache at `…/hexokit/prstatus.json`, the code-bridge socket root + host registry at `…/hexokit/cb/` — 0700, sockets 0600, records pruned live per call; see [code-bridge](/run-kit/code-bridge.md)), the derived per-tab workspace files at `…/hexokit/code/` (`<server>/<@N>-<hash6>.code-workspace` carrying `rk.tab`/`rk.server` into the extension host — 0700 dir, 0600 files, regenerated on demand and never a source of truth, no GC; see [code-bridge](/run-kit/code-bridge.md) § Tab identity), and the cron substrate tenant (`…/hexokit/cron/` — per-server entry intent files (`<slug>.yaml`), delivery logs (`<slug>.log`), wake cursors (`<slug>.cursor.yaml`), and the tick lock (`.lock`); dir 0700, files 0600; see [cron](/run-kit/cron.md)), and the GUI tenant (`…/hexokit/gui/` — the supervisor's `host.sock` RFB socket; dir 0700, socket 0600; see [gui](/run-kit/gui.md)), still XDG-honoring with the `~/.local/state` fallback — a deliberate asymmetry vs the config root, safe because Constitution §II restricts this dir to droppable, never-authoritative files (the cron entry files are the intent exception — the same class as `.status.yaml`, while their log/cursor/lock siblings stay droppable). All paths resolve through apphome's dual-read rule, so the legacy `…/run-kit/` tree stays authoritative until the home migration publishes. On snapshot-store first use, when the resolved dir is absent and the legacy `…/rk/snapshots` exists, the old dir is moved (`os.Rename`, best-effort, one-time) and a `MOVED-to-run-kit` breadcrumb file is left in the legacy dir naming the new path; a failed move degrades to cold-start behavior, never an error. The legacy `prstatus.json` is left behind — it is a startup seed cache that regenerates cold.
- **tmux.conf + tmux.d**: `DefaultConfigPath` is `~/.config/hexokit/tmux.conf` (resolved through apphome, like `settings.Dir()`), the drop-in dir is `~/.config/hexokit/tmux.d/`, and the embed sources the drop-ins per the dual-read `if-shell` (§ Managed tmux.conf). On ensure at the default path, legacy `~/.rk/tmux.d/*.conf` drop-ins are moved into the resolved `tmux.d/` (a same-name file already at the new path wins — never overwritten) and the old dir becomes the breadcrumb `tmux.d.migrated`; a legacy `~/.rk/tmux.conf` becomes the breadcrumb `tmux.conf.migrated` only when byte-equal to the current embed — pre-header files carry no stamp, so anything else (old-embed pristine or hand-edited) is left untouched and surfaced only by the doctor recipe. All best-effort, never fatal. (0tu6)

`~/.rk/` still has tenants covered by no migration: the web-push store (`internal/push`), the code-server bin dir (`internal/codeserver`) and profile/install dirs (`internal/daemon`), and job logs (`internal/daemon/jobs.go`). (li54)

## Requirements

### Requirement: Fixed config root
The config root SHALL be `$HOME/.config/hexokit/`, built with `filepath.Join` from `os.UserHomeDir()`, and MUST NOT consult `$XDG_CONFIG_HOME` or `os.UserConfigDir`. Home resolution SHALL go through `internal/apphome`, which SHALL apply the dual-read rule per home for one release: the hexokit dir when it exists, else the legacy run-kit dir when it exists, else the hexokit dir. The sole exception is the test-only `RK_CONFIG_DIR` override, which wins over the rule: when set to a non-whitespace value, `Dir()` SHALL return it verbatim, `configPath()` SHALL follow, and the legacy `~/.rk/settings.yaml` fallback-read and breadcrumb rename SHALL be suppressed; unset or whitespace-only MUST be byte-identical to the fixed root.

#### Scenario: Env cannot move the root
- **GIVEN** `XDG_CONFIG_HOME=/some/tmp` and `HOME=/test/home`
- **WHEN** the settings path is resolved
- **THEN** it is `/test/home/.config/hexokit/config.yaml`

#### Scenario: The test override relocates root and suppresses legacy touchpoints
- **GIVEN** `RK_CONFIG_DIR=/tmp/e2e/config` and a legacy `~/.rk/settings.yaml` on disk
- **WHEN** settings are loaded and saved
- **THEN** reads and writes land at `/tmp/e2e/config/config.yaml`, the legacy file is neither imported nor renamed, and the fixed `$HOME` root is untouched

### Requirement: Registry as single source of truth
Every settings key SHALL be one registry entry carrying key/type/default/description/category/ui/live; adding a key MUST NOT require new parse/serialize branches, nor new HTTP value plumbing — the registry's generic value read/apply hooks serve `GET`/`POST /api/settings` for every key.

### Requirement: Settings mutations are all-or-nothing
`POST /api/settings` SHALL validate the entire body before any write; an unknown key, malformed body, or any per-key validation failure MUST be a 400 with nothing persisted.

#### Scenario: Unknown key persists nothing
- **GIVEN** a body `{"theme": "dark", "bogus_key": 1}`
- **WHEN** POSTed to `/api/settings`
- **THEN** the response is 400 and the stored `theme` is unchanged

### Requirement: Byte-stable serialization
An existing settings file with values unchanged SHALL round-trip byte-identically through load + save (omit-when-default — `port` excepted, which serializes whenever explicitly set — scalar order, quoted values, sorted map keys).

### Requirement: Env restricted to bootstrap keys
Env forms SHALL exist only for `RK_PORT`, `RK_HOST`, `RK_CODE_SERVER_PORT`; a preference key (e.g. `ssh_host`) SHALL resolve from code default and config.yaml only.

#### Scenario: Preference key ignores env
- **GIVEN** `RK_SSH_HOST=devbox` in the environment and no `ssh_host` setting
- **WHEN** `GET /api/health` is served
- **THEN** the response carries no `sshHost`

### Requirement: Breadcrumb migrations
A migration SHALL fallback-read the old path, migrate on first write, and leave a self-documenting breadcrumb (`settings.yaml.migrated`, `MOVED-to-run-kit`, `tmux.conf.migrated`, `tmux.d.migrated`); a failed breadcrumb/move MUST NOT fail the operation and MUST degrade to cold-start behavior.

### Requirement: Home migration publishes atomically at release serve start
`homemigrate.Migrate()` SHALL run only at the top of a release-build `serve` RunE (before `config.Load()`/`tmux.EnsureConfig()`, followed by `tmux.RefreshDefaultConfigPath()`); dev builds and runs under `RK_CONFIG_DIR` SHALL skip it, `rk daemon start`/`restart` MUST NOT call it, and the publish SHALL be deferred while the resolved daemon port is already bound. For each home where the legacy dir exists and the new one does not, it SHALL copy the migrated set into a temp sibling and publish with one `os.Rename`; a race loser MUST discard its temp copy; every failure MUST be best-effort and non-fatal; the legacy trees MUST be left byte-unchanged. The config home SHALL copy its whole tree with symlinks carried as symlinks (contained links verbatim, escaping links recreated with an absolute target); the state home SHALL copy only `cron/`, `snapshots/`, and the GUI's write-once seeded files.

### Requirement: Existing installs are pinned at the legacy daemon port
During config-home migration of an existing install (`apphome.UnmigratedExistingInstall()`) whose config.yaml sets no port, the migration SHALL append the named `settings.PortPinComment` line plus `port: <DaemonLegacy>` byte-preservingly (no re-serialize); the pin MUST NOT come from `RK_PORT` or `DaemonDefault`, and fresh installs MUST NOT get one. The comment SHALL round-trip through settings saves (`PortPinNote`) and SHALL be cleared by any registry write to `port`. `config.Load`'s code-default rung SHALL be `DaemonLegacy` for an unmigrated existing install (the same predicate), with `RK_PORT` and config.yaml still winning. The doctor `port pin` advisory row SHALL stay verdict-neutral, SHALL emit only when config.yaml pins port == `DaemonLegacy` != `DaemonDefault` and `RK_PORT` is unset, and MUST NOT emit while the two constants are equal.

### Requirement: Managed tmux.conf ownership
Every rk write of the default tmux.conf SHALL produce a file whose first line is the managed header `# rk-managed sha256:<hex> — DO NOT EDIT; overrides go in ~/.config/hexokit/tmux.d/`, with `<hex>` the SHA-256 lowercase-hex digest of the body. The daemon-start refresh SHALL classify the on-disk file against the embed (missing / managed-current / managed-stale / hand-edited) and write only on missing or managed-stale; a stamp-verified legacy `run-kit` header suffix SHALL classify as managed-stale, never hand-edited; a hand-edited file MUST never be written or auto-migrated. The embed SHALL source drop-ins from exactly one tmux.d dir, chosen by the config-home dual-read rule at tmux load time. The reload sweep SHALL run only after a stale→force-write transition, SHALL touch only live-enumerated **managed** servers (`@rk_srv_managed` per [tmux-sessions](/run-kit/tmux-sessions.md) — an external server receives no conf, and an explicit `POST /api/tmux/reload-config` on one returns `200 {"status":"skipped","reason":"external"}`, not an error), and MUST never fail daemon start. When `tmux_conf`/`RK_TMUX_CONF` redirects the config path, rk SHALL perform no ensure/refresh/doctor on the file.

#### Scenario: Stale refreshes, hand-edited survives
- **GIVEN** a managed & stale file at the default path
- **WHEN** the daemon starts
- **THEN** the file is force-written with the current embed and the reload sweep runs; **AND GIVEN** a hand-edited file, **THEN** it survives byte-identical and no sweep runs.

### Requirement: user.conf override scaffold
Every scaffold path (`EnsureConfig`, `ForceWriteConfig`, `rk mux init-conf`, `POST /api/tmux/init-conf`) SHALL ensure `tmux.d/` exists and scaffold `tmux.d/user.conf` as a commented starter when absent; an existing `user.conf` MUST never be overwritten, including under `--force`.

#### Scenario: --force preserves user.conf
- **GIVEN** a user with customizations in `tmux.d/user.conf`
- **WHEN** `rk mux init-conf --force` runs
- **THEN** the managed tmux.conf is rewritten and `user.conf` is byte-identical to before.

## Design Decisions

### Fixed config root, no XDG
**Decision**: `$HOME/.config/hexokit/`, resolved by `internal/apphome` (dual-read against the legacy `run-kit` dir for one release); only `$HOME` moves it.
**Why**: rk is a daemon + CLI + agents-in-panes — an env var differing between those contexts silently forks which config is read; determinism by construction (hop's proven pattern). Dotfiles users symlink the directory.
**Rejected**: `os.UserConfigDir` (macOS → `~/Library/Application Support`, path differs per platform); honoring `$XDG_CONFIG_HOME` (per-process forkability is the exact failure mode).
*Introduced by*: 260823-li54-config-root-registry-core

### Test-only config-root override at the shared root
**Decision**: `RK_CONFIG_DIR` is read inside `internal/settings` at `Dir()` — the single root every settings consumer (`configPath`, `/api/settings`, board persistence, PWA accent read) resolves through — with the legacy-path touchpoints suppressed while it is active; the managed tmux.conf path is computed independently in `internal/tmux` and deliberately does not move.
**Why**: scope-at-the-shared-root is the same rationale as `RK_SERVER_ALLOWLIST` filtering in `ListServers` — a per-consumer override would leave sibling paths unscoped; the in-package `os.Getenv` read matches the package precedent, and only the settings file needs per-run isolation.
**Rejected**: threading through `internal/config` (new cross-package plumbing for one test-only value); overriding `$HOME` for the dev subtree (moves `~/.rk`, node/pnpm caches — larger blast radius for the same isolation win); a cross-worktree flock around config-touching specs (serializes instead of isolating).
*Introduced by*: 260903-y60c-e2e-config-root-isolation

### Hand-rolled registry-driven serializer
**Decision**: keep the line-scanner parse + string-builder serialize, driven by the registry.
**Why**: preserves tolerant-read semantics and byte-stable omit-when-default output the tests pin; extends the proven `nestedSections` registry shape to all keys.
**Rejected**: `yaml.v3` marshal/unmarshal — reformats user files, loses omit-when-default byte-stability, adds comment-handling complexity.
*Introduced by*: 260823-li54-config-root-registry-core

### Breadcrumb by rename
**Decision**: migration breadcrumbs are self-documenting filesystem artifacts — the old settings file becomes `*.migrated`; the state move leaves a `MOVED-to-run-kit` marker file.
**Why**: an old binary or a curious user finds a clearly-marked artifact instead of a silently diverging live file.
**Rejected**: deleting the old file (destroys the rollback path); leaving it live (silent fork — two writers, two truths).
*Introduced by*: 260823-li54-config-root-registry-core

### Migrate at daemon start, publish atomically
**Decision**: The home migration runs only at release-build `serve` start (skipped for dev builds and under `RK_CONFIG_DIR`; never from `rk daemon start`/`restart`). It copies the legacy tree into a temp sibling and publishes with one `rename(2)`. Until then every process resolves the legacy home (new-if-exists, else legacy-if-exists, else new).
**Why**: After `brew upgrade` the old daemon keeps writing to the legacy dirs until it restarts. A CLI-triggered migration would split state, and the new daemon would boot on a stale copy. The atomic publish makes "new dir exists" equivalent to "migrated or fresh", so the resolution rule needs no marker file.
**Rejected**: Migrating on the first CLI invocation (state split across the old-daemon window). Moving instead of copying (breaks downgrade and violates the left-in-place rule).
*Introduced by*: 260926-qm4d-hexokit-home-migration

### Env escapes stay undocumented
**Decision**: `RK_TMUX_CONF` and `LOG_LEVEL` survive as per-process env escapes that win over their config.yaml keys, with no user-facing documentation.
**Why**: a per-process test/debug toggle must not mutate the user's config.yaml, and the dev rig exports `LOG_LEVEL=debug` (`justfile`, `scripts/dev.sh`).
**Rejected**: deleting the env reads (breaks the dev rig and per-process testing); documenting them (grows the env surface the override order just restricted).
*Introduced by*: 260823-li54-config-root-registry-core

### GET shape: array of full registry entries
**Decision**: `{"settings": [{key, kind, default, description, category, ui, live, options?, value}]}` in registry order, snake_case registry key names verbatim.
**Why**: a registry-driven settings surface renders typed controls straight from this — one payload, ordered, self-describing; null-for-unset preserves the read contract the per-key GETs carried.
**Rejected**: split `{registry: [...], values: {...}}` (two structures to zip client-side); values-only map (drops the metadata a registry-driven surface needs, defeating the registry).
*Introduced by*: 260823-f1ot-settings-api-hard-fold

### Value plumbing in registry hooks, board-name validation at the API layer
**Decision**: registry entries own generic JSON value read/apply hooks (normalization + value-shape validation lives with the entry, reusing `internal/validate`); board-order **name** validity (`tmux.ValidBoardName`) and duplicate rejection stay in the API handler.
**Why**: keeps "adding a key is one registry entry" true for the API path; `internal/tmux` imports `internal/settings` (tmux.go), so settings calling into tmux is an import cycle — the API package already imports both.
**Rejected**: a per-key switch in `api/settings.go` (reintroduces per-key growth at the HTTP layer); moving `ValidBoardName` into `internal/validate` (churns `api/boards.go` callers for no behavioral gain).
*Introduced by*: 260823-f1ot-settings-api-hard-fold

### Per-entry map merge
**Decision**: map-kind keys merge per-entry with `null` unsetting one entry; top-level `null` clears the map; `board_order` replaces wholesale.
**Why**: mirrors the `SetServerColor(server, color *string)` one-entry semantics so client setters stay one-entry-sized; a full-map replace would force every color-picker click to read-modify-write the whole map client-side (racy across tabs).
**Rejected**: wholesale map replacement (race-prone, bigger client diffs); JSON-merge-patch RFC 7386 wholesale-object semantics (breaks the one-entry setter shape).
*Introduced by*: 260823-f1ot-settings-api-hard-fold

### Built-ins as a code tier, user map stores overrides only
**Decision**: `Settings.RiffPresets` stores only the user's preset entries (nil default); the three built-ins live in the package-level `BuiltinRiffPresets` table; `RiffPresets(Settings)` returns the merged view (built-ins in canonical order, then user additions sorted — never empty).
**Why**: keeps omit-when-default and byte-stable round-trip with zero `mapSection` changes — a default-seeded map would either serialize three lines into every saved file or need a per-entry omit branch.
**Rejected**: seeding the map in `Default()`.
*Introduced by*: 260916-i567-builtin-riff-presets-settings-registry

### Hash-stamped header as the ownership declaration
**Decision**: ownership and staleness of the managed tmux.conf are derived from a SHA-256 stamp in the file's own first line; the three-state check is a pure local computation against the embed.
**Why**: no version registry, no timestamps, no extra state file (Constitution II — derive from the filesystem); "did the user edit this?" becomes deterministic and testable.
**Rejected**: a version marker (stale detection breaks when the embed changes without a version bump); mtime heuristics (false positives on copy/touch); a sidecar state file (a second source of truth to drift).
*Introduced by*: 260823-0tu6-tmux-conf-ownership

### Byte-equal embed test for pre-header migration
**Decision**: an old `~/.rk/tmux.conf` is auto-breadcrumbed only when byte-equal to the current embed; everything else is hands-off with a doctor recipe.
**Why**: pre-header files carry no stamp, so managed-ness is unprovable; byte-equality with the current embed is the only zero-false-positive detector, and false positives here destroy user edits.
**Rejected**: comparing against historical embeds (rk does not archive them); auto-migrating any old file (violates the never-clobber rule).
*Introduced by*: 260823-0tu6-tmux-conf-ownership

### Sweep only on an actual force-write
**Decision**: the reload sweep fires only on the managed-stale → force-write transition, not on every daemon start.
**Why**: reloading unchanged config is wasted tmux traffic across every live server, and the sweep's only purpose is propagating a refresh that just happened.
**Rejected**: unconditional sweep at start (noise, and touches servers for nothing); sweeping on missing→write (a fresh file means no server was started with older content by rk's `-f` — new servers pick it up at creation).
*Introduced by*: 260823-0tu6-tmux-conf-ownership

### Managed-conf apply paths gate on the provenance mark
**Decision**: all three conf-apply paths (the daemon-start reload sweep, the WS-attach best-effort reload, and `POST /api/tmux/reload-config`) skip external (unmarked) servers; the explicit endpoint reports `200 {"status":"skipped","reason":"external"}` rather than erroring, and the sweep/attach skips log at debug. `CreateSession`'s `-f` flag carries no gate.
**Why**: the user's own tmux.conf regime and rk's managed conf are different regimes — sourcing rk's conf into a server the user configured themselves silently changes its keybindings, styling, and options. tmux ignores `-f` on an already-running server, so the flag applies only at birth, which is exactly when the `@rk_srv_managed` stamp lands — gating it would be dead code.
**Rejected**: gating only the sweep (the WS-attach reload fired merely on viewing a terminal — the hottest path); erroring on the endpoint's external case (a report keeps scripted reloads non-fatal).
*Introduced by*: 260826-lv87-external-server-provenance-adopt

### auto_name liveness via POST-driven tracker rewire, no broadcast
**Decision**: the settings POST rewires the hub's auto-name tracker in place; no generic settings-changed SSE event is added.
**Why**: `live` means "applies on next read without restart" — every other live key already honors it per its read cadence; auto_name's read-once-at-construction seam was the only violation. Cross-tab push is new backend surface the invocation forbids.
**Rejected**: per-tick `settings.Load()` in the hub (file I/O every ~2s per server for one bool); a settings-changed broadcast (unneeded surface).
*Introduced by*: 260823-5r41-settings-pane-live-apply

### Enum options ride the registry
**Decision**: `registryEntry.options []string` for enum kinds, served through KeyInfo and GET.
**Why**: a generated enum control needs options as data and the registry is the single source of truth.
**Rejected**: legal values living only inside the parse/apply closures (invisible to generated controls, as `log_level`'s once were); hardcoding options in the frontend (drifts from the registry, defeats generation).
*Introduced by*: 260823-5r41-settings-pane-live-apply

### Conditional pane-index prefix on the pane border
**Decision**: the managed conf's `pane-border-format` shows `#P · ` only when `window_panes > 1`, via `#{?#{e|>:#{window_panes},1},#P · ,}`; the raw `%N` pane id appears nowhere in the border.
**Why**: the single-pane window is the dominant case — a constant `1 · ` prefix is noise that duplicates nothing useful, and a raw tmux internal id means nothing to a user reading primary chrome. The id stays reachable where it belongs: the web status bar's `Copy tmux pane id` affordance and `tmux display-message -p '#{pane_id}'`.
**Rejected**: keeping `#P` unconditionally (noise in the common case); keeping `#D` anywhere in the border (the internal-id leak).
*Introduced by*: 260902-qt7k-ipad-chrome-polish

### Pane-border git info is daemon-stamped, not forked at draw time
**Decision**: the `pane-border-format` reads its path tail, worktree badge, and git branch from pane user-options (`@rk_pane_pathtail` / `@rk_pane_git_worktree` / `@rk_pane_git_branch`) that the daemon's snapshotter stamps only-on-change; the format runs no `#()` shell jobs.
**Why**: a `#()` job in a border format forks `/bin/sh` plus a git subprocess per pane on every border redraw, and redraws come in bursts under multi-client resizes — draw-time forks are the wrong place for git work. The daemon already derives each pane's branch and git root cheaply and cached (the shared `internal/gitinfo` resolver, so the border matches the sidebar), so handing tmux the answer as data removes every draw-time fork. Stamping lives on the snapshotter tick because it is subscriber-independent — a native-terminal-only user with no browser open still gets a populated border. The multi-viewer server wedge this was first shipped against has a different owner: the tmux pane-status draw defect guarded by → Multi-viewer sizing guard; the fork-free border is hygiene, not the fix for that wedge.
**Rejected**: stamping from the SSE poll (browser-gated — blanks the border when no web client watches the server); dropping the branch/badge from the border entirely (loses information users rely on).
*Introduced by*: 260908-s9fw-cache-pane-border-git-info

### Multi-viewer sizing guard: `window-size smallest` + `aggressive-resize on`
**Decision**: the managed conf sizes every window to the narrowest size-participating client whose current window it is (`set -g window-size smallest`, `setw -g aggressive-resize on`), applied unconditionally on every tmux version.
**Why**: every released tmux through 3.7c underflows the pane-border-status draw width in `screen-redraw.c` `screen_redraw_draw_pane_status` (`width = size - x` in `u_int`) whenever a client's viewport is narrower than the window and a pane status line straddles the viewport edge with text shorter than its offset; the wrapped width sends one `tty_draw_line` over ~4 billion cells, spinning the single-threaded server ~21 s per redraw and freezing every client, the control-mode subscription, and the dashboard (40–64 s per episode as redraws repeat). The geometry needs only two differently sized viewers of one window — an agent's terminal plus a browser tile, or a desktop tile plus a phone — and a right-hand pane; a plain `sleep` pane reproduces it. run-kit cannot patch the user's tmux and no release carries upstream master's rewritten redraw (`redraw_draw_status_span` clamps the width), so the guard removes the geometry instead: under `smallest` no viewer is ever narrower than its window. `aggressive-resize on` is load-bearing — without it a narrow client viewing one window of a grouped `_rk-pin-*` session shrinks every window in the group; with it only the window it currently views is constrained (verified).
**Rejected**: `pane-border-status off` (loses per-pane identity in multi-pane and Board views and orphans the daemon stamping); daemon- or hook-driven per-window border toggling (the first redraw after a geometry change already wedges before any reactor runs, tmux formats cannot enumerate clients, and `run-shell` is asynchronous); padding or shortening the status text (the underflow depends on the pane's x-offset, which the format cannot control); `window-size largest`/`manual` (guarantee clipping for every narrower viewer / freeze everyone); a tmux version gate or `rk doctor` row (every released version is affected, and the policy stands on its own once a fixed tmux ships); waiting for upstream (the report draft lives with the change; no release date).
*Introduced by*: 260909-3cp9-pane-split-wedge-sizing-guard

See [backend-packages](/run-kit/architecture/backend-packages.md) § `internal/settings` for the package-level contract and [layout-snapshots](/run-kit/layout-snapshots.md) for the snapshot store under the state root.

### Backend settings file over localStorage-only
**Decision**: `~/.config/hexokit/config.yaml` via the `internal/settings/` package + the `GET/POST /api/settings` endpoint pair. localStorage kept as a synchronous cache for instant reads before the API responds on page load. Simple `key: value` text parsing (not yaml.v3). Settings are global (not per-server, no `?server=` param).
**Why**: survives browser cache clears, works across devices accessing the same server. The text parser started with one field and avoids re-adding a heavyweight dependency.
*Introduced by*: 260323-7wys-ansi-palette-theme-rework

### The port policy is one embedded data file, not a verb its consumers call
**Decision**: `ports.env` is committed, embedded by Go (`//go:embed`), sourced by bash, and parsed by the Playwright helper; `rk ports [--json]` is the user-facing view, not the scripts' read path.
**Why**: `e2e-env.sh` is sourced by `dev.sh`/`pw.sh`/`test-e2e.sh` before any binary is built, and the `rk` on PATH is the brew install (no `ports` verb until a release ships) — a verb-based read would need a `go run` compile per `just dev` or break on version skew. One bash-sourceable `KEY=integer` file is the only shape all three consumers (bash pre-build, Go, TS) read without a build step or new dependency.
**Rejected**: scripts calling `rk ports --json` (compile cost, version skew); Go constants plus generated shell/TS copies with a drift test (more moving parts than one shared file).
*Introduced by*: 260925-40fa-machine-ports-policy

### Reserved-block collisions warn, never refuse
**Decision**: a daemon port inside a reserved block produces an `slog.Warn` at `rk serve` start, an OK-shaped doctor note, and an `rk ports` report — nothing refuses to start. Dev builds (`version == "dev"`) exempt only the rig block; tunnel and sentinel hits warn on every build, and all three surfaces read through the one `reservedCollisions` helper.
**Why**: disruption-free — a working daemon may already sit inside the tunnel block; dev/e2e rigs live on rig-block ports by design, so warning there would fire on every dev loop with advice that does not apply, and keying the exemption on the un-ldflagged build needs no new env marker (constitution IV / no new env names).
**Rejected**: refusing in `serve` (breaks working installs); a split refuse-new/warn-legacy posture (asymmetric for little gain); an env-var exemption marker (new env surface).
*Introduced by*: 260925-40fa-machine-ports-policy

### Serialize-when-set for the port pin
**Decision**: `port` serializes whenever explicitly set, even when equal to the code default; 0 = unset is omitted.
**Why**: the key exists to pin an install (the hexokit-rebrand migration writes `port: 3000` into existing installs ahead of the default flip). `Save` rewrites the whole file, so omit-at-default would drop the pin on any settings save and silently move the install when the default later flips.
**Rejected**: the omit-at-default convention the other scalars use — it cannot tell "pinned at 3000" apart from "unset".
*Introduced by*: 260925-v1r0-port-config-key

### Default daemon port is single-sourced from the port policy

**Decision**: the code default is `portpolicy.DaemonDefault` (from `ports.env`); `internal/config`'s defaults and the `port` registry entry's default text (`strconv.Itoa(portpolicy.DaemonDefault)`) both read it.
**Why**: the port policy is the one source of truth for reserved and default ports, so the settings registry must not carry a second literal that could drift when the default flips. `internal/portpolicy` imports only the standard library, so both `config` and `settings` can depend on it without a cycle (`config` already imports `settings` for the middle rung).
**Rejected**: a `settings.DefaultPort` constant (a second home for the same value beside `ports.env`); duplicating the literal in `config` and `settings` (magic-number anti-pattern).
*Introduced by*: 260925-v1r0-port-config-key

### Pin the legacy default, not RK_PORT
**Decision**: The migration pins `port: 3000` (`portpolicy.DaemonLegacy`, appended byte-preservingly with the named `PortPinComment` line) unless config.yaml already sets a port. Unmigrated existing installs get the same value as a virtual default in `config.Load` via the shared `apphome.UnmigratedExistingInstall()` predicate.
**Why**: `RK_PORT` wins over the pin anyway, and capturing a transient `RK_PORT` (dev rig, test) would pin a bogus port permanently. `DaemonDefault` (6123) is the fresh-install default, not the port existing installs run.
**Rejected**: Pinning `cfg.Port` as resolved (captures env). Pinning `DaemonDefault` (the fresh-install default — it would move existing installs off their pinned port).
*Introduced by*: 260926-qm4d-hexokit-home-migration
