# Plan: Retire the run-kit-desktop Electron userData

**Change**: 261006-gy29-retire-runkit-desktop-userdata
**Intake**: `intake.md`

## Requirements

### Desktop: Legacy userData retirement

> **Folder-name correction.** The intake names the legacy/new userData folders `run-kit-desktop/` / `hexokit-desktop/`. Packaged builds key `app.getPath("userData")` on `productName` (electron-builder.yml: `Run Kit` before the rename, `HexoKit` after), and `carryForwardLegacyUserData` reads `join(dirname(userDataDir()), "Run Kit")`. `run-kit-desktop/` is only ever created by dev-mode `electron .` runs (package.json `name`) and nothing reads it. Per the intake's own rule — resolve the legacy path the same way the carry-forward does, so the two cannot drift — the retired folder is the carry-forward's legacy sibling (`Run Kit` in packaged builds).

#### R1: Delete the legacy userData folder once the new store exists
On app start, after `carryForwardLegacyUserData`, the desktop main process SHALL remove the legacy userData sibling (the same path passed to `carryForwardLegacyUserData`) recursively when `hosts.json` exists in the current userData dir. When the new dir has no `hosts.json`, the legacy folder SHALL be left untouched.

- **GIVEN** `<userData>/hosts.json` exists and the legacy sibling exists
- **WHEN** the app starts
- **THEN** the legacy sibling folder and all its contents are removed
- **AND** `<userData>` is untouched

- **GIVEN** `<userData>/hosts.json` does not exist
- **WHEN** the app starts
- **THEN** the legacy sibling is left in place

#### R2: A pre-rename jump carries forward, then retires, on one start
The retirement SHALL run after the carry-forward in the same start, so a user jumping from a pre-rename build gets their stores copied and the legacy folder removed on the first start. The retirement SHALL NOT run on a start whose carry-forward reported a failure, and a failed carry-forward SHALL roll back that attempt's copies (skipping, not failing on, a store the new dir already has), so a partial copy never satisfies the `hosts.json` gate on a later start and never loses the uncopied legacy store.

- **GIVEN** a fresh new userData dir and a legacy dir with `hosts.json` and `windows.json`
- **WHEN** the app starts
- **THEN** both files are copied into the new dir and then the legacy dir is removed

- **GIVEN** the carry-forward throws after copying `hosts.json`
- **WHEN** the app starts
- **THEN** the legacy dir is left in place

#### R3: Symlinked legacy path removes only the link
If the legacy path is a symbolic link, the retirement SHALL remove the link itself and SHALL NOT follow it or delete anything at its target.

- **GIVEN** the legacy path is a symlink to a directory containing files
- **WHEN** the retirement runs with `<userData>/hosts.json` present
- **THEN** the symlink is gone and the target directory and its files remain

#### R4: Best-effort — failures never block start
Every retirement failure (permissions, I/O) SHALL be logged via `console.warn` and swallowed; the function SHALL NOT throw. An absent legacy folder is a silent no-op.

- **GIVEN** the legacy folder cannot be removed
- **WHEN** the retirement runs
- **THEN** it returns without throwing and logs exactly one warning

#### R5: Carry-forward keeps its trigger
`carryForwardLegacyUserData` SHALL keep its existing trigger condition and copy behavior; its doc comment SHALL no longer promise that the legacy dir stays in place for a downgrade.

- **GIVEN** the existing carry-forward test suite
- **WHEN** it runs
- **THEN** every existing case still passes

### Non-Goals

- Deleting the dev-mode `run-kit-desktop/` folder — only `electron .` runs create it, nothing reads it, and the packaged app has no reason to know about dev-mode siblings.
- Any `rk` binary change — the desktop app owns its own userData.

### Design Decisions

#### Retire the legacy userData beside the carry-forward, gated on the new store
**Decision**: `retireLegacyUserData(newDir, legacyDir)` in `user-data-migration.ts` removes the carry-forward's legacy sibling when `newDir/hosts.json` exists; main.ts runs it right after the carry-forward and skips it on a start whose carry-forward failed.
**Why**: The same `hosts.json` precondition that makes the carry-forward a no-op guarantees the carry-forward had its chance, and sharing the legacy path at the call site means the two cannot drift. Skipping after a failed carry-forward keeps a partial copy from losing the uncopied store.
**Rejected**: Deleting from the `rk` binary — the desktop app ships separately and can lag `rk`; leaving the folder forever — a stale copy of hosts, window state and Chromium caches with no reader.
*Introduced by*: 261006-gy29-retire-runkit-desktop-userdata

## Tasks

### Phase 2: Core Implementation

- [x] T001 In `app/desktop/src/user-data-migration.ts`, make `carryForwardLegacyUserData` also return `failed: boolean`, add `retireLegacyUserData(newDir, legacyDir): { removed: boolean }` (gate on `newDir/hosts.json`; `lstat` the legacy path — absent → no-op, symlink → `unlinkSync`, else `rmSync` recursive; every failure `console.warn` + swallowed), and update the module/function doc comments <!-- R1 R3 R4 R5 -->
- [x] T002 In `app/desktop/src/main.ts` `whenReady`, compute the legacy path once, pass it to both calls, and run `retireLegacyUserData` only when the carry-forward did not fail; log when the folder was removed <!-- R1 R2 -->

### Phase 3: Integration & Edge Cases

- [x] T003 In `app/desktop/src/user-data-migration.test.ts`, add cases: removed when `hosts.json` exists; kept when it doesn't; absent legacy is a no-op; symlinked legacy removes only the link; a failed delete logs and doesn't throw; pre-rename jump (carry-forward then retire leaves the stores in the new dir and no legacy dir); carry-forward reports `failed` on a copy error <!-- R1 R2 R3 R4 R5 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `retireLegacyUserData` removes the legacy dir recursively when `newDir/hosts.json` exists and leaves it when it doesn't
- [x] A-002 R2: main.ts passes the same legacy path to both calls and runs the retirement after the carry-forward, only when the carry-forward did not fail
- [x] A-003 R3: A symlinked legacy path is unlinked; its target survives
- [x] A-004 R4: Retirement failures are logged once via `console.warn` and never thrown; an absent legacy dir is a silent no-op
- [x] A-005 R5: `carryForwardLegacyUserData`'s trigger and copy behavior are unchanged; it reports `failed: true` only when it caught an error

### Scenario Coverage

- [x] A-006 R2: A test covers the pre-rename jump (carry-forward then retire on one start)
- [x] A-007 R1: `pnpm run compile && pnpm run test` in `app/desktop` passes, including the new cases

### Edge Cases & Error Handling

- [x] A-008 R2: A carry-forward that fails mid-copy leaves the legacy dir in place (main.ts gate)

### Code Quality

- [x] A-009 Pattern consistency: The new helper is electron-free and directory-parameterized like `carryForwardLegacyUserData`, with the same warn-and-continue failure style
- [x] A-010 No unnecessary duplication: The legacy path is computed once in main.ts and shared by both calls
- [x] A-011 Tests included: New behavior is covered by `node --test` cases beside the existing carry-forward tests
- [x] A-012 No comment narration: Comments state constraints (why the gate, why lstat) without citing change IDs

### Security

- [x] A-013 R3: Deletion never follows a symlink (lstat-based check, `unlinkSync` for links)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Retire the carry-forward's legacy sibling (`Run Kit` in packaged builds), not the literal `run-kit-desktop/` the intake names | Packaged userData keys on `productName` (`Run Kit` → `HexoKit`); the intake requires using the carry-forward's path so the two cannot drift; `run-kit-desktop/` is dev-mode only | S:60 R:55 A:80 D:55 |
| 2 | Confident | Skip retirement on a start whose carry-forward failed | A partial copy (hosts.json copied, windows.json not) would otherwise lose the uncopied store, since `hosts.json` presence alone would pass the gate | S:55 R:80 A:80 D:75 |
| 3 | Confident | Signal carry-forward failure via a new `failed` field on its return value | Smallest change that lets main.ts gate; existing callers destructure `copied` only | S:50 R:90 A:85 D:70 |

3 assumptions (0 certain, 3 confident, 0 tentative).
