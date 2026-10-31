# Plan: `+ New` Split Button in the Sidebar Head

**Change**: 261030-5am0-sidebar-head-new-split-button
**Intake**: `intake.md`

## Requirements

### New control: NewSplitButton

#### R1: Route-varying instant primary segment
The split button's primary segment SHALL be an instant create at the deepest level the current route has, labelled by route: terminal `/$server/$window` → `+ Tab` (palette id `create-window`); server `/$server` → `+ Group` (palette id `create-session-instant`, a new id for the instant group create); board `/board/$name` → `+ Tab` (`create-window`, keyed to the focused pane's workspace › group); host `/` → `+ Workspace` (`create-server`, opens the New sheet at Workspace level; plain button, no caret). The primary SHALL invoke the palette action by id (Constitution V) and its tooltip SHALL read `New tab` / `New group` / `New workspace`, with the effective chord appended when the action's binding is enabled.

- **GIVEN** the terminal route **WHEN** the primary is clicked **THEN** the `create-window` palette body runs (instant, unnamed, current group)
- **GIVEN** the server route **WHEN** the primary is clicked **THEN** an unnamed group is created instantly via the shared create-group hook
- **GIVEN** the host route **THEN** a `+ Workspace` button with no caret renders and opens the New sheet at Workspace level

#### R2: Caret menu grouped by target
The caret SHALL open a `role="menu"` (`data-testid="new-split-menu"`) whose sections are headed by where the result lands (`IN <ws> › <group>`, `IN <ws>`), each row leading with a glyph and ending with its trailing keycap when the action's binding is enabled. Terminal/board: `IN <ws> › <group>`: Tab (`create-window`), Tab at folder… (`create-window-at-folder`), Agent tab… (`agent-spawn`), Web tab… (`create-iframe-window`), Reopen closed tab (`reopen-window`); `IN <ws>`: Group (`create-session`), Group at folder… (`create-session-at-folder`); then Workspace… (`create-server`). Server route: only the `IN <ws>` section plus `Workspace…`. Every row SHALL invoke its palette action by id; a row whose id is not registered on the current route SHALL be omitted (omit-not-disable). `Group on new worktree…` is not rendered.

- **GIVEN** the terminal route with the menu open **WHEN** `Tab at folder…` is chosen **THEN** the `create-window-at-folder` body runs and the menu closes
- **GIVEN** the server route **THEN** the menu has no `Tab` rows

#### R3: Placement in the sidebar head with a measured fold ladder
While the desktop sidebar head shows, the split SHALL render in `SidebarHead` beside the toggle (`[logo][HexoKit] … [+ Tab ▾][≡]`). A measured fold SHALL pick rung R1 (wordmark + full split), R2 (wordmark hidden, logo link keeps `aria-label="HexoKit home"`), R3 (icon-only `+▾`); the decision is a pure function with one-sided expand hysteresis, keeping the previous rung when unmeasured.

- **GIVEN** the head content is wider than the head **WHEN** measured **THEN** the next rung is chosen
- **GIVEN** an unmeasured environment (all zero) **THEN** the previous rung is kept

#### R4: Left-cluster fallback and host page
On desktop with the head not shown (sidebar closed, or the bar narrower than `HEAD_MIN_BAR_PX` beside the head) an icon-only `+▾` SHALL render in the left cluster immediately after the hamburger. On the host page (no sidebar) a `+ Workspace` plain button SHALL render after the brand crumb. The control is not in the top bar below `sm`.

- **GIVEN** the sidebar is closed on desktop **THEN** exactly one New control renders, after the hamburger and before the history arrows

#### R5: Mobile drawer brand row
Below `sm` the control SHALL render at the right end of the drawer's `SidebarBrand` row at the coarse 40px height; its caret menu is the same menu shell (coarse rows).

- **GIVEN** a mobile viewport with the drawer open **THEN** the brand row carries the control and the top bar does not

#### R6: Desktop-shell drag band
The head sits below `ShellTitlebarStrip` (a sibling above the top bar), so it is not part of the titlebar drag band; the button SHALL NOT add a second no-drag island. The shell demo records the head in the shell to prove it stays clickable.

### Sidebar

#### R7: Per-group `+` at rest
Each group header row (`session-row.tsx`) SHALL carry a `+` icon button (`aria-label="New tab in <group>"`) visible at rest at ~70% ink on fine pointers (full ink on hover) and always on coarse, calling `onCreateWindow(server, group)` (the shared create-tab path).

- **GIVEN** a group row **WHEN** `+` is clicked **THEN** `onCreateWindow(server, group)` fires and the row is not toggled/selected

#### R8: Retired in-bar doors
The window switcher's `+ New Tab` / `+ New Agent` footer actions and the Workspaces panel header `+` SHALL be removed (palette actions untouched). The flyout cards' `New tab` / `New group` rows and the empty-state button stay. (The server-group header hover `+` named in the study no longer exists; the flyout card row is the survivor.)

### Keyboard and palette

#### R9: ⌥⌘T `create-session` on mac
`create-session` SHALL bind to ⌥⌘T on mac via a new mac-only `optcmd` tier (Meta+Alt, no Shift/Ctrl); Win/Linux stays ⇧Ctrl+N. The tier SHALL be modeled end to end: match, capture, conflict collision, keycap formatting (`⌥⌘T`), the terminal-refusal seam, and the web chord table. Browser reservation of ⌥⌘T is unverified for Chrome/Safari/Firefox, so no claim is registered; a user can rebind.

- **GIVEN** a mac host **WHEN** Meta+Alt+T is pressed **THEN** `create-session` matches and `create-window` (⌘T) does not
- **GIVEN** a Win/Linux host **THEN** `create-session` stays ⇧Ctrl+N

#### R10: Palette parity ids
`create-session-instant` ("Group: Create Instantly") SHALL be a registered palette action on the server and terminal routes and the board route; the board route SHALL register `create-window`, `create-window-at-folder`, `create-session`, `create-session-instant`, `create-session-at-folder` keyed to the focused pane's workspace/group; `create-server` SHALL move to the layout-level global group so Host and Board have it.

### Design Decisions

#### Route-varying primary
**Decision**: The primary segment's label and action follow the route (`+ Tab` / `+ Group` / `+ Workspace`), the noun on the label keeping it honest.
**Why**: A fixed `+ Tab` would do nothing on the workspace page; one persistent create control fixes discoverability.
**Rejected**: A fixed-direction primary (top-bar.md's earlier split rule): dead on Host/Server.
*Introduced by*: 261030-5am0-sidebar-head-new-split-button

#### Per-group `+` visible at rest
**Decision**: The group row `+` is visible at rest, breaking the one hover-reveal contract for this control.
**Why**: Creation is a primary action; a hidden door was the discoverability problem.
**Rejected**: Hover-reveal (the flyout card row stays as the secondary path).
*Introduced by*: 261030-5am0-sidebar-head-new-split-button

## Tasks

### Phase 1: Core modules

- [x] T001 Add `app/frontend/src/lib/new-split.ts` (primary spec per mode, menu section builder, `nextHeadRung` pure fold) and `lib/new-split.test.ts` <!-- R1 R2 R3 -->
- [x] T002 Add `app/frontend/src/lib/keybindings.ts` `optcmd` tier (types, match, capture, collide, format, refuse seam), `create-session` → ⌥⌘T on mac, `lib/web-chord-table.ts` expansion, tests in `keybindings.test.ts` / `web-chord-table.test.ts` <!-- R9 -->
- [x] T003 Add `app/frontend/src/components/new-split-button.tsx` (split shell reusing `open-button.tsx` geometry, hook deriving route/target, palette-id row invocation) and `new-split-button.test.tsx` <!-- R1 R2 -->

### Phase 2: Wiring

- [x] T004 `components/top-bar.tsx`: `SidebarHead` renders the split with the measured fold; left-cluster icon-only fallback after the hamburger; host-page `+ Workspace`; drop the window switcher's create footer and the now-dead `onCreateWindow`/`onSpawnAgent` props (+ slot context, `RootTopBar`, AppShell registration) <!-- R3 R4 R8 -->
- [x] T005 `components/sidebar/index.tsx`: `SidebarBrand` carries the split at the right end (coarse 40px); `components/sidebar/server-panel.tsx`: remove the header `+` and the `onCreateServer` prop chain <!-- R5 R8 -->
- [x] T006 `components/sidebar/session-row.tsx`: per-group `+` at rest <!-- R7 -->
- [x] T007 `app.tsx` / `hooks/use-global-palette-actions.ts` / `components/board/board-page.tsx`: `create-session-instant`, `create-server` moved to globals, board-route create actions <!-- R10 -->

### Phase 3: Tests and evidence

- [x] T008 Update affected Vitest files (top-bar, server-panel, session-row, sidebar, app, slot context) and add coverage per the intake <!-- R1 R2 R3 R4 R5 R7 R8 -->
- [x] T009 Update e2e specs that used the retired doors (`spawn-agent.spec.ts`, `server-panel-grid.spec.ts`, and others found by grep) and add `new-split-button.spec.ts`; run via `just test-e2e` <!-- R1 R2 R8 -->
- [x] T010 Write `app/frontend/tests/demo/new-split-button.demo.ts` and `app/desktop/tests/demo/new-split-button.demo.ts`; record via `just demo new-split-button --before` (note blockers if infra is unavailable) <!-- R3 R5 R6 -->

## Execution Order

- T001 blocks T003; T002 is independent; T003 blocks T004–T006; T007 can run beside T004.

## Acceptance

### Functional Completeness

- [x] A-001 R1: Each route renders the right primary label and invokes the right palette id
- [x] A-002 R2: The menu sections/rows per route invoke palette ids and omit unregistered ones
- [x] A-003 R3: The head shows the split beside the toggle with a measured R1→R2→R3 fold
- [x] A-004 R4: The closed-sidebar fallback and host `+ Workspace` render once each
- [x] A-005 R5: The mobile brand row carries the control at the coarse height
- [x] A-006 R6: No second no-drag island is added and the shell demo spec exists
- [x] A-007 R7: The per-group `+` is visible at rest and fires `onCreateWindow(server, group)`
- [x] A-008 R9: ⌥⌘T binds `create-session` on mac through the `optcmd` tier
- [x] A-009 R10: The new palette ids are registered on their routes

### Removal Verification

- [x] A-010 R8: The switcher footer actions and the Workspaces panel `+` are gone; no dead props remain

### Edge Cases & Error Handling

- [x] A-011 R3: Unmeasured layouts keep the previous rung; label changes reset the measurement
- [x] A-012 R1: A primary click with no registered target action is a no-op

### Code Quality

- [x] A-013 Pattern consistency: New code follows the OpenButton/controlClass patterns
- [x] A-014 No unnecessary duplication: Create flows reuse the shared create hooks; no new optimistic lifecycle
- [x] A-015 Comments state constraints only (no change-ID narration)
- [x] A-016 New tests cover the added behavior; e2e specs carry intent comments

## Notes

- Check items as you review: `- [x]`
- **Demo evidence**: `just demo new-split-button --before` recorded the web lane (before/after × desktop/mobile) into `.demo/`. The shell lane's spec ran but the recorder failed (`ffmpeg exited (code 255)` on the private Xvfb x11grab) for the after pass, and the before pass failed in the shell lane too, so there is no shell recording; state this in the PR body.
- **e2e**: full `just test-e2e` run: 559 passed, 2 flaky; the failures it showed were the specs updated for retired doors (fixed and re-run green) plus `gui-toolbar-fold` (fails first attempt, passes on retry; it measures the gui tile header, which this change does not touch) and one `working-diff` timeout that passed on re-run.
- **Deviations from the intake**: `focused-pane-context` carries `{server, windowId, …}` but no session, so the board menu resolves the group from `sessionsByServer`; the server-group header hover `+` named in the study no longer exists in the code (only the flyout card row, kept); the head-less fallback shrinks the nav floor 150→96px to keep the left cluster inside its track (`top-bar-overlap.spec.ts`), and the host `+ Workspace` shows from `lg` up.
- Memory hydration (`top-bar`, `sidebar`, `keyboard-and-palette`, `desktop-shell`) is the hydrate stage's job.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Primary on the server route is a new palette id `create-session-instant`; the menu `Group` row stays `create-session` (the named prompt) | Palette `create-session` opens the name prompt today, not an instant create; Constitution V needs an id for the instant path | S:70 R:80 A:70 D:60 |
| 2 | Confident | The head is not part of the titlebar drag band, so no extra no-drag island is added | `ShellTitlebarStrip` is a sibling above the top bar; the top bar has no drag class | S:75 R:85 A:80 D:75 |
| 3 | Tentative | ⌥⌘T browser reservation is unverified; no claim registered | A web search found no source naming a reserved ⌥⌘T in Chrome/Safari/Firefox | S:40 R:90 A:50 D:60 |
| 4 | Confident | Board route registers create-window/create-session* actions; Agent/Web/Reopen rows are omitted there | Those dialogs mount only in AppShell; rows are omit-not-disable | S:60 R:85 A:70 D:60 |
| 5 | Confident | `create-server` moves to the global palette group | Host and Board have no AppShell to register it | S:70 R:85 A:80 D:75 |
| 6 | Confident | Mobile caret menu uses the shared popover shell (coarse rows), not a bottom sheet | "Existing coarse menu pattern" is the popover | S:65 R:90 A:75 D:65 |
| 7 | Certain | The server-group header hover `+` no longer exists; only the flyout card row survives | Code read: header has only the card, empty-state button is separate | S:90 R:95 A:90 D:90 |

7 assumptions (1 certain, 5 confident, 1 tentative).
