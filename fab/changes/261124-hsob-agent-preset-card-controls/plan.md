# Plan: Agent preset card controls (plan step C1)

**Change**: 261124-hsob-agent-preset-card-controls
**Intake**: `intake.md`

All paths below are under `app/frontend/` unless stated. Frontend only — no backend, route, tmux-option or fab-kit change.

## Requirements

### Data: preset ladder and machine default

#### R1: Machine default exposed through the cached fab-config read
`src/lib/agent-presets.ts` SHALL expose, from the ONE cached `getFabConfig()` read (30 s TTL, never rejects), both the machine-wide preset list (`agent_presets`) and the machine default preset (`fields["agent.preset"].value` when it is a non-empty string; otherwise absent). `loadMachineAgentPresets()` MUST keep its current signature and behavior (thin wrapper), so existing callers and tests are unaffected. A hook (alongside `useAgentPresetList` / `useMachineAgentPresets`) SHALL expose the machine default to components.

- **GIVEN** `/api/fab-config` returns `installed: true`, `agent_presets: [...]` and `fields["agent.preset"].value = "claude"`
- **WHEN** the card asks for the machine default
- **THEN** it receives `"claude"` and the preset list, from a single network request within the TTL
- **AND** when `installed: false`, the request fails, or the field is empty/null, the default is absent and nothing throws

#### R2: Pure effective-preset resolver
A pure function SHALL resolve an entity's effective preset and its source from `{ own?, workspace?, machineDefault? }` (`workspace` passed only for a group): own set → `"set here"`; else (group) workspace set → `"from workspace"`; else machine default set → `"machine default"`; else `{ name: undefined, source: "fab's defaults" }`. `none` at any rung is a real value that stops the walk. Empty string counts as unset.

- **GIVEN** a group with no own value and a workspace value `none`
- **WHEN** resolved
- **THEN** the result is `{ name: "none", source: "from workspace" }`
- **AND** a workspace never consults a `workspace` rung

### Sidebar: card preset line

#### R3: Preset line always present while fab reports presets
The group card (`session-row.tsx`) and the workspace card (`ServerCardContent` in `server-card.tsx`, consumed by both the Workspaces-panel tile and the GROUPS-pane workspace header) SHALL render `agent preset: <name> · <source>` whenever the preset list the card judges against is non-empty — not only when the entity has its own preset — and SHALL render no line when fab reports no presets (list undefined or empty). `<name>` uses `describeAgentPreset(name, list)` (`<name> (unknown)`, `none (no preset)`); when nothing is set anywhere the line reads exactly `agent preset: none · fab's defaults`. `data-testid="row-flyout-agent-preset"` is kept. The group card judges names against the group's repo-scoped list when remembered (`useAgentPresetList(server, session)`), else the machine list; the workspace card uses the machine list.

- **GIVEN** presets are reported, the group has no own value, and its workspace has `codex-workers`
- **WHEN** the group card opens
- **THEN** it shows `agent preset: codex-workers · from workspace`
- **AND** with own `old-preset` unknown to the list it shows `agent preset: old-preset (unknown) · set here`
- **AND** with nothing set anywhere it shows `agent preset: none · fab's defaults`
- **AND** when fab reports no presets, no preset line renders

#### R4: Workspace preset threaded to group rows
`SessionRow` SHALL receive the owning workspace's preset (`serverInfo?.agent_preset` from `ServerGroup` in `src/components/sidebar/index.tsx`) as a primitive string prop, so the group card can resolve inheritance without new fetches; the row's memo contract (stable primitive/identity props) MUST be preserved.

- **GIVEN** a workspace with `agent_preset: "codex-workers"` and a group row inside it
- **WHEN** the group row renders
- **THEN** its card can show `· from workspace` without any extra request

### Sidebar: Agent preset… row and chooser

#### R5: "Agent preset…" action row
Both cards SHALL render a `CardActionRow` labelled `Agent preset…` (testid `row-flyout-agent-preset-action`) placed **immediately after** `Change color…` (or first among the rows when the card has no Change color… row), with the effective preset's display name as its `hint` (same display string as the line's `<name>`; `none` when nothing is set anywhere). The row SHALL be hidden when fab reports no presets, and rendered only when the consumer supplies the set seam (optional-handler gate, like `onSpawnAgent`).

- **GIVEN** presets are reported and the group has own `codex-review`
- **WHEN** the group card opens
- **THEN** the action row directly after `Change color…` reads `Agent preset…` with hint `codex-review`
- **AND** with no presets reported, the row is absent

#### R6: Chooser opens as an anchored popover (close-then-open)
Clicking the row SHALL close the card and then open a chooser popover anchored to the same element the color popover anchors to — the group row (`session-row.tsx`), the Workspaces-panel tile (`server-panel.tsx` `ServerTile`), and the GROUPS-pane workspace header (`index.tsx` `ServerGroup`) — with the card's `useRowFlyout({ suppressed })` including the chooser's open state (popover-over-card precedence). Where the color popover is portalled (tile, header) the chooser SHALL be portalled too, using `useAnchoredPopoverPos` or an equivalent that keeps the taller chooser inside the viewport (flip/clamp; it must fit within a 375 px wide, 812 px tall viewport). Same mechanism on fine and coarse pointers.

- **GIVEN** the group card is open
- **WHEN** the user clicks `Agent preset…`
- **THEN** the card closes and the chooser opens anchored to that group row, fully inside the viewport

#### R7: Chooser contents and current-choice marking
The chooser SHALL list, in order: `inherit` with description `uses <name> (<source>)` computed from the inherited rungs only (group: workspace → machine default → fab's defaults; workspace: machine default → fab's defaults; `<name>` uses the same display rules, `none` when nothing is set — e.g. `uses none (fab's defaults)`); then each preset from the list with its `description` (omitted when absent); then `none` with `no preset, even the machine default`. A heading `Agent preset · Group <name>` / `Agent preset · Workspace <name>` and a footer `Applies to tabs created from now on. Running tabs keep theirs.` SHALL render. The current choice SHALL be marked (`aria-checked="true"` plus a visible mark): `inherit` when the entity has no own value, the matching preset, or `none` for own `none`; an own unknown name marks nothing. It is a `role="radiogroup"` (`aria-label="Agent preset for <entity>"`) of `role="radio"` entries. The list-building logic SHALL be a pure function in `src/lib/agent-presets.ts`; the chooser component SHALL be one shared component (e.g. `src/components/sidebar/agent-preset-chooser.tsx`) used by all three anchors.

- **GIVEN** a group with no own value, workspace `codex-workers`, and presets `claude`, `codex-review`, `codex-workers`
- **WHEN** the chooser opens
- **THEN** entries are `inherit` (`uses codex-workers (from workspace)`), `claude`, `codex-review`, `codex-workers` (each with its description), `none` (`no preset, even the machine default`)
- **AND** `inherit` is the checked entry

#### R8: Chooser list source
For a group the chooser SHALL offer the group's repo-scoped list when available, as the palette does (`app.tsx` ~L4870: `getRiffPresets(server, session)` → `rememberRepoAgentPresets` → fall back to `loadMachineAgentPresets()`), rendering any already-held list (remembered repo list or machine list) immediately; for a workspace, the machine list.

- **GIVEN** a group whose repo defines a project preset `team`
- **WHEN** its chooser opens
- **THEN** `team` appears among the entries once the repo-scoped list is loaded

#### R9: Picking applies through the existing routes
Picking an entry SHALL call the existing API and close the chooser: group → `setSessionAgentPreset(server, session, value)`; workspace → `setServerAgentPreset(server, value)`; `inherit` sends `null`, `none` sends `"none"`, a preset sends its name. Errors SHALL surface as a toast and the workspace path SHALL refresh servers, mirroring the existing clear handlers (`index.tsx` ~L1775–1790, ~L2643), which SHALL be generalised into set handlers taking `name | null` (clear = set `null`) rather than duplicated.

- **GIVEN** a workspace chooser
- **WHEN** the user picks `inherit`
- **THEN** `POST /api/servers/agent-preset` receives `{ name: <server>, agent_preset: null }` and the chooser closes
- **AND** picking `none` on a group POSTs `{ agent_preset: "none" }` to `/api/sessions/<group>/agent-preset`

#### R10: Chooser keyboard and dismissal
ArrowDown/ArrowUp SHALL move focus between entries (wrapping), Enter (and Space) SHALL pick the focused entry, Escape SHALL close without changing anything, and a click outside SHALL close. On open, focus SHALL start on the current choice, falling back to `inherit` when nothing is checked. The palette actions (`Group: Set Agent Preset…`, `Group: Clear Agent Preset`, `Workspace: Set Agent Preset…`, `Workspace: Clear Agent Preset`) MUST remain unchanged.

- **GIVEN** the chooser opened with `codex-review` current
- **WHEN** the user presses ArrowDown then Enter
- **THEN** focus started on `codex-review`, moved to the next entry, and that entry is applied
- **AND** Escape instead closes with no API call

### Sidebar: row marker

#### R11: Preset-name marker on group and workspace rows
A group row, a Workspaces-panel tile and the GROUPS-pane workspace header SHALL show a small neutral chip with the entity's **own** preset name (testid `agent-preset-marker`), and nothing when the entity only inherits. An own `none` shows the literal `none`. Placement: directly after the name, before the badges (group row: after the name span, before the viewer badge / `WaitingBadge` / `+`; tile: on the name line after the name; header: after the server name, before its trailing controls). Styling: neutral (`text-text-secondary`, 1px `border-border`, small radius, ~10px text, `leading-none`), capped at `max-w-[14ch]` with ellipsis; the entity name (`min-w-0 truncate`) keeps priority. Sizing differs by surface width: on group rows and the GROUPS-pane header (room to spare) the chip MAY be `shrink-0`; on the **Workspaces-panel tile** (72–96 px wide) the name and the chip SHALL share the line — the chip shrinks with its own ellipsis (`min-w-0`/shrinkable, a small floor of ~3ch, at most about half the line) and the name keeps a visible floor (~3ch) — so that BOTH the workspace name and the chip have non-zero rendered width inside the tile at 1280×720 and 375×812, even for long names and long presets; `title="agent preset: <name>"` and an accessible label. It MUST NOT wrap the row or push content past the coarse `pr-[56px]` rail reserve or the 375 px drawer width, and must not alter the window row (Row Minimalism).

- **GIVEN** a group with own `codex-review` and a sibling group that inherits
- **WHEN** the sidebar renders
- **THEN** only the first group's row shows a `codex-review` chip, after its name
- **AND** a very long preset name is truncated with an ellipsis inside the chip and the row stays one line at 375 px on a coarse pointer
- **AND** on a Workspaces-panel tile with own `codex-review`, the workspace name and the chip are both visibly rendered (each wider than 0 px and inside the tile) on desktop and mobile

### Sidebar: unchanged clear row

#### R12: Clear row for an unknown name stays
`AgentPresetClearRow` ("Clear agent preset", shown only for a name unknown to the list) SHALL keep its current behavior.

- **GIVEN** a group with own `old-preset` unknown to the list
- **WHEN** the card opens
- **THEN** `Clear agent preset` is still offered and still POSTs `null`

### Docs

#### R13: Memory updated
`docs/memory/run-kit/ui/sidebar.md` and `docs/memory/run-kit/ui/dialogs-and-state.md` SHALL describe the always-present line and its source wording, the `Agent preset…` row, the chooser (entries, marking, list source, keyboard, footer), and the row marker (hydrate stage).

- **GIVEN** the change is hydrated
- **WHEN** a reader opens `sidebar.md`
- **THEN** it states the current card/row behavior with no transition narration

### Non-Goals

- Settings > Agent "Save as preset…" / "Manage…" — plan step C2.
- A per-role breakdown in the chooser.
- Changing the preset of a running tab; any backend or fab-kit change.
- Changing the palette agent-preset actions.
- Showing a repo's project-file `agent.preset` as a rung on the card.

### Design Decisions

#### Chooser as an anchored popover reusing the color-picker anchor
**Decision**: The chooser opens via the card's close-then-open idiom as a popover anchored where the `Change color…` popover anchors, on both pointer classes.
**Why**: The card already hosts every per-entity action and the color popover is the established "card row opens a picker" shape; the design study shows the chooser taking the card's place.
**Rejected**: A centered dialog (a new surface shape unlike Change color…); popover on desktop + dialog on mobile (two shapes for one control).
*Introduced by*: 261124-hsob-agent-preset-card-controls

#### Marker after the name, before badges
**Decision**: The own-preset marker is a capped (14ch) neutral chip directly after the entity name.
**Why**: It reads as an attribute of the name, stays clear of the right-hand badge/`+`/rail cluster, and the name keeps truncation priority.
**Rejected**: Trailing after the count (crowds the `+`/rail at narrow widths); hiding at narrow widths (loses the at-a-glance signal on mobile).
*Introduced by*: 261124-hsob-agent-preset-card-controls

## Tasks

### Phase 1: Setup

- [x] T001 Extend `src/lib/agent-presets.ts`: cache `{ presets, machineDefault }` from the single `getFabConfig()` read (keep TTL + never-rejects; `loadMachineAgentPresets()` becomes a thin wrapper), add the pure `resolveAgentPreset({ own, workspace?, machineDefault? })` and `buildAgentPresetChoices({ presets, own, inherited })` (returns entries with `value: string | null`, `label`, `description?`, `checked`), and a display helper shared by line/hint/inherit description. Add a hook (e.g. `src/hooks/use-machine-agent-preset-info.ts` or extend `use-agent-preset-list.ts`) exposing the machine default. Unit tests in `src/lib/agent-presets.test.ts` covering every row of R2/R3's wording table and R7's list/marking (incl. unknown → none checked, workspace `none` stopping the walk). <!-- R1 --> <!-- R2 --> <!-- R7 -->

### Phase 2: Core Implementation

- [x] T002 Rework `src/components/sidebar/agent-preset-card.tsx`: replace `AgentPresetFact` with a line component taking `{ own, workspace?, server?, session? }` that renders `agent preset: <name> · <source>` when the judged list is non-empty and nothing otherwise; add an `AgentPresetActionRow` (`CardActionRow`, label `Agent preset…`, testid `row-flyout-agent-preset-action`, hint = effective display name, hidden with no presets; pick an existing icon from `icons.tsx` or add a small gear/sliders glyph); keep `AgentPresetClearRow` unchanged. <!-- R3 --> <!-- R5 --> <!-- R12 -->
- [x] T003 Create the shared chooser `src/components/sidebar/agent-preset-chooser.tsx`: heading, `role="radiogroup"` of `role="radio"` entries from `buildAgentPresetChoices`, footer text, visible mark on the checked entry, ≥36 px rows on coarse (`coarse:min-h-[36px]`), keyboard (Arrow wrap, Enter/Space pick, Escape close, initial focus on checked or `inherit`), click-outside close (follow `SwatchPopover`'s dismissal pattern), list source per R8 (group: show held list immediately, then `getRiffPresets` → `rememberRepoAgentPresets` → fallback `loadMachineAgentPresets`; workspace: machine list), `onPick(value: string | null)` then close. <!-- R6 --> <!-- R7 --> <!-- R8 --> <!-- R10 --> <!-- rework: chooser viewport fit must use measured height / clamp max-height to innerHeight-top; key entries by value not label; focus only on first open (do not re-steal focus when the repo list arrives); repo-list loading via a shared lib loader -->
- [x] T004 Group card + row in `src/components/sidebar/session-row.tsx`: new props `workspaceAgentPreset?: string` and `onSetAgentPreset?: (server, session, name: string | null) => void`; always-present line; `Agent preset…` row immediately after `Change color…` using close-then-open with a `showPresetChooser` state added to `useRowFlyout({ suppressed })`; mount the chooser anchored to the row (same placement idiom as the row's `SwatchPopover`, clamped inside the viewport); render the R11 marker after the name span. <!-- R3 --> <!-- R4 --> <!-- R5 --> <!-- R6 --> <!-- R11 -->
- [x] T005 Workspace card in `src/components/sidebar/server-card.tsx`: `ServerCardContent` gains the line (always-present, machine list), the `Agent preset…` row immediately after `Change color…` (seam `onAgentPresetAction?: () => void`), keeping the Clear row; if `useAnchoredPopoverPos`'s 100 px flip guess is too small for the chooser, add an optional height parameter (default unchanged for existing callers). <!-- R3 --> <!-- R5 --> <!-- R6 -->
- [x] T006 Workspaces-panel tile in `src/components/sidebar/server-panel.tsx` (`ServerTile`) and GROUPS-pane header in `src/components/sidebar/index.tsx` (`ServerGroup`): wire close-then-open to a portalled chooser anchored at `tileAnchorRef` / `headerRef` (suppress the card while open), and render the R11 marker after the name on the tile's name line and the header's name. <!-- R6 --> <!-- R11 --> <!-- rework: tile name line made flex drops the ellipsis and squashes the marker (server-panel.tsx:407); header chip inherits uppercase from the toggle button (index.tsx:3001) --> <!-- rework cycle 2 (revised R11): tile chip is shrink-0 so the workspace name collapses to 0px in 72-96px tiles; make the tile chip shrinkable with a floor and give the name a floor; drop the tile glyphs' mr-0.5 now that the line is flex gap-1 -->

### Phase 3: Integration & Edge Cases

- [x] T007 In `src/components/sidebar/index.tsx`: generalise `handleSessionAgentPresetClear` / `handleServerAgentPresetClear` / `handleAgentPresetClear` into set handlers taking `name | null` (toast on error; workspace path refreshes servers), keep the clear seams as calls with `null`, thread `onSetAgentPreset` + `workspaceAgentPreset={serverInfo?.agent_preset}` to `SessionRow` (~L3241) and the set seams to `ServerPanel`/`ServerTile` and the header card, preserving stable identity-arg handlers for the row memo. Verify the board-route sidebar still renders (no seam ⇒ no row). <!-- R4 --> <!-- R9 --> <!-- R12 -->
- [x] T008 Vitest component tests: extend `src/components/sidebar/session-row.test.tsx` (~L700 preset block) and `src/components/sidebar/server-panel.test.tsx` (~L655 block) — line always present/hidden, source wording, action row placement directly after `Change color…` + hint, click closes card and opens chooser, picking calls the seam with name / `null` / `"none"`, keyboard (initial focus, arrows, Enter, Escape), marker only for own preset; add `src/components/sidebar/agent-preset-chooser.test.tsx` if useful. Update any existing assertions the always-present line changes. <!-- R3 --> <!-- R5 --> <!-- R7 --> <!-- R9 --> <!-- R10 --> <!-- R11 --> <!-- rework: add a test for a long workspace name + marker on the tile, and the header chip keeping the preset's case -->
- [x] T009 Playwright e2e `tests/e2e/agent-preset-card.spec.ts` (model on `tests/e2e/agent-preset-palette.spec.ts`'s fully mocked routes; file header + Proves/Steps JSDoc per Constitution): set, inherit and `none` on a group and on a workspace via the card row + chooser (assert POST bodies), the row marker appearing for an own preset and absent when inheriting, keyboard pick, and a coarse/mobile (375×812) case opening the card from the rail. Run with `just test-e2e "agent-preset"` plus `row-minimalism`, `row-flyout`, `sidebar-section-rail`, `agent-preset-palette`. <!-- R3 --> <!-- R6 --> <!-- R9 --> <!-- R10 --> <!-- R11 --> <!-- rework cycle 2: add an e2e geometry assertion on the Workspaces tile (desktop + 375x812): name width > 0 and chip width > 0, both inside the tile, for a workspace with its own preset -->

### Phase 4: Polish

- [x] T010 Demo spec `tests/demo/agent-preset-card.demo.ts` (model on `tests/demo/group-agent-preset.demo.ts`): open a group card, show the line, open the chooser, pick a preset, show the row marker; repeat inherit on the workspace. Verify it records with `just demo agent-preset-card --desktop-only` and `--mobile-only` (the before/after recording for the PR is produced at ship). <!-- R6 --> <!-- R11 -->
- [x] T011 Run the verification gates via `just`: `just test-frontend`, frontend type check (`cd app/frontend && npx tsc --noEmit`), the e2e specs above, `just build`. Fix any failures. If `control-gallery.tsx` or the Control primitive was touched (not expected), regenerate the control-gallery baselines. <!-- R1 --> <!-- R3 -->

## Execution Order

- T001 blocks T002–T006 (they consume the resolver, choices builder and machine-default hook).
- T003 blocks T004–T006 (they mount the chooser).
- T007 depends on T004–T006 (seam shapes).
- T008–T010 follow T007; T011 runs last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: The machine default and the preset list come from one cached `/api/fab-config` read; `loadMachineAgentPresets()` callers are unchanged
- [x] A-002 R2: The resolver returns the four sources exactly as `set here` / `from workspace` / `machine default` / `fab's defaults`, treating `none` as a value
- [x] A-003 R3: Both cards show `agent preset: <name> · <source>` whenever presets are reported, and no line otherwise
- [x] A-004 R4: `SessionRow` receives the workspace preset as a primitive prop without breaking its memo contract
- [x] A-005 R5: `Agent preset…` sits immediately after `Change color…` on both cards with the effective name as hint, hidden with no presets
- [x] A-006 R6: Clicking the row closes the card and opens the chooser anchored to the group row / tile / header, inside the viewport — one shared `AnchoredAgentPresetChooser` (portalled) flips on the measured height and clamps `maxHeight` to `innerHeight - top`; e2e asserts containment at 375×812
- [x] A-007 R7: The chooser lists inherit (with its resolved description), the presets with descriptions, and none, with the current choice marked; one shared component, pure list builder
- [x] A-008 R8: A group's chooser offers its repo-scoped list when available, else the machine list
- [x] A-009 R9: Picks POST to the existing routes (`null` for inherit, `"none"` for none, the name otherwise) via generalised set handlers, with toast on error
- [x] A-010 R10: Arrow/Enter/Escape/click-outside work, focus starts on the current choice, and the palette actions are unchanged
- [x] A-011 R11: Group rows, workspace tiles and the GROUPS-pane header show the own-preset chip after the name, nothing when inheriting — header chip keeps the preset's case; group/header chips stay `shrink-0`; the tile chip is now shrinkable (`min-w-[3ch] max-w-1/2 shrink`, `agent-preset-card.tsx:67`) and the tile name has a `min-w-[3ch] flex-1 truncate` floor (`server-panel.tsx:427`). Re-measured: desktop tile 96 px → name 37 px / chip 41 px; mobile tile 72 px → name 25 px / chip 29 px, for short and long names/presets. Residual edge (should-fix): a protected + external tile on mobile pushes the chip past the clipped line
- [x] A-012 R12: `Clear agent preset` still appears only for an unknown own name and still clears
- [x] A-013 **N/A**: covered by hydrate stage

### Behavioral Correctness

- [x] A-014 R3: A group/workspace that inherits now shows a preset line (previously none); the own-value line now carries `· set here`

### Scenario Coverage

- [x] A-015 R3: Vitest covers every line-wording case (own, unknown, own none, from workspace, machine default, fab's defaults) and the no-presets hidden case
- [x] A-016 R9: e2e covers set, inherit and none on a group and on a workspace, asserting POST bodies
- [x] A-017 R11: e2e covers the row marker appearing for an own preset and absent when inheriting
- [x] A-018 R6: e2e covers the coarse-pointer / 375 px path opening the card from the rail and picking from the chooser

### Edge Cases & Error Handling

- [x] A-019 R7: An own unknown name marks no entry, focus starts on `inherit`, and the Clear row remains
- [x] A-020 R2: A workspace `none` makes an inheriting group read `none (no preset) · from workspace`
- [x] A-030 R11: On a Workspaces-panel tile with its own preset, the name and the chip both render with non-zero width inside the tile at 1280×720 and 375×812 (e2e geometry assertion) — `agent-preset-card.spec.ts` "desktop tile keeps…" / "mobile tile keeps…" pass; a reviewer geometry probe with long workspace names and long presets also passed
- [x] A-021 R11: A long preset name truncates inside the chip and the row stays one line at 375 px coarse without overlapping the rail — group row and header verified by geometry probe (chip ≤ 84 px, name visible); the tile case is tracked under A-011
- [x] A-022 R9: A failed POST surfaces a toast and leaves the UI consistent — `index.test.tsx` "toasts a failed workspace preset write" covers the header path; group/tile handlers share the same toast-on-error shape

### Code Quality

- [x] A-023 Pattern consistency: New code follows the sidebar's card/popover idioms (close-then-open, optional-handler gating, `useRowFlyout` suppression) and naming
- [x] A-024 No unnecessary duplication: Set handlers generalise the existing clear handlers; list building lives in one pure function; `api/client.ts` utilities reused
- [x] A-025 Type narrowing: No `as` casts where `if` guards or discriminated unions suffice
- [x] A-026 Tests: New behavior has Vitest and Playwright coverage; every new `test()` carries the Proves/Steps JSDoc and the spec file a header comment
- [x] A-027 No polling: The chooser and line use the cached reads/SSE state, never `setInterval` + fetch
- [x] A-028 Comments: No narration or change-id citations in code comments
- [x] A-029 No real fab config writes: tests use mocks/stubs only (plan Rule 6)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- PR evidence (`just demo agent-preset-card --before`, desktop + mobile) is produced at ship.

## Deletion Candidates

- `app/frontend/src/hooks/use-machine-agent-presets.ts` (`useMachineAgentPresets`) — near-verbatim twin of `useMachineAgentPresetInfo`; its one caller (`app.tsx:4858`) could read `useMachineAgentPresetInfo()?.presets` and the file be dropped (palette wiring — defer to C2 or a follow-up).
- `app/frontend/src/components/sidebar/server-panel.tsx:406` (`whitespace-nowrap` + `text-ellipsis` on the tile's name-line `div`) — the line is now a flex container whose name `span` (`truncate`) and chip (`whitespace-nowrap text-ellipsis`) own their own truncation, so the container's ellipsis/nowrap classes are inert (keep `overflow-hidden` and `${nameClass}`, which still clip and color the glyphs).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | When a card has no `Change color…` row, `Agent preset…` is the first action row | Placement is defined relative to Change color…; first is the natural fallback | S:60 R:90 A:75 D:75 |
| 2 | Confident | Chooser portalled where the color popover is portalled (tile, header) and inline-absolute on the group row, clamped to the viewport | Reuses each surface's existing anchoring; the chooser is taller so it needs clamping | S:65 R:85 A:75 D:70 |
| 3 | Confident | `useAnchoredPopoverPos` may gain an optional height parameter, default unchanged | Its 100 px flip guess is too small for the chooser; optional param keeps existing callers intact | S:55 R:90 A:80 D:70 |
| 4 | Confident | Action-row hint shows `none` when nothing is set anywhere, matching the line's name | Keeps line and hint consistent with the intake's chosen wording | S:65 R:95 A:80 D:75 |
| 5 | Confident | Group chooser fetches the repo-scoped list on open via `getRiffPresets`, showing any held list immediately | Mirrors the palette's load path named in the plan | S:75 R:90 A:80 D:75 |

5 assumptions (0 certain, 5 confident, 0 tentative).
