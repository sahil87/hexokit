# Plan: Folder-First New Sheet

**Change**: 261030-6d2o-folder-first-new-sheet
**Intake**: `intake.md`

## Requirements

### Backend: Git worktrees endpoint

#### R1: `GET /api/worktrees?path=<folder>`
The server SHALL expose a read-only `GET /api/worktrees?path=<folder>` returning `{"repo": "<basename>", "worktrees": [{"path": "<abs>", "branch": "<name>"}]}`. It MUST validate `path` with `validate.ValidatePath` and expand it with `validate.ExpandTilde` (via the shared `resolveWorkingDir`), and MUST run `git -C <path> worktree list --porcelain` through `exec.CommandContext` with a timeout and an argument slice. A missing/empty `path` or a path that is not inside a git repository SHALL answer 200 with `{"repo": "", "worktrees": []}`; an invalid path SHALL answer 400. The `repo` name is the basename of the repository's main worktree.

- **GIVEN** a git repo with a linked worktree under `$HOME`
- **WHEN** the client requests `/api/worktrees?path=<repo>`
- **THEN** both worktrees are returned with their branch names and `repo` is the main worktree's basename
- **GIVEN** a directory that is not a git repository
- **WHEN** the client requests `/api/worktrees?path=<dir>`
- **THEN** the response is 200 `{"repo":"","worktrees":[]}`
- **GIVEN** a path containing a newline or outside `$HOME`
- **WHEN** requested
- **THEN** the response is 400

### Frontend: New sheet

#### R2: One sheet, three levels
A `NewSheet` component (`components/new-sheet.tsx`) on the shared `Dialog` shell SHALL create a Tab, a Group, or a Workspace from one folder-first flow, with a level switch (`aria-pressed` buttons) whose buttons show the effective chord for the levels that have one. The level always comes from the opener. The sheet is ~520px wide on desktop and a bottom sheet below `sm` (a new `Dialog` size variant).

- **GIVEN** the sheet opens at Group level
- **WHEN** the user presses the `Tab` level button
- **THEN** the Tab button is `aria-pressed` and the preview and primary-button label switch to tab wording

#### R3: Folder field, list, and autocomplete
The folder field SHALL be prefilled with the context folder, focused with its text selected. The list SHALL show, in order, **Current** (the context folder, with branch chip and `active tab`), **Worktrees · <repo>** (from `/api/worktrees`, each with branch chip and `N tabs open` when tabs sit there), **Open elsewhere** (distinct tab `worktreePath`s across the workspace's groups, deduped against rows already listed). When the field holds text that is not an exact list match, the list SHALL instead show debounced `getDirectories` autocomplete results (reusing `FolderPathInput`'s suggestion logic).

- **GIVEN** a workspace whose groups have tabs in three folders
- **WHEN** the sheet opens on one of them
- **THEN** Current shows it and Open elsewhere lists only the other two
- **GIVEN** the user types `~/co`
- **WHEN** the debounce elapses
- **THEN** directory suggestions replace the folder list

#### R4: Preview and name derivation
A preview line SHALL state exactly what will be created in Workspace/Group/Tab vocabulary (`New tab in <ws> › <group> at <folder>`, `New group <name> in <ws>, first tab at <folder>`, `New workspace <name> (tmux -L <name>), first group and tab at <folder>`). Group and workspace names SHALL derive from the folder with `deriveNameFromPath` and the per-kind `toSafe*Name`, deduped against live names by `-2`…`-10` then `-11` (workspace names too). An already-live workspace name that a user-typed override produces SHALL disable Create with the hint `A workspace named <name> already exists`.

- **GIVEN** a workspace with a group `hexokit`
- **WHEN** the Group level has folder `~/code/hexokit`
- **THEN** the preview names the new group `hexokit-2`
- **GIVEN** the Workspace name override is `rk-daemon` and that workspace exists
- **WHEN** the user attempts to create
- **THEN** Create is disabled with the already-exists hint

#### R5: Keyboard handling
`Enter` SHALL create with the field's folder and the derived (or overridden) name. `↑/↓` SHALL move through the list (selecting a list row sets the field; selecting an autocomplete row fills the field without creating). `Tab`/`Shift+Tab` in the folder field SHALL cycle the level. `⌘↵`/`Ctrl+↵` SHALL open the name override (a name input prefilled with the derived name, select-all'd; Tab level has no name). `Esc` SHALL close.

- **GIVEN** the sheet at Group level with focus in the folder field
- **WHEN** the user presses `Ctrl+Enter`
- **THEN** a name input appears prefilled with the derived name and Enter creates with the typed name

#### R6: Create actions via existing APIs
Tab SHALL call `createWindow(server, group, undefined, cwd)` with the optimistic ghost labelled `rawBasename(cwd)`; Group SHALL call `createSession(server, name, cwd)` through the optimistic ghost-session path; Workspace SHALL call `createServer(name, cwd)` plus `markServerPending(name)` and navigate to `/$server`. The sheet closes on submit; ⌘T / `create-window` and the instant `create-session` chord stay instant with no sheet.

- **GIVEN** the sheet at Workspace level with name `api` and folder `~/code/api`
- **WHEN** Create fires
- **THEN** `createServer("api", "~/code/api")` is called and the app navigates to `/api`

### Frontend: Openers

#### R7: Opener context and palette wiring
A `new-sheet-context` (state + referentially stable `openNewSheet({level, server?, group?})`/`closeNewSheet`, `newSheetOpen`), provided at `AppLayout` like `server-dialogs-context`, SHALL drive a single layout-mounted host. Palette: `Tab: Create at Folder` opens Tab level, new `Group: Create at Folder` opens Group level, `Workspace: Create` opens Workspace level. The sheet's open state MUST fold into AppShell's modal-gating predicate.

- **GIVEN** a current group
- **WHEN** the user runs `Group: Create at Folder` from the palette
- **THEN** the New sheet opens at Group level

#### R8: Remove the window-only dialog
`create-session-dialog.tsx`, its lazy import, `showCreateWindowAtFolderDialog` state, and its render site SHALL be deleted. `FolderPathInput` and `CreateWorkspaceDialog` stay (other consumers).

- **GIVEN** the codebase after this change
- **WHEN** searching for `CreateSessionDialog`
- **THEN** no source reference remains

### Non-Goals
- Run options (shell/claude/codex/riff/web page) in the sheet — study §4 "open".
- `+ new worktree from main…` row (`wt create`) — deferred.
- Durable per-workspace recent folders — would need Constitution II persistence.
- Changing ⌘T / instant `create-session` behavior or the split button (change 4).

## Tasks

### Phase 1: Backend

- [x] T001 Add `app/backend/api/worktrees.go` (`handleWorktrees`: `resolveWorkingDir`, `exec.CommandContext` `git -C` with timeout, porcelain parser) and register `r.Get("/api/worktrees", s.handleWorktrees)` in `app/backend/api/router.go` <!-- R1 -->
- [x] T002 [P] Add `app/backend/api/worktrees_test.go` (repo + linked worktree, non-repo, empty path, invalid path, porcelain parser units incl. detached/bare) <!-- R1 -->

### Phase 2: Frontend core

- [x] T003 Add `getWorktrees(path)` + `WorktreesResponse` type to `app/frontend/src/api/client.ts` (+ client test) <!-- R1 -->
- [x] T004 Extract `useDirectorySuggestions` from `app/frontend/src/components/folder-path-input.tsx` (used by `FolderPathInput` and the sheet); add `tabFolders(sessions)` beside `projectRoots` <!-- R3 -->
- [x] T005 Add `app/frontend/src/lib/new-sheet.ts` (pure logic: level order/labels, `deriveUniqueName`, `buildFolderSections`, `previewFor`, tab counts) + `new-sheet.test.ts` <!-- R3 R4 -->
- [x] T006 Add `size="sheet"` variant to `app/frontend/src/components/dialog.tsx` (520px desktop, bottom sheet below `sm`) + `dialog.test.tsx` cases <!-- R2 -->
- [x] T007 Add `app/frontend/src/components/new-sheet.tsx` (+ `new-sheet.test.tsx`): level switch, folder field, grouped list, preview, footer, name override, keyboard map <!-- R2 R3 R4 R5 -->
- [x] T008 Add `app/frontend/src/contexts/new-sheet-context.tsx` (+ test) <!-- R7 -->

### Phase 3: Integration

- [x] T009 Add `app/frontend/src/components/new-sheet-host.tsx` (layout-mounted; resolves server/group/context folder from `SessionContext` + route; runs the three create actions; lazy `NewSheet`) and mount in `app.tsx` `AppLayout` with `NewSheetProvider` <!-- R6 R7 -->
- [x] T010 Wire palette in `app/frontend/src/app.tsx`: `Tab: Create at Folder` → Tab level, new `Group: Create at Folder` (id `create-session-at-folder`), `Workspace: Create` → Workspace level; fold `newSheetOpen` into the modal-gating predicate <!-- R7 -->
- [x] T011 Delete `app/frontend/src/components/create-session-dialog.tsx` and its lazy import / state / render site in `app.tsx`; update stale comment references <!-- R8 -->

### Phase 4: Verification and evidence

- [x] T012 Run `go vet ./... && go test ./api/ ./internal/...`, `npx tsc --noEmit`, affected Vitest files <!-- R1 R2 R3 R4 R5 R6 R7 R8 -->
- [x] T013 Add e2e `app/frontend/tests/e2e/new-sheet.spec.ts` (palette → pick folder → create group → sidebar shows folder-named group) and run via `just test-e2e "new-sheet"` <!-- R6 R7 -->
- [x] T014 Add `app/frontend/tests/demo/new-sheet.demo.ts` and record via `just demo new-sheet` (note blocker if recording infra is unavailable) <!-- R2 R3 R6 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `GET /api/worktrees` exists, runs git via `exec.CommandContext` with a timeout and returns the documented JSON
- [x] A-002 R2: The sheet renders a level switch with `aria-pressed` buttons and a bottom-sheet presentation below `sm`
- [x] A-003 R3: Folder list shows Current / Worktrees · repo / Open elsewhere sections and falls back to directory autocomplete for typed text
- [x] A-004 R4: Preview line and primary-button label track the level in Workspace/Group/Tab vocabulary
- [x] A-005 R5: Enter, ↑/↓, Tab/Shift+Tab, ⌘↵/Ctrl+↵, and Esc behave as specified
- [x] A-006 R6: Each level calls its existing API (`createWindow`, `createSession`, `createServer`) with the folder as cwd
- [x] A-007 R7: Palette `Tab: Create at Folder`, `Group: Create at Folder`, `Workspace: Create` open the sheet at the right level via the opener context
- [x] A-008 R8: `CreateSessionDialog` and its wiring are gone

### Behavioral Correctness

- [x] A-009 R6: ⌘T `create-window` and the instant `create-session` chord still create without the sheet
- [x] A-010 R4: Group/workspace names derive from the folder, deduped `-2`…`-10`/`-11`

### Removal Verification

- [x] A-011 R8: No remaining import, state, or render of `CreateSessionDialog`; `FolderPathInput` and `CreateWorkspaceDialog` retained

### Scenario Coverage

- [x] A-012 R1: Go tests cover repo with linked worktree, non-repo, invalid path
- [x] A-013 R2: Vitest covers the level switch and preview text per level
- [x] A-014 R5: Vitest covers keyboard handling and the right API call per level
- [x] A-015 R6: e2e opens via the palette, picks a folder, creates a group, sees the folder-named group in the sidebar

### Edge Cases & Error Handling

- [x] A-016 R4: An already-live workspace name disables Create with `A workspace named <name> already exists`
- [x] A-017 R7: On the host page (no workspace) Tab/Group levels are unavailable and the sheet falls back to Workspace level
- [x] A-018 R1: A non-repo folder yields an empty worktrees list and the sheet simply omits that section

### Code Quality

- [x] A-019 Pattern consistency: New code follows `server-dialogs-context` / lazy+Suspense / `Dialog` shell patterns
- [x] A-020 No unnecessary duplication: `FolderPathInput` suggestion logic, `deriveNameFromPath`/`toSafe*Name`, and the create-workspace collision rule are reused, not copied
- [x] A-021: All Go subprocess calls use `exec.CommandContext` with timeouts and argument slices
- [x] A-022: No comment narration; comments state constraints only
- [x] A-023: New features include tests (Go + Vitest + e2e) and a `just demo` recording or a recorded blocker

### Security

- [x] A-024 R1: `path` is validated (`ValidatePath` + `ExpandTilde`, home-bounded) and passed to git as an argument, never via a shell

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- T012: `go test ./api/ ./internal/...` is green except `internal/wtdiff` `TestReadAgainstARealRepository` ("a modified file inside the eager budget shipped no rows"), a package this change does not touch; full Vitest (266 files) and `tsc --noEmit` are green.
- T013/T014: `just test-e2e` for `new-sheet`, `create-server-waiting`, `session-name-prompt`, `create-workspace-at-folder` pass; `just demo new-sheet --before` recorded `.demo/new-sheet-{before,after}-{desktop,mobile}.webm`.
- The `create-server-waiting` e2e now drives the New sheet (its `Workspace: Create` palette entry no longer opens the name-only dialog).
- Vite logs a duplicate React key `go-host` (`app.tsx` + `lib/palette/nav.ts`) in the palette; it predates this change and is unrelated.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `repo` in `/api/worktrees` is the main worktree's basename, not `--show-toplevel`'s | `show-toplevel` from a linked worktree returns the worktree dir (e.g. `gutsy-bullfrog`), which would mislabel `Worktrees · <repo>` | S:70 R:90 A:75 D:70 |
| 2 | Confident | Detached worktrees come back with `branch: ""`; the chip shows `detached` | Matches porcelain (no `branch` line); keeps the documented schema | S:70 R:90 A:80 D:70 |
| 3 | Confident | `↑/↓` on a list row sets the folder field; on an autocomplete row it fills the field without creating | Directory suggestions are navigation, not destinations; list rows are valid destinations | S:60 R:90 A:75 D:65 |
| 4 | Confident | Mounted as a layout-level `NewSheetHost` (like `ServerDialogs`) that owns the create actions, rather than inside `AppShell` | The opener seam must serve boards/host pages and change 4's callers; `AppShell`-only state would not | S:75 R:80 A:80 D:70 |
| 5 | Confident | Tab/Group levels are disabled (and the sheet coerces to Workspace) when no workspace/group target resolves, e.g. on the host page | Tab/Group have no target there; Workspace is always valid | S:70 R:90 A:80 D:75 |
| 6 | Tentative | New `Dialog` size `sheet` = `sm:max-w-[520px]`, pinned to the bottom with square bottom corners below `sm` | The mock used ~520px; polish call | S:50 R:95 A:60 D:55 |
| 7 | Tentative | Group-level keycap shows the current `create-session` chord label (none on mac) until change 4 lands ⌥⌘T | Intake allows "no keycap, or the current binding" | S:55 R:95 A:65 D:55 |
| 8 | Confident | Workspace names are deduped on derivation against live workspace names (`-2`…`-10`, `-11`) like groups | The preview must show a creatable name; a collision only blocks a user-typed override | S:65 R:90 A:75 D:65 |

8 assumptions (0 certain, 6 confident, 2 tentative).
