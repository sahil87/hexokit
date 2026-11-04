# Intake: Retire the run-kit-desktop Electron userData

**Change**: 261006-gy29-retire-runkit-desktop-userdata
**Created**: 2026-10-07

## Origin

> Retire the run-kit-desktop Electron userData (split from 3ht0)

Conversational. Split out of `261006-3ht0-consolidate-two-homes` during its clarification. That change started as one consolidation of rk's on-disk footprint. The user then agreed to split it into three: (1) move `~/.rk` into the hexokit state home (3ht0), (2) delete the stale run-kit homes (`261006-lwt6-delete-stale-runkit-homes`), and (3) this change. The user's words on this item in the original discussion: "yes - if not used remove that too". This change is Electron-only and fully independent of the other two, so it can land in any order.

The legacy folder:

| Platform | Path | Contents |
|---|---|---|
| macOS | `~/Library/Application Support/run-kit-desktop/` | `hosts.json`, `windows.json`, `servers.json`, Chromium caches/cookies |
| Linux | `~/.config/run-kit-desktop/` | same |

Today it is read only as the one-shot copy source for `carryForwardLegacyUserData` when `hexokit-desktop/hosts.json` is absent.

## Why

1. **Problem.** After the HexoKit rename, the desktop app's Electron userData moved from `run-kit-desktop/` to `hexokit-desktop/`. The old folder is never deleted, so every user who updated keeps a stale copy of hosts, window state and Chromium caches. This is one of the stray locations that makes "where does rk keep X" hard to answer.
2. **If we don't.** The stale folder stays forever, and nothing ever reads it again once `hexokit-desktop/hosts.json` exists.
3. **Why this approach.** The desktop app ships separately from the `rk` binary and can lag behind it, so the Electron main process cleans up its own legacy folder instead of `rk`. The trigger is the same condition that already makes the carry-forward a no-op (`hexokit-desktop/hosts.json` exists), so cleanup can never run before the carry-forward had its chance.

## What Changes

### 1. Delete the legacy userData folder after carry-forward

In `app/desktop/src/main.ts`, immediately after `carryForwardLegacyUserData`, remove the legacy `run-kit-desktop` userData sibling recursively when `hexokit-desktop/hosts.json` exists. Its existence means the carry-forward already ran, or the new-name app has its own store.

- Resolve the legacy path the same way `user-data-migration.ts` already does (sibling of `app.getPath('userData')`), so the two can't drift.
- If the legacy path is a symlink, remove the link only; never follow it.
- Best-effort: a failure is logged and never blocks app start.
- Nothing in the old folder is read today: `servers.json` was never carried, and neither were cookies or caches. Deleting them loses nothing in use.

### 2. Keep the carry-forward

`carryForwardLegacyUserData` stays. It still saves a user who jumps from a pre-rename desktop build straight to this one: the carry-forward copies `hosts.json` first, and only then does the deletion's precondition hold. Its trigger condition is unchanged.

## Affected Memory

- `run-kit/desktop-shell`: (modify) document that the legacy `run-kit-desktop` userData folder is deleted after carry-forward once `hexokit-desktop/hosts.json` exists.

## Impact

- **Desktop**: `app/desktop/src/main.ts`, `app/desktop/src/user-data-migration.ts` (the deletion helper can live beside the carry-forward).
- **Tests**: node test beside the existing `user-data-migration` test: the folder is deleted when `hosts.json` exists; kept when it doesn't; a symlinked legacy path removes only the link; a failed delete doesn't throw; pre-rename jump (carry-forward then delete on one start).
- **Risk**: deletes a user folder on app start, guarded by the presence of the new store's `hosts.json`.

## Open Questions

None.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Delete the `run-kit-desktop` userData folder recursively once `hexokit-desktop/hosts.json` exists | Discussed — user: "yes - if not used remove that too"; verified nothing reads it past the one-shot carry-forward | S:90 R:40 A:85 D:85 |
| 2 | Confident | The Electron main process does the cleanup, not the `rk` binary | The desktop app ships separately and can lag `rk`; it owns its own userData | S:70 R:70 A:85 D:80 |
| 3 | Confident | Keep `carryForwardLegacyUserData` for pre-rename jumps | Discussed in 3ht0 — skip-release code is kept; deletion only runs after carry-forward | S:80 R:70 A:80 D:80 |
| 4 | Confident | Symlinked legacy path: remove the link only; failures are logged, never block start | Standard safe-delete posture matching the rest of the split | S:60 R:75 A:80 D:80 |

4 assumptions (0 certain, 4 confident, 0 tentative, 0 unresolved).
