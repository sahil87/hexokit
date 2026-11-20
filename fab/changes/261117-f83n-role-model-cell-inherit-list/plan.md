# Plan: Role Model Cell — Inherit-First List, Custom Entry, Stale-Pin Flag, Tool-Change Reset

**Change**: 261117-f83n-role-model-cell-inherit-list
**Intake**: `intake.md`

## Requirements

### Settings Agents Tab: Role Model Cell

#### R1: Inherit-first model list that opens unfiltered
The per-role model cell SHALL be a native `<select>` (aria-label `` `${role} model` ``) whose options are produced by a pure builder in fixed order: (1) inherit, labelled `↳ inherit (<inherited>)` with value `""`; (2) every suggestion for the row's effective tool, in document order, labelled by id; (3) the current override when it is not a suggestion — labelled `<value> (not offered)` when the suggestion list is non-empty, plain `<value>` when empty; (4) `Custom…` with a sentinel value that cannot be a model id. `<inherited>` SHALL be `cell.effective` when `cell.override === null`, else `cell.inherited`, falling back to `provider default`. The select's value SHALL be `cell.override ?? ""`, and it SHALL be dimmed while inheriting. Picking inherit SHALL POST `{ "agent.profiles.<role>.model": null }`; picking a suggestion or the stale entry SHALL POST that id. Writes go through the row's `useRowWrite.run`.

- **GIVEN** the `doing` role has model override `claude-sonnet-5-5` and claude suggests `[claude-opus-5-5, claude-sonnet-5-5]`
- **WHEN** the user opens the model list
- **THEN** the options are `↳ inherit (<inherited>)`, `claude-opus-5-5`, `claude-sonnet-5-5`, `Custom…` with `claude-sonnet-5-5` selected
- **AND** no option is hidden by the saved value

- **GIVEN** the `review` role inherits model `""` (no fill)
- **WHEN** the panel renders
- **THEN** the first option reads `↳ inherit (provider default)` and is selected

- **GIVEN** an override `gpt-5.6-sol` on a claude row
- **WHEN** the panel renders
- **THEN** a `gpt-5.6-sol (not offered)` option sits after the suggestions and before `Custom…`, selected

#### R2: Custom free-text entry
Picking `Custom…` SHALL NOT write; it SHALL swap the cell to a focused text input built on `useTextSettingDraft` (initial draft `cell.override ?? ""`). Enter/blur SHALL commit the trimmed value (`""` → `null`). A successful commit, or a blur/Enter with an unchanged draft, SHALL return the cell to the list. A failed commit SHALL keep the input, the draft, and show the error inline. Escape SHALL always revert, clear the error, return to the list, and stop propagation so the dialog stays open.

- **GIVEN** the model list is shown
- **WHEN** the user picks `Custom…`, types `glm-latest[1m]`, presses Enter
- **THEN** one POST `{ "agent.profiles.<role>.model": "glm-latest[1m]" }` is sent and the list returns
- **WHEN** the user picks `Custom…` then presses Escape
- **THEN** no POST is sent and the select is shown again

#### R3: Stale-pin inline note
When `cell.override !== null` and the row's suggestion list is non-empty and lacks the override, the row SHALL render an amber full-width sub-row note (`data-testid="stale-model-<role>"`) replacing the old ⚠ marker. Non-claude tool wording: `pinned to <value>, which <tool> doesn't offer — [inherit <inherited>] instead?`. Claude (`role.provider.effective === "claude"`) wording: `pinned to <value>, not in the list — [inherit <inherited>] to track the latest`. The bracketed part SHALL be a button (accessible name `` `Inherit ${inherited} for ${role} model` ``, disabled while busy) that POSTs `{ "agent.profiles.<role>.model": null }`. No note when the list is empty or there is no override.

- **GIVEN** a codex row with model override `claude-opus-5-5` and codex suggests `[gpt-5.6-sol]`
- **WHEN** the panel renders
- **THEN** the note reads `pinned to claude-opus-5-5, which codex doesn't offer — inherit … instead?`
- **WHEN** the user clicks the inherit button
- **THEN** a POST `{ "agent.profiles.review.model": null }` is sent

- **GIVEN** a kimi row (no suggestions) with override `kimi-k3`
- **THEN** no stale note renders

#### R4: Tool change resets model and effort in one POST
Changing a role's provider SHALL send one patch. The new effective tool is `v ?? role.provider.inherited` (falling back to `fields["agent.<depth>"].value` when `inherited` is empty). When the new effective tool equals `role.provider.effective`, the patch SHALL carry only the provider key. Otherwise it SHALL carry the provider key plus `model: null` unless the model override exists and is in `modelSuggestions[newTool]`, and `effort: null` unless the effort override exists and is in `effortSuggestions`.

- **GIVEN** `review` effective tool claude, model override `claude-opus-5-5`, effort override `high`
- **WHEN** the user picks `codex`
- **THEN** POST `{ provider: "codex", model: null }` (effort kept — `high` is suggested)
- **GIVEN** `review` effective codex with override `gpt-5.6-sol`
- **WHEN** the user picks inherit for the tool and the depth knob is `codex`
- **THEN** POST `{ provider: null }` only
- **GIVEN** a role with no overrides inheriting claude
- **WHEN** the user picks codex
- **THEN** POST `{ provider: "codex", model: null, effort: null }`

### Non-Goals

- Backend changes, per-tool effort capability, inherit-label fix — H2
- Model discovery / searchable list — H4
- Tool-default option — H3
- provider → cli relabel — H5

### Design Decisions

#### Inherit-first native select for the role model cell
**Decision**: The model cell is a native `<select>` whose options come from a pure kind-tagged builder: inherit (unset) first, then the tool's suggestions, the non-offered override, and `Custom…` (free text).
**Why**: A `<datalist>` is filtered by the input's text, so once a pin is saved only that pin is listed; a select always lists everything and makes "inherit" — the default the kit's per-role fills rely on — a visible first choice. The builder keeps order and commit semantics fixed when the renderer becomes searchable.
**Rejected**: Keeping the datalist and clearing on focus (still browser-filtered, hides the current value); a custom combobox now (more machinery than a short list needs).
*Introduced by*: 261117-f83n-role-model-cell-inherit-list

#### Tool change clears overrides the new tool doesn't offer
**Decision**: A provider write carries `model: null` / `effort: null` in the same POST unless the new effective tool offers the override; a write that doesn't change the effective tool sends only the provider key.
**Why**: A cross-tool pin (`claude --model gpt-5.6-sol`) is always wrong; clearing it in the same request leaves no window with the bad pair. Same-tool writes must not wipe a custom pin the suggestion list doesn't carry.
**Rejected**: Warning only (the old ⚠ — the bad pair still reaches dispatch); always clearing (wipes legitimate custom claude models on a no-op write).
*Introduced by*: 261117-f83n-role-model-cell-inherit-list

## Tasks

### Phase 2: Core Implementation

- [x] T001 In `app/frontend/src/components/settings-agents-panel.tsx`, add the `ModelOption` type, `MODEL_INHERIT`/`MODEL_CUSTOM` constants and pure `modelOptions(cell, suggestions)` builder, and replace `RoleModelInput` with a `RoleModelCell` rendering the `<select>` (list mode, committing via the row's `run`) and the `Custom…` text-input mode on `useTextSettingDraft` (focus on enter, Escape always returns, commit success returns) <!-- R1 R2 -->
- [x] T002 In the same file, remove the ⚠ `mismatch` marker and add the stale-pin sub-row note with the claude/non-claude wording and the one-click inherit button in `RoleRow` <!-- R3 -->
- [x] T003 In the same file, change `RoleRow`'s provider `onChange` to build the tool-change patch (new effective tool, same-tool short-circuit, model/effort keep-or-null), passing `modelSuggestions` map, `effortSuggestions` and the depth knob value from `RoleTable` <!-- R4 -->

### Phase 3: Tests

- [x] T004 Update `app/frontend/src/components/settings-agents-panel.test.tsx`: replace datalist/placeholder/⚠ tests; add cases for each option kind, custom mode (commit, empty → null, Escape, failure), stale-pin note wording + action + absence, and tool-change patch shapes (cleared, kept, inherit vs depth knob, same tool) <!-- R1 R2 R3 R4 -->
- [x] T005 Add the e2e regression to `app/frontend/tests/e2e/settings-agents.spec.ts` (JSDoc Proves/Steps): pick a model, re-mount the tab, assert the select keeps the value and lists inherit, every suggestion and `Custom…`; run `npx tsc --noEmit`, the unit tests and the agents e2e spec <!-- R1 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: The model cell is a `<select>` with options inherit → suggestions → non-suggested override → `Custom…`, and inherit/suggestion picks POST `null`/the id
- [x] A-002 R2: `Custom…` swaps to a text input that commits on Enter/blur (empty → null) and returns to the list on success or Escape
- [x] A-003 R3: A stale pin renders the inline note with the per-tool wording and a button that POSTs `null`
- [x] A-004 R4: Provider changes send one patch that keeps model/effort only when the new tool offers them, and only the provider key when the effective tool doesn't change

### Behavioral Correctness

- [x] A-005 R1: With a saved override, every suggestion is still listed (the datalist filter bug is gone)

### Removal Verification

- [x] A-006 R3: The ⚠ `model not in the provider's suggestions` marker and the `<datalist>` are gone, with no dead code

### Scenario Coverage

- [x] A-007 R1: Unit tests cover each option kind, and the e2e spec covers set → re-mount → full list
- [x] A-008 R4: Unit tests cover cleared, kept, inherit-vs-depth-knob and same-tool patch shapes

### Edge Cases & Error Handling

- [x] A-009 R3: No note when suggestions are empty or no override exists; the `(not offered)` suffix is omitted for an empty list
- [x] A-010 R2: A failed custom commit keeps the input and draft and shows the error; Escape does not close the dialog

### Code Quality

- [x] A-011 Pattern consistency: New code follows the panel's existing patterns (`useRowWrite`, `useTextSettingDraft`, `RoleSelect` styling, `profileKey`)
- [x] A-012 No unnecessary duplication: The inherit-value rule is shared between the select label and the stale note
- [x] A-013: Frontend uses type narrowing over `as` casts in new code
- [x] A-014: No magic strings — sentinel option values are named constants
- [x] A-015: Comments state constraints only; no narration or change IDs
- [x] A-016: The new e2e test carries a Proves/Steps JSDoc block

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the replaced `RoleModelInput`, its `<datalist>` and the ⚠ `mismatch` marker were already removed in the diff; `inheritedLabel`, `roleSelectClass` and `useTextSettingDraft`'s `onKeyDown` all keep live callers)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | `MODEL_CUSTOM` sentinel is a string containing a character no model id can carry | Keeps the select's value space disjoint from real ids; inherit uses `""` which the backend already treats as unset | S:70 R:90 A:80 D:70 |
| 2 | Confident | The `Custom…` text input reuses the `${role} model` aria-label (only one of select/input exists at a time) | Keeps label-based queries stable across modes | S:65 R:90 A:75 D:65 |
| 3 | Confident | The e2e "reload" switches away from the Agents tab and back (re-mount re-fetches) | The panel fetches on every mount; tab switching is the documented freshness path and avoids re-opening the palette | S:70 R:90 A:75 D:70 |
| 4 | Certain | Light lane: 5 tasks, all in one component plus its tests | Lane rule ≤ 5 tasks | S:90 R:90 A:95 D:90 |

4 assumptions (1 certain, 3 confident, 0 tentative).
