# Intake: Folder-First New Sheet

**Change**: 261030-6d2o-folder-first-new-sheet
**Created**: 2026-10-30

## Origin

> I want to make it easier to 1) start a new server (Workspace), 2) start a new session (Group) 3) Start a new window (tab). Can you think of ways, present mocks to me.

Conversational (`/fab-discuss` on 2026-10-30). Design study `docs/wiki/create-flow-studies.html` §4 (Option B) is the mock for this change, and §6 holds the final recommendation the user approved ("Ok, nice. Proceed" → "Sequenced changes"). This is **change 3 of 4**. It depends on `261030-g0gv-ui-rename-workspace-group-tab` (vocabulary) and `261030-qm52-workspace-create-at-folder` (`POST /api/servers {name, cwd}`). It is consumed by `261030-5am0-sidebar-head-new-split-button`, whose "…" menu rows open this sheet.

## Why

Today the three levels use three different create grammars: a workspace gets a name-only dialog, a group is created instantly with a name derived from the active tab's folder, and a tab is created instantly and unnamed. None of them can choose a folder except the palette-only `Tab: Create at Folder` (`create-session-dialog.tsx`), and the session-level at-folder action was removed. So opening a *different* repo or worktree means `cd`-ing in a shell first. The study ranked this friction #2 (folders can't be chosen) and #5 (no shared grammar).

The **folder is the real input**: names already derive from folders everywhere (tmux auto-names tabs; instant groups use `deriveNameFromPath`). One sheet whose primary input is the folder, with a level switch, covers all three levels in one flow.

Rejected alternatives (from the study): per-level dialogs (keeps three grammars); a top-bar-only menu without a sheet (can't pick folders).

## What Changes

### The sheet component

A new `NewSheet` (`components/new-sheet.tsx`, lazy + Suspense like `SessionNamePrompt`) on the shared `Dialog` shell. It's about 520px wide on desktop (a new `Dialog` size, or `sm` widened; follow the `Dialog` size conventions in dialogs-and-state.md) and a bottom sheet on mobile (< sm). It replaces `CreateSessionDialog` (the window-only "at Folder" dialog), which is deleted along with its palette wiring once the sheet covers it.

Layout, top to bottom (match the study's §4 mock):

1. **Title row**: `New` + a **level switch** (segmented control, `aria-pressed` buttons): `Tab ⌘T` · `Group ⌥⌘T` · `Workspace`. The keycaps show the platform's effective chord via the existing keybinding label helpers. (The ⌥⌘T group chord itself lands in change 4. Until then the Group button shows no keycap, or the current `create-session` binding.)
2. **Folder field**: label `folder`. It's prefilled with the context folder (the active tab's `worktreePath`; on the workspace page, the most recent tab's folder in that workspace; on the host page, empty) and focused with everything selected.
3. **Folder list**, grouped with small uppercase section headers:
   - **Current**: the context folder, with its branch chip and the meta `active tab`.
   - **Worktrees · <repo>**: the git worktrees of the context folder's repo, from a new read-only endpoint (below), each with a branch chip and `N tabs open` when tabs already sit there.
   - **Open elsewhere**: the distinct `worktreePath`s of tabs across the current workspace's groups (today's `quickPicks` logic, widened from `windows[0]` to all windows), excluding ones already listed.
   - When the field has typed text that isn't an exact list match, the list instead shows `getDirectories(value)` autocomplete results (today's debounced behavior in `create-session-dialog.tsx`).
4. **Preview line** (`bg-inset` box): exactly what will be created, in the new vocabulary, with a mini tree marking the new node in green:
   - Tab: `New tab in <ws> › <group> at <folder>`
   - Group: `New group <name> in <ws>, first tab at <folder>`
   - Workspace: `New workspace <name> (tmux -L <name>), first group and tab at <folder>`
   Names derive with `deriveNameFromPath` + the per-kind `toSafe*Name` and are deduped like instant creation (`-2`…`-10`).
5. **Footer**: hints `Tab level` · `↑↓ folder` · `⌘↵ name it…`, and a primary button whose label tracks the level (`Create tab ↵` / `Create group ↵` / `Create workspace ↵`).

Keyboard: `Enter` creates with the selected folder and derived name. `↑/↓` move through the folder list. `Tab`/`Shift+Tab` cycle the level while focus is in the field. `⌘↵` / `Ctrl+↵` opens the name override (a name input prefilled with the derived name, select-all'd, the `SessionNamePrompt` save-as model; Tab level has no name because tabs stay unnamed and tmux auto-names them). `Esc` closes.

### Create actions (existing APIs)

- Tab → `createWindow(server, group, undefined, cwd)` (no name; the optimistic ghost label is `rawBasename(cwd)` as `+ New Window` does today).
- Group → `createSession(server, name, cwd)` via the instant-create path's optimistic ghost machinery.
- Workspace → `createServer(name, cwd)` (change 2) + `markServerPending(name)` + navigate to `/$server`, the existing create-server lifecycle.

### New read-only endpoint: git worktrees

`GET /api/worktrees?path=<folder>` → `{"repo": "<toplevel basename>", "worktrees": [{"path": "...", "branch": "..."}]}`. It runs `git -C <path> worktree list --porcelain` via `exec.CommandContext` with a timeout and an argument slice (Constitution I). `path` is validated with `validate.ValidatePath` + `ExpandTilde`. A non-repo path returns `{"worktrees": []}` with 200. Paths come back `~`-abbreviated by the frontend's `abbreviateHomePath`.

### Openers

- Palette: `Tab: Create at Folder` → the sheet at Tab level; new `Group: Create at Folder` → the sheet at Group level; `Workspace: Create` → the sheet at Workspace level (replacing the name-only create-workspace dialog's palette entry; the dialog's other openers move in change 4).
- The sheet exposes an opener seam (`openNewSheet({level, server?, group?})`) via a small context following `server-dialogs-context.tsx` (state + referentially stable triggers, mounted once in `AppLayout`), so change 4's split button and per-group `+` can open it.
- **Not changed here:** ⌘T / `create-window` and the instant `create-session` keep creating instantly with no sheet (study §6: one-click and chord creates stay instant).

### Out of scope (deferred, study §4 "open")

- Run options (shell / claude / codex / riff preset / web page) inside the sheet.
- The `+ new worktree from main…` row (runs `wt create`).
- Durable per-workspace "recent folders" (would need a tmux option or a state-home file per Constitution II).

### Tests and evidence

Vitest for the level switch, preview text per level, name derivation and dedupe, keyboard handling, and the right API call per level. Go tests for `/api/worktrees` (repo, non-repo, invalid path). e2e: open via the palette, pick a folder, create a group → the sidebar shows the folder-named group. `just demo new-sheet` (desktop and mobile) for PR evidence.

## Affected Memory

- `run-kit/ui/dialogs-and-state`: (modify) the New sheet replaces `CreateSessionDialog`; opener context
- `run-kit/ui/routes-and-shell`: (modify) create-at-folder flows per level
- `run-kit/ui/keyboard-and-palette`: (modify) `Tab/Group: Create at Folder`, `Workspace: Create` open the sheet
- `run-kit/api-and-sockets`: (modify) `GET /api/worktrees`

## Impact

Frontend: new `new-sheet.tsx` + opener context + palette wiring in `app.tsx`/`lib/palette`; delete `create-session-dialog.tsx`. Backend: one read-only handler + route + tests. Uses change 2's `createServer(name, cwd)`.

## Open Questions

- Should the sheet remember the last level used per opener? Default: no; the level always comes from the opener.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | One sheet for all three levels, folder as the primary input, live preview | Study §4/§6, approved by the user | S:85 R:75 A:85 D:85 |
| 2 | Confident | Chords and one-click creates stay instant; only "…"/at-folder openers use the sheet | Study §6 revised trigger table | S:80 R:85 A:80 D:75 |
| 3 | Confident | Folder sources v1: current, git worktrees (new endpoint), folders open in the workspace, autocomplete | Study §4 mock; durable recents deferred for Constitution II | S:70 R:85 A:70 D:65 |
| 4 | Confident | Run options and "+ new worktree" are deferred | Marked "open" in study §4/§6 | S:75 R:90 A:75 D:75 |
| 5 | Confident | `CreateSessionDialog` is deleted and replaced by the sheet | It's the window-only predecessor; keeping both duplicates the folder picker | S:60 R:80 A:75 D:70 |
| 6 | Confident | The tab level has no name override (tabs stay unnamed and tmux auto-names them) | The existing "Unnamed + New Window" convention | S:65 R:90 A:85 D:80 |
| 7 | Tentative | Width about 520px via a new or adjusted `Dialog` size | The mock used ~520px; exact size is a polish call <!-- assumed: ~520px sheet width --> | S:45 R:95 A:55 D:50 |

7 assumptions (1 certain, 5 confident, 1 tentative, 0 unresolved).
