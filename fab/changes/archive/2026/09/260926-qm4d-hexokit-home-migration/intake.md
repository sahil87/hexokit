# Intake: HexoKit Home Migration

**Change**: 260926-qm4d-hexokit-home-migration
**Created**: 2026-09-26

## Origin

> Phase 3 of the HexoKit rebrand, plan row C4 (fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md — read the whole file fresh, including rules table D2/D8/D9/D15/D16/D17/P, and the C4 row). R0 (app identity rename, PR #950) just merged to main. This change:
>
> D9 one-time home-directory migration: ~/.config/run-kit -> ~/.config/hexokit (dual-read one release), $XDG_STATE_HOME/run-kit -> hexokit (cron entries + snapshots MUST move; droppable caches may cold-start), runkit-* localStorage -> hexokit-* (read-old/write-new). Add an e2e that seeds old keys/dirs and asserts pickup.
>
> Port pin (rule P): while migrating config.yaml, write the current effective daemon port into the `port` key (already shipped in P3/PR#1051) with a one-line comment explaining it is pinned during the rename so remote access keeps working — existing installs stay on 3000, only fresh installs get the new default later (C5). Add a doctor row nudging pinned-at-3000 installs toward 6123 (C5 will actually move the default; this change only lands the pin+nudge plumbing).
>
> Tunnel range: persisted remotes.yaml 3100-3199 -> 21500-21599 as a one-shot reassignment (lowest free) in the same load path ONLY IF TRIVIAL; otherwise leave the range alone and record it in the policy/plan doc — do not force it.
>
> Also: as part of this change, update the plan doc's R0 row (mark merged, link PR #950) and the Status line at the top, since that bookkeeping was left for the next change to pick up.
>
> Ships in the same release as R0 (already merged) and C5 (not yet started, depends on this). Full pipeline: /fab-new then /fab-fff.

One-shot request, followed by a codebase survey in the same session (a read-only inventory of every home-path resolver, the frontend storage keys, doctor rows, and existing migration helpers). Findings from that survey and the decisions they forced are encoded below and in the Assumptions table.

**Plan-doc finding**: the remaining-work doc's pickup protocol says "the rules table above is Certain", but commit `3f9937e7` ("P1 #1050, P2 #1049, P3 #1051 merged…") accidentally deleted the whole `## Rules that bind every row here` section (D2/D8/D9/D11/D14/D15/P plus the "Roster coupling" paragraph). The verbatim text is recoverable from `git show 0f615740:fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. Rule P is the source of the 21500–21599 tunnel block and the "pin, don't move" rule this change implements.

## Why

1. **Problem.** HexoKit's app identity shipped in R0 (#950): the long command is `hexokit`, the desktop app is "HexoKit". But everything on disk is still called run-kit: `~/.config/run-kit/` (config.yaml, the managed tmux.conf, `tmux.d/` user overrides), `$XDG_STATE_HOME/run-kit/` (cron entries, layout snapshots, caches), and ~45 `runkit-*` localStorage keys (theme, keybindings, macros, sidebar geometry, compose drafts). The `config-home` toolkit standard fixes the config dir to the full tool name, so it must become `hexokit`.
2. **Consequence of getting it wrong.** The master plan names *silent state loss* as the one user-visible regression the rename can cause. If paths flip without a migration, users lose their settings, keybindings, macros, and cron jobs, and their tmux overrides stop loading. If C5 (daemon default 3000 → 6123) ships without a pin, every existing install silently moves to :6123 on its next restart, breaking Tailscale Serve mappings, bookmarks, phone shortcuts, and MCP clients at `…:3000/mcp`.
3. **Why this approach.** Rule D9 says: read old, write new, leave the old copy in place for one release. Rule P says existing installs are pinned, not moved. The repo already has precedents for each piece: `snapshot.MigrateLegacyDir` (move a dir only when the target is absent, leave a breadcrumb), the `settings` fallback-read of `~/.rk/settings.yaml`, the desktop `carryForwardLegacyUserData` (copy, not move, so a downgrade still works), and one-shot localStorage translations (`quake-terminal.ts`, `sidebar/index.tsx`). This change reuses those shapes under one resolver instead of ~9 hand-rolled `filepath.Join(home, ".local/state", "run-kit", …)` copies.

## What Changes

### 1. One home resolver (new package; name chosen at apply, e.g. `internal/apphome`)

There is no shared helper today. Every resolver builds its path inline:

| Home | Resolvers today (all `run-kit`) |
|------|--------------------------------|
| Config root `$HOME/.config/run-kit` | `internal/settings/settings.go:163` `Dir()`; `internal/tmux/tmux.go:294` `DefaultConfigPath` (built separately; `RK_CONFIG_DIR` does NOT move it) |
| State root `${XDG_STATE_HOME:-~/.local/state}/run-kit` | `internal/cron/dir.go:45-52` (`cron/`), `internal/snapshot/store.go:43-50` (`snapshots/`), `internal/prstatus/prstatus_disk.go:80-87` (`prstatus.json`), `internal/gui/state.go:24-31` (`gui/`), `internal/codeworkspace/codeworkspace.go:28-35` (`code/`), `internal/codebridge/state.go:14-21` (`cb/`), `internal/transcript/opencode.go:128-135` (`opencode-export/`) |

Add one small package that owns:

```go
const Name = "hexokit"        // the current home dir name
const LegacyName = "run-kit"  // dual-read for one release, then dropped

func ConfigDir() (string, error) // $HOME/.config/<resolved>  — never $XDG_CONFIG_HOME (settings.go:14-21 rationale stands)
func StateDir() (string, error)  // ${XDG_STATE_HOME:-$HOME/.local/state}/<resolved>
```

**Resolution rule, the same for both homes (this is the dual-read):**

- If the new dir (`…/hexokit`) exists, use it.
- Else, if the legacy dir (`…/run-kit`) exists, use it. This is an existing install that has not migrated yet.
- Else use the new dir. This is a fresh install.

Every resolver above switches to `ConfigDir()`/`StateDir()` joined with its leaf. `settings.Dir()` keeps its `RK_CONFIG_DIR` test override (it wins over the rule). `tmux.DefaultConfigPath` becomes `ConfigDir()/tmux.conf`. The leaf names (`cron`, `snapshots`, `gui`, `code`, `cb`, `prstatus.json`, `opencode-export`, `tmux.conf`, `tmux.d/`, `config.yaml`) are unchanged.

The rule is atomic because the migration (§2) publishes the new dir with a single `rename(2)`. Before that rename nothing creates `…/hexokit`, since every writer resolves through the rule and gets the legacy dir. So "new dir exists" ⇔ "migrated, or fresh install". No marker file is needed.

### 2. The one-time migration: copy, then atomic publish

A `Migrate()` entry point (in a package that may import `settings`/`portpolicy` without an import cycle, e.g. `internal/apphome/migrate` or `internal/homemigrate`). For each home, when the legacy dir exists and the new one does not:

1. Copy the legacy tree into a temp sibling (`~/.config/.hexokit-migrate-<rand>`, `$XDG_STATE_HOME/.hexokit-migrate-<rand>`).
2. Apply the port pin (§3) to the temp copy's `config.yaml`. Config home only.
3. `os.Rename(temp, new)`. If it fails because the new dir now exists (a concurrent migrator won the race), discard the temp copy.
4. Best-effort and never fatal, following the existing migration helpers. A failure logs a warning and leaves the legacy home authoritative, because the resolution rule still points at it.

The legacy dir is **left in place, untouched**. That is D9's "old left in place for one release", and it also keeps a downgrade working (the desktop `carryForwardLegacyUserData` precedent).

**What is copied:**

| Home | Copied | Not copied (cold start is fine) |
|------|--------|--------------------------------|
| Config `~/.config/run-kit/` | the whole tree: `config.yaml`, `tmux.conf`, `tmux.d/` (user overrides), anything else | — |
| State `$XDG_STATE_HOME/run-kit/` | `cron/` (entries are user intent, **must** move; log + cursor ride along), `snapshots/` (recovery backups, **must** move) | `prstatus.json` (seed cache), `gui/` (sockets, re-seeded WM files, CDP profiles), `code/` (regenerated `.code-workspace` files), `cb/` (runtime rendezvous), `opencode-export/` (materialized exports) |

**When it runs: at daemon start, not on the first CLI invocation.** Call `Migrate()` at the top of `serve`'s RunE, before settings or config are read, and in `rk daemon start` / `rk daemon restart` before they resolve the port they pass via `-e RK_PORT` (P3). Why: after `brew upgrade` the old-binary daemon keeps running and writing to the legacy dirs (settings saves from the UI, cron ticks, periodic snapshots) until it restarts. Migrating on the first new-binary CLI call, such as an agent hook firing seconds after the upgrade, would split state between the two homes. The new daemon would then start on a stale copy and lose everything written in between. Until the new daemon starts, the resolution rule keeps every process (old daemon, new CLI) on the legacy home, so they stay consistent.

**Dev builds skip the automatic migration** (`version == "dev"`: `just dev`/air and the e2e rigs, the same gate `cmd/rk/reserved.go:13` uses). A worktree dev rig shares the developer's real `~/.config/run-kit` with the live brew daemon. If the rig migrated it, a later real upgrade would start from that stale snapshot. With the skip, dev rigs keep resolving the legacy home exactly as they do today. Tests drive `Migrate()` directly or build the binary with a release `-ldflags -X main.version=…`.

### 3. Port pin (rule P, D17)

The pin happens inside the config-home migration (step 2 above), only for an **existing install**: the legacy config dir **or** the legacy state dir exists. A fresh install gets no pin and lands on whatever `portpolicy.DaemonDefault` is (6123 after C5).

- If the legacy `config.yaml` already sets `port:`, leave it as is. The user pinned it already.
- Otherwise **append** to the copied file's bytes, without re-serializing, so the user's comments and ordering survive:

  ```yaml
  # port pinned during the HexoKit rename so remote access keeps working (fresh installs use the new default; see rk doctor)
  port: 3000
  ```

  The comment wording can be tuned at apply, but it stays one line. The appended key is top-level. `parse` ends an active nested section on any non-indented line, so appending after a nested section like `riff_presets:` is safe.
- **Pin value = the legacy default (3000), not `RK_PORT`.** Add a named policy constant, e.g. `PORTPOLICY_DAEMON_LEGACY=3000` in `internal/portpolicy/ports.env` (exposed as `portpolicy.DaemonLegacy`). Do NOT pin `portpolicy.DaemonDefault`: C5 flips that to 6123 in the same release, so a pin written from it would pin the wrong port. `RK_PORT` is deliberately not captured. A user who exports `RK_PORT` persistently keeps winning over the pin anyway (precedence code default < config.yaml < `RK_PORT`). A transient `RK_PORT`, such as a dev rig or test run triggering the migration, would otherwise be pinned permanently.
- **Unmigrated installs are virtually pinned.** In `config.Load` (`internal/config/config.go`), when the legacy config home is the active one (resolution rule branch 2) and config.yaml sets no port, the default is `portpolicy.DaemonLegacy`. This keeps `rk url`, `rk ports`, `doctor`, and `rk daemon start`'s `-e RK_PORT` consistent with the still-running old daemon (:3000) during the window between upgrade and first restart, even after C5 moves `DaemonDefault`.
- **The comment survives settings saves.** `settings.Save` rewrites the whole file via `serialize`, and `parse` drops comments, so the pin comment would vanish on the first UI settings save. Make it round-trip:
  - `parse` recognizes the exact pin-comment line (a named constant) and sets a flag on `Settings` (e.g. `PortPinNote bool`).
  - The `port` serializer emits the comment line before `port: N` when the flag is set and `Port != 0`.
  - Any registry write to `port` (`ApplyValue`) clears the flag, because a user-chosen port is no longer the migration pin.

### 4. Doctor row: the 6123 nudge (plumbing only)

Add a conditional advisory row. It is OK-shaped with a `Note`, never flips the verdict, and follows the `removedEnvCheck` `(doctorCheck, bool)` pattern: no row when the condition is false. It is named e.g. `port pin` and sits next to the existing `ports` row (`cmd/rk/doctor.go:212`).

- **Fires when:** config.yaml pins `port == portpolicy.DaemonLegacy` (3000), **and** `portpolicy.DaemonDefault != portpolicy.DaemonLegacy`, **and** `RK_PORT` is not overriding it.
- **Note:** roughly `pinned at :3000 (kept through the HexoKit rename); new installs default to :6123 — to move: set port: 6123 in ~/.config/hexokit/config.yaml, rk daemon restart, then re-point Tailscale Serve, bookmarks/phone shortcuts, and MCP clients at …/mcp`. Use `DaemonDefault` for the target number, not a literal.
- **Dormant until C5.** Today `DaemonDefault == DaemonLegacy == 3000`, so the row does not fire. C5 flips `PORTPOLICY_DAEMON_DEFAULT` to 6123 and the nudge turns on with no further code. R0, C4, and C5 ship in one release, so no user sees the gap. Table tests inject both constants to cover the firing branch now.

### 5. Managed tmux.conf and `tmux.d/` follow the config home

- `configs/tmux/default.conf:111` (`source-file -q ~/.config/run-kit/tmux.d/*.conf`) → `~/.config/hexokit/tmux.d/*.conf`. Update the template comments at `:3,108` too.
- `internal/tmux/managedconf.go:26` `managedHeaderSuffix` (`… overrides go in ~/.config/run-kit/tmux.d/`) → `hexokit`.
- The migrated copy of the managed `tmux.conf` becomes stale against the new embed. `EnsureConfig` / `ClassifyManagedConf` / `RefreshSweep` must classify it as **managed-stale** and rewrite it, never as hand-edited. Apply must verify how the stamp is checked. The header line and the embedded text both change, so this is the likeliest place for a false "hand-edited" classification. Live tmux servers started with `-f ~/.config/run-kit/tmux.conf` keep sourcing the legacy `tmux.d/`, which still exists because it is left in place. `RefreshSweep` reloads managed servers onto the new file after it rewrites the conf.
- The existing `~/.rk/tmux.d` → config-home legacy migration (`migrateLegacyConfPaths`/`migrateLegacyDropIns`) keeps working against the resolved config dir.

### 6. Code-bridge state (`cb/`): a two-process contract

`app/code-bridge/src/extension.ts:361-365` `stateDir()` hard-codes `<state>/run-kit/cb`. The VS Code extension writes host records, boot markers, and bridge sockets there, and the Go side reads them (`internal/codebridge`).

- The extension adopts the same resolution rule: `<state>/hexokit/cb` if `<state>/hexokit` exists, else `<state>/run-kit/cb` if `<state>/run-kit` exists, else hexokit.
- The VSIX is only reinstalled on `rk code-server install/update`, not on daemon start (`cmd/rk/code_server.go:219`). An old extension would keep writing `run-kit/cb` after the Go side has migrated. So for one release, Go-side host/boot discovery also reads the legacy `<state>/run-kit/cb` when the resolved state dir is the new one, and records found under the new dir win on a hostId collision. `app/frontend/tests/e2e/code-surface.spec.ts:668,678,759` hard-codes `join(stateHome, "run-kit", "cb", …)`. Update it to follow the resolver.

### 7. Frontend localStorage: `runkit-*` → `hexokit-*` (read-old, write-new)

There is no central storage module. Each feature owns a key constant; the full list is in the inventory, e.g. `contexts/theme-context.tsx:29-31`, `contexts/chrome-context.tsx:21-26`, `lib/keybindings.ts:150`, `lib/macros.ts:41`, `lib/compose-draft-store.ts:75,272`, `hooks/use-sidebar-sections.ts:17-20`, `components/sidebar/*`, `lib/quake-terminal.ts`, `lib/shell-notifications.ts`, `components/data-table.tsx`, etc., plus `runkit:board-autofit:` / `runkit:board-widths:`.

- **Rename every live key constant** `runkit-…` → `hexokit-…` and `runkit:…` → `hexokit:…`.
- **One-shot copy at boot.** Add a `migrateLegacyStorageKeys()` module that runs before the React tree mounts (in `main.tsx`):
  - For every `localStorage` key starting with `runkit-` or `runkit:`, if the `hexokit` counterpart is absent, copy the value. Leave the old key in place (D9, one release).
  - Guard the pass with a marker key (e.g. `hexokit-storage-migrated`), so it runs **once per origin**. Many prefs delete their key to mean "default", and without the marker a re-run would resurrect the old value.
  - Wrap it in try/catch (private mode, blocked storage), following the existing per-feature wrappers.
- **Retired-key translators** keep reading their legacy names directly, e.g. `runkit-window-view:{s}:{w}` (`lib/window-view.ts:136`), `runkit-window-panel:…` (`lib/right-panel.ts:59`), `runkit-code-folder:…` (`app.tsx:1288`), `runkit-panel-sessions` → per-server, `runkit-operator-console-*` → quake. Apply decides whether the generic copy excludes these or harmlessly includes them. They must keep working either way.
- **`index.html:16,31` pre-paint script** reads `runkit-theme` and `runkit-instance-color` before first paint, before `main.tsx` runs. It reads `hexokit-…` first and falls back to `runkit-…`, so the first load after upgrade does not flash the wrong theme.
- **`rk-*` keys are substrate (D2) and are NOT renamed**: `rk-gui-*`, `rk-web-capture`, `rk-layout-zoom:`/`rk-layout-sizes:`/`rk-layout-popped:`. The same goes for `rk:` DOM events, the `rk-popout` BroadcastChannel, and `rk-*` CSS classes. The palette labels `run-kit: Version`, `run-kit: Update Now`, etc. are brand text, not storage, and are out of scope for this change.
- Update the UI constant `components/settings-all-panel.tsx:35` `CONFIG_YAML_PATH` to `~/.config/hexokit/config.yaml`.

### 8. Tests, including the pickup e2e

- **Go unit tests.** Cover the resolution rule (fresh, legacy-only, new-exists, both-exist), `Migrate()` (copy set, temp + rename, race loser, failure leaves legacy authoritative, legacy untouched), the pin (existing `port:` kept, append path, comment round-trip through parse/serialize/ApplyValue, fresh install unpinned, `RK_PORT` ignored), the virtual pin in `config.Load`, the doctor row table (fires / dormant / `RK_PORT` override), and the cb dual-read. Update the ~13 existing tests that assert `run-kit` path segments: `settings_test.go`, `managedconf_test.go`, `tmux_test.go`, `cron/dir_test.go`, `snapshot/store_test.go`, `prstatus_disk_test.go`, `gui/state_test.go`, `codebridge/state_test.go`, `codeworkspace_test.go`, `api/codeworkspace_test.go`, `api/codebridge_test.go`, `gui_supervise_test.go`, `daemon/gui_test.go`.
- **Dir pickup e2e (black box).** Build the real binary with a release version ldflag (`mcp_e2e_test.go` pattern). Seed a temp `HOME` + `XDG_STATE_HOME` with a legacy `~/.config/run-kit/config.yaml` (e.g. a theme and a `riff_presets` entry, no `port:`), a `tmux.d/user.conf`, a cron entry, and a snapshot. Trigger the migration the production way. Assert:
  - the new homes exist with that content;
  - `config.yaml` carries the pin comment + `port: 3000`;
  - CLI verbs (e.g. `rk cron list --json`, `rk snapshot list`, `rk ports`) read the migrated data;
  - the legacy dirs are byte-unchanged.

  Also assert that a legacy-only home, before migration, is still read by the CLI (the dual-read). Apply picks the cheapest faithful trigger. Booting `serve` against an isolated tmux socket is the faithful one; if that is too heavy, use `rk daemon start` or a direct `Migrate()` call.
- **Storage pickup e2e (Playwright).** A spec under `app/frontend/tests/e2e/` that seeds `runkit-*` keys via `page.addInitScript` before first load: theme, `runkit-sidebar-width`, `runkit-keybindings` or `runkit-macros`, and one dynamic key such as `runkit-last-window:<server>`. Then it loads the app and asserts:
  - the seeded prefs are applied (theme class, sidebar width);
  - the `hexokit-*` keys now exist with the same values;
  - the `runkit-*` originals are still present;
  - a second load after deleting a `hexokit-*` key does NOT resurrect it (the marker).

  Constitution: add a JSDoc **Proves:/Steps:** block per test and a file header. Per memory, the frontend unit gate is the full `just test-frontend`, and any `page.route` stub must use a regex.
- `app/frontend/tests/e2e/_settings.ts:13-17` falls back to `join(homedir(), ".config", "run-kit")`. Update it to the new home.

### 9. Tunnel range: left at 3100–3199 (the "only if trivial" test fails)

A one-shot reassignment of persisted `remotes.yaml` `local_port`s to 21500–21599 is **not trivial**:

- `Remote.LocalPort` is documented immutable (`internal/remote/store.go:49-54`) because the origin `http://127.0.0.1:<port>` keys per-origin browser state and the desktop shell's persistent view identity. Moving it resets every remote's localStorage (including the keys §7 is migrating) and orphans desktop host entries.
- A live tunnel window (`ssh -L <old>:…` in the `rk-remotes` session) would be orphaned on the old port.
- `remote.Load`'s `validateEntries` rejects any entry outside `PortRangeStart..End`. Flipping the constants without a coordinated rewrite makes every existing `remotes.yaml` fail to load.

So `PORTPOLICY_TUNNEL_START/END` stay at 3100/3199. Record the deferral in two places:

- A comment in `internal/portpolicy/ports.env` stating the rule P target (21500–21599) and why it is deferred: stable per-origin state, desktop host identity, live tunnels, and the read-path range check.
- The plan doc's C4 row, plus a follow-up note. A possible later shape is new remotes assigned from 21500+ while existing entries are grandfathered, with the read-path check accepting both blocks. It is not decided here.

### 10. Paths in prose, help, and docs (present-truth lines only; D11)

- **Go help/prose strings** naming `~/.config/run-kit` / `$XDG_STATE_HOME/run-kit`: `internal/tmux/tmux.go:412`, `internal/daemon/daemon.go:205`, `internal/mcp/policy.go:222,456`, `cmd/rk/serve.go:190`, `riff.go:96`, `initconf.go:24`, `doctor.go:329,346,520`, `snapshot.go:60`, `cron.go:47`, `gui_launch.go:74`, `gui_supervise.go:258,260`, `desktop.go:158`, and package doc comments (e.g. `settings.go:1-21,39`). Point them at `hexokit`.
- **Shipped skill text** `docs/site/skill/cron.md`, `docs/site/skill/gui.md`: update the paths.
- **Constitution** `fab/project/constitution.md` §II (`$XDG_STATE_HOME/run-kit/` carve-outs) and §IV (`~/.config/run-kit/config.yaml`): change the paths to hexokit. This is a PATCH amendment, 1.15.0 → 1.15.1 (path wording, no principle change); update the Last Amended date.
- **`fab/project/context.md`**: the Backend "Config" line names `~/.config/run-kit/config.yaml`.
- **`docs/specs/`**: `docs/specs/cron.md` and `docs/specs/right-panel.md` state these paths; others may too. Update present-truth path lines only.
- **Substrate stays** (D2): `rk`, `RK_*` (including `RK_CONFIG_DIR`, `RK_TMUX_CONF`), `@rk_*`, `rk-*` sockets/sessions, `~/.rk/`, `os.UserCacheDir()/rk/daemon.log`.

### 11. Plan-doc bookkeeping (`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`)

- **R0 row**: Status → `**merged** 2026-09-26 (\`3d7afba1\`) — …` with the PR column already linking [run-kit#950](https://github.com/sahil87/run-kit/pull/950). Keep the one-line summary of what shipped: `hexokit` command + `xk`/`rk`/`run-kit` completions, Electron productName/artifactName, Linux AppImage arm, `appId` kept.
- **Status line** (top, dated 2026-09-26): Phase 3 in progress, R0 merged, C4 in progress on this change (PR link once shipped), C5 next.
- **C4 row**: Status → in progress / PR link (ship adds it). Note the tunnel-range deferral and the dormant-until-C5 doctor nudge.
- **Restore the deleted rules table.** Put `## Rules that bind every row here (from the master decision log)` back, verbatim from `git show 0f615740:fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`, between the Status line and `## Open rows`: rows D2 (already carries D16's `rk` + `xk`), D8, D9, D11, D14, D15, P (already carries D17), plus the "Roster coupling" paragraph. The pickup protocol ("The rules table above is Certain") depends on it.
- **Risks section**: amend "Silent state loss (C4)" with what shipped (copy + atomic publish at daemon start, dual-read, pickup e2e).

## Affected Memory

- `run-kit/configuration`: (modify) config home `~/.config/hexokit/` + resolution rule + one-release legacy dual-read; migration at daemon start (copy + atomic rename, dev builds skip); port pin (legacy-default constant, comment round-trip, virtual pin for unmigrated installs); localStorage key prefix `hexokit-` + one-shot copy
- `run-kit/daemon-lifecycle`: (modify) serve / `rk daemon start|restart` run the home migration before resolving the port
- `run-kit/cron`: (modify) cron state under `$XDG_STATE_HOME/hexokit/cron/`; entries migrate
- `run-kit/layout-snapshots`: (modify) snapshot root under `…/hexokit/snapshots/`; snapshots migrate
- `run-kit/code-bridge`: (modify) `cb/` resolution rule on both sides + Go-side legacy dual-read for old VSIXes
- `run-kit/tmux-sessions`: (modify) managed tmux.conf / `tmux.d/` under the new config home; header + drop-in glob text
- `run-kit/remote-hosts`: (modify) tunnel range kept at 3100–3199; rule P target 21500–21599 deferred, and why
- `run-kit/architecture/backend-packages`: (modify) the new home-resolver/migration package(s)
- `run-kit/gui`: (modify) GUI state root path
- `run-kit/ui/*` and other files naming `runkit-*` keys or `run-kit` home paths: (modify) present-truth path/key lines only (D11). Hydrate sweeps them, e.g. `ui/sidebar`, `ui/quake-terminal`, `ui/keyboard-and-palette`, `ui/compose-and-bottom-bar`, `ui/boards`, `ui/data-table`, `architecture/pr-status`, `architecture/testing`, `test-sockets`

## Impact

- **Go backend**: new home package(s); `internal/settings`, `internal/config`, `internal/tmux` (+ `managedconf.go`), `internal/cron`, `internal/snapshot`, `internal/prstatus`, `internal/gui`, `internal/codeworkspace`, `internal/codebridge`, `internal/transcript`, `internal/portpolicy` (`ports.env` + `DaemonLegacy`); `cmd/rk/serve.go`, `daemon_start.go`, `daemon_restart.go`, `doctor.go`, and the help strings listed in §10.
- **Embedded tmux template**: `configs/tmux/default.conf`, which is copied to `app/backend/build/tmux.conf` for the embed. Fresh worktrees need `just _ensure-tmux-conf` before `go test`.
- **Code-bridge extension**: `app/code-bridge/src/extension.ts` `stateDir()`.
- **Frontend**: ~30 files with `runkit-` key constants, a new storage-migration module + `main.tsx` call, `index.html` pre-paint script, `settings-all-panel.tsx`; tests `_settings.ts`, `code-surface.spec.ts`, a new pickup spec, and Vitest files asserting key names.
- **Docs**: constitution (1.15.1), `context.md`, `docs/specs/*` path lines, `docs/site/skill/{cron,gui}.md`, the plan doc.
- **Not touched**: `remotes.yaml` location (`~/.config/rk/remotes.yaml`) and port range, `~/.rk/*`, `rk` cache dir, desktop userData (R0 already carried it forward), fab-owned `$XDG_STATE_HOME/fab/`, palette brand labels.
- **Gates**: `env -u TMUX -u TMUX_PANE go test ./...` (per memory), `just test-frontend` (full Vitest), `npx tsc --noEmit`, the new e2e spec + `code-surface.spec` via `just test-e2e <name>.spec`, `just build`.

## Open Questions

- Does `ClassifyManagedConf` treat the migrated (now stale) managed `tmux.conf` as managed-stale, so it is rewritten, or as hand-edited, so it is left and flagged? Apply must check. If it would read as hand-edited, the migration must teach the classifier the legacy header/drop-in text as a known prior managed version.
- Can the Go pickup e2e trigger migration through `serve` cheaply, with an isolated tmux socket and a random `RK_PORT`, or does it need `rk daemon start` or a direct `Migrate()` call? Apply picks the cheapest faithful one.
- `remotes.yaml` lives at `~/.config/rk/remotes.yaml`, outside both homes. The `config-home` standard would put it under `~/.config/hexokit/`. It is out of scope here and noted as a follow-up in the plan doc.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Old homes are copied, never moved or deleted; the legacy dir stays untouched for one release | D9 verbatim ("old left in place for one release"); desktop carry-forward precedent (copy keeps downgrade working) | S:95 R:85 A:95 D:95 |
| 2 | Certain | `rk`/`RK_*`/`@rk_*`/`rk-*` identifiers — incl. `rk-*` localStorage keys, `RK_CONFIG_DIR`, `~/.rk/`, the `rk` cache dir — are not renamed | D2 substrate rule; user restated it | S:95 R:80 A:95 D:95 |
| 3 | Certain | Tunnel range stays 3100–3199; deferral recorded in ports.env + plan doc | User's "only if trivial" test fails: LocalPort is immutable by design (per-origin browser state, desktop view identity), live tunnels would orphan, Load's range check rejects every existing entry | S:90 R:85 A:90 D:90 |
| 4 | Confident | One resolver: new dir if it exists, else legacy if it exists, else new; migration publishes via atomic rename so no marker file is needed | Implements "dual-read one release" with one rule; nothing creates the new dir pre-migration because every writer resolves through the rule | S:70 R:70 A:80 D:70 |
| 5 | Confident | Migration runs at daemon start (serve, `rk daemon start/restart`), not on the first CLI invocation | The old daemon keeps writing to legacy dirs after `brew upgrade` until restart; CLI-triggered migration (e.g. an agent hook) would split state and the new daemon would boot on a stale copy | S:60 R:70 A:75 D:60 |
| 6 | Confident | Dev builds (`version == "dev"`) skip the automatic migration | Dev rigs share the developer's real legacy home with the live brew daemon; migrating from a rig would freeze a stale copy for the real upgrade. reserved.go dev-build gate precedent | S:55 R:80 A:75 D:70 |
| 7 | Confident | Pin value = config.yaml's existing `port` if set, else the legacy default 3000 (new `PORTPOLICY_DAEMON_LEGACY` constant); RK_PORT is not captured | Refines "current effective port": RK_PORT keeps winning on its own, and capturing a transient dev/test RK_PORT would pin a bogus port permanently; pinning from DaemonDefault breaks once C5 flips it in the same release | S:65 R:75 A:75 D:60 |
| 8 | Confident | Pin written only for existing installs (legacy config OR state dir exists), appended to the copied bytes (no re-serialize) | Rule P: fresh installs take the new default; appending preserves the user's own comments/order | S:75 R:80 A:80 D:75 |
| 9 | Confident | Pin comment round-trips: parse flags the exact marker line, serialize re-emits it before `port:`, any registry write to port clears it | serialize rewrites the whole file and parse drops comments — without this the comment dies on the first UI settings save | S:60 R:85 A:80 D:65 |
| 10 | Confident | Unmigrated legacy installs get a virtual pin: config.Load defaults to DaemonLegacy while the legacy config home is active | Keeps `rk url`/`ports`/doctor/`daemon start -e RK_PORT` consistent with the still-running old daemon once C5 moves the default | S:55 R:80 A:70 D:65 |
| 11 | Confident | Doctor nudge row fires when pinned port == DaemonLegacy ≠ DaemonDefault and RK_PORT isn't overriding — dormant until C5 flips the default | User: "this change only lands the pin+nudge plumbing"; R0+C4+C5 share one release so the dormancy is invisible; table tests cover the firing branch | S:70 R:85 A:75 D:65 |
| 12 | Confident | State migration copies only `cron/` and `snapshots/`; prstatus.json, gui/, code/, cb/, opencode-export/ cold-start | User: "cron entries + snapshots MUST move; droppable caches may cold-start"; inventory classifies the rest as caches/rendezvous | S:85 R:80 A:80 D:80 |
| 13 | Confident | Code-bridge `cb/`: extension adopts the same resolution rule; Go discovery also reads legacy `run-kit/cb` for one release | Two-process contract; the VSIX updates only on `rk code-server install/update`, so an old extension would otherwise break the bridge after migration | S:55 R:80 A:70 D:65 |
| 14 | Confident | localStorage: rename every `runkit-`/`runkit:` constant to `hexokit`; one-shot marker-guarded boot copy (old keys kept); index.html pre-paint reads hexokit then runkit | D9 read-old/write-new; the marker prevents resurrecting values the app deletes to mean "default"; pre-paint avoids a theme flash | S:75 R:80 A:80 D:70 |
| 15 | Confident | Pickup e2e = two tests: a Go black-box test (release-ldflag binary, temp HOME/XDG_STATE_HOME) for dirs + a Playwright spec for localStorage | Dir migration is backend-only and dev rigs skip it; localStorage pickup is browser-only — one spec cannot faithfully cover both | S:60 R:85 A:75 D:65 |
| 16 | Confident | Constitution §II/§IV path wording → hexokit as a PATCH amendment (1.15.0 → 1.15.1) | Path text only, no principle change; keeps the constitution present-true | S:70 R:90 A:80 D:80 |
| 17 | Confident | `remotes.yaml` location (`~/.config/rk/`) is out of scope — noted as a plan-doc follow-up | Not in D9 or the C4 row; the user didn't ask; moving it is separable | S:60 R:90 A:70 D:70 |
| 18 | Certain | Plan doc: R0 → merged (#950, 3d7afba1), Status line refreshed, C4 row updated, and the rules table deleted by 3f9937e7 restored verbatim from 0f615740 | User asked for R0/Status bookkeeping; the table restoration fixes an accidental deletion the pickup protocol depends on | S:90 R:95 A:90 D:90 |
| 19 | Tentative | New package naming/split (`internal/apphome` resolver + a separate migrate package to avoid a settings import cycle) | Shape follows import graph (settings imports the resolver; migration needs settings.parse); exact names are apply's call <!-- assumed: package names/split — import-cycle driven, apply may choose different names --> | S:45 R:90 A:60 D:40 |

19 assumptions (4 certain, 14 confident, 1 tentative, 0 unresolved).
