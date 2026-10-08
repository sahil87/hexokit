# Plan: Status Bugs — Pane Ordinal + Version Segment

**Change**: 260913-gpi7-status-bugs-ordinal-version
**Intake**: `intake.md`

## Requirements

### Status surfaces: `tmx` identity-row label

#### R1: One shared `tmx` label resolver
`registers.ts` SHALL export `getTmxLabel(win: WindowInfo): string` returning `pane <ordinal>/<count>[ <paneId>]`, where `ordinal` is the active pane's 1-based position in `win.panes` (`findIndex(isActive) + 1`), `count` is `win.panes.length`, and the ` <paneId>` suffix is present only when the active pane's `paneId` is non-empty. The id comes ONLY from the active pane: when no pane is marked active, the ordinal falls back to `1` and no id is shown (so the panel's passive no-copy branch never displays an id it cannot copy). `paneIndex` MUST NOT participate in the ordinal.

- **GIVEN** a window with one pane `{ paneIndex: 1, paneId: "%107", isActive: true }`
- **WHEN** `getTmxLabel(win)` is called
- **THEN** it returns `pane 1/1 %107`

- **GIVEN** three panes with `paneIndex` 1, 2, 3 and only the third (`%109`) active
- **WHEN** `getTmxLabel(win)` is called
- **THEN** it returns `pane 3/3 %109`

- **GIVEN** a window with `panes: []` (or `undefined`)
- **WHEN** `getTmxLabel(win)` is called
- **THEN** it returns `pane 1/0`

- **GIVEN** one active pane with `paneId: ""`
- **WHEN** `getTmxLabel(win)` is called
- **THEN** it returns `pane 1/1`

- **GIVEN** two panes, neither marked active
- **WHEN** `getTmxLabel(win)` is called
- **THEN** it returns `pane 1/2` (ordinal 1, no id)

#### R2: All three `tmx` sites render the shared label
The PANE panel (`status-panel.tsx` `WindowContent`, both the copyable and the passive branch), the status bar strip (`status-bar.tsx` `WindowCluster`), and the status bar overflow row (`status-bar.tsx` `OverflowMenu`) MUST render their `tmx` text from `getTmxLabel(win)` and MUST NOT compose `paneIndex + 1` inline. Copy values stay `paneId`.

- **GIVEN** a single-pane window whose pane has `paneIndex: 1`
- **WHEN** the PANE panel, the bar strip, and the bar overflow menu render
- **THEN** each shows `pane 1/1 %5` (not `pane 2/1 %5`), and clicking the row/segment copies `%5`

### Status bar: right-cluster version fragment

#### R3: Version is an independently-sized segment
In `status-bar.tsx`'s right cluster the host name and version SHALL be two sibling flex items inside a wrapper `<span className="flex items-center gap-1 min-w-0 whitespace-nowrap">` that carries no `truncate`. The host button SHALL carry `min-w-0 truncate`; the version button SHALL carry `shrink-0 hidden min-[700px]:inline` and no `truncate`. The literal leading-space separator inside the version button is removed. The overflow menu's `version` row (`min-[700px]:hidden`) is unchanged.

- **GIVEN** a bar with `hostName = "mba"` and `version = "v0.9.3"`
- **WHEN** it renders
- **THEN** the `Copy host name` and `Copy version` buttons share a parent element that lacks the `truncate` class, the host button has `truncate`, and the version button's class list includes `shrink-0` and `min-[700px]:inline`
- **AND** the `status-bar-host` cluster text still contains `mba` and `v0.9.3`

- **GIVEN** no `version` event has arrived yet
- **WHEN** the bar renders
- **THEN** no version button renders and the host name still shows (unchanged behaviour)

### Non-Goals

- The `tmx` grammar change (`%107` / `%107 · 2/3`) — change 1 of the plan.
- Any breakpoint/fold change to the bar — change 2.
- Backend `paneIndex` semantics — it stays tmux's raw `#{pane_index}`.
- Memory edits — hydrate's job (sidebar.md § WindowPanel, status-signals.md § Status Bar).

### Design Decisions

#### `tmx` ordinal is the position in `win.panes`, not `paneIndex + 1`
**Decision**: The ordinal shown in the `tmx` row is the active pane's 1-based index within the streamed `panes` array.
**Why**: `paneIndex` is tmux's `#{pane_index}`, which already honours `pane-base-index`; adding 1 double-offsets under base-index 1 (`pane 2/1`). Position-in-list is base-index agnostic and always ≤ count.
**Rejected**: Subtracting a server-reported base index — extra plumbing for a value the pane list already implies; keeping `paneIndex + 1` and documenting it — wrong on the common config.
*Introduced by*: 260913-gpi7-status-bugs-ordinal-version

#### Host and version stay one visual pair in a non-truncating wrapper
**Decision**: The two buttons live in a `flex gap-1 min-w-0` wrapper; the host truncates, the version is `shrink-0` and drops at 700 px.
**Why**: A single `truncate` span ate the trailing version first at any width. Two loose cluster siblings would be spaced by the cluster's `gap-3`, visibly widening the `<host> v<version>` fragment; the wrapper keeps the pair tight while the children carry independent shrink rules.
**Rejected**: Two loose `gap-3` siblings (wider fragment); keeping one span and moving the version first (host would then truncate away and the ladder would still be undocumented).
*Introduced by*: 260913-gpi7-status-bugs-ordinal-version

## Tasks

### Phase 1: Core Implementation

- [x] T001 Add `getTmxLabel(win)` to `app/frontend/src/components/sidebar/registers.ts` (with a doc comment stating the base-index constraint and a one-sentence header note that the `tmx` identity-row label lives here for its three consumers); add `describe("getTmxLabel")` to `app/frontend/src/components/sidebar/registers.test.ts` covering `paneIndex: 1` single pane ⇒ `pane 1/1 %107`, three panes third active ⇒ `pane 3/3 %109`, empty `paneId` ⇒ `pane 1/1`, no panes ⇒ `pane 1/0`. <!-- R1 -->
- [x] T002 Replace the inline `pane ${paneIndex + 1}/${count}` compositions with `getTmxLabel(win)` in `app/frontend/src/components/sidebar/status-panel.tsx` (`WindowContent`, both branches; drop `paneCount`/`activePaneIndex`) and `app/frontend/src/components/status-bar.tsx` (`WindowCluster.tmxValue`, `OverflowMenu.tmxRest`); add a `paneIndex: 1` single-pane case to `status-panel.test.tsx` (tmx row reads `pane 1/1 %5`) and to `status-bar.test.tsx` (strip and overflow row read `pane 1/1 %5`). <!-- R2 -->
- [x] T003 In `app/frontend/src/components/status-bar.tsx` replace the `min-w-0 truncate` host+version span with a `flex items-center gap-1 min-w-0 whitespace-nowrap` wrapper; host button `min-w-0 truncate`, version button `shrink-0 hidden min-[700px]:inline`, remove the `{hostName ? " " : ""}` separator; extend the host+version test in `status-bar.test.tsx` to assert the shared non-`truncate` parent, host `truncate`, and version `shrink-0` + `min-[700px]:inline`. <!-- R3 -->

### Phase 2: Verification

- [x] T004 From `app/frontend`: `npx tsc --noEmit`; `pnpm vitest run src/components/sidebar/registers.test.ts src/components/sidebar/status-panel.test.tsx src/components/status-bar.test.tsx`; then from the repo root `just test-e2e status-bar.spec` (single spec, `.spec` suffix) to confirm the four `pane 1/1 %1` assertions still hold — update the JSDoc intent comment in the same commit if any assertion has to move. <!-- R1 R2 R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `getTmxLabel` is exported from `registers.ts` and returns `pane <ordinal>/<count>[ <paneId>]` with the ordinal derived from position in `win.panes`
- [x] A-002 R2: No `paneIndex + 1` (or `activePaneIndex + 1`) composition remains in `status-panel.tsx` or `status-bar.tsx`; all three `tmx` sites call `getTmxLabel`
- [x] A-003 R3: Host and version buttons are siblings in a wrapper without `truncate`; version carries `shrink-0 hidden min-[700px]:inline`; the overflow `version` row still carries `min-[700px]:hidden`

### Behavioral Correctness

- [x] A-004 R2: A single-pane window with `paneIndex: 1` renders `pane 1/1 %5` in the PANE panel, the bar strip, and the bar overflow row (unit tests prove each)
- [x] A-005 R3: With a long host name and a narrow cluster the version text is never clipped by an ellipsis (structural: no `truncate` on the version or its wrapper)

### Scenario Coverage

- [x] A-006 R1: `registers.test.ts` covers `1/1 %107`, `3/3 %109`, `pane 1/1` (empty id), and `pane 1/0` (no panes)
- [x] A-007 R2: Existing `paneIndex: 0` fixtures still read `pane 1/1 %5` / `pane 1/1 %1` (unit + e2e `status-bar.spec.ts` unchanged and green)

### Edge Cases & Error Handling

- [x] A-008 R1: No active pane and no panes ⇒ `pane 1/0` (matches the existing passive-tmx assertion in `status-bar.test.tsx`); panes but none active ⇒ `pane 1/<count>` with no id (unit test)
- [x] A-009 R3: No version yet ⇒ no version button, host still rendered; no host ⇒ version alone renders inside the wrapper

### Code Quality

- [x] A-010 Pattern consistency: `getTmxLabel` follows the `registers.ts` pure-function style (no React, typed on `WindowInfo`), and the JSX classes follow the existing button class strings
- [x] A-011 No unnecessary duplication: the three `tmx` sites share one resolver; no second label composition exists
- [x] A-012 Type narrowing over assertions: no `as` casts introduced
- [x] A-013 Tests cover the changed behaviour (new/bug-fix behaviour has unit tests; the affected e2e spec was run)
- [x] A-014 Comment narration: new comments state constraints (base-index, why the wrapper is not `truncate`), cite no change IDs or PR numbers
- [x] A-015 Type check passes: `npx tsc --noEmit` is clean

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change removes the three inline `pane ${paneIndex + 1}/${count}` compositions it replaces (plus the now-unused `paneCount`/`activePaneIndex` locals and the `{hostName ? " " : ""}` separator); no other existing file, function, branch, or config is made redundant or unused.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | `getTmxLabel` takes the whole `WindowInfo` (not a panes array) so callers pass `win` like the other resolvers | Mirrors `getFabLine(win)` / `getOutputLine(win, …)` signatures in the same file | S:85 R:95 A:95 D:90 |
| 2 | Certain | The panel's passive branch keeps rendering the label without an id via the same function (empty `paneId` ⇒ no suffix) rather than a second variant | Intake § What Changes 1; one resolver is the point of the extraction | S:90 R:95 A:95 D:95 |
| 3 | Confident | The wrapper's `whitespace-nowrap` is kept on the wrapper (children inherit) rather than repeated per button | Pure class placement; children are single-line buttons; trivially reversible | S:75 R:98 A:90 D:85 |

3 assumptions (2 certain, 1 confident, 0 tentative).
