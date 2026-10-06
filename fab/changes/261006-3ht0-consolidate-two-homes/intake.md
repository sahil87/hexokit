# Intake: Move ~/.rk into the hexokit State Home

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

**Split (2026-10-07).** During clarification the user agreed to split the work into three changes:
1. **This change**: move `~/.rk` into the hexokit state home, prune old versions, amend Constitution II.
2. `261006-lwt6-delete-stale-runkit-homes`: delete `~/.config/run-kit/` and `~/.local/state/run-kit/` behind guards, and drop the legacy code-bridge readers. It depends on this change's VSIX reinstall.
3. `261006-gy29-retire-runkit-desktop-userdata`: the Electron app deletes its old `run-kit-desktop` userData.

The split keeps the irreversible deletion in its own small, focused review. This change deletes nothing a user can't get back except old code-server/desktop versions (current + previous are kept) and two `.migrated` breadcrumbs.

End state the user wants confirmed across all three: **two homes**, config at `~/.config/hexokit/` and state at `~/.local/state/hexokit/`. The desktop app's own Electron userData (`hexokit-desktop/`) stays where Electron puts it, as a separate process with its own convention. It is not counted as an rk home.

## Why

1. **Problem.** rk's state is spread across four trees plus Electron's userData. Nobody can answer "where does rk keep X" without reading code. The user had to ask an agent to find their own config file. Two of those trees are stale duplicates that drift further from the live config every day the user edits settings. One of them (`~/.rk`) still holds live, irreplaceable data that no migration ever touched (the web-push VAPID keypair, and the code-server binary that `rk code-server update` decides it owns by checking whether the folder exists). Old code-server versions are never pruned: 3.7 GB on the maintainer's box and growing with every update.
2. **If we don't.** `~/.rk` stays a third, undocumented home holding live data, and grows by one code-server version per update. Change lwt6 (deleting the stale run-kit homes) also can't land safely without this change's code-bridge VSIX reinstall.
3. **Why this approach.**
   - **State home over `~/.local/share/` for binaries.** The user asked for exactly two homes. Strict XDG would put downloaded binaries in `$XDG_DATA_HOME`. That adds a third root for little gain once pruning bounds the size.
   - **Not the cache dir.** `~/.cache` was rejected because `rk code-server update` decides whether rk owns code-server by checking that the bin folder exists. A cache cleaner wiping it would silently flip that ownership.

## What Changes

### 1. Move `~/.rk` tenants into the hexokit state home

A new one-shot step at **release daemon start**. It uses the same dev-build gate as `homemigrate`, is skipped under the `RK_CONFIG_DIR` test override, and runs **after** `homemigrate.Migrate`. It moves each `~/.rk` tenant into `apphome.NewStateDir()` (`${XDG_STATE_HOME:-~/.local/state}/hexokit/`). The target is always the *new* state home, never the resolved one: if the state-home migration failed this boot, skip the whole step. Never move live data into a run-kit folder, which change lwt6 deletes.

| Source | Destination | Notes |
|---|---|---|
| `~/.rk/vapid.json` | `<state>/vapid.json` | **Must move, never regenerate.** A new keypair invalidates every existing push subscription. Keep mode `0600`. |
| `~/.rk/code-server-bin/` | `<state>/code-server/bin/` | `current` is a **relative** symlink (`current -> 4.139.1`), so renaming the folder is safe. |
| `~/.rk/code-server-profile/` | `<state>/code-server/profile/` | code-server's `--user-data-dir` (seeded `settings.json`, extensions, hot-exit state). |
| `~/.rk/code-server/` (pre-260813 profile path) | `<state>/code-server/profile/` | Fold the existing `migrateCodeServerProfile` one-shot rename into this move: old present and new absent ⇒ move to the state profile. |
| `~/.rk/<window>.log` (`update.log`, `restart.log`, …) | `<state>/logs/<window>.log` | `internal/daemon/jobs.go:216` tee path moves too. |
| `~/.rk/desktop/` (Linux only) | `<state>/desktop/` | Re-run `internal/desktop/integrate.go` afterwards. The `.desktop` entry's `Exec=` and the `~/.local/bin` symlink hold **absolute** paths and must be regenerated. |
| `~/.rk/settings.yaml.migrated`, `~/.rk/tmux.d.migrated/` | deleted | Breadcrumbs from the earlier `~/.rk` → `~/.config/run-kit` migration; no longer useful. |
| `~/.rk/tmux.conf` (user hand-edited, not byte-equal to the embed) | **left in place** | User-owned; the existing doctor recipe keeps surfacing it. |

**Placement rule: state files go to the state home, config files go to the config home.** Every moved tenant above is state: a generated keypair, downloaded binaries, the code-server runtime profile, job logs, an rk-managed install. All code-server files sit together under `<state>/code-server/`. The only config-class files in `~/.rk` are the hand-edited `tmux.conf` and a not-yet-migrated `settings.yaml`. Their config-home counterparts already exist (published by `homemigrate`), and the never-overwrite rule applies, so they stay where they are and `MOVED.md` points at them. <!-- clarified: placement by class; code-server grouped under code-server/ -->

Mechanics:
- **Rename first.** Use `os.Rename` (atomic, instant for the 3.7 GB tree). On `EXDEV` (`$XDG_STATE_HOME` on another volume), fall back to copy, then verify, then remove the source.
- **Never overwrite.** If a destination already exists, leave the source in place and log; `rk doctor` reports it.
- **Best-effort and non-fatal**, matching `homemigrate`'s posture.
- **code-server must not be running from the old paths.** The `rk-code-server` sibling session survives daemon restarts (Constitution VI). The step stops that session before moving bin or profile and restarts it afterwards, reusing the existing restart path from change `260924-7koz`. Before restarting, it calls the idempotent `codeserver.InstallBridgeExtension` (a no-op when the bundled version is already installed) so the bridge extension comes up on a version that uses the hexokit state home. Today the VSIX is installed only by `rk code-server install`/`update` (`cmd/rk/code_server.go`). An install failure is logged and non-fatal; change lwt6's guard 3 holds back the legacy `cb/` in that case. If code-server isn't running, it just moves. <!-- clarified: step-1 restart reinstalls the bundled VSIX (option a) -->
- **After the move, every resolver points at the state home**: `internal/push/store.go`, `internal/codeserver/codeserver.go` (`binDirName`), `internal/daemon/codeserver.go` (`codeServerProfileDir`), `internal/daemon/jobs.go`, `internal/desktop/desktop.go:70` (Linux install root). Each goes through `internal/apphome`, so the rule can't drift. `~/.rk` path literals leave the codebase except as migration sources.
- **Ending state of `~/.rk`.** If it ends up empty, remove it. If user-owned files remain (the hand-edited `tmux.conf`, a not-yet-migrated `settings.yaml`), write `~/.rk/MOVED.md`. It names the two homes, says what moved where, notes that the `port:` line in `~/.config/hexokit/config.yaml` is the rename pin and can be deleted to adopt the new default 6123 (linking the caveats below), and says the remaining files are the user's and the folder is safe to delete once they're handled.

### 2. Prune old code-server and Linux desktop versions

After `rk code-server install` / `update` flips `current` (and once during the step 1 move), delete every `<state>/code-server/bin/<version>/` except **current** and **the previous one**. "Previous" means the version `current` pointed at before the flip; with no flip history, the highest-semver version below current. Keeping the previous version covers rollback and a code-server still running the pre-flip binary. Never delete the `current` target. On the maintainer's box this frees about 2.5 GB.

The same keep-set, through one shared pruning helper, applies to Linux `rk desktop` installs (`<state>/desktop/<version>/`, which uses the same `current` symlink layout) after `rk desktop` install/update flips `current`, and once during the step 1 move. <!-- clarified: Linux desktop versions pruned with the code-server keep-set -->

### 3. Surfaces

- **`rk doctor`**: a `~/.rk` row. It shows absent, or present with the remaining user-owned files, or a tenant left in place because its destination already existed. The existing `port pin` row stays. The existing `~/.rk/tmux.conf` recipe stays. (Rows for the run-kit homes belong to change lwt6.)
- **Help text naming `~/.rk`**: `cmd/rk/code_server.go`, `cmd/rk/desktop.go` (the `--path` defaults: `~/.rk/desktop` on Linux becomes the state path), `cmd/rk/upgrade.go`, `cmd/rk/daemon_run.go` (log tee path). Check every one against the toolkit standards (`shll standards`), per the constitution.
- **Comments**: `app/frontend/src/hooks/use-global-palette-actions.ts:484` ("failures land in ~/.rk logs").

### 4. Caveats for removing `port: 3000`, to put in `MOVED.md` and memory

This is not a code change. The user plans to delete the pin by hand, and the note should warn what the port change breaks. The port is part of the address, so everything tied to `127.0.0.1:3000` breaks:
- Desktop `hosts.json` entries stored as `http://127.0.0.1:3000`.
- Per-viewer `localStorage` preferences (theme, terminal font, …), PWA installs and Web Push subscriptions are all scoped to the old address and start empty on `:6123`.
- A `tailscale serve` (or any reverse proxy) forwarding to `:3000`.
- Bookmarks.

## Affected Memory

- `run-kit/configuration`: (modify) the home inventory: `~/.rk` tenants now live in the state home (layout `vapid.json`, `code-server/{bin,profile}/`, `logs/`, `desktop/`). Retire the "`~/.rk` still has tenants" paragraph. Document the state-vs-config placement rule and `MOVED.md`.
- `run-kit/daemon-lifecycle`: (modify) daemon-start sequence gains the `~/.rk` move after `homemigrate`; `rk-code-server` stop/restart (with VSIX reinstall) around the move; code-server profile path; job-log tee path.
- `run-kit/pwa-and-push`: (modify) VAPID store path moves to the state home; never regenerated.
- `run-kit/desktop-shell`: (modify) Linux install root moves to `<state>/desktop` with `.desktop`/`~/.local/bin` regeneration; version pruning.
- `run-kit/code-bridge`: (modify) the bundled VSIX is also reinstalled when the `~/.rk` move restarts code-server.
- `run-kit/build-and-release`: (modify) if it documents the code-server bin layout or upgrade paths that name `~/.rk`; version pruning.
- `run-kit/architecture/backend-packages`, `run-kit/architecture/cli`, `run-kit/architecture/overview`, `run-kit/toolkit-standards`, `run-kit/gui`, `run-kit/tmux-sessions`, `run-kit/test-sockets`, `run-kit/api-and-sockets`, `run-kit/ui/lenses-and-layout`: (modify) path mentions of `~/.rk`, wherever they describe current behavior.

## Impact

- **Backend**:
  - `internal/apphome` (resolvers for the new leaves)
  - `internal/homemigrate` (or a sibling package for the `~/.rk` move)
  - `internal/push`, `internal/codeserver` (resolver plus pruning), `internal/daemon` (`codeserver.go`, `jobs.go`, start sequence), `internal/desktop` (`desktop.go`, `integrate.go`)
  - `internal/settings` (the `~/.rk/settings.yaml` fallback stays)
  - `cmd/rk/{doctor,code_server,desktop,upgrade,daemon_run}.go`
- **Frontend**: one comment.
- **Tests**:
  - Go unit tests over a temp `$HOME` / `$XDG_STATE_HOME`: each tenant move (including the pre-260813 `~/.rk/code-server/` profile), the `EXDEV` copy fallback, never-overwrite, skip when the state-home migration failed, the `RK_CONFIG_DIR` skip, `~/.rk` removed when empty vs `MOVED.md` written, code-server stop → VSIX install → restart ordering, and the pruning keep-set (with and without flip history).
- **Constitution**: Principle II names exactly two carve-out classes under `$XDG_STATE_HOME/hexokit/` (recovery backups, startup seed caches). The state home already holds `cron/` (user intent). This change adds the VAPID keypair, binaries and logs. A PATCH amendment to Principle II, made in this change, draws the line by *whose* state it is. Terminal session data and rk's own session state live in tmux (and the filesystem it derives from). Integrations such as code-server keep their own state by their own means. rk-managed assets (the VAPID keypair, downloaded binaries, job logs) sit in the state home alongside them. None of these is a state store in the principle's sense. The VAPID keypair stays in the state home, not the config home: the config home is often dotfiles-managed, and a private key there could leak into a repo. <!-- clarified: Constitution II PATCH clarification in scope -->
- **Constitution file**: `fab/project/constitution.md` (Principle II PATCH, version bump per its amendment rules).
- **Risk**: moves live data (the VAPID keypair, 3.7 GB of binaries) at daemon start. Every move is rename-first, never overwrites, and is reported by `rk doctor`. Downgrade is not supported: no one downgrades. For the record, a current-release binary run after the `~/.rk` move would generate a new VAPID keypair and stop treating code-server as rk-managed.

## Open Questions

None. All three were resolved in clarification on 2026-10-06 (see Clarifications). Answers about legacy-home deletion now live in change lwt6.

## Clarifications

Row numbers below refer to the pre-split Assumptions table.

### Session 2026-10-06

| # | Question | Answer |
|---|----------|--------|
| 1 | How is the legacy state home's `cb/` retired, given the VSIX is installed only by `rk code-server install`/`update`? | (a)+(c): the step-1 code-server restart calls the idempotent `InstallBridgeExtension`; if guard 3 still holds, delete everything in the legacy state home except `cb/`, and retire `cb/` once it has no live host. |
| 2 | Constitution II and the VAPID keypair, binaries and logs in the state home? | PATCH clarification in this change. Wording (user): terminal session data and rk-specific data are stored in tmux, but extensions like code-server store their state by other means. VAPID stays in the state home. |
| 3 | Prune Linux `rk desktop` versions too? | Yes: same current+previous keep-set via the shared pruning helper. |

### Session 2026-10-06 (bulk confirm)

| # | Action | Detail |
|---|--------|--------|
| 13 | Confirmed | No one runs a user-managed code-server; the step-1 VSIX reinstall covers every install |
| 10 | Confirmed | "no one is going to downgrade" |
| 12 | Changed | "all code-server related files are in a code-server folder" |
| 11 | Confirmed | — |
| 5 | Changed | "state related files go to state home, config related files go to config home" |
| 6 | Confirmed | — |
| 2 | Confirmed | — |
| 4 | Confirmed | — |

## Assumptions

Rescored at the 2026-10-07 split: the Disambiguation and Agent-competence scores of rows the user answered (or whose code was verified) now reflect what is known, instead of the pre-answer values clarify leaves in place. Rows about legacy-home deletion moved to lwt6, and the desktop userData row moved to gy29.

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Exactly two rk homes: config `~/.config/hexokit/`, state `${XDG_STATE_HOME:-~/.local/state}/hexokit/` | Discussed — user stated the target and asked for confirmation; confirmed | S:95 R:60 A:90 D:90 |
| 2 | Confident | Prune code-server versions to current + previous | Clarified — user confirmed | S:95 R:60 A:85 D:85 |
| 3 | Confident | State files go to the state home and config files to the config home; every moved `~/.rk` tenant is state-class, user-owned config files stay in place | Clarified — user changed to "state related files go to state home, config related files go to config home" | S:95 R:50 A:75 D:85 |
| 4 | Confident | `vapid.json` is moved, never regenerated | A new keypair breaks every existing Web Push subscription; reading `internal/push` makes this clear | S:70 R:40 A:90 D:90 |
| 5 | Confident | Stop and restart the `rk-code-server` session around moving bin and profile | Constitution VI keeps the sibling session alive across daemon restarts; moving a live profile splits writes | S:65 R:60 A:80 D:75 |
| 6 | Confident | No downgrade support; the move is one-way | Clarified — user: "no one is going to downgrade" | S:95 R:40 A:60 D:90 |
| 7 | Confident | `~/.rk` is removed when empty; otherwise it gets `MOVED.md` naming the homes, the port-pin line and the port-change caveats | Clarified — user confirmed | S:95 R:80 A:55 D:85 |
| 8 | Confident | State-home layout: `vapid.json`, `code-server/{bin,profile}/`, `logs/`, `desktop/` | Clarified — user changed to all code-server files in a `code-server/` folder | S:95 R:70 A:55 D:90 |
| 9 | Confident | `rename` first, copy+verify+remove on `EXDEV`; never overwrite an existing destination | Standard safe-move posture matching homemigrate's never-overwrite rule | S:45 R:70 A:75 D:70 |
| 10 | Confident | The code-server restart around the move calls the idempotent `InstallBridgeExtension` before restarting | Clarified — user chose this (option a); verified the VSIX is otherwise installed only by `rk code-server install`/`update` | S:95 R:70 A:75 D:85 |
| 11 | Confident | PATCH-amend Constitution II in this change: session/rk state lives in tmux; integrations like code-server keep their own state by other means; rk-managed assets (VAPID, binaries, logs) sit in the state home | Clarified — user gave the wording | S:95 R:70 A:60 D:85 |
| 12 | Confident | Prune Linux `rk desktop` versions with the code-server current+previous keep-set via one shared helper | Clarified — user confirmed; same `current` symlink layout | S:95 R:70 A:70 D:70 |

12 assumptions (1 certain, 11 confident, 0 tentative, 0 unresolved).
