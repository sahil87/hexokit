# Plan: HexoKit Home Migration

**Change**: 260926-qm4d-hexokit-home-migration
**Intake**: `intake.md`

## Requirements

### Homes: Resolution

#### R1: One resolver owns both homes
A single new package (working name `internal/apphome`) SHALL own the on-disk home names and resolution. It exposes `Name = "hexokit"`, `LegacyName = "run-kit"`, `ConfigDir()` (`$HOME/.config/<resolved>`, never `$XDG_CONFIG_HOME`) and `StateDir()` (`${XDG_STATE_HOME:-$HOME/.local/state}/<resolved>`). Every existing resolver MUST go through it, replacing its inline `filepath.Join(…, "run-kit", …)`. That covers `settings.Dir()`, `tmux.DefaultConfigPath`, `cron.DefaultDir`, `snapshot.DefaultDir`, `prstatus.DefaultCachePath`, `gui.StateDir`, `codeworkspace.StateDir`, `codebridge.StateDir`, and the transcript opencode-export dir. Leaf names are unchanged. `settings.Dir()` keeps its `RK_CONFIG_DIR` override, and that override wins over the rule.

- **GIVEN** a home where neither `~/.config/hexokit` nor `~/.config/run-kit` exists (a fresh install)
- **WHEN** any resolver runs
- **THEN** it returns the path under `hexokit`

#### R2: Dual-read resolution rule
For each home independently: if the new dir exists, use it. Otherwise, if the legacy dir exists, use the legacy dir. Otherwise use the new dir. Nothing may create the new dir while the legacy dir is the active one, except the migration's atomic publish (R3).

- **GIVEN** only `~/.config/run-kit/config.yaml` exists
- **WHEN** `settings.Load()` runs (CLI or daemon, before migration)
- **THEN** it reads `~/.config/run-kit/config.yaml`
- **AND** a `settings.Save()` writes back to `~/.config/run-kit/config.yaml`, not to a new `hexokit` dir

- **GIVEN** both `$XDG_STATE_HOME/hexokit` and `$XDG_STATE_HOME/run-kit` exist
- **WHEN** `cron.DefaultDir()` runs
- **THEN** it returns `$XDG_STATE_HOME/hexokit/cron`

### Homes: Migration

#### R3: Copy then atomic publish, at serve start
A `Migrate()` entry point (in a package that may import `settings` and `portpolicy` without an import cycle) SHALL, for each home where the legacy dir exists and the new one does not:

1. copy the migrated set into a temp sibling dir (`.hexokit-migrate-*` next to the target);
2. apply the port pin (R5) to the temp copy's `config.yaml` (config home only);
3. `os.Rename` the temp dir onto the new dir.

If the rename fails because the target now exists, the temp copy MUST be removed and the existing target wins. Every failure is best-effort and non-fatal: log, remove the temp dir, and leave the legacy home active per R2. The legacy dir MUST be left byte-unchanged. `Migrate()` SHALL be called at the top of `serve`'s RunE, before `config.Load()` and `tmux.EnsureConfig()`. It MUST NOT run from generic CLI invocations.

- **GIVEN** a legacy install with `~/.config/run-kit/{config.yaml,tmux.conf,tmux.d/user.conf}` and `$XDG_STATE_HOME/run-kit/{cron/a.yaml,snapshots/s.json,prstatus.json,gui/…}`
- **WHEN** a release-build `serve` starts
- **THEN** `~/.config/hexokit/` holds the full config tree, and `$XDG_STATE_HOME/hexokit/` holds `cron/` and `snapshots/` only
- **AND** the legacy trees are unchanged

- **GIVEN** two processes race to migrate
- **WHEN** both finish copying
- **THEN** exactly one rename publishes, and the loser's temp dir is removed

#### R4: What migrates
The config home copies its whole tree. **Symlinks are always carried over as symlinks, never dropped and never dereferenced into copies.** A link whose target resolves inside the legacy tree keeps its relative/verbatim target, so it points into the new copy. A link whose target resolves outside the tree (a dotfiles-managed `config.yaml` or `tmux.d/*.conf`) is recreated pointing at the same absolute target, with a relative target rewritten to its absolute resolution. Dropping such a link would silently lose the user's config (the regression D9 exists to prevent). Recreating a link the user already had grants nothing new. When the staged `config.yaml` is a symlink, the pin (R5) is appended through the link into its target. That target is the user's one config file shared by both homes, and the old binary reads `port: 3000` as its own default. The state home copies `cron/` and `snapshots/` (recursive, preserving file modes). `prstatus.json`, `gui/`, `code/`, `cb/` and `opencode-export/` are NOT copied and cold-start.

- **GIVEN** `~/.config/run-kit/config.yaml -> ~/dotfiles/rk.yaml` and `tmux.d/user.conf -> ../../dotfiles/tmux.conf` (both outside the tree)
- **WHEN** migration publishes
- **THEN** `~/.config/hexokit/config.yaml` and `tmux.d/user.conf` are symlinks resolving to the same dotfiles files, and `settings.Load()` reads the dotfile content (plus the pin)

- **GIVEN** a legacy state dir with `prstatus.json` and `gui/icewm/`
- **WHEN** migration publishes
- **THEN** neither exists under `$XDG_STATE_HOME/hexokit/`

#### R4a: User-editable seeded GUI files migrate
The state copy set SHALL also include `gui/icewm/preferences` when present. It is write-once seeded, and the user's edits persist per `docs/site/skill/gui.md`, so it is user data, not a cache. The same applies to any other write-once seeded WM config the GUI seeder never overwrites (apply checks `internal/gui/seed*.go`, e.g. the LXQt `etc` defaults, and includes only write-once files). Sockets and CDP profiles still cold-start.

- **GIVEN** a legacy `gui/icewm/preferences` the user edited
- **WHEN** state migration publishes
- **THEN** `$XDG_STATE_HOME/hexokit/gui/icewm/preferences` is byte-identical, and nothing else under `gui/` is copied beyond the write-once seeded files

#### R6: Dev builds skip the automatic migration
When `version == "dev"` (just dev/air, e2e rigs), serve SHALL NOT call `Migrate()`. The home keeps resolving per R2, the same as today.

- **GIVEN** a dev-build serve over a legacy-only home
- **WHEN** it starts
- **THEN** no `hexokit` dir is created, and the daemon uses the legacy home

### Ports: Pin (rule P, D17)

#### R5: Pin existing installs at the legacy port
A new policy constant `PORTPOLICY_DAEMON_LEGACY=3000` (in `internal/portpolicy/ports.env`, exposed as `portpolicy.DaemonLegacy`) SHALL name the pre-rename default. During config-home migration of an **existing install** (the legacy config dir OR the legacy state dir exists):

- If the legacy `config.yaml` parses with `Port != 0`, it is left as is.
- Otherwise the migration SHALL append the pin-comment line (a named constant, one line) plus `port: <DaemonLegacy>` to the copied file bytes. There is no re-serialize, so user comments and ordering survive. A missing legacy `config.yaml` means the pin is written as the file's only content.

The pin value MUST NOT come from `RK_PORT` or `portpolicy.DaemonDefault`. A fresh install gets no pin. When only the legacy state dir exists, the config-home step creates `~/.config/hexokit/config.yaml` holding just the pin, through the same temp + rename publish.

- **GIVEN** legacy `config.yaml` = `theme: "dark"\nriff_presets:\n  foo: /bar\n`, no port, and `RK_PORT=21001` in the environment
- **WHEN** migration runs
- **THEN** `~/.config/hexokit/config.yaml` = the original bytes (newline-terminated) + `# <pin comment>\nport: 3000\n`
- **AND** `settings.Load()` on it yields `Port == 3000`, `Theme == "dark"`, and the `foo` riff preset

- **GIVEN** legacy `config.yaml` with `port: 4100`
- **WHEN** migration runs
- **THEN** the copy is byte-identical and carries no pin comment

#### R7: Pin comment round-trips through settings saves
`parse` SHALL recognize the exact pin-comment line and set `Settings.PortPinNote = true`. The `port` serializer SHALL emit the pin-comment line immediately before `port: N` when `PortPinNote && Port != 0`. Any registry write to `port` (`ApplyValue("port", …)`, set or null) SHALL clear `PortPinNote`.

- **GIVEN** a migrated config.yaml with the pin comment
- **WHEN** a UI settings save of `theme` runs (`Load` → mutate → `Save`)
- **THEN** the saved file still contains the pin comment directly above `port: 3000`

- **GIVEN** the same file
- **WHEN** `port` is set to 6123 via the registry
- **THEN** the saved file has `port: 6123` and no pin comment

#### R8: Virtual pin for unmigrated installs
`config.Load` SHALL use `portpolicy.DaemonLegacy` as the code-default rung for an **unmigrated existing install**: the new config dir is absent AND (the legacy config dir OR the legacy state dir exists). That is the same existing-install test the migration uses to decide the pin (R5), so the virtual pin and the real pin can never disagree. That applies when `config.yaml` sets no port; `RK_PORT` still wins. Fresh and migrated installs keep `portpolicy.DaemonDefault`. The resolver package exposes a predicate for this (`apphome.UnmigratedExistingInstall()`).

- **GIVEN** a legacy-only home with no `port:` and a hypothetical `DaemonDefault = 6123`
- **WHEN** `config.Load()` runs (e.g. inside `rk daemon restart`'s `startSession`)
- **THEN** `cfg.Port == 3000`

- **GIVEN** a state-only legacy install (only `$XDG_STATE_HOME/run-kit` exists) and `DaemonDefault = 6123`
- **WHEN** `config.Load()` runs before migration
- **THEN** `cfg.Port == 3000`, matching the pin the migration will write

#### R9: Doctor nudge row (dormant until C5)
`rk doctor` SHALL add a conditional advisory row. It is OK with a `Note`, never flips the verdict, and follows the `removedEnvCheck` `(doctorCheck, bool)` shape. It is named `port pin`, placed after `ports`, and emitted only when all three hold:

1. config.yaml's `port == portpolicy.DaemonLegacy`;
2. `portpolicy.DaemonDefault != portpolicy.DaemonLegacy`;
3. `RK_PORT` is not set to a valid port.

The note names the pinned port, the new default, and the move recipe: set `port: <DaemonDefault>` in `~/.config/hexokit/config.yaml`, `rk daemon restart`, then re-point Tailscale Serve, bookmarks/phone shortcuts, and MCP clients at `…/mcp`. The check function MUST be pure over its inputs (pinned port, default, legacy, env) for table tests.

- **GIVEN** pinned 3000, default 3000 (today)
- **WHEN** doctor runs
- **THEN** no `port pin` row is emitted

- **GIVEN** pinned 3000, default 6123, RK_PORT unset
- **WHEN** the check is evaluated
- **THEN** an OK row with the nudge note is returned

### tmux: Managed conf follows the config home

#### R10: Drop-in path, header, and legacy-header recognition
`configs/tmux/default.conf` SHALL source the drop-ins from the **resolved** config home, mirroring the apphome rule (R2) at tmux config-load time, through one `if-shell` (no `-b`, so it runs in order):

```
if-shell '[ -d "$HOME/.config/hexokit" ] || [ ! -d "$HOME/.config/run-kit" ]' 'source-file -q ~/.config/hexokit/tmux.d/*.conf' 'source-file -q ~/.config/run-kit/tmux.d/*.conf'
```

The exact quoting is verified at apply against the floor tmux version. Exactly one tmux.d dir is ever sourced, so there is no double-sourcing after migration, when both dirs exist. A new-embed managed conf written to the LEGACY path before migration (a dev/e2e rig's `EnsureConfig`, a manual `rk mux init-conf --force`) therefore still sources the legacy `tmux.d/`. That closes the pre-migration override-loss window. Its comments at lines 3 and 108 name `~/.config/hexokit/tmux.d/`, with the one-release legacy fallback mentioned once. `managedHeaderSuffix` SHALL name `~/.config/hexokit/tmux.d/`. `ClassifyManagedConf` MUST also accept the prior suffix (`" — DO NOT EDIT; overrides go in ~/.config/run-kit/tmux.d/"`, kept as a named legacy constant) with a verifying stamp as `ConfManagedStale`, never `ConfHandEdited`. A migrated managed tmux.conf is then force-refreshed by `EnsureConfig`, and `RefreshSweep` reloads live servers.

- **GIVEN** a migrated `~/.config/hexokit/tmux.conf` written by the previous release (legacy suffix, valid stamp, old body)
- **WHEN** `tmux.EnsureConfig()` runs
- **THEN** it classifies ConfManagedStale, rewrites the file with the new header + embed, and reports refreshed=true

- **GIVEN** an unmigrated install (only `~/.config/run-kit/` exists, with `tmux.d/user.conf` setting a marker option) whose legacy `tmux.conf` has been rewritten with the NEW embed
- **WHEN** a tmux server loads that conf
- **THEN** `user.conf` is sourced (the marker option is set)
- **AND** after `~/.config/hexokit/tmux.d/` exists, only the hexokit drop-ins are sourced

- **GIVEN** a legacy-suffix header whose stamp does not verify
- **WHEN** classified
- **THEN** it is ConfHandEdited (unchanged behavior)

### Code bridge: two-process contract

#### R11: Extension and Go agree on `cb/`, with a legacy read window
`app/code-bridge/src/extension.ts` `stateDir()` SHALL apply the R2 rule: `<state>/hexokit/cb` if `<state>/hexokit` exists, else `<state>/run-kit/cb` if `<state>/run-kit` exists, else `<state>/hexokit/cb`. Go-side host and boot discovery (`internal/codebridge`) SHALL, when the resolved state dir is the new one, also read `<state>/run-kit/cb/{hosts,boots}` for one release. Records under the resolved dir win on a hostId collision. Sockets are addressed by the host record's own path or dir, so a legacy-dir host stays reachable.

- **GIVEN** a migrated state home and an old VSIX still writing `<state>/run-kit/cb/hosts/h1.json`
- **WHEN** Go lists bridge hosts
- **THEN** h1 is found

### Frontend: localStorage

#### R12: Keys renamed with a one-shot, marker-guarded copy
Every live `runkit-…`/`runkit:…` localStorage key constant in `app/frontend/src` SHALL become `hexokit-…`/`hexokit:…`. A new module (e.g. `src/lib/legacy-storage-migration.ts`), invoked from `main.tsx` before the React tree mounts, SHALL:

- unless the marker key `hexokit-storage-migrated` is present, copy every `runkit-*`/`runkit:*` key's value to its `hexokit` counterpart when that counterpart is absent;
- then set the marker;
- never delete the legacy keys, and swallow storage errors.

Retired-key translators (`runkit-window-view:`, `runkit-window-panel:`, `runkit-code-folder:`, `runkit-panel-sessions`, `runkit-operator-console-*`) MUST keep working. Either exclude them from the copy and leave their readers on the legacy names, or copy them and point the translators at the hexokit names; pick one consistently. `rk-*` keys are NOT renamed (D2).

- **GIVEN** `runkit-theme=dark` and no hexokit keys
- **WHEN** the app boots
- **THEN** `hexokit-theme=dark`, the dark theme applies, and `runkit-theme` is still present

- **GIVEN** a migrated origin (marker set) where the app has deleted `hexokit-sidebar-width` to mean "default"
- **WHEN** the app boots again
- **THEN** `hexokit-sidebar-width` is not recreated from `runkit-sidebar-width`

#### R13: Pre-paint theme reads the new key first
`app/frontend/index.html`'s pre-paint script SHALL read `hexokit-theme` / `hexokit-instance-color`, falling back to `runkit-theme` / `runkit-instance-color` when the new key is absent.

- **GIVEN** first load after upgrade with only `runkit-theme=light`
- **WHEN** index.html's inline script runs
- **THEN** the light theme applies before first paint

### Ports: Tunnel range

#### R14: Tunnel range deferred, recorded
`PORTPOLICY_TUNNEL_START/END` SHALL stay 3100/3199. `internal/portpolicy/ports.env` SHALL carry a comment stating that the rule P target is 21500–21599 and why a one-shot reassignment is deferred. The reasons: `local_port` is immutable by design (per-origin browser state and desktop view identity), live `ssh -L` tunnels would orphan, and `remote.Load` rejects out-of-range entries. The `remotes.yaml` store is not touched.

- **GIVEN** the change is applied
- **WHEN** `rk ports` runs
- **THEN** the tunnel block still reads 3100–3199

### Docs: present-truth paths

#### R15: Paths in help, skill text, constitution, context, specs
Present-truth mentions of `~/.config/run-kit` / `$XDG_STATE_HOME/run-kit` / `~/.local/state/run-kit` SHALL name `hexokit`. That covers Go help/prose strings and doc comments, `docs/site/skill/{cron,gui}.md`, `components/settings-all-panel.tsx` `CONFIG_YAML_PATH`, `fab/project/context.md`, and `docs/specs/*` present-tense lines. Constitution §II/§IV path text SHALL update as a PATCH amendment, 1.15.0 → 1.15.1, Last Amended 2026-09-26. Historical text (`fab/changes`, plans' history, memory narrative) is not rewritten (D11). Substrate identifiers stay (D2).

- **GIVEN** the change is applied
- **WHEN** `rg -n '\.config/run-kit|state/run-kit|XDG_STATE_HOME/run-kit' app/ configs/ docs/site docs/specs fab/project` runs
- **THEN** the only hits are the deliberate legacy constants/dual-read code, their tests, and legacy fixtures

### Tests

#### R16: Home pickup e2e (dirs)
A Go black-box test SHALL:

- build the real binary with `-ldflags -X main.version=v0.0.0-test` (the `mcp_e2e_test.go` build pattern, including the `build/tmux.conf` seed);
- seed a temp `HOME` + `XDG_STATE_HOME` with a legacy config home (config.yaml with theme + riff preset, no port; managed tmux.conf from the previous header form; `tmux.d/user.conf`) and a legacy state home (a valid cron entry, a snapshot, `prstatus.json`);
- first assert that a CLI verb (e.g. `rk cron list --json`) reads the legacy data pre-migration;
- trigger migration the production way (serve on an isolated tmux socket + free `RK_PORT`, or the cheapest faithful equivalent; document the choice in the test header);
- then assert: the new homes exist with that content; config.yaml carries the pin comment + `port: 3000`; `prstatus.json` was not copied; CLI verbs read the migrated data; the legacy trees are byte-unchanged.

It skips when `go` or `tmux` is absent.

- **GIVEN** the seeded legacy homes
- **WHEN** the test runs
- **THEN** all assertions above hold

#### R17: Storage pickup e2e (Playwright)
A new spec `app/frontend/tests/e2e/legacy-storage-migration.spec.ts` SHALL:

- seed `runkit-*` keys via `page.addInitScript` before the first navigation (at least `runkit-theme`, `runkit-sidebar-width`, `runkit-macros` or `runkit-keybindings`, and one dynamic key);
- assert: the prefs are applied, the `hexokit-*` counterparts hold the same values, and the `runkit-*` originals remain;
- assert that a reload after deleting a `hexokit-*` key does not resurrect it.

The init script must seed only on the first load, e.g. guarded by a sessionStorage flag, so the reload does not re-seed. Each `test()` carries a JSDoc **Proves:/Steps:** block, and the file opens with a header comment (constitution Test Intent Comments).

- **GIVEN** the seeded legacy keys
- **WHEN** the spec runs via `just test-e2e legacy-storage-migration.spec`
- **THEN** it passes

### Plan doc

#### R18: Rebrand plan bookkeeping
`fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` SHALL be updated as follows:

- **R0 row**: marked `**merged** 2026-09-26` (commit `3d7afba1`, PR [run-kit#950](https://github.com/sahil87/run-kit/pull/950)), with a one-line summary of what shipped.
- **Status line**: dated 2026-09-26. Phase 3 in progress: R0 merged, C4 in progress (this change), C5 next.
- **C4 row**: marked in progress, noting the tunnel-range deferral, the dormant-until-C5 doctor nudge, and the `remotes.yaml` location follow-up.
- **Rules table**: restore `## Rules that bind every row here (from the master decision log)` verbatim from `git show 0f615740:fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md`. That is the D2/D8/D9/D11/D14/D15/P table plus the "Roster coupling" paragraph, placed between the Status line and the `---` preceding `## Open rows`.
- **Risks**: the "Silent state loss" bullet names the shipped mitigation.

- **GIVEN** the updated doc
- **WHEN** read
- **THEN** the pickup protocol's "rules table above" exists above `## Open rows`

### Non-Goals

- Moving `~/.config/rk/remotes.yaml` into the config home: separable, noted as a follow-up
- Renaming `~/.rk/*`, `os.UserCacheDir()/rk`, the desktop userData (R0 did it), or fab-owned `$XDG_STATE_HOME/fab/`
- Palette brand labels (`run-kit: Version`, `run-kit: Update Now`)
- Deleting the legacy homes/keys: that is next release's cleanup
- Moving the daemon default to 6123: C5

### Design Decisions

#### Migrate at daemon start, publish atomically
**Decision**: The home migration runs only at release-build `serve` start. It copies the legacy tree into a temp sibling and publishes with one `rename(2)`. Until then every process resolves the legacy home (new-if-exists, else legacy-if-exists, else new).
**Why**: After `brew upgrade` the old daemon keeps writing to the legacy dirs until it restarts. A CLI-triggered migration would split state, and the new daemon would boot on a stale copy. The atomic publish makes "new dir exists" equivalent to "migrated or fresh", so the resolution rule needs no marker file.
**Rejected**: Migrating on the first CLI invocation (state split across the old-daemon window). Moving instead of copying (breaks downgrade and violates D9's "left in place").
*Introduced by*: 260926-qm4d-hexokit-home-migration

#### Pin the legacy default, not RK_PORT
**Decision**: The migration pins `port: 3000` (`portpolicy.DaemonLegacy`) unless config.yaml already sets a port. Unmigrated installs get the same value as a virtual default.
**Why**: `RK_PORT` wins over the pin anyway, and capturing a transient `RK_PORT` (dev rig, test) would pin a bogus port permanently. `DaemonDefault` becomes 6123 in the same release (C5).
**Rejected**: Pinning `cfg.Port` as resolved (captures env). Pinning `DaemonDefault` (wrong after C5).
*Introduced by*: 260926-qm4d-hexokit-home-migration

#### Tunnel range deferred
**Decision**: Keep 3100–3199 and record the 21500–21599 target plus the reasons in `ports.env`.
**Why**: `local_port` keys per-origin browser state and desktop identity, live tunnels bind the old port, and `Load` range-checks entries. Reassignment is not the trivial one-shot the plan allowed for.
**Rejected**: One-shot reassignment in `Load`.
*Introduced by*: 260926-qm4d-hexokit-home-migration

## Tasks

### Phase 1: Setup

- [x] T001 Create the home resolver package `app/backend/internal/apphome/` (`apphome.go` + `apphome_test.go`): `Name`, `LegacyName`, `ConfigDir()`, `StateDir()`, `ConfigIsLegacy()`, plus `LegacyConfigDir()`/`LegacyStateDir()`/`NewConfigDir()`/`NewStateDir()` helpers for the migration. Implement the R2 rule. Table tests cover fresh / legacy-only / new-only / both, and XDG set/unset <!-- R1 --> <!-- R2 -->
- [x] T002 [P] Add `PORTPOLICY_DAEMON_LEGACY=3000` to `app/backend/internal/portpolicy/ports.env` and expose `portpolicy.DaemonLegacy` in `portpolicy.go` (+ test). Add the tunnel-deferral comment above `PORTPOLICY_TUNNEL_START` (21500–21599 target; reasons per R14). Check that `scripts/e2e-env.sh`/`test-e2e.sh`/Playwright parsers tolerate the new key and the comment lines <!-- R5 --> <!-- R14 -->

### Phase 2: Core Implementation

- [x] T003 Route every resolver through `apphome`, and update their tests' expected `run-kit` segments:
  - `internal/settings/settings.go` `Dir()` (keep the `RK_CONFIG_DIR` override and the `~/.rk` legacy fallback);
  - `internal/tmux/tmux.go` `DefaultConfigPath`;
  - `internal/cron/dir.go`, `internal/snapshot/store.go` (`MigrateLegacyDir`'s `<state>/rk` parent math must still work);
  - `internal/prstatus/prstatus_disk.go`, `internal/gui/state.go`, `internal/codeworkspace/codeworkspace.go`, `internal/codebridge/state.go`, `internal/transcript/opencode.go`.
  <!-- R1 --> <!-- R2 -->
- [x] T004 Settings pin-comment round-trip in `internal/settings/settings.go`:
  - a `PortPinComment` constant (one line, e.g. `# port pinned during the HexoKit rename so remote access keeps working (fresh installs use the new default; see rk doctor)`);
  - `Settings.PortPinNote`;
  - `parse` detects the exact line; the port serializer emits it before `port:` when set and `Port != 0`;
  - `ApplyValue("port", …)` clears the flag.

  Tests in `settings_test.go`/`registry_test.go` <!-- R7 -->
- [x] T005 Virtual pin in `internal/config/config.go`: the code-default rung is `portpolicy.DaemonLegacy` when `apphome.ConfigIsLegacy()` and `RK_CONFIG_DIR` is not overriding. Test it with a temp `HOME` and by overriding `DaemonDefault` via a package seam if needed <!-- R8 -->
- [x] T006 Migration package (e.g. `app/backend/internal/apphome/migrate` or `internal/homemigrate`): `Migrate(logger)`.
  - Config home: copy the whole tree.
  - State home: copy `cron/` + `snapshots/` only.
  - Temp sibling + `os.Rename` publish, with race-loser cleanup.
  - Existing-install detection and the pin append (R5), with no re-serialize: ensure a trailing newline, then append `PortPinComment + "\n" + "port: 3000\n"`. When there is no legacy config.yaml but the legacy state dir exists, create the config home with just the pin.
  - Best-effort errors. Legacy trees stay untouched.
  - Skip entirely when `RK_CONFIG_DIR` is set (isolation), mirroring the settings legacy-fallback suppression.

  Unit tests cover every branch in R3/R4/R5, including symlinks/file modes preserved or reasonably handled, and a pre-existing target meaning no-op <!-- R3 --> <!-- R4 --> <!-- R5 -->
- [x] T007 Call `Migrate()` at the top of `cmd/rk/serve.go` RunE, before `config.Load()`, and only when `version != "dev"`. Put the gate in a small helper (e.g. `migrateHomesUnlessDev`) with a unit test <!-- R3 --> <!-- R6 -->
- [x] T008 Managed tmux.conf:
  - `configs/tmux/default.conf`: `tmux.d` glob → `~/.config/hexokit/tmux.d/*.conf`, plus the comments at lines 3 and 108;
  - `internal/tmux/managedconf.go`: `managedHeaderSuffix` → hexokit, and a `legacyManagedHeaderSuffixes` list accepted by `ClassifyManagedConf` (stamp-verified legacy header → `ConfManagedStale`).

  Tests in `managedconf_test.go`/`tmux_test.go`. Refresh `app/backend/build/tmux.conf` via `just _ensure-tmux-conf` <!-- R10 -->
- [x] T009 [P] Code bridge:
  - `app/code-bridge/src/extension.ts` `stateDir()` applies the R2 rule (sync `fs.existsSync` checks);
  - `internal/codebridge` host/boot discovery also reads the legacy `<state>/run-kit/cb` when the resolved dir is new, and resolved-dir records win on a collision.

  Go tests; extension unit test if the package has a test setup <!-- R11 -->
- [x] T010 Doctor `port pin` row in `app/backend/cmd/rk/doctor.go`: a pure `portPinCheck(pinned, def, legacy int, envOverride bool) (doctorCheck, bool)` plus the wiring after the `ports` row. Table tests in `doctor_test.go` cover dormant today, firing, `RK_PORT` override, and unpinned <!-- R9 -->
- [x] T011 Frontend key rename: every live `runkit-`/`runkit:` localStorage key constant in `app/frontend/src/**` → `hexokit-`/`hexokit:` (theme-context, session-context, chrome-context, use-sidebar-sections, sidebar panels, sessions scope, keybindings, macros, compose-draft-store, compose-strip, open-in-app, last-pinned-board, last-window-per-server, instance-accent, shell-notifications, web-engine-pref, web-zoom, quake-terminal, screen-break-store, gui-posture `runkit-gui-wm-strip-dismissed`, data-table, use-board-autofit, use-pane-widths). Update the Vitest files asserting key names <!-- R12 -->
- [x] T012 New `app/frontend/src/lib/legacy-storage-migration.ts` (+ `.test.ts`): a marker-guarded one-shot copy of `runkit-*`/`runkit:*` → `hexokit` counterparts, keeping the legacy keys and swallowing errors. Handle the retired-key translators consistently per R12. Call it from `app/frontend/src/main.tsx` before `createRoot(...).render` <!-- R12 -->
- [x] T013 [P] `app/frontend/index.html` pre-paint script: read `hexokit-theme`/`hexokit-instance-color`, falling back to the `runkit-` keys <!-- R13 -->

### Phase 3: Integration & Edge Cases

- [x] T014 Go black-box pickup e2e `app/backend/cmd/rk/home_migration_e2e_test.go` per R16 (release-version ldflag build, temp `HOME`/`XDG_STATE_HOME`, isolated tmux socket, pre- and post-migration CLI reads, pin assertions, legacy byte-unchanged check). Header comment explains the trigger choice <!-- R16 -->
- [x] T015 Playwright pickup spec `app/frontend/tests/e2e/legacy-storage-migration.spec.ts` per R17, with a file header and JSDoc Proves/Steps per test. Update `app/frontend/tests/e2e/_settings.ts:13-17` (fallback → `~/.config/hexokit`) and `code-surface.spec.ts:668,678,759` (`run-kit/cb` → the resolved state dir; rigs are fresh, so `hexokit`) <!-- R17 --> <!-- R11 -->

### Phase 4: Polish

- [x] T016 Present-truth path strings → hexokit (R15):
  - Go help/prose and doc comments: `internal/tmux/tmux.go:412`, `internal/daemon/daemon.go:205`, `internal/mcp/policy.go:222,456`, `cmd/rk/serve.go:190`, `riff.go:96`, `initconf.go:24`, `doctor.go` (hints/notes), `snapshot.go:60`, `cron.go:47`, `gui_launch.go:74`, `gui_supervise.go:258,260`, `desktop.go:158`, `settings.go` package doc, `fabconfig.go:7`, `validate.go:132`, `prstatus` comments;
  - `app/frontend/src/components/settings-all-panel.tsx:35`;
  - `docs/site/skill/cron.md`, `docs/site/skill/gui.md`.

  Keep help-dump/golden tests green <!-- R15 -->
- [x] T017 [P] Constitution `fab/project/constitution.md` §II/§IV paths → hexokit, version 1.15.0 → 1.15.1, Last Amended 2026-09-26. Update the `fab/project/context.md` Config line. Update present-tense path lines in `docs/specs/*` (at least `cron.md`, `right-panel.md`, `index.md`) <!-- R15 -->
- [x] T018 [P] Plan doc `fab/plans/sahil/26-09-12-hexokit-rebrand-remaining.md` per R18, including restoring the rules table verbatim from `0f615740` <!-- R18 -->
- [x] T019 Gates, fixing anything they surface:
  - `cd app/backend && just _ensure-tmux-conf && env -u TMUX -u TMUX_PANE go test ./...` and `go vet ./...`;
  - `cd app/frontend && pnpm install --frozen-lockfile` (fresh worktree) then `npx tsc --noEmit`;
  - `just test-frontend` (full Vitest);
  - `just test-e2e legacy-storage-migration.spec`, `just test-e2e code-surface.spec`, `just test-e2e operator-compose.spec` (single specs only — no full e2e run);
  - `just build`.
  <!-- R16 --> <!-- R17 -->

### Phase 5: Rework (review cycle 1)

- [x] T020 `app/backend/internal/homemigrate/homemigrate.go` `copyChildren`: never skip symlinks. Recreate contained links verbatim. Recreate escaping links with an absolute target (a relative target is rewritten to its absolute resolution). Document that a symlinked staged `config.yaml` gets the pin appended through the link. Replace the skip-escaping-symlink tests with tests for the R4 dotfiles scenario (absolute + relative escaping links carried over, pin lands in the link target, contained link still relative), and update the plan-assumption row 13 wording <!-- R4 --> <!-- R5 -->
- [x] T021 `app/backend/internal/config/config.go` `daemonDefaultPort`: the virtual pin fires for an unmigrated existing install (new config dir absent AND legacy config OR legacy state dir present), using one shared predicate with `homemigrate.existingInstall` (put it in `apphome`, e.g. `apphome.UnmigratedExistingInstall()`, and have homemigrate reuse it for the pin decision). Add a test for the state-only legacy scenario <!-- R8 -->
- [x] T022 [P] Cleanup: (a) `scripts/test-e2e.sh:105,109` comments name `~/.config/hexokit` / `$XDG_STATE_HOME/hexokit`; (b) `app/backend/internal/codebridge/resolve.go` — `LiveHostsMerged` composes `LiveHosts` per dir instead of duplicating its liveness/prune loop (or `LiveHosts` is unexported/removed if it has no production caller), with tests kept green. Re-run the scoped gates: `env -u TMUX -u TMUX_PANE go test ./internal/apphome/... ./internal/homemigrate/... ./internal/config/... ./internal/codebridge/... ./cmd/rk/...` plus `go vet ./...` <!-- R3 --> <!-- R11 -->

### Phase 6: Rework (review cycle 2)

- [x] T023 `configs/tmux/default.conf`: replace the single hexokit `source-file` line with the R10 `if-shell` dual-source that mirrors the apphome rule; update the comments. Refresh `app/backend/build/tmux.conf` (`just _ensure-tmux-conf`). Add a Go test in `internal/tmux` that starts an ISOLATED tmux server (private `-S` socket, temp `HOME`) against the managed conf and asserts the R10 scenario both ways: legacy-only → the legacy `tmux.d` marker is sourced; after the hexokit `tmux.d` exists → only the hexokit marker is sourced. Skip when tmux is absent. Keep managedconf/tmux tests green <!-- R10 -->
- [x] T024 [P] `app/backend/internal/homemigrate/homemigrate.go`: add `gui/icewm/preferences` (and any other write-once seeded WM files per R4a) to the state copy, with tests. `app/backend/internal/apphome/apphome.go`: remove the now-unused `ConfigIsLegacy()` and its tests (`UnmigratedExistingInstall` is the one predicate). Update the R8 text only if it names `ConfigIsLegacy` <!-- R4a --> <!-- R8 -->
- [x] T025 [P] `app/backend/internal/tmux/managedconf.go` `userConfStarter` title → `# HexoKit tmux overrides` (or equivalent brand wording), with tests adjusted. Re-run the gates: `env -u TMUX -u TMUX_PANE go test ./...`, `go vet ./...`, `just test-e2e legacy-storage-migration.spec` <!-- R10 -->

## Execution Order

- T001 blocks T003, T005, T006, T009
- T002 blocks T005, T006, T010
- T004 blocks T006 (the pin comment constant)
- T006 blocks T007, T014
- T008 blocks T014 (the legacy managed-header fixture)
- T011 blocks T012, T015

## Acceptance

### Functional Completeness

- [x] A-001 R1: Every home resolver listed in R1 resolves through `apphome`; no inline `"run-kit"` path join remains outside `apphome` and its migration code
- [x] A-002 R2: Resolution rule tests cover fresh / legacy-only / new-only / both for both homes, and pre-migration `settings.Save` writes to the legacy file
- [x] A-003 R3: `Migrate()` copies to a temp sibling and publishes by rename; the race loser cleans up; failures are non-fatal and leave the legacy home active; the legacy tree is unchanged
- [x] A-004 R4: The state migration copies exactly `cron/` and `snapshots/`
- [x] A-005 R5: `PORTPOLICY_DAEMON_LEGACY=3000` exists; the pin is appended byte-preservingly only for existing installs without a port; `RK_PORT` and `DaemonDefault` are never the pin source
- [x] A-006 R6: Dev builds never call `Migrate()`
- [x] A-007 R7: The pin comment survives a settings save and is cleared by a registry write to `port`
- [x] A-008 R8: `config.Load` defaults to `DaemonLegacy` for an unmigrated legacy home
- [x] A-009 R9: The `port pin` doctor row is dormant today, fires on pinned==legacy≠default without `RK_PORT`, and is verdict-neutral
- [x] A-010 R10: The embed sources `~/.config/hexokit/tmux.d` (via the R10 if-shell dual-source, legacy dir when unmigrated); a stamp-verified legacy header classifies ConfManagedStale and is refreshed
- [x] A-011 R11: The extension and Go agree on `cb/` resolution; Go reads legacy `run-kit/cb` hosts after migration
- [x] A-012 R12: All live frontend `runkit` keys are renamed; the boot copy is marker-guarded and keeps legacy keys; retired translators still work; `rk-*` keys are untouched
- [x] A-013 R13: index.html pre-paint reads hexokit keys with a runkit fallback
- [x] A-014 R14: The tunnel range is unchanged at 3100–3199, and the deferral comment is present in ports.env
- [x] A-015 R15: Present-truth path text says hexokit; constitution is at 1.15.1
- [x] A-016 R16: The Go pickup e2e exists and passes
- [x] A-017 R17: The Playwright pickup spec exists, passes, and carries intent comments
- [x] A-018 R18: Plan doc R0 is merged/linked, the Status line is updated, C4 is updated, and the rules table is restored verbatim

### Scenario Coverage

- [x] A-019 R5: A test proves an `RK_PORT` set during migration does not change the pinned value
- [x] A-020 R3: A test proves a pre-existing `~/.config/hexokit` makes migration a no-op (no overwrite, no pin)
- [x] A-021 R12: A test proves a key deleted after migration is not resurrected

### Edge Cases & Error Handling

- [x] A-022 R3: A copy failure midway (e.g. an unreadable file) removes the temp dir and leaves no partial `hexokit` dir
- [x] A-023 R5: A legacy config.yaml without a trailing newline still yields a parseable file with the pin on its own line
- [x] A-024 R12: Blocked/throwing localStorage does not break app boot

### Code Quality

- [x] A-025 Pattern consistency: New code follows the existing migration-helper shapes (best-effort, debug/warn logging, seams for tests) and doctor-row conventions
- [x] A-026 No unnecessary duplication: The ~9 inline XDG/home joins collapse into `apphome`; no second copy of the resolution rule in Go
- [x] A-027: Named constants for home names, the pin comment, the legacy port, the marker key, and legacy header suffixes (no magic strings)
- [x] A-028: Tests cover added/changed behavior (code-quality principle)
- [x] A-029: Comments state constraints and "why" only, and cite no change IDs or PR numbers

### Security

- [x] A-030 R4: The migration carries every symlink over as a symlink (never dereferenced into a copy, never dropped), with escaping links retargeted absolutely, and creates dirs with modes no wider than the source (cron/snapshot/cb 0700 modes preserved) <!-- rework: skipping escaping symlinks silently dropped dotfiles-managed config/tmux.d files -->
- [x] A-032 R10: The embed sources exactly one tmux.d dir chosen by the apphome rule at load time; an isolated-tmux test proves both branches
- [x] A-033 R4a: Write-once user-editable GUI seed files migrate; no other gui/ content is copied
- [x] A-031 R8: The virtual pin and the migration's pin decision share one existing-install predicate; a state-only legacy install resolves 3000 before migration

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- `app/backend/internal/codebridge/resolve.go:74` `LiveHosts` — production callers moved to `LiveHostsMerged`; only `client_test.go` still calls it. Could be unexported or folded into the merged reader (which currently re-implements its liveness/prune loop).
- `app/backend/internal/snapshot/store.go:81` `MOVED-to-run-kit` breadcrumb name — keep: an on-disk artifact name written by prior releases; renaming gains nothing and the constant still matches the code.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Migration is called only from serve start (not `rk daemon start/restart`); the R8 virtual pin covers those callers' pre-serve port resolution | `startSession` resolves `config.Load()` before the new serve runs; the virtual pin makes it pass 3000, and serve then migrates and pins 3000 — one call site instead of three | S:65 R:85 A:80 D:70 |
| 2 | Confident | `ClassifyManagedConf` accepts the legacy header suffix as ConfManagedStale | Verified: the classifier requires an exact suffix match, so changing the suffix would otherwise mark every migrated managed conf hand-edited and never refresh it | S:80 R:85 A:90 D:80 |
| 3 | Confident | `Migrate()` is skipped under `RK_CONFIG_DIR` | Mirrors the settings legacy-fallback suppression: an isolated run must never write the real `$HOME` | S:70 R:90 A:85 D:80 |
| 4 | Confident | The Playwright pickup spec seeds via `addInitScript` guarded by a sessionStorage flag | Needed so the no-resurrection reload does not re-seed | S:60 R:90 A:80 D:70 |
| 5 | Tentative | Package names `internal/apphome` + a migrate subpackage; the apply worker may rename to break an import cycle | The import graph decides (settings imports the resolver; migration needs settings.parse) <!-- assumed: package naming left to apply --> | S:45 R:90 A:60 D:40 |
| 6 | Confident | Migration package landed as `internal/homemigrate` (sits above `settings`/`apphome`, no cycle); apphome "exists" = stat succeeds AND IsDir; `ConfigIsLegacy()` returns a bare bool (resolution failure → false) | Apply-time import-graph result (row 5); a regular file at a home path must never claim the name | S:70 R:85 A:80 D:70 |
| 7 | Confident | `tmux.DefaultConfigPath` stays init-time; serve calls `tmux.RefreshDefaultConfigPath()` right after `Migrate()` so the first post-upgrade boot classifies/refreshes the NEW home's tmux.conf (user-owned `tmux_conf`/`RK_TMUX_CONF` never moves) | Converting every consumer to lazy resolution was too broad; a targeted re-resolution after the publish covers R10 without touching CLI/doctor paths that must keep resolving legacy pre-migration | S:60 R:80 A:70 D:60 |
| 8 | Confident | Pin decision parses the STAGED copy's config.yaml via a new exported `settings.ParseBytes` seam; comment match is on the trimmed line | The pin check can never drift from the real parser; whitespace-tolerant match avoids flag/file skew | S:70 R:85 A:75 D:65 |
| 9 | Confident | No new portpolicy seam needed: `DaemonDefault`/`DaemonLegacy` are mutable package vars and `config.Load()` reads them at call time (no init-time capture), so tests flip `DaemonDefault` directly | Smallest change that satisfies R8's post-C5 simulation | S:70 R:85 A:75 D:70 |
| 10 | Confident | Doctor `port pin` row's "pinned" input is `settings.Load().Port` (the config.yaml rung only); a stamp-verified legacy-header tmux.conf whose body already matches the new embed still classifies ConfManagedStale (header itself must be rewritten) | `config.Load().Port` would conflate the RK_PORT rung the check reasons about separately; the stamp covers only the body | S:65 R:85 A:75 D:65 |
| 11 | Confident | localStorage retired-key strategy: the boot copy EXCLUDES `runkit-window-view:`, `runkit-window-panel:`, `runkit-code-folder:`, `runkit-operator-console-`, `runkit-panel-sessions`; their translators keep reading the legacy names (sidebar translator writes the renamed live key `hexokit-panel-sessions-{server}`) | R12 left the choice to apply; these are inbound-only one-release translation inputs whose owners delete the legacy key after translating — a copied counterpart would be dead state | S:65 R:80 A:75 D:65 |
| 12 | Confident | Code-bridge dual-read lives in `internal/codebridge` as merged readers (`ReadRecordsMerged`/`ReadBootMarkersMerged`/`LiveHostsMerged`), resolved dir wins on hostId collision for BOTH hosts and boot markers; extension `stateDir()` extracted to `state-dir.ts` for testability | One Go home for the dual-read rule (A-026); markers are hostId-keyed like hosts, so the symmetric rule; `extension.ts` imports `vscode`, untestable under the plain-node runner | S:65 R:80 A:75 D:65 |
| 13 | Confident | Symlink policy in homemigrate (revised in rework cycle 1): every symlink is recreated as a link, contained links verbatim, escaping links with an absolute target; special files skipped with a debug log | Skipping escaping links silently dropped dotfiles-managed config.yaml / tmux.d files; recreating a link the user already had grants nothing new and never dereferences it | S:75 R:85 A:80 D:75 |
| 14 | Confident | Go pickup e2e triggers migration via the production `serve` boot, made hermetic with `RK_SERVER_ALLOWLIST` + a private `TMUX_TMPDIR` (no tmux server created, no live socket opened); snapshot reads use `rk mux snapshot list --json` (the deprecated root alias prints a notice that breaks JSON parsing) | `rk daemon start` would open a window on the real `rk-daemon` server; direct `Migrate()` would skip the RunE ordering (migrate → RefreshDefaultConfigPath → EnsureConfig) the test exists to prove | S:70 R:80 A:80 D:70 |
| 15 | Confident | Theme is host-scoped (`ThemeProvider` refetches `/api/settings` on mount and rewrites the local theme cache), so the storage pickup spec route-holds `/api/settings` while asserting the migrated pre-sync state; sidebar width (device-local) needs no hold | Host>device precedence is designed behavior, not a migration bug; the hold freezes the pre-sync state the test exists to prove | S:60 R:85 A:75 D:60 |
| 16 | Confident | Present-truth sweep also covered: docs/site non-skill pages (the R15 gate grep covers all of docs/site), arbitrary fixture mock paths in unit tests, `run-kit-desktop` userData paths LEFT as run-kit (different dir, R0 kept it, non-goal), and e2e specs' live-key seeds/assertions renamed to `hexokit-*` (post-action reads of `runkit-*` would fail; `right-panel.spec.ts`'s `runkit-rail-open` kept — the removed feature's key never existed under hexokit) | Gate-grep cleanliness plus keeping the e2e suite green; historical/removed-feature names stay truthful | S:65 R:80 A:75 D:65 |

16 assumptions (0 certain, 15 confident, 1 tentative).
