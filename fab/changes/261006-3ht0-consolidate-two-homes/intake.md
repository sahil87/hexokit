# Intake: Consolidate rk's On-Disk Homes to Two

**Change**: 261006-3ht0-consolidate-two-homes
**Created**: 2026-10-06

## Origin

> Consolidate rk's on-disk homes to exactly two (config ~/.config/hexokit/, state ~/.local/state/hexokit/) — scope per the discussion above

Conversational. The discussion (`/fab-discuss`) began with the user trying to find where the "keep port 3000 for older users" fact was stored after the HexoKit rename moved the default daemon port to 6123. The finding: it is a plain `port: 3000` line (plus `settings.PortPinComment`) written into `~/.config/hexokit/config.yaml` by `homemigrate.applyPortPin`, mirrored by a pre-migration virtual pin in `config.daemonDefaultPort()`. The user wants to know where config lives so they can remove that line themselves. Along the way the audit found rk's footprint spread across far more places than the two XDG homes:

| Location | Contents (on the maintainer's box) | Status today |
|---|---|---|
| `~/.config/hexokit/` | `config.yaml`, `tmux.conf`, `tmux.d/` | live config home |
| `~/.local/state/hexokit/` | `cron/`, `snapshots/`, `prstatus.json` | live state home |
| `~/.config/run-kit/` | stale copy (config.yaml last written 2026-09-12; diverged since migration on 2026-09-29) | left byte-unchanged by `homemigrate` for downgrade; dual-read fallback |
| `~/.local/state/run-kit/` | stale `cron/`, `snapshots/`, `prstatus.json`, plus `cb/`, `code/` | same; `cb/` still in the code-bridge legacy read window |
| `~/.rk/` | `vapid.json`, `code-server-bin/` (**3.7 GB**, six versions 4.134.0 → 4.139.1), `code-server-profile/`, `update.log`, hand-edited `tmux.conf`, `settings.yaml.migrated`, `tmux.d.migrated/` | **live tenants never migrated** (memory `configuration.md` already notes this) |
| `~/Library/Application Support/run-kit-desktop/` (macOS) / `~/.config/run-kit-desktop/` (Linux) | old Electron userData: `hosts.json`, `windows.json`, `servers.json`, Chromium caches/cookies | read only as the one-shot copy source when `hexokit-desktop/hosts.json` is absent |

The user's decisions, in order:

1. Move the stale homes into the new homes. Originally they asked for a note left in each stale folder saying where the new home is. Refined during discussion: **delete the stale run-kit homes outright** rather than leaving a note-only folder. The user asked whether outright deletion is safe for people updating from the current release (who still see the stale folders). The answer: yes, gated on the guards below. Outright deletion also removes the risk that a note-only folder would revive `apphome`'s legacy fallback and the port-3000 pin.
2. Retire `run-kit-desktop/` too, since nothing reads it once `hexokit-desktop/hosts.json` exists.
3. Prune old code-server versions, keeping current + previous.

End state the user wants confirmed: **two homes**, config at `~/.config/hexokit/` and state at `~/.local/state/hexokit/`. The desktop app's own Electron userData (`hexokit-desktop/`) stays where Electron puts it, as a separate process with its own convention. It is not counted as an rk home.

## Why

1. **Problem.** rk's state is spread across four trees plus Electron's userData. Nobody can answer "where does rk keep X" without reading code. The user had to ask an agent to find their own config file. Two of those trees are stale duplicates that drift further from the live config every day the user edits settings. One of them (`~/.rk`) still holds live, irreplaceable data that no migration ever touched (the web-push VAPID keypair, and the code-server binary that `rk code-server update` decides it owns by checking whether the folder exists). Old code-server versions are never pruned: 3.7 GB on the maintainer's box and growing with every update.
2. **If we don't.** The rename release promised that the dual-read window and the legacy-folder fallbacks are "dropped next release" (`code-bridge.md`, `apphome.LegacyName` comment). Without this change that promise never lands. Stale folders stay forever and confuse users (the maintainer still sees them on the current release). Fallback code paths stay alive, and `~/.rk` grows indefinitely.
3. **Why this approach.**
   - **Delete over a note-only folder.** A folder that still exists counts as a legacy home to `apphome.resolve()` and `UnmigratedExistingInstall()`. If a user ever deletes `~/.config/hexokit/` to reset, a note-only `~/.config/run-kit/` would be picked as the home, and the migration would re-run and re-pin port 3000. Deletion removes the folder, so the fallback has nothing to find.
   - **State home over `~/.local/share/` for binaries.** The user asked for exactly two homes. Strict XDG would put downloaded binaries in `$XDG_DATA_HOME`. That adds a third root for little gain once pruning bounds the size.
   - **Not the cache dir.** `~/.cache` was rejected because `rk code-server update` decides whether rk owns code-server by checking that the bin folder exists. A cache cleaner wiping it would silently flip that ownership.

## What Changes

### 1. Move `~/.rk` tenants into the hexokit state home

A new one-shot step at **release daemon start**. It uses the same dev-build gate as `homemigrate`, is skipped under the `RK_CONFIG_DIR` test override, and runs **after** `homemigrate.Migrate`. It moves each `~/.rk` tenant into `apphome.NewStateDir()` (`${XDG_STATE_HOME:-~/.local/state}/hexokit/`). The target is always the *new* state home, never the resolved one: if the state-home migration failed this boot, skip the whole step. Never move live data into a run-kit folder that step 3 is about to delete.

| Source | Destination | Notes |
|---|---|---|
| `~/.rk/vapid.json` | `<state>/vapid.json` | **Must move, never regenerate.** A new keypair invalidates every existing push subscription. Keep mode `0600`. |
| `~/.rk/code-server-bin/` | `<state>/code-server-bin/` | `current` is a **relative** symlink (`current -> 4.139.1`), so renaming the folder is safe. |
| `~/.rk/code-server-profile/` | `<state>/code-server-profile/` | code-server's `--user-data-dir` (seeded `settings.json`, extensions, hot-exit state). |
| `~/.rk/code-server/` (pre-260813 profile path) | `<state>/code-server-profile/` | Fold the existing `migrateCodeServerProfile` one-shot rename into this move: old present and new absent ⇒ move to the state profile. |
| `~/.rk/<window>.log` (`update.log`, `restart.log`, …) | `<state>/logs/<window>.log` | `internal/daemon/jobs.go:216` tee path moves too. |
| `~/.rk/desktop/` (Linux only) | `<state>/desktop/` | Re-run `internal/desktop/integrate.go` afterwards. The `.desktop` entry's `Exec=` and the `~/.local/bin` symlink hold **absolute** paths and must be regenerated. |
| `~/.rk/settings.yaml.migrated`, `~/.rk/tmux.d.migrated/` | deleted | Breadcrumbs from the earlier `~/.rk` → `~/.config/run-kit` migration; no longer useful. |
| `~/.rk/tmux.conf` (user hand-edited, not byte-equal to the embed) | **left in place** | User-owned; the existing doctor recipe keeps surfacing it. |

Mechanics:
- **Rename first.** Use `os.Rename` (atomic, instant for the 3.7 GB tree). On `EXDEV` (`$XDG_STATE_HOME` on another volume), fall back to copy, then verify, then remove the source.
- **Never overwrite.** If a destination already exists, leave the source in place and log; `rk doctor` reports it.
- **Best-effort and non-fatal**, matching `homemigrate`'s posture.
- **code-server must not be running from the old paths.** The `rk-code-server` sibling session survives daemon restarts (Constitution VI). The step stops that session before moving bin or profile and restarts it afterwards, reusing the existing restart path from change `260924-7koz`. If code-server isn't running, it just moves.
- **After the move, every resolver points at the state home**: `internal/push/store.go`, `internal/codeserver/codeserver.go` (`binDirName`), `internal/daemon/codeserver.go` (`codeServerProfileDir`), `internal/daemon/jobs.go`, `internal/desktop/desktop.go:70` (Linux install root). Each goes through `internal/apphome`, so the rule can't drift. `~/.rk` path literals leave the codebase except as migration sources.
- **Ending state of `~/.rk`.** If it ends up empty, remove it. If user-owned files remain (the hand-edited `tmux.conf`, a not-yet-migrated `settings.yaml`), write `~/.rk/MOVED.md`. It names the two homes, says what moved where, notes that the `port:` line in `~/.config/hexokit/config.yaml` is the rename pin and can be deleted to adopt the new default 6123 (linking the caveats below), and says the remaining files are the user's and the folder is safe to delete once they're handled.

### 2. Prune old code-server versions

After `rk code-server install` / `update` flips `current` (and once during the step 1 move), delete every `<state>/code-server-bin/<version>/` except **current** and **the previous one**. "Previous" means the version `current` pointed at before the flip; with no flip history, the highest-semver version below current. Keeping the previous version covers rollback and a code-server still running the pre-flip binary. Never delete the `current` target. On the maintainer's box this frees about 2.5 GB.

### 3. Delete the stale run-kit homes outright

After steps 1–2, at the same daemon-start point, delete `~/.config/run-kit/` and `~/.local/state/run-kit/` with `os.RemoveAll`. `RemoveAll` does not follow symlinks: a dotfiles-managed `config.yaml` link inside is removed and its target is untouched. If the legacy folder is *itself* a symlink, remove the link only.

**Guards. Every one must hold per home, or that home is left alone this boot and `rk doctor` says why:**
1. The corresponding **new** home exists (the `homemigrate` publish succeeded). If the migration failed, the legacy home is still the live one.
2. **No symlink anywhere in the new home resolves into the legacy tree.** `homemigrate.copyChildren` recreates *absolute* link targets verbatim, so a link could still point into `~/.config/run-kit/`. Deleting the legacy tree would leave it dangling.
3. **(state home only) No live code-bridge host is registered under `<state>/run-kit/cb/`.** An old VSIX running in code-server keeps registering there. Deleting the folder under it makes `rk code exec` lose that host, and the old extension would recreate the folder. Deletion waits until the legacy leaf has no live host. The step-1 code-server restart helps only if it also brings the extension up to a version that uses the hexokit home (see Open Questions).

Users updating from the current release (homes already migrated, stale folders present) get the deletion on first start of this release. Users jumping straight from a pre-rename release get `homemigrate`'s copy plus the pin first, then deletion on the same boot once the guards pass.

### 4. Retire `run-kit-desktop` userData

In the Electron main process (`app/desktop/src/main.ts`, after `carryForwardLegacyUserData`), remove the legacy `run-kit-desktop` userData sibling recursively when `hexokit-desktop/hosts.json` exists. That means the carry-forward already ran or the new-name app has its own store. The desktop app ships separately and can lag the `rk` binary, so it does its own cleanup. Nothing in the old folder is read today: `servers.json` was never carried, and the cookies and caches were never carried either.

### 5. Drop dead legacy read paths

- **Code-bridge two-process legacy window.** Drop `ReadRecordsMerged` / `ReadBootMarkersMerged` / `LiveHostsMerged`'s legacy leaf (`discoveryDirs`) and the extension's `src/state-dir.ts` legacy branch. Do this only together with the guard-3 answer (Open Questions).
- **Keep** `homemigrate`, `apphome`'s dual-read `resolve()` legacy branch, `UnmigratedExistingInstall` and the virtual pin, and the desktop `carryForwardLegacyUserData`. They do nothing once the legacy folders are gone, and they still save a user who skips the rename release entirely (pre-rename → this release) from coming up as a fresh install on 6123.

### 6. Surfaces

- **`rk doctor`**: a row per legacy location (`~/.rk`, `~/.config/run-kit`, `~/.local/state/run-kit`). It shows absent, or present with the reason a guard held it back, or with the remaining user-owned files. The existing `port pin` row stays. The existing `~/.rk/tmux.conf` recipe stays.
- **Help text naming `~/.rk`**: `cmd/rk/code_server.go`, `cmd/rk/desktop.go` (the `--path` defaults: `~/.rk/desktop` on Linux becomes the state path), `cmd/rk/upgrade.go`, `cmd/rk/daemon_run.go` (log tee path). Check every one against the toolkit standards (`shll standards`), per the constitution.
- **Comments**: `app/frontend/src/hooks/use-global-palette-actions.ts:484` ("failures land in ~/.rk logs").

### 7. Caveats for removing `port: 3000`, to put in `MOVED.md` and memory

This is not a code change. The user plans to delete the pin by hand, and the note should warn what the port change breaks. The port is part of the address, so everything tied to `127.0.0.1:3000` breaks:
- Desktop `hosts.json` entries stored as `http://127.0.0.1:3000`.
- Per-viewer `localStorage` preferences (theme, terminal font, …), PWA installs and Web Push subscriptions are all scoped to the old address and start empty on `:6123`.
- A `tailscale serve` (or any reverse proxy) forwarding to `:3000`.
- Bookmarks.

## Affected Memory

- `run-kit/configuration`: (modify) the home inventory becomes the two homes plus Electron userData. Retire the "`~/.rk` still has tenants" paragraph. Document the legacy-home deletion and its guards, and the kept skip-release migration code. Correct the "legacy trees left byte-unchanged" statement.
- `run-kit/daemon-lifecycle`: (modify) daemon-start sequence gains the `~/.rk` move and the legacy-home deletion after `homemigrate`. code-server profile path, `rk-code-server` stop/restart around the move, job-log tee path.
- `run-kit/pwa-and-push`: (modify) VAPID store path moves to the state home; never regenerate.
- `run-kit/desktop-shell`: (modify) `run-kit-desktop` userData retirement; Linux install root moves to `<state>/desktop` with `.desktop`/`~/.local/bin` regeneration.
- `run-kit/code-bridge`: (modify) the legacy `run-kit/cb` read window closes.
- `run-kit/build-and-release`: (modify) if it documents the code-server bin layout or upgrade paths that name `~/.rk`.
- `run-kit/architecture/backend-packages`, `run-kit/architecture/cli`, `run-kit/architecture/overview`, `run-kit/toolkit-standards`, `run-kit/gui`, `run-kit/tmux-sessions`, `run-kit/test-sockets`, `run-kit/api-and-sockets`, `run-kit/ui/lenses-and-layout`: (modify) path mentions of `~/.rk`, wherever they describe current behavior.

## Impact

- **Backend**:
  - `internal/apphome` (resolvers for the new leaves)
  - `internal/homemigrate` (or a sibling package for the `~/.rk` move and legacy deletion)
  - `internal/push`, `internal/codeserver` (resolver plus pruning), `internal/daemon` (`codeserver.go`, `jobs.go`, start sequence), `internal/desktop` (`desktop.go`, `integrate.go`)
  - `internal/codebridge` (merged readers), `internal/settings` (the `~/.rk/settings.yaml` fallback stays)
  - `cmd/rk/{doctor,code_server,desktop,upgrade,daemon_run}.go`
- **Code-bridge extension**: `src/state-dir.ts`.
- **Desktop**: `app/desktop/src/main.ts`, `user-data-migration.ts` (plus its node test).
- **Frontend**: one comment.
- **Tests**:
  - Go unit tests over a temp `$HOME` / `$XDG_STATE_HOME`: each tenant move, the `EXDEV` copy fallback, never-overwrite, each deletion guard (including a symlink into the legacy tree, a live legacy cb host, and a failed migration), `RemoveAll` not following links, the skip-release path (pre-rename → migrate → delete on one boot), the `RK_CONFIG_DIR` skip, and the pruning keep-set.
  - Node test for the desktop retirement.
- **Constitution**: Principle II names exactly two carve-out classes under `$XDG_STATE_HOME/hexokit/` (recovery backups, startup seed caches). The state home already holds `cron/` (user intent). This change adds the VAPID keypair, binaries and logs. See Open Questions.
- **Risk**: this deletes user folders at daemon start. Every deletion is guarded, logged, and reported by `rk doctor`. Downgrade after this release: a pre-rename binary finds no legacy home. The *current* release's binary still reads hexokit, but after the `~/.rk` move it finds no `vapid.json` (and generates a new keypair, breaking push subscriptions) and no `code-server-bin` (so it treats code-server as user-managed). Accepted as one-way.

## Open Questions

- **Guard 3 / code-bridge window.** Does any daemon-start or code-server-restart path upgrade the installed rk-code-bridge VSIX, or only `rk code-server install`/`update`? If only the latter, an old extension can keep `<state>/run-kit/cb/` alive indefinitely. Options:
  - (a) Have the step-1 restart reinstall the bundled VSIX.
  - (b) Leave the legacy state home in place until the guard passes, possibly forever on boxes that never update code-server.
  - (c) Delete the rest of the legacy state home but keep only `cb/`.
  <!-- assumed: legacy cb/ retirement path left to apply — depends on whether any restart path upgrades the VSIX -->
- **Constitution II wording.** Should Principle II's state-home carve-out list be amended (PATCH/MINOR) to name the VAPID keypair, rk-managed binaries and job logs, or do these fall outside "state" in the principle's sense? The VAPID keypair is a generated credential. It is arguably config-class, and could go in the config home instead.
  <!-- assumed: constitution II amendment surfaced, not made here — amendments are the user's call -->
- **Linux `rk desktop` versions** (`<state>/desktop/<version>/`) accumulate exactly like code-server's. Should they get the same current-plus-previous pruning in this change?

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Exactly two rk homes: config `~/.config/hexokit/`, state `${XDG_STATE_HOME:-~/.local/state}/hexokit/` | Discussed — user stated the target and asked for confirmation; confirmed | S:95 R:60 A:90 D:90 |
| 2 | Confident | Stale `~/.config/run-kit/` and `~/.local/state/run-kit/` are deleted outright, not reduced to a note-only folder | Discussed — user chose "delete outright"; a note-only folder would revive the apphome fallback and the port-3000 pin | S:90 R:35 A:85 D:85 |
| 3 | Confident | `run-kit-desktop` userData is retired by the desktop main process once `hexokit-desktop/hosts.json` exists | Discussed — user: "yes - if not used remove that too"; verified nothing reads it past the one-shot carry-forward | S:90 R:40 A:85 D:85 |
| 4 | Confident | Prune code-server versions to current + previous | Discussed — user: "ok" to the current+previous proposal | S:90 R:60 A:85 D:85 |
| 5 | Confident | `~/.rk` tenants move into the state home (not the config home, not `~/.local/share`, not `~/.cache`) | Discussed — two-home requirement; cache rejected because `rk code-server update` decides it owns code-server by whether the folder exists | S:75 R:50 A:75 D:65 |
| 6 | Confident | Deletion runs at release daemon start after `homemigrate`, gated on: new home exists, no new-home symlink into the legacy tree, (state) no live legacy cb host | Discussed — guards proposed in conversation; follows homemigrate's dev-gate and RK_CONFIG_DIR skip | S:75 R:45 A:80 D:70 |
| 7 | Confident | `vapid.json` is moved, never regenerated | A new keypair breaks every existing Web Push subscription; reading `internal/push` makes this clear | S:70 R:40 A:90 D:90 |
| 8 | Confident | Stop and restart the `rk-code-server` session around moving bin and profile | Constitution VI keeps the sibling session alive across daemon restarts; moving a live profile splits writes | S:65 R:60 A:80 D:75 |
| 9 | Confident | Keep `homemigrate`, apphome's dual-read, the virtual pin and the desktop carry-forward for users who skip a release | Recommended in discussion; user did not object. Inert once the legacy folders are gone, and protects pre-rename → this-release jumps | S:60 R:70 A:70 D:60 |
| 10 | Confident | Accept the one-way downgrade cost (current-release binary after the move loses the VAPID key and treats code-server as user-managed) | Raised in discussion as "your call"; user proceeded without objecting | S:55 R:40 A:60 D:65 |
| 11 | Confident | `~/.rk` is removed when empty; otherwise it gets `MOVED.md` naming the homes, the port-pin line and the port-change caveats | User originally asked for a note in stale homes; with run-kit folders deleted outright, `~/.rk` (holding user-owned files) is the only place a note still lands | S:60 R:80 A:55 D:50 |
| 12 | Confident | State-home leaf layout: `vapid.json`, `code-server-bin/`, `code-server-profile/`, `logs/`, `desktop/` at the state root | Mirrors the existing "leaf names unchanged" precedent; a grouped `code-server/{bin,profile}` layout is equally valid | S:40 R:70 A:55 D:45 |
| 13 | Confident | Drop the code-bridge legacy-cb merged readers in this change | Proposed in discussion; safe only once guard 3 / VSIX upgrade is answered (Open Questions) | S:55 R:65 A:45 D:45 |
| 14 | Confident | `rename` first, copy+verify+remove on `EXDEV`; never overwrite an existing destination | Standard safe-move posture matching homemigrate's never-overwrite rule | S:45 R:70 A:75 D:70 |
| 15 | Tentative | How the legacy state home's `cb/` is retired when an old VSIX may still write there (reinstall VSIX on restart / wait for guard / delete all but `cb/`) | Not discussed; needs the VSIX-upgrade path checked at apply, and it decides whether the legacy state home can always be deleted | S:30 R:40 A:30 D:25 |
| 16 | Tentative | Constitution II wording for the VAPID keypair, binaries and logs in the state home is surfaced as an open question, not amended here | Constitution amendments are the user's call; the state home already exceeds the two named carve-outs (`cron/`) | S:35 R:70 A:40 D:40 |

16 assumptions (1 certain, 13 confident, 2 tentative, 0 unresolved).
