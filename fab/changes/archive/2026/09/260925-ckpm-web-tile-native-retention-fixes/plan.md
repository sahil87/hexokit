# Plan: Web Tile Native Retention Fixes

**Change**: 260925-ckpm-web-tile-native-retention-fixes
**Intake**: `intake.md`

## Requirements

### Backend: Web-Tab Family Bound

#### R1: Web-tab cap is 16 at both ends
The backend `MaxWebTabs` constant (`app/backend/internal/tmux/tmux.go`) SHALL be 16, and the frontend `WEB_TAB_FAMILY_CAP` (`app/frontend/src/components/iframe-window.tsx`) SHALL be 16. Every consumer that iterates `1..MaxWebTabs` (`WebTabOption`/`WebTabRootOption`, `webtabs.go`, `tabaddr.go`, `api/windows.go`, `api/windows_web.go`, `cmd/rk/tab_web.go`) follows the constant automatically and SHALL need no hand edit beyond verification.

- **GIVEN** a window with 16 web tabs declared
- **WHEN** a 17th add is attempted through the API, the CLI, or the strip `+`
- **THEN** the backend rejects it with 409 "web tabs full (16)" and the frontend disables `+` with the `web tabs full (16)` tip
- **AND** a window with 15 tabs still accepts an add

#### R2: Format-string field offsets derive from MaxWebTabs
Both fixed-format parsers — `parseWindows` (`internal/tmux/tmux.go`) and `parseLayoutWindows` (`internal/tmux/layout.go`) — SHALL compute the field positions after the `@rk_win_web_<n>` URL/root slots from `MaxWebTabs` through named constants, so the next raise is a one-line change. Short lines from older captures SHALL still parse tolerantly. On-disk layout snapshots (parsed JSON) SHALL need no migration.

- **GIVEN** a `list-windows` format line with all 16 URL slots and 16 root slots populated plus distinct values in every trailing field (web_active, code root, marker, role, flair, owner, note, legacy note)
- **WHEN** `parseWindows` / `parseLayoutWindows` parse it
- **THEN** every trailing field lands in its correct struct member
- **AND** a short line (fewer fields, e.g. an 8-slot-era capture) parses without error with missing fields empty

### Web Tile: Draft Tab

#### R3: A selected draft deactivates every frame and shows a blank new-tab panel
While `selectedDraft !== null` in `iframe-window.tsx`, EVERY Engine in the frames wrapper SHALL render with `active={false}` (the native guest hides by the visibility rule; iframe frames hide), and the content area SHALL show a minimal blank new-tab panel reusing the existing empty-tile onboarding visual language instead of the previous page.

- **GIVEN** a web tile with at least one declared tab and a frame showing a page
- **WHEN** the user opens a draft (`+`, double-click, or palette `Web: New tab`)
- **THEN** no Engine is active and the blank new-tab panel renders in place of the previous page
- **AND** the native engine's guest is hidden (not destroyed)

#### R4: Re-selecting a real tab re-activates its frame without a reload
Frames SHALL stay mounted while a draft is selected (P3 hide-never-unmount). Selecting a real tab again (click, keyboard, or submitting a URL that lands in an existing slot) SHALL re-activate its frame WITHOUT reloading it. Submitting the draft adds a tab and activates the new frame as today.

- **GIVEN** a draft is selected over a previously active tab
- **WHEN** the user clicks the previous tab
- **THEN** the same frame instance becomes visible again with its in-page state intact (no remount, no reload)

### Web Tile: Menu Overlay Hiding

#### R5: Click-opened menus hide the native view
While any click-opened menu, dropdown, popover, or context menu that can overlap a tile is open, the native engine's guest SHALL be hidden, exactly as for modal overlays. Menus SHALL register with the overlay-presence registry (`lib/overlay-presence.ts`) as kind `transient` via `useOccludes("transient", open)` (above any early return), and the native frame's hide signal SHALL read `modal + transient` counts. The `overlay-presence.ts` header doc SHALL be updated to state the rule.

- **GIVEN** a native web tile with a visible guest
- **WHEN** the user opens a click-opened menu (e.g. the top-bar overflow menu)
- **THEN** the guest is hidden while the menu is open
- **AND** closing the menu restores the guest

#### R6: Tooltips and hover-opened flyouts are excluded
Tooltips (`tip.tsx`) and hover-opened flyout cards (e.g. sidebar `row-flyout-card.tsx`, opened by `useHover`) SHALL NOT register and SHALL NOT hide the native view. The snapshot-swap approach (`capturePage` + static image) SHALL NOT be implemented.

- **GIVEN** a native web tile with a visible guest
- **WHEN** the user hovers an element bearing a tooltip or hover flyout
- **THEN** the guest stays visible

### Desktop Shell: Native Guest Retention

#### R7: Stable retention identity
Each native frame SHALL carry a stable retention identity that uniquely names "this web tab as shown in this desktop window": the desktop BrowserWindow id, the host id, the tmux server name, the tmux window id (`@N`), and the web-tab slot URL. The guest's own in-page navigation (tracked location drifting from the slot URL) SHALL NOT change the identity. The identity SHALL be computed SPA-side (the SPA knows server/window/slot) and sent on create/park; main SHALL treat it as an opaque string key.

- **GIVEN** a web tab mounted in a desktop window
- **WHEN** the tile unmounts and later remounts for the same (window, host, server, tmux window, slot URL)
- **THEN** the identity is identical across the two mounts
- **AND** a different desktop window, host, server, tmux window, or slot URL yields a different identity

#### R8: Park instead of destroy on tile unmount
When a native frame unmounts because the TILE went away (window/route switch, layout change dropping the web tile, host switch within the desktop window), main SHALL hide the guest (`setVisible(false)`, off the visible z-stack per the existing detach discipline) and move it to a parked set keyed by the stable identity. The guest renderer SHALL keep running — page state, JS state, and WebSocket connections survive. The frontend unmount cleanup SHALL park; explicit destroy signals (R11) come from the owning chrome.

- **GIVEN** a mounted native web tab
- **WHEN** the user switches to another tmux window (the tile unmounts)
- **THEN** the guest is hidden and parked, not closed
- **AND** its renderer keeps running (a page-side token set at load survives)

#### R9: Adopt on remount
A native frame mounting with an identity matching a parked view SHALL adopt it instead of creating a new one: re-bind it to the new frame's `tabKey`/sender, re-show it, re-apply bounds, re-send the chord table and zoom factor, and re-report the current title / favicon / tracked URL / canGoBack / canGoForward / loading state to the new frame so the chrome shows the right values without waiting for a navigation event. Existing hide rules (modal/transient overlay hiding, `tileError`, drag-hide, host detach/attach) SHALL apply to an adopted view; parked views of a detached host SHALL stay hidden when that host is re-attached — only mounted views re-show.

- **GIVEN** a parked guest for identity I
- **WHEN** a frame mounts with identity I
- **THEN** no new `WebContentsView` is created; the parked guest is re-bound, re-shown, re-bounded, re-sent chords/zoom, and its current chrome state is re-reported to the new frame

#### R10: LRU cap of 4 parked views
At most 4 parked (hidden, not currently mounted) views SHALL exist; parking a fifth SHALL evict (destroy) the least-recently-parked one. Mounted views SHALL NOT count toward the cap. The cap SHALL be a named constant, not a setting (Constitution IV).

- **GIVEN** 4 parked views
- **WHEN** a fifth view parks
- **THEN** the least-recently-parked view is destroyed and the parked count stays 4

#### R11: Explicit destroy triggers
A guest SHALL be destroyed immediately (never parked) when: the tab is closed or removed from the window's web-tab family; the tab's URL slot changes (Engine re-key); the host is removed (the existing `removeHostWebViewsEverywhere` path, extended to parked entries); the desktop window closes (the existing `win.on("closed")` teardown, extended to parked entries); the host SPA reloads (the existing `did-navigate` teardown, extended to parked entries); or the guest is LRU-evicted. The chrome (`iframe-window.tsx`) SHALL issue the destroy for tab close and URL-slot change through the engine's registered handle; a killed tmux window's parked views age out through the LRU cap (no reconciliation loop — intake Assumption 6).

- **GIVEN** a mounted native web tab
- **WHEN** the user closes that tab (the tile stays mounted)
- **THEN** the guest is destroyed, not parked
- **AND** re-adding the same URL later boots a fresh page

#### R12: Pure parking logic in an electron-free module
The parking / LRU / identity-matching logic SHALL live in the electron-free `app/desktop/src/web-views.ts` (its opaque-handle-`H` pattern) so it is unit-testable under `node --test`; the impure glue (construction, `WebContentsView` operations, IPC) stays in `main.ts`.

- **GIVEN** the compiled `web-views.ts` module
- **WHEN** `node --test` runs its suite
- **THEN** park, adopt, identity match, LRU-4 eviction, and destroy-on-close transitions are covered without Electron

### Verification: Desktop E2E

#### R13: Desktop e2e proofs
`app/desktop/tests/e2e/` SHALL carry single-runnable specs proving: (a) a web tab survives a tmux window switch and back WITHOUT reloading, proven by a page-side load token (random token or `performance.timeOrigin`) unchanged after returning; (b) opening a menu hides the native view and closing it restores the view; (c) "+" hides the previous guest. Every Playwright `test()` SHALL carry the Constitution's Test Intent Comments (Proves/Steps JSDoc + file header).

- **GIVEN** the desktop e2e lane rig
- **WHEN** the specs run (single specs only)
- **THEN** all three behaviors are proven green against Electron's own objects and page-side state

### Docs: Specs

#### R14: Specs state the new behavior
`docs/specs/window-views.md` SHALL document native-engine retention (park/adopt, LRU 4, destroy triggers) and the draft behavior. `docs/specs/ui-state.md` and any other spec stating the 8-tab cap SHALL state 16. `docs/memory/` SHALL NOT be edited at apply (hydrate's job).

- **GIVEN** the specs tree
- **WHEN** the change ships
- **THEN** no spec still states an 8-tab cap, and window-views.md describes park/adopt and draft deactivation

### Non-Goals

- Iframe-engine retention across tile unmounts — needs the code tile's DOM-retention machinery; native-only scope (intake Assumption 8).
- SPA↔main reconciliation of parked identities against the live window/tab set — optional tidy-up, not a correctness dependency (intake Assumption 6); the LRU cap bounds strays.
- Snapshot-swap menu compositing — rejected by the user.
- Adoption across a host SPA reload — the existing `did-navigate` teardown rule is kept (intake Assumption 7).

### Design Decisions

#### Park on every engine unmount; the chrome owns explicit destroys
**Decision**: the native engine's unmount cleanup always parks; `iframe-window.tsx` explicitly calls a `destroy()` verb on the engine's registered handle when a tab is closed or its URL slot changes.
**Why**: the engine cannot distinguish "tile going away" from "this tab is gone" at cleanup time, but the chrome — which owns the tab family and re-keys engines by `${engineKind}:${tabUrl}` — knows exactly when a tab dies; the handle registry (keyed by frame URL) already gives the chrome the channel to say so. A kind flip (engine preference toggle) therefore parks rather than destroys, which is correct on flip-back and bounded by the LRU.
**Rejected**: a tile-unmount flag set in a parent cleanup (React child cleanups run first — the flag lands too late); SPA↔main reconciliation against the SSE window list (a new signal the simplest correct design does not need — intake Assumption 6).
*Introduced by*: 260925-ckpm-web-tile-native-retention-fixes

#### Menus register as `transient`; the native hide signal reads modal + transient
**Decision**: click-opened menus register `useOccludes("transient", open)`; the native frame hides on `count("modal") + count("transient") > 0`.
**Why**: `modal` keeps its existing semantic (palette, dialogs, drawers — surfaces that block the page); `transient` was created for exactly this later consumer and its count is already subscribable; registering menus as `modal` would mislabel them for every future modal-kind consumer.
**Rejected**: registering menus as `modal` (semantically wrong; the header doc would lie).
*Introduced by*: 260925-ckpm-web-tile-native-retention-fixes

#### Identity is an opaque SPA-computed string
**Decision**: the SPA computes the retention identity (`window-host-server-tmuxwindow-slotURL`, separator-joined) and sends it on `web:create`/`web:park`; main stores and matches it as an opaque string.
**Why**: the SPA owns server/window/slot knowledge; main owns only the desktop window id and host id, which it prefixes itself (the sender's host view resolves both). An opaque key keeps matching logic trivial and electron-free.
**Rejected**: main-side tuple assembly from parsed fields (duplicates SPA routing knowledge in main for no gain).
*Introduced by*: 260925-ckpm-web-tile-native-retention-fixes

## Tasks

### Phase 1: Web-Tab Cap 16

- [x] T001 Backend cap + derived offsets: set `MaxWebTabs = 16` in `app/backend/internal/tmux/tmux.go`; derive every post-URL-slot field offset from `MaxWebTabs` via named constants in `parseWindows` + the `ListWindows` format builder (`tmux.go`) and `parseLayoutWindows` (`internal/tmux/layout.go`); update the doc comments that enumerate 8 slots / 25 fields; verify `webtabs.go` and the present-root read already follow the constant <!-- R1, R2 -->
- [x] T002 [P] Frontend cap: set `WEB_TAB_FAMILY_CAP = 16` in `app/frontend/src/components/iframe-window.tsx` <!-- R1 -->
- [x] T003 Go tests: update `internal/tmux/tmux_test.go`, `internal/tmux/layout_test.go`, `internal/tmux/webtabs_test.go`, `internal/tabaddr/tabaddr_test.go` ("above the cap" 9 → 17), `cmd/rk/tab_test.go`, `api/windows_web_test.go`; add a 16-slot fully-populated parse case for BOTH parsers asserting every trailing field lands correctly, plus short-line tolerance <!-- R1, R2 -->
- [x] T004 [P] Frontend cap tests: update the "+ disabled at the family cap" cases in `app/frontend/src/components/iframe-window.test.tsx` to 16 (enabled at 15) <!-- R1 -->

### Phase 2: Draft Tab & Menu Hiding

- [x] T005 Draft deactivation + blank panel: in `app/frontend/src/components/iframe-window.tsx`, render every Engine with `active={false}` while `selectedDraft !== null` and render a minimal blank new-tab panel (reusing the empty-tile onboarding visual language) in the content area; re-selecting a tab re-activates its frame without remount; colocated vitest coverage in `iframe-window.test.tsx` / stub-engine suite <!-- R3, R4 -->
- [x] T006 Menu registration: update `app/frontend/src/lib/overlay-presence.ts` (header doc states menus register `transient`; native hide signal reads modal + transient) and `app/frontend/src/components/web-frame-native.tsx` visibility rule; register EVERY click-opened menu/dropdown/popover/context menu with `useOccludes("transient", open)` above any early return — inventory via grep (`role="menu"`, `aria-haspopup`, `role="listbox"`, `onContextMenu`, portals): `top-bar-overflow-menu.tsx`, `open-button.tsx`, the top-bar Split split-button, `breadcrumb-dropdown.tsx`, `layout-chip.tsx`, `surface-layout.tsx` tile-header menus, `sidebar/marker-pad.tsx`, `swatch-popover.tsx`, sidebar panel portals, `gui-toolbar-menu.tsx`, `gui-wm-picker.tsx`, `theme-picker-list.tsx`, `status-bar.tsx`, `bottom-bar.tsx`, `terminal-client.tsx` context menu, `desktop-shell/titlebar-strip.tsx`, `compose-history-flyout.tsx`, `create-session-dialog.tsx` listbox, keybinding/settings popovers; EXCLUDE `tip.tsx` and hover-opened `row-flyout-card.tsx`; vitest for acquire-on-open/release-on-close on representative registered menus <!-- R5, R6 -->

### Phase 3: Native Guest Retention

- [x] T007 Pure retention module: extend `app/desktop/src/web-views.ts` with the parked-set state (keyed by identity string), park/adopt/identity-match/LRU-4-evict transitions (named `PARKED_WEB_VIEW_CAP = 4`), mounted views not counting, and parked-aware scoped removals; full `node --test` coverage in `web-views.test.ts` <!-- R7, R8, R9, R10, R12 -->
- [x] T008 Main glue: in `app/desktop/src/main.ts` wire adopt-or-create into `web:create`/`createWebView` (re-bind tabKey/sender, re-show, re-apply bounds, re-send chords/zoom, re-report title/favicon/url/canGoBack/canGoForward/loading to the new frame), add the `web:park` channel + identity on `web:create` (structural validators beside the existing ones), extend `removeHostWebViewsEverywhere` / window-close teardown / host-SPA `did-navigate` teardown to parked entries, keep `web:destroy` as immediate destroy; update `src/preload.ts` and the SPA bridge typings (`app/frontend/src/lib/shell.ts`) <!-- R8, R9, R10, R11 -->
- [x] T009 SPA engine + chrome: `app/frontend/src/components/web-frame-native.tsx` computes the stable identity, parks on unmount (replacing the unconditional destroy), replays adopted state; `app/frontend/src/components/iframe-window.tsx` destroys through the engine handle on tab close and URL-slot change; vitest in `web-frame-native.test.tsx` (+ chrome destroy-wiring coverage) <!-- R7, R8, R9, R11 -->

### Phase 4: E2E & Specs

- [x] T010 Desktop e2e: `app/desktop/tests/e2e/` specs (single-runnable, `env -u DISPLAY`) — (a) window-switch retention proven by an unchanged page-side load token; (b) menu open hides / close restores the native view; (c) "+" hides the previous guest; Test Intent Comments (Proves/Steps JSDoc + file header) on every `test()` <!-- R13 -->
- [x] T011 Specs: update `docs/specs/window-views.md` (park/adopt, LRU 4, destroy triggers, draft behavior) and `docs/specs/ui-state.md` + any other spec stating the 8-tab cap (grep `MaxWebTabs`, "8 web", "eight", `n ≤ 8`) to 16; do NOT touch `docs/memory/` <!-- R14 -->

## Execution Order

- T001 and T002/T004 are independent (backend vs frontend files); T003 depends on T001
- T005 and T006 are independent of Phase 1 and of each other (T006 touches `web-frame-native.tsx`'s visibility rule; T009 rewrites the same file's lifecycle — run T006 BEFORE T009)
- T007 blocks T008 blocks T009 (module → glue → SPA)
- T010 depends on T005, T006, T008, T009; T011 depends on all implementation tasks

## Acceptance

### Functional Completeness

- [x] A-001 R1: `MaxWebTabs` and `WEB_TAB_FAMILY_CAP` are 16; a 17th add is rejected (409 / disabled `+`); 15 → 16 succeeds
- [x] A-002 R2: both parsers compute post-slot offsets from `MaxWebTabs` via named constants; no literal post-slot indices remain
- [x] A-003 R3: with a draft selected, every Engine renders `active={false}` and the blank new-tab panel shows
- [x] A-004 R4: re-selecting a tab re-activates the same frame instance without reload
- [x] A-005 R5: every click-opened menu/dropdown/popover/context menu registers `transient`; the native guest hides while one is open and re-shows on close
- [x] A-006 R6: `tip.tsx` and hover flyouts register nothing; no snapshot-swap code exists
- [x] A-007 R7: the retention identity is (desktop window, host, tmux server, tmux window id, slot URL); in-page navigation does not change it
- [x] A-008 R8: tile unmount parks the guest hidden; the renderer keeps running
- [x] A-009 R9: remount with a matching identity adopts — no new `WebContentsView`, bounds/chords/zoom re-sent, chrome state re-reported
- [x] A-010 R10: at most 4 parked views; the fifth park evicts the least-recently-parked; mounted views never count
- [x] A-011 R11: tab close, URL-slot change, host removal, window close, host SPA reload, and LRU eviction destroy immediately; scoped removals cover parked entries
- [x] A-012 R12: park/adopt/LRU logic is in electron-free `web-views.ts` with `node --test` coverage
- [x] A-013 R13: the three desktop e2e proofs exist with Test Intent Comments and pass as single specs
- [x] A-014 R14: `window-views.md` documents retention + draft; no spec states an 8-tab cap

### Behavioral Correctness

- [x] A-015 R1: `tabaddr` rejects `@1/web/17` and bare `17`; `@1/web/16` resolves
- [x] A-016 R5: overlay-presence `count("transient")` rises on menu open and falls on close (unit test)
- [x] A-017 R9: an adopted guest's `webContents` id is unchanged across the unmount/remount (no re-creation)

### Scenario Coverage

- [x] A-018 R13: retention e2e proves the page-side load token is unchanged after a window switch and back
- [x] A-019 R13: menu-hide e2e proves guest visibility false while open and true after close
- [x] A-020 R13: draft e2e proves "+" hides the previous guest
- [x] A-021 R2: Go parse tests cover a fully-populated 16-slot line and a short (older-capture) line for both parsers

### Edge Cases & Error Handling

- [x] A-022 R10: LRU eviction destroys the evicted guest's webContents; evicting an unknown/empty parked set is a no-op
- [x] A-023 R8: parked views of a detached host stay hidden when the host re-attaches (only mounted views re-show); adopted views honor modal/transient/tileError/drag-hide rules
- [x] A-024 R11: new/changed `web:*` IPC payloads are structurally validated beside the existing validators (tabKey ≤128 chars, identity non-empty bounded string)
- [x] A-025 R4: submitting the draft materializes a tab and activates the new frame exactly as before

### Code Quality

- [x] A-026 Pattern consistency: new code follows the `web-views.ts` opaque-handle / function-style-transition shape and the chrome's existing engine-seam idioms
- [x] A-027 No unnecessary duplication: existing utilities (`useOccludes`, overlay-presence, handle registry, host detach/attach plans) are reused, not reimplemented
- [x] A-028 No magic numbers: `MaxWebTabs`, `WEB_TAB_FAMILY_CAP`, `PARKED_WEB_VIEW_CAP`, and the derived offset constants name every bound
- [x] A-029 Tests alongside: every behavior change lands with its unit/e2e coverage in the same pass
- [x] A-030 Type narrowing over assertions: new frontend/desktop TS uses guards and discriminated shapes, no `as` casts
- [x] A-031 No comment narration: new comments state only invariants/cross-file contracts, no history or change IDs

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The two deliberate retentions: `api/present.go` `presentSlotPattern` / `internal/tmux/webtabs.go` `legacyPresentSlotMax` stay pinned at the 8-slot bound because the retired `/present/@N/{n}/` URL form was only ever composed under that cap (documented at both sites), and the per-mount `tabKey` (`web-${++mountSeq}` in `web-frame-native.tsx`) remains the event-demux key alongside the new retention identity — the two name different things (a mount vs. a tab-in-a-window).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Retention identity = desktop BrowserWindow id + host id + tmux server + tmux window id (`@N`) + slot URL, computed SPA-side as an opaque separator-joined string, main-prefixing window/host from the sender's host view | Intake Assumption 5 delegates the exact tuple; the SPA owns server/window/slot knowledge, main owns window/host | S:85 R:80 A:80 D:75 |
| 2 | Confident | Engine unmount always parks; the chrome destroys explicitly via the engine handle on tab close / URL-slot change; a kind flip parks (bounded by LRU) | React child cleanups precede the parent's, so a parent-set flag cannot discriminate; the chrome owns the family and the handle registry | S:70 R:75 A:70 D:60 |
| 3 | Certain | Menus register as `transient`; the native hide signal reads modal + transient counts | `transient` was created for this consumer; `modal` keeps its blocking-page semantic | S:80 R:80 A:75 D:70 |
| 4 | Confident | No SPA↔main reconciliation loop for killed tmux windows; parked strays age out through the LRU cap | Intake Assumption 6 (orchestrator decision): simplest correct design; bounded memory | S:65 R:70 A:70 D:65 |
| 5 | Certain | Parked views die with a host SPA reload (existing `did-navigate` teardown extended to parked entries) | Intake Assumption 7; a reload re-mounts every tile anyway | S:70 R:70 A:70 D:65 |
| 6 | Confident | One new IPC channel `web:park` plus an `identity` field on `web:create`; `web:destroy` stays immediate-destroy | Smallest additive surface matching the existing fourteen-channel shape; older shells simply never park | S:65 R:80 A:70 D:60 |

6 assumptions (3 certain, 3 confident, 0 tentative).
