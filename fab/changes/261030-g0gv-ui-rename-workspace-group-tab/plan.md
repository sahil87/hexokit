# Plan: UI Rename — Server → Workspace, Session → Group, Window → Tab

**Change**: 261030-g0gv-ui-rename-workspace-group-tab
**Intake**: `intake.md`

## Requirements

### UI Copy: Vocabulary

#### R1: Workspace replaces tmux server in UI copy
Every user-visible string in `app/frontend/src/` (JSX text, `aria-label`, `title`, `placeholder`, `Tip label`, palette `label`, keybinding `label`/`description`/`mapLabel`, toast/error text that the frontend composes) that names a **tmux server** SHALL say **Workspace** (title case at the start of a label, `workspace` mid-sentence). This includes `tmux Server` / `tmux server` / `Tmux servers`, which become `Workspace` / `workspace` / `Workspaces` (the `tmux` qualifier is dropped from the noun). The palette family prefix `Server:` SHALL become `Workspace:`. The top-bar heading prefix constant `TMUX_SERVER_PREFIX` SHALL render `Workspace:`.

- **GIVEN** the command palette is open
- **WHEN** the user types `workspace`
- **THEN** rows formerly labelled `Server: Create`, `Server: Kill <n>`, `Server: Set Color`, `Server: Protect <n>`, `Server: Adopt <n> into HexoKit`, `Server: Move up/down`, `Server: Restore <n>`, `Server: Dismiss recovery <n>`, `Server: Switch to …` appear as `Workspace: …`
- **AND** no palette row starts with `Server:`

#### R2: Group replaces tmux session in UI copy
Every user-visible string naming a **tmux session** SHALL say **Group** / `group`, and the palette prefix `Session:` SHALL become `Group:`. Sidebar titles `Sessions` become `Groups`. The keyboard map description `New session (a new group of tabs)` becomes `New group`.

- **GIVEN** a tab is open in a group named `hexokit`
- **WHEN** the user hovers the group row's flyout card
- **THEN** the card title reads `Group hexokit` and its rows read `New tab`, `Rename group`, `Kill group`
- **AND** the kill confirm reads `Kill group hexokit and all its tabs?`

#### R3: Tab finishes replacing tmux window in UI copy
Remaining user-visible strings naming a **tmux window** SHALL say **Tab** / `tab`, and the palette prefix `Window:` SHALL become `Tab:` (e.g. `Window: Set note…` → `Tab: Set note…`; `Session: Sort windows…` → `Group: Sort tabs…`). Strings naming a **browser/desktop-app window** (e.g. `App: New Window`, `New app window`, `Close app window`, popout windows, "window" meaning the OS window) SHALL NOT change.

- **GIVEN** the palette
- **WHEN** the user searches `note`
- **THEN** the row reads `Tab: Set note…`
- **AND** `App: New Window` is unchanged

#### R4: Web-tile tabs are "web tabs"
User-visible strings that refer to the web tile's own tab strip (`@N/web/<n>`) and currently say a bare "tab" SHALL say "web tab", so Tab unambiguously means a tmux window.

- **GIVEN** the web tile's strip
- **WHEN** the user hovers its add/close controls
- **THEN** Tips and aria-labels say "web tab" (e.g. `New web tab`, `Close web tab`)

#### R5: tmux terms survive only as secondary facts
Flyout-card facts lines SHALL keep the tmux identifiers as secondary facts: the workspace card keeps `tmux -L <name>` (its count noun becomes `groups`), and the group card keeps `$<id>`. The External-workspace facts suffix keeps "not started by HexoKit".

- **GIVEN** workspace `work` with 3 groups
- **WHEN** its card opens
- **THEN** the facts line reads `tmux -L work · 3 groups`

### Scope Boundary

#### R6: Non-copy surfaces are unchanged
Code identifiers, prop/function/file names, `data-testid`s, route params (`/$server/$window`), the `?server=` search param, API paths and payloads, localStorage keys, CLI verbs, tmux option names, Go code, and backend-originated error strings SHALL NOT change.

- **GIVEN** the change's diff
- **WHEN** it is reviewed
- **THEN** no `data-testid`, route definition, API path, storage key or `.go` file is renamed

### Docs

#### R7: The design study ships and is indexed
`docs/wiki/create-flow-studies.html` SHALL be committed, and `docs/specs/index.md` SHALL gain a design-study row for it. Docs pages under `docs/site/**` that quote a renamed UI label verbatim SHALL be updated.

- **GIVEN** `docs/specs/index.md`
- **WHEN** a reader scans the design-study table
- **THEN** a `Create Flow Studies` row links `../wiki/create-flow-studies.html`

### Tests

#### R8: Tests assert the new copy
Unit and e2e tests that assert renamed strings SHALL be updated to the new copy, and the affected suites SHALL pass.

- **GIVEN** the updated sources
- **WHEN** `npx tsc --noEmit`, the affected Vitest files and the text-selecting e2e specs run
- **THEN** they pass

### Non-Goals

- CLI aliases (`rk workspace`, `rk group`) — a separate decision
- Renaming code identifiers (`createSession`, `ServerPanel`, `session-row.tsx`, …) — churn without user value
- Backend/API error message wording — shared with CLI/MCP clients

### Design Decisions

#### UI vocabulary diverges from the tmux layer by design
**Decision**: The UI says Workspace / Group / Tab; the CLI, API, URL params and tmux options keep server / session / window.
**Why**: The UI speaks to people organizing work; the lower layers speak tmux and are a stable contract (CLI-as-contract). "Workspace" also disambiguates the tmux server from the HexoKit daemon and remote hosts.
**Rejected**: A full-stack rename (breaks scripts, MCP clients and URLs for no UI benefit); keeping tmux nouns in the UI (opaque to non-tmux users, and already inconsistent after the Window → Tab move).
*Introduced by*: 261030-g0gv-ui-rename-workspace-group-tab

## Tasks

### Phase 1: Core copy sweep

- [x] T001 [P] Rename palette families in `app/frontend/src/app.tsx` (`Server:`/`Session:`/`Window:` label strings incl. template-literal labels like `` `Server: Kill ${name}` ``), plus dialog titles/fields/kill copy rendered there (`Kill session?`, `Rename session`, `Session name`, `Session name...`) <!-- R1 R2 R3 -->
- [x] T002 [P] Rename palette builders in `app/frontend/src/lib/palette/*.ts` (`server-color.ts`, `sort.ts` → `Group: Sort tabs…`, `recovery.ts`, `nav.ts`, `shell.ts`, `code.ts`, and any other file building `Server:`/`Session:`/`Window:` labels) and `app/frontend/src/hooks/use-global-palette-actions.ts` (leave `App: New Window` alone) <!-- R1 R2 R3 -->
- [x] T003 [P] Rename sidebar copy in `app/frontend/src/components/sidebar/` (`index.tsx`: `Sessions`, `Session tree`, `Toggle sessions scope`, `New session on …`, empty-state `+ New Session`, server-group aria/Tips; `server-panel.tsx`: `Servers`/`Tmux servers`/`New tmux server`; `server-card.tsx`: `Server <n>` title, `N sessions` facts noun, `New session`, `Kill server`, `Protection for …`; `session-row.tsx`: `Session <n>` card title, `Rename session`, `Kill session`; `kill-dialog.tsx`; `section-rail.tsx` `Server` Tip → `Workspaces`; `row-flyout-card.tsx`; `window-row.tsx`; `boards-section.tsx`) <!-- R1 R2 R3 R5 -->
- [x] T004 [P] Rename dialogs: `app/frontend/src/components/server-dialogs.tsx` (`Create tmux server` → `New workspace`, `Server name`, kill/protected/adopt copy, `and all its sessions` → `and all its groups`), `components/session-name-prompt.tsx` (`New session` → `New group`, `Session name`), `components/spawn-agent-dialog.tsx` (`blank = empty session` → `blank = plain shell`), `components/gui-off-dialog.tsx` (only tmux-sense nouns) <!-- R1 R2 -->
- [x] T005 [P] Rename top bar + pages: `components/top-bar.tsx` (`TMUX_SERVER_PREFIX` value → `"Workspace:"`, `tmux Server` aria, Tips; leave comments), `components/top-bar-overflow-menu.tsx`, `components/host-overview-page.tsx` (`TMUX SERVERS` zone label → `WORKSPACES`, `+ New Server` → `+ New workspace`, `Create tmux server`, `Server name`, `Protected server …`), `components/session-tiles/session-tiles.tsx` (`tmux Server Overview` → `Workspace overview`, `Sessions` → `Groups`, `+ New Session` → `+ New group`), `components/status-bar.tsx`, `components/board/board-page.tsx`, `components/watched-table.tsx`, `components/watched-tasks.tsx`, `components/system-card.tsx`, `components/quake-terminal.tsx` (`Operator server` → `Operator workspace`), `components/recovery-section.tsx`, `components/code-surface.tsx`, `components/surface-layout.tsx`, `components/desktop-shell/titlebar-strip.tsx` — tmux-sense nouns only <!-- R1 R2 R3 -->
- [x] T006 [P] Rename keyboard copy in `app/frontend/src/lib/keybindings.ts` (`New session (a new group of tabs)` → `New group`, any `session`/`server`/tmux-`window` `label`/`description`/`mapLabel`), and Settings panels `components/settings-shortcuts-panel.tsx` / `components/settings-all-panel.tsx` where they render tmux nouns <!-- R1 R2 R3 -->
- [x] T007 [P] Rename frontend-composed toast/error copy in `app/frontend/src/contexts/optimistic-context.tsx`, `hooks/use-dialog-state.ts`, `contexts/session-context.tsx`, `lib/state-socket.ts` (user-visible strings only — e.g. `Failed to create session` → `Failed to create group`) <!-- R1 R2 -->
- [x] T008 [P] Web-tile strip: change bare "tab" Tips/aria in the web tile's tab-strip component(s) (`components/iframe-window.tsx` and its strip/tab components) to "web tab" <!-- R4 -->

### Phase 2: Verification sweep

- [x] T009 Leftover grep: re-scan non-test `app/frontend/src/**/*.{ts,tsx}` user-visible strings for `Server`, `server`, `Session`, `session`, `tmux-window` `Window`/`window`; fix stragglers; confirm (`git diff --stat`) no testid, route, API path, storage key or `.go` file changed <!-- R1 R2 R3 R6 -->

### Phase 3: Tests

- [x] T010 Update Vitest assertions (`app/frontend/src/**/*.test.ts(x)`) matching renamed copy; run `npx tsc --noEmit` and the affected Vitest files <!-- R8 -->
- [x] T011 Update e2e specs under `app/frontend/tests/` that select/assert by renamed text or role name; run the affected specs via `just pw test <name>` / `just test-e2e "<pattern>"` <!-- R8 -->

### Phase 4: Docs and evidence

- [x] T012 [P] Commit `docs/wiki/create-flow-studies.html`; add its row to `docs/specs/index.md`'s design-study table; update `docs/site/**` pages that quote renamed UI labels verbatim <!-- R7 -->
- [x] T013 Record PR evidence: add `app/frontend/tests/demo/ui-rename.demo.ts` (sidebar Workspaces/Groups panels + a group flyout card, palette `Workspace:`/`Group:` rows, host page `WORKSPACES` zone) and run `just demo ui-rename --before` <!-- R1 R2 R3 -->
  - Note: `just demo ui-rename --before` recorded `.demo/ui-rename-{before,after}-{desktop,mobile}.webm`. The before pass ran against the base ref, where the spec's new-copy assertions (`Group <n>` card title, `Workspaces` region) cannot hold, so the before recordings are partial. State that in the PR body.

## Execution Order

- Phase 1 tasks are independent ([P]); T009 runs after all of them.
- T010/T011 run after T009 (assertions must match the final copy).
- T013 runs last (records the finished UI).

## Acceptance

### Functional Completeness

- [ ] A-001 R1: No user-visible frontend string names a tmux server as "server"/"tmux Server"; palette rows use `Workspace:`; the heading prefix renders `Workspace:`
- [ ] A-002 R2: No user-visible frontend string names a tmux session as "session"; palette rows use `Group:`; sidebar title reads `Groups`
- [ ] A-003 R3: No palette row starts with `Window:`; `Session: Sort windows…` reads `Group: Sort tabs…`
- [ ] A-004 R4: Web-tile strip Tips/aria say "web tab"
- [ ] A-005 R5: Workspace card facts read `tmux -L <name> · N groups`; group card keeps `$<id>`
- [ ] A-006 R7: `docs/wiki/create-flow-studies.html` is committed and indexed in `docs/specs/index.md`

### Behavioral Correctness

- [ ] A-007 R3: Browser/app-window strings (`App: New Window`, `New app window`, `Close app window`, popout copy) are unchanged

### Scenario Coverage

- [ ] A-008 R2: Group flyout card shows `Group <n>`, `Rename group`, `Kill group`; kill confirm reads `Kill group <n> and all its tabs?`
- [ ] A-009 R1: Host page shows `WORKSPACES` and `+ New workspace`; create dialog title `New workspace`
- [ ] A-010 R8: `npx tsc --noEmit` passes; affected Vitest files pass; affected e2e specs pass

### Edge Cases & Error Handling

- [ ] A-011 R6: No `data-testid`, route param, `?server=`, API path, localStorage key, CLI verb, tmux option or `.go` file changed
- [ ] A-012 R1: Frontend-composed toasts/errors use the new nouns; backend-originated error strings are untouched

### Code Quality

- [ ] A-013 Pattern consistency: casing follows the surrounding conventions (title-case palette prefixes, sentence-case row labels, uppercase zone labels)
- [ ] A-014 No unnecessary duplication: shared label constants (e.g. `TMUX_SERVER_PREFIX`) are changed at their single definition, not shadowed
- [ ] A-015 No comment narration: no comments added that cite this rename or change IDs
- [ ] A-016 PR evidence: a `just demo` recording (desktop + mobile, with `--before`) exists for the PR body

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `tmux` qualifier dropped from the noun (`tmux Server` → `Workspace`) | Intake rename map lists `Create tmux server` → `New workspace`, `TMUX SERVERS` → `WORKSPACES` | S:85 R:90 A:85 D:85 |
| 2 | Confident | Browser/OS "window" senses are excluded from the Tab rename | Tab = tmux window only; `App: New Window` is the desktop app window | S:70 R:90 A:85 D:80 |
| 3 | Confident | Frontend-composed toasts are in scope; backend error strings are not | Intake scope rule | S:70 R:90 A:75 D:75 |
| 4 | Confident | Leave code comments alone unless they are user-visible | Comments aren't UI copy; rewriting them is churn | S:60 R:95 A:80 D:75 |
| 5 | Confident | Full lane (13 tasks) | Task count > 5 | S:90 R:95 A:95 D:95 |

5 assumptions (1 certain, 4 confident, 0 tentative).
