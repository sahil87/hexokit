# Plan: Create a Workspace at a Folder

**Change**: 261030-qm52-workspace-create-at-folder
**Intake**: `intake.md`

## Requirements

### API: Workspace creation

#### R1: `POST /api/servers` accepts an optional `cwd`
`handleServerCreate` (`app/backend/api/servers.go`) SHALL accept an optional `cwd` string in the body. When `cwd` is non-empty it SHALL be validated exactly as `handleSessionCreate` validates its `cwd`: `validate.ValidatePath(cwd, "Working directory")`, then `validate.ExpandTilde(cwd)`. Any error is a 400 with that message and no tmux call. The two handlers SHALL share one helper for this validation instead of copying it.

- **GIVEN** body `{"name":"hexokit","cwd":"~/code/hexokit"}`
- **WHEN** the request is handled
- **THEN** `CreateSession` receives cwd `$HOME/code/hexokit` and server `hexokit`
- **AND** body `{"name":"x","cwd":"/etc"}` returns 400 `Path must be under home directory` with no `CreateSession` call

#### R2: The first group is named after the folder
When `cwd` is present, the first group (tmux session) SHALL be named by the backend's Go equivalent of the frontend `deriveNameFromPath`. That function strips trailing `/`, maps `~` or empty to empty, and takes the last path segment of the **raw** `cwd`. Every char in ``[ ;&|`$(){}[\]<>!#*?\n\r\t:.]`` and `-` converts to `_`. Runs of `_` collapse, leading and trailing `_` are trimmed, and the result is capped at `validate.MaxNameLength`. An empty result SHALL fall back to `main`. The derived name SHALL pass `validate.ValidateNewName`.

- **GIVEN** `cwd` `~/code/my-app.v2`
- **WHEN** the workspace is created
- **THEN** its first group is `my_app_v2`
- **AND** `cwd` `~` (or `~/`) yields group `main` at `$HOME`

#### R3: Absent `cwd` keeps the legacy birth session
When `cwd` is absent or empty, the handler SHALL behave as it does today: group `"0"` at `os.UserHomeDir()`. `rk`/MCP and other existing callers see identical behavior.

- **GIVEN** body `{"name":"work"}`
- **WHEN** the request is handled
- **THEN** `CreateSession("0", $HOME, "work")` is called

#### R4: The response names the first group
A successful create SHALL return `201 {"ok": true, "group": "<firstGroup>"}`, where `"0"` is the group for the legacy path.

- **GIVEN** a successful create with `cwd` `~/code/hexokit`
- **WHEN** the client reads the response
- **THEN** it is `{"ok":true,"group":"hexokit"}`

### Frontend: Create-workspace dialogs

#### R5: `createServer` forwards `cwd`
`createServer(name, cwd?)` in `app/frontend/src/api/client.ts` SHALL include `cwd` in the JSON body only when it is a non-empty string. Its return type gains an optional `group`.

- **GIVEN** `createServer("w")`
- **WHEN** it posts
- **THEN** the body is exactly `{"name":"w"}`

#### R6: Both create-workspace dialogs gain an optional folder field
The `ServerDialogs` create dialog (`components/server-dialogs.tsx`) and the host page create dialog (`components/host-overview-page.tsx`) SHALL render an optional folder input below the name input. It has the same combobox behavior as `create-session-dialog.tsx`: quick-picks from the sessions' project roots when empty, debounced `getDirectories` autocomplete, and ↑/↓/Enter/Esc. The folder-input piece SHALL be extracted into a reusable component (e.g. `components/folder-path-input.tsx`), which `create-session-dialog.tsx` then also uses, with no behavior change for that dialog. A blank folder submits without `cwd`.

- **GIVEN** the New workspace dialog
- **WHEN** the user picks `~/code/hexokit` and clicks Create
- **THEN** `createServer("hexokit", "~/code/hexokit")` is called

#### R7: The folder prefills from the active tab
In `ServerDialogs`, the folder SHALL prefill on open with the current tab's `worktreePath` when one is resolvable from existing context. Otherwise it is empty. The host page (no active tab) prefills empty.

- **GIVEN** the user is viewing a tab whose `worktreePath` is `~/code/x`
- **WHEN** they open New workspace
- **THEN** the folder field reads `~/code/x`

#### R8: The name follows the folder until edited
While the name field is untouched, choosing or typing a folder SHALL prefill the name with `toSafeServerName(deriveNameFromPath(folder))`. Once the user types in the name field, the folder SHALL no longer drive it, until the dialog is closed and reopened.

- **GIVEN** an untouched name
- **WHEN** the folder becomes `~/code/my app`
- **THEN** the name reads `my_app`
- **AND** after the user types `foo` in the name, changing the folder leaves `foo`

#### R9: The create lifecycle is unchanged
Ghost, pending marker, navigate to `/$server` and `refreshServers` SHALL behave exactly as today. Only the action's arguments gain `cwd`.

- **GIVEN** a create with a folder
- **WHEN** it is submitted
- **THEN** the UI shows the waiting state and then the workspace view, as before

#### R10: Creating an existing workspace name is refused
<!-- rework c1: review S1. The folder-derived prefill makes the current workspace's own name the default, and nothing rejected it. -->
`handleServerCreate` SHALL return **409** `Workspace "<name>" already exists` before any tmux call when a live server with that name already exists (checked through the existing tmux server-listing seam). This applies whether `cwd` is present or absent. It replaces the old accidental behavior, where the create either 500ed on a duplicate `"0"` or silently added a group to the live server. Both create-workspace dialogs SHALL disable Create and show an inline hint (`A workspace named <name> already exists`) when the finalized name matches a server in `ctx.servers`.

- **GIVEN** workspace `hexokit` is live and the current tab is at `~/code/hexokit`
- **WHEN** the user opens New workspace
- **THEN** the name prefills `hexokit`, Create is disabled, and the hint shows
- **AND** a direct `POST /api/servers {"name":"hexokit"}` returns 409 with no `CreateSession` call

### Non-Goals

- The `rk mux new` / MCP `new_server` `--cwd` flag: out of scope. Those callers keep the legacy default.
- Navigating straight to the new group's tab using the `group` response field: the landing route is unchanged (R9).
- An existence check on `cwd`: the session handler has none. tmux falls back on its own.

### Design Decisions

#### Server-side first-group derivation
**Decision**: The backend derives the first group's name from the raw `cwd` with a Go port of `deriveNameFromPath`. An empty result falls back to `main`.
**Why**: One request creates the workspace correctly with no client race. It also matches how instant group creation already names groups after their folder.
**Rejected**: Creating then renaming or killing `"0"` from the client. It is racy and flashes a junk group.
*Introduced by*: 261030-qm52-workspace-create-at-folder

## Tasks

### Phase 1: Backend

- [x] T001 Add `validate.SessionNameFromPath(p string) string` (Go port of `deriveNameFromPath` + `toSafeSessionName` + `finalizeSafeName`, capped at `MaxNameLength`) with table tests in `app/backend/internal/validate/validate.go` / `validate_test.go` <!-- R2 -->
- [x] T002 Extract the shared cwd-validation helper (ValidatePath + ExpandTilde → `(resolved, errMsg)`) and use it from `handleSessionCreate` in `app/backend/api/sessions.go` with no behavior change <!-- R1 -->
- [x] T003 Rework `handleServerCreate` in `app/backend/api/servers.go`: optional `cwd`, folder-named first group with a `main` fallback, legacy `"0"`/$HOME when absent, response `{"ok":true,"group":…}` <!-- R1 R2 R3 R4 -->
- [x] T004 Add `api/servers_test.go` cases: cwd absent → `"0"`@home; cwd present → derived group at expanded path; `~` → `main`; invalid cwd (outside home, `~user`) → 400 with no CreateSession; invalid name → 400; response carries `group` <!-- R1 R2 R3 R4 -->

### Phase 2: Frontend

- [x] T005 `createServer(name, cwd?)` in `app/frontend/src/api/client.ts` (cwd only when non-empty; return type adds `group?: string`) plus a client unit test if a client test file covers `createServer` <!-- R5 -->
- [x] T006 Extract the folder combobox from `components/create-session-dialog.tsx` into a reusable `components/folder-path-input.tsx` and re-wire `create-session-dialog.tsx` onto it; keep that dialog's tests green <!-- R6 -->
- [x] T007 `components/server-dialogs.tsx`: add the folder field, prefill it from the current tab's `worktreePath`, make the name follow the folder until edited, pass `cwd` through `executeCreateServer` <!-- R6 R7 R8 R9 -->
- [x] T008 `components/host-overview-page.tsx`: the same folder field and name-follow, with an empty prefill and `cwd` passed through <!-- R6 R8 R9 -->

### Phase 3: Tests & evidence

- [x] T009 Vitest: the dialog sends `cwd`; a blank folder sends none; the name follows the folder until typed; the extracted input keeps the quick-picks/autocomplete behavior (`server-dialogs.test.tsx` / host page test / `folder-path-input.test.tsx`) <!-- R6 R7 R8 -->
- [x] T010 E2E: create a workspace with a folder → the sidebar shows a group named after the folder, not `0` (new or extended spec under `app/frontend/tests/e2e/`; run via `just test-e2e <spec>`) <!-- R2 R9 -->
- [x] T011 PR evidence: a demo spec under `app/frontend/tests/demo/` showing the dialog with a folder and the resulting sidebar; record `just demo <name> --before` and after, desktop and mobile <!-- R6 R9 -->

### Phase 4: Rework cycle 1

- [x] T012 `app/backend/api/servers.go` `handleServerCreate`: 409 `Workspace "<name>" already exists` when the server is already live, checked after name validation and before cwd/tmux work, through the existing `s.tmux` server-listing seam (extend `mockTmuxOps` if needed); add `servers_test.go` cases for 409 with and without cwd, with no CreateSession call <!-- R10 -->
- [x] T013 `components/create-workspace-dialog.tsx` (shared by both dialogs): disable Create and show the inline hint `A workspace named <name> already exists` when the finalized name is in the known server list (passed in by each host from `ctx.servers`); Vitest for the prefill-collision case <!-- R10 -->
- [x] T014 [P] `components/server-dialogs.tsx`: build the folder quick-picks from every workspace's groups (as `host-overview-page.tsx:74-77` does), not only the current workspace's (review N1) <!-- R6 -->
- [x] T015 [P] `internal/validate/validate.go` `SessionNameFromPath`: one-line comment that the byte-based cap intentionally differs from `names.ts`'s UTF-16 slice, because `ValidateName` measures bytes (review N3) <!-- R2 -->

<!-- Apply note: T007 + T008 share one `components/create-workspace-dialog.tsx` (name + folder + name-follow) rather than duplicating the markup in both dialogs; each host keeps its own create lifecycle. -->
<!-- Apply note: T011 recorded desktop + mobile, before + after (`.demo/workspace-create-at-folder-{before,after}-{desktop,mobile}.webm`). The before pass has no folder field, so the spec falls back to a name-only create and shows the legacy "0" group. -->

## Execution Order

- T001, T002 block T003; T003 blocks T004
- T006 blocks T007, T008
- T005 blocks T007, T008

## Acceptance

### Functional Completeness

- [x] A-001 R1: `POST /api/servers` with a valid `cwd` creates the first group at the expanded path
- [x] A-002 R2: The first group is named by the Go `deriveNameFromPath` port; empty derivation → `main`
- [x] A-003 R3: With no `cwd`, the create is byte-identical to before (`"0"` at $HOME)
- [x] A-004 R4: The 201 response carries `group`
- [x] A-005 R5: `createServer` sends `cwd` only when non-empty
- [x] A-006 R6: Both create-workspace dialogs render the shared folder input; the Create tab at folder dialog uses the same component unchanged
- [x] A-007 R7: The ServerDialogs folder prefills from the current tab's worktree path when available
- [x] A-008 R8: The name follows the folder until the user edits the name

### Behavioral Correctness

- [x] A-009 R1: `handleSessionCreate` validation behavior is unchanged after the helper extraction (existing session tests pass)
- [x] A-010 R9: Ghost/pending/navigate/refresh lifecycle unchanged

### Scenario Coverage

- [x] A-011 R2: E2E proves a folder-created workspace shows a folder-named group and no `0`
- [x] A-012 R1: Go tests cover cwd present, absent, `~`, and invalid

### Edge Cases & Error Handling

- [x] A-013 R1: A cwd outside $HOME or `~user` returns 400 and runs no tmux command
- [x] A-014 R2: Names with dots, hyphens, spaces, and trailing slashes derive to valid `ValidateNewName` names

- [x] A-018 R10: An already-live workspace name returns 409 before any tmux call (with and without `cwd`), and both dialogs disable Create with the hint when the name collides

### Code Quality

- [x] A-015 Pattern consistency: New code follows the naming and structure of the surrounding handlers and dialogs
- [x] A-016 No unnecessary duplication: The cwd validation and folder combobox each live in one place

### Security

- [x] A-017 R1: User-supplied `cwd` reaches tmux only after ValidatePath + ExpandTilde, via the existing `exec.CommandContext` argument-slice path; no new subprocess sites

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the inline cwd validation in `handleSessionCreate`, the combobox in `create-session-dialog.tsx`, and both dialogs' inline name markup/regex were already removed by the extraction).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Derive the group name from the raw `cwd` (not the expanded path) so `~` → `main` as the intake specifies | Matches the frontend `deriveNameFromPath` input; the intake names `~` → `main` | S:75 R:90 A:80 D:75 |
| 2 | Confident | No existence check on `cwd` | `handleSessionCreate` has none; the intake says reuse it, don't extend it | S:70 R:90 A:80 D:80 |
| 3 | Confident | Landing route stays `/$server`; the `group` field is informational | Intake: lifecycle unchanged | S:70 R:90 A:80 D:75 |
| 4 | Tentative | New component name `folder-path-input.tsx` | The intake leaves naming open; easy to rename | S:50 R:95 A:70 D:60 |

4 assumptions (0 certain, 3 confident, 1 tentative).
