# Intake: Delete the Stale run-kit Homes

**Change**: 261006-lwt6-delete-stale-runkit-homes
**Created**: 2026-10-07

## Origin

> Delete the stale run-kit config/state homes (split from 3ht0)

Conversational. Split out of `261006-3ht0-consolidate-two-homes` during its clarification. That change started as one consolidation of rk's on-disk footprint down to two homes (config `~/.config/hexokit/`, state `${XDG_STATE_HOME:-~/.local/state}/hexokit/`). The user then agreed to split it into three: (1) move `~/.rk` into the hexokit state home (3ht0), (2) this change, and (3) retire the desktop app's old userData (`261006-gy29-retire-runkit-desktop-userdata`).

**Depends on 3ht0.** Guard 3 below relies on 3ht0's code-server restart reinstalling the bundled code-bridge VSIX, which moves the extension's registrations off the legacy `cb/` folder. This change must land after 3ht0, in the same release or a later one.

The stale homes on the maintainer's box:

| Location | Contents | Status today |
|---|---|---|
| `~/.config/run-kit/` | stale copy (config.yaml last written 2026-09-12; diverged since migration on 2026-09-29) | left byte-unchanged by `homemigrate`; dual-read fallback |
| `~/.local/state/run-kit/` | stale `cron/`, `snapshots/`, `prstatus.json`, plus `cb/`, `code/` | same; `cb/` still in the code-bridge legacy read window |

The user's decisions:
- Originally they asked for a note left in each stale folder saying where the new home is. Refined during discussion: **delete the stale run-kit homes outright** rather than leave a note-only folder. The user asked whether outright deletion is safe for people updating from the current release (who still see the stale folders). The answer: yes, gated on the guards below.
- No one runs a user-managed code-server, so 3ht0's VSIX reinstall covers every install, and the legacy code-bridge readers can be dropped here.

## Why

1. **Problem.** The two run-kit homes are stale duplicates that drift further from the live config every day the user edits settings. They confuse users (the maintainer still sees them on the current release) and keep fallback code paths alive.
2. **If we don't.** The rename release promised that the dual-read window and the legacy-folder fallbacks are "dropped next release" (`code-bridge.md`, `apphome.LegacyName` comment). Without this change that promise never lands.
3. **Why this approach.**
   - **Delete over a note-only folder.** A folder that still exists counts as a legacy home to `apphome.resolve()` and `UnmigratedExistingInstall()`. If a user ever deletes `~/.config/hexokit/` to reset, a note-only `~/.config/run-kit/` would be picked as the home, and the migration would re-run and re-pin port 3000. Deletion removes the folder, so the fallback has nothing to find.
   - **Guarded, at daemon start.** The same point as `homemigrate`, so a user jumping from a pre-rename release gets the migration copy first and the deletion on the same boot.

## What Changes

### 1. Delete the stale run-kit homes outright

At release daemon start, after `homemigrate.Migrate` and after 3ht0's `~/.rk` move, delete `~/.config/run-kit/` and `~/.local/state/run-kit/` with `os.RemoveAll`. Same dev-build gate as `homemigrate`; skipped under the `RK_CONFIG_DIR` test override. `RemoveAll` does not follow symlinks: a dotfiles-managed `config.yaml` link inside is removed and its target is untouched. If the legacy folder is *itself* a symlink, remove the link only. Best-effort and non-fatal, matching `homemigrate`'s posture.

**Guards. Every one must hold per home, or that home is left alone this boot and `rk doctor` says why:**
1. The corresponding **new** home exists (the `homemigrate` publish succeeded). If the migration failed, the legacy home is still the live one.
2. **No symlink anywhere in the new home resolves into the legacy tree.** `homemigrate.copyChildren` recreates *absolute* link targets verbatim, so a link could still point into `~/.config/run-kit/`. Deleting the legacy tree would leave it dangling.
3. **(state home only) No live code-bridge host is registered under `<legacy state>/cb/`.** An old VSIX running in code-server keeps registering there. Deleting the folder under it makes `rk code exec` lose that host, and the old extension would recreate the folder. 3ht0's code-server restart reinstalls the bundled VSIX, which normally clears this guard. **If guard 3 still holds** (the VSIX install failed, or an old extension host is still live), delete everything in the legacy state home **except `cb/`**. Retire `cb/` and the then-empty folder on a later boot, once it has no live host. Guard 3 never holds back the rest of the legacy state home.

Users updating from the current release (homes already migrated, stale folders present) get the deletion on first start of this release. Users jumping straight from a pre-rename release get `homemigrate`'s copy plus the port pin first, then deletion on the same boot once the guards pass.

### 2. Drop the code-bridge legacy read window

Drop the legacy leaf from `ReadRecordsMerged` / `ReadBootMarkersMerged` / `LiveHostsMerged` (`discoveryDirs` in `internal/codebridge/state.go`), and the extension's `src/state-dir.ts` legacy branch. 3ht0's VSIX reinstall moves every install off the legacy leaf (user-managed code-server is not a deployment anyone runs). `rk doctor`'s legacy-state row reports a retained `cb/` if the reinstall ever failed.

### 3. Keep the skip-release migration code

**Keep** `homemigrate`, `apphome`'s dual-read `resolve()` legacy branch, `UnmigratedExistingInstall` with the virtual port pin. They do nothing once the legacy folders are gone, and they still save a user who skips the rename release entirely (pre-rename → this release) from coming up as a fresh install on port 6123.

### 4. `rk doctor`

A row per legacy home (`~/.config/run-kit`, `~/.local/state/run-kit`): absent, or present with the guard that held it back (or the retained `cb/`). The existing `port pin` row stays.

## Affected Memory

- `run-kit/configuration`: (modify) document the legacy-home deletion and its guards, and the kept skip-release migration code. Correct the "legacy trees left byte-unchanged" statement.
- `run-kit/daemon-lifecycle`: (modify) the daemon-start sequence gains the legacy-home deletion after `homemigrate` and the `~/.rk` move.
- `run-kit/code-bridge`: (modify) the legacy `run-kit/cb` read window closes.

## Impact

- **Backend**: `internal/homemigrate` (or a sibling package) for the deletion and guards; `internal/codebridge` (merged readers); `internal/daemon` start sequence; `cmd/rk/doctor.go`.
- **Code-bridge extension**: `src/state-dir.ts`.
- **Tests**: Go unit tests over a temp `$HOME` / `$XDG_STATE_HOME`: each guard (failed migration, a symlink into the legacy tree, a live legacy cb host → delete all but `cb/`), `RemoveAll` not following links, a symlinked legacy root, the skip-release path (pre-rename → migrate → delete on one boot), the `RK_CONFIG_DIR` skip, and the merged readers reading only the new leaf.
- **Risk**: deletes user folders at daemon start. Every deletion is guarded, logged and reported by `rk doctor`. Downgrade is not supported.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Delete `~/.config/run-kit/` and `~/.local/state/run-kit/` outright, not reduced to a note-only folder | Clarified in 3ht0 — user confirmed; a note-only folder would revive the apphome fallback and the port-3000 pin | S:95 R:35 A:85 D:90 |
| 2 | Confident | Deletion runs at release daemon start after `homemigrate` and the `~/.rk` move, gated per home on: new home exists, no new-home symlink into the legacy tree, (state) no live legacy cb host | Clarified in 3ht0 — user confirmed | S:95 R:45 A:80 D:85 |
| 3 | Confident | Guard-3 fallback: delete all of the legacy state home except `cb/`; retire `cb/` once it has no live host | Clarified in 3ht0 — user chose this fallback behind the VSIX reinstall | S:95 R:50 A:75 D:85 |
| 4 | Confident | Drop the code-bridge legacy-cb merged readers and the extension's legacy branch | Clarified in 3ht0 — user confirmed; no one runs a user-managed code-server | S:95 R:65 A:75 D:85 |
| 5 | Confident | Keep `homemigrate`, apphome's dual-read and the virtual pin for users who skip a release | Recommended in 3ht0 discussion; user did not object. Inert once the legacy folders are gone | S:60 R:70 A:70 D:60 |
| 6 | Confident | Lands after 3ht0 (same release or later) | Guard 3 relies on 3ht0's VSIX reinstall | S:80 R:70 A:85 D:85 |

6 assumptions (0 certain, 6 confident, 0 tentative, 0 unresolved).
