# Plan: Model Suggestions and Per-Model Efforts from `fab agent models`

**Change**: 261120-hnzf-model-suggestions-from-fab-agent-models
**Intake**: `intake.md`

## Requirements

### Backend: Discovery-Backed Model Suggestions (`internal/fabsysconfig`)

#### R1: Suggestions come from `fab agent models --json`
`Client.Read` SHALL run `fab agent models --json` exactly once per call, through the injected `Runner` (so `execRunner`'s `FabTimeout` and `Dir=$HOME` apply), and SHALL build `Document.ModelSuggestions` from its stdout rows. `Document.ModelSuggestions` SHALL have type `map[string][]ModelSuggestion`, where `ModelSuggestion` is `{ID string "id"; Label string "label,omitempty"; Efforts []string "efforts,omitempty"; Default bool "default,omitempty"}`. `Label` SHALL be empty when the row's label equals its id (or is empty). Every entry of `doc.Tools` SHALL have a key (an empty slice when no rows), and rows for a tool not in `doc.Tools` SHALL be ignored.

- **GIVEN** fab prints rows for claude (`opus` alias, `glm-latest[1m]` labelled `GLM 5.3 (Latest)`, `claude-fable-5-1[1m]` with `default:true`) and codex
- **WHEN** `Read` runs
- **THEN** `modelSuggestions.claude` lists `{id:"opus", efforts:[…]}`, `{id:"glm-latest[1m]", label:"GLM 5.3 (Latest)", …}`, `{id:"claude-fable-5-1[1m]", default:true, …}` in fab's order
- **AND** a tool in `doc.Tools` with no rows maps to `[]`

#### R2: Row parsing rules
Rows SHALL be read with the tool field from `cli`, falling back to `provider` when `cli` is empty (new spelling wins). Rows with `source == "reserved"` SHALL be excluded. Within a tool, rows SHALL keep fab's order and SHALL be de-duplicated by `id`, first occurrence winning. Rows with an empty id SHALL be skipped.

- **GIVEN** a row `{"provider":"codex","id":"gpt-6.1-sol",…}` (pre-rename fab) and a row `{"cli":"claude","id":"tool-default","source":"reserved",…}`
- **WHEN** `Read` runs
- **THEN** `gpt-6.1-sol` appears under codex and `tool-default` appears under no tool
- **AND** a second row with the same id under one tool is dropped

#### R3: Fill-scan fallback
When `fab agent models --json` exits non-zero, times out, or its stdout does not decode as a JSON array of rows, `Read` SHALL fall back to today's fill scan (`clis|providers.<tool>.profiles.*.model` values, sorted, de-duplicated) producing `ModelSuggestion{ID: v}` entries, and SHALL add no warning for the failure.

- **GIVEN** an older fab that rejects `agent models --json` with exit 1
- **WHEN** `Read` runs
- **THEN** `modelSuggestions.claude` holds the fill ids as `{id}` objects and `Warnings` is empty

#### R4: Discovery runs concurrently with the config reads
`Read` SHALL start the `fab agent models --json` call concurrently with `fab config show --origin --json` / `fab config explain --json` and join it before building suggestions, so a slow discovery does not add to the config reads' latency. `Read` SHALL NOT issue a discovery call when fab is not installed.

- **GIVEN** discovery takes ~3s and the config reads take ~100ms
- **WHEN** `GET /api/fab-config` runs
- **THEN** the request takes ≈ the discovery time, not the sum

#### R5: Discovery warnings surface on GET and POST
`Read` SHALL put the `warningLines(stderr)` of a successful discovery call into `Document.Warnings`. `Apply` SHALL return the write calls' warning lines followed by the re-read's discovery warnings (it SHALL NOT discard the latter).

- **GIVEN** discovery stderr `warning: codex: codex debug models: timed out after 3s`
- **WHEN** `Read` runs
- **THEN** `Warnings` equals `["warning: codex: codex debug models: timed out after 3s"]`
- **AND** an `Apply` whose `set` printed `warning: x` returns `["warning: x", "warning: codex: …"]`

### Frontend: API Types (`src/api/client.ts`)

#### R6: Suggestion and warning types
`FabConfigDocument.modelSuggestions` SHALL be typed `Record<string, FabModelSuggestion[]>` with `FabModelSuggestion = {id: string; label?: string; efforts?: string[]; default?: boolean}`, and the `warnings` doc comment SHALL state it carries discovery warnings on every read plus write warnings on a POST.

- **GIVEN** the daemon's new document
- **WHEN** the SPA type-checks
- **THEN** `npx tsc --noEmit` passes with every consumer reading `suggestion.id`

### Frontend: Model Cell (`settings-agents-panel.tsx`)

#### R7: Labels, secondary id, default marker
`modelOptions(cell, suggestions)` SHALL take `FabModelSuggestion[]` and keep its fixed option order (inherit, suggestions, stale override, `Custom…`) and commit values (inherit `""` → `null`, suggestion → its id, Custom → NUL sentinel). A suggestion option SHALL expose its id, its label (label, else id), and whether it is the tool's default. In the native `<select>`, the option text SHALL be `` `${label} · ${id}` `` when the label differs from the id, else the id, with ` · tool default` appended for the default model.

- **GIVEN** claude suggestions `{id:"glm-latest[1m]", label:"GLM 5.3 (Latest)"}` and `{id:"opus"}` and `{id:"claude-fable-5-1[1m]", default:true}`
- **WHEN** the doing row's model list renders
- **THEN** the options read `GLM 5.3 (Latest) · glm-latest[1m]`, `opus`, `claude-fable-5-1[1m] · tool default`

#### R8: Searchable list above 30 suggestions
When the row's tool has more than `SEARCHABLE_MODEL_THRESHOLD = 30` suggestions, the model cell SHALL render a searchable list instead of the native `<select>`: a trigger button (aria-label `<role> model`, showing the current option's label, dimmed when inheriting, disabled while busy) that opens a text filter plus a listbox of the same `modelOptions`. The filter SHALL start empty every time it opens (whatever the saved value), SHALL match label or id case-insensitively, and SHALL never hide the inherit or `Custom…` options. ArrowUp/ArrowDown SHALL move the active option, Enter SHALL commit it, clicking an option SHALL commit it, and Escape SHALL close the list without committing and stop propagation (the Settings dialog stays open). Each listbox option SHALL show the label as primary text and, when different, the id as secondary dimmed text, plus the default marker. Choosing `Custom…` SHALL swap to `CustomModelInput` as today. At ≤30 suggestions the native `<select>` SHALL remain.

- **GIVEN** a kimi row with 40 suggestions and a saved override `kimi-a`
- **WHEN** the user opens the list
- **THEN** the filter is empty and all 40 suggestions plus inherit and `Custom…` are listed
- **AND WHEN** they type `k3.1` **THEN** only matching suggestions remain, plus inherit and `Custom…`
- **AND WHEN** they press Enter on a suggestion **THEN** one POST sets `agent.profiles.<role>.model` to its id

#### R9: Stale pin means "the tool doesn't offer it"
`isStalePin` and the `(not offered)` option SHALL compare the override against suggestion ids. The note's wording is unchanged; its doc comment SHALL say the list is what the tool offers (discovered by fab), not the kit's fills.

- **GIVEN** a claude role pinned to `claude-opus-5-5` and a discovered list without it
- **WHEN** the row renders
- **THEN** the stale note shows; with `glm-latest[1m]` pinned and discovered, no note shows

### Frontend: Effort Options

#### R10: Per-model effort list
A row's effort options SHALL be, in order of preference: (1) the `efforts` of the suggestion whose id is the row's effective model (`role.model.effective`), or of the `default: true` suggestion when the effective model is empty, when non-empty; (2) else the tool's set — the union of `efforts` across the tool's suggestions, first-seen order — when non-empty; (3) else `doc.effortSuggestions`. H2's disabled state (`effortCapable[tool] === false`) SHALL be unchanged, and an effort override outside the list SHALL still be shown (RoleSelect's existing behaviour).

- **GIVEN** a codex row whose effective model reports `["low","medium","high","xhigh","max","ultra"]`
- **WHEN** the effort select renders
- **THEN** it offers `ultra`
- **AND GIVEN** no suggestion reports efforts **THEN** it offers `low…max`

#### R11: Tool-change patch uses ids and the new tool's effort set
`toolChangePatch` SHALL keep the model override only when it is an id in the new tool's suggestions, and keep the effort override only when it is in the new tool's effort set (R10 rule 2, falling back to `effortSuggestions`) and the new tool is effort-capable. It SHALL still send one patch with the neutral `tool` leaf and touch only the tool key when the effective tool does not change.

- **GIVEN** a role on claude with effort `xhigh` and model `opus`, switching to codex whose set is `["low","medium","high"]` and which does not offer `opus`
- **WHEN** the user picks codex
- **THEN** the patch is `{tool: "codex", model: null, effort: null}`

### Frontend: Panel Warnings

#### R12: GET warnings render
`SettingsAgentsPanel` SHALL render the GET document's `warnings` in the `fab-warnings` block on load; a POST SHALL replace them with that response's `warnings` (today's behaviour).

- **GIVEN** `GET /api/fab-config` returns `warnings: ["warning: codex: …"]`
- **WHEN** the Agents tab mounts
- **THEN** the warning line is visible

### e2e

#### R13: Stub and spec cover the new document
`tests/e2e/_fab-config-stub.ts` SHALL serve `modelSuggestions` as `FabModelSuggestion[]` (with at least one label, one `efforts` list, one `default`) and a tool with more than 30 suggestions; `tests/e2e/settings-agents.spec.ts` SHALL keep the reload-then-open regression and add a case proving the searchable list opens unfiltered with a saved override and commits a filtered pick, with the constitution's JSDoc intent comment.

- **GIVEN** the stubbed tab
- **WHEN** the e2e spec runs
- **THEN** it passes

### Non-Goals

- Offering the F2 `tool-default` token in the UI — H3's step
- hexokit reading any tool's config file — fab owns discovery
- Caching discovery between requests — plan D1 v1 says no cache
- Clearing an effort override when the *model* (not the tool) changes

### Design Decisions

#### Fail Silently to the Fill Scan
**Decision**: Any `fab agent models --json` failure (non-zero exit, timeout, undecodable output) falls back to the fill scan with no hexokit warning.
**Why**: An older fab without the verb is the expected cause and would otherwise warn on every visit; fab's own adapters already warn per tool when discovery partially fails.
**Rejected**: Detecting "unknown verb" from stderr text — fragile across fab versions (an older fab reads `models` as a role name).
*Introduced by*: 261120-hnzf-model-suggestions-from-fab-agent-models

#### Exclude Reserved Rows
**Decision**: Rows with `source: "reserved"` never become suggestions.
**Why**: The reserved `tool-default` token is a sentinel, not a model; offering it with its own label and commit semantics is a separate step.
**Rejected**: Listing it as a plain suggestion — users would pin the literal token without the "tool default" display rule.
*Introduced by*: 261120-hnzf-model-suggestions-from-fab-agent-models

## Tasks

### Phase 1: Backend

- [x] T001 In `app/backend/internal/fabsysconfig/fabsysconfig.go`, add the `ModelSuggestion` type, change `Document.ModelSuggestions` to `map[string][]ModelSuggestion`, convert `modelSuggestions(rows, tool)` (the fill scan) to return `[]ModelSuggestion`, and update the package doc's "Reads decode" list with `fab agent models --json` and its fallback <!-- R1 R3 -->
- [x] T002 In `fabsysconfig.go`, add the discovery read: a `modelRow` struct (`cli`, `provider`, `id`, `label`, `efforts`, `default`, `source`), a function running `agent models --json` via `c.run` returning parsed rows + warning lines (error on non-zero exit or decode failure), and a pure `discoveredSuggestions(rows, tools)` applying R2 (cli→provider fallback, reserved excluded, empty id skipped, dedup by id, fab order, label omitted when equal to id, every tool keyed); start it in a goroutine at the top of `Read` (after the installed check) and join before building suggestions; on error use the fill scan silently; append discovery warnings to `doc.Warnings` <!-- R1 R2 R3 R4 R5 -->
- [x] T003 In `fabsysconfig.go` `Apply`, return the write warnings followed by the re-read document's discovery warnings <!-- R5 -->
- [x] T004 In `app/backend/internal/fabsysconfig/fabsysconfig_test.go`, make `fakeFab` safe for concurrent use (mutex around `calls`), script `agent models --json` (a `models`/`modelsErr` stdout+stderr field; default: exit 1 so existing tests exercise the fallback unchanged), update existing assertions on `ModelSuggestions` to the new shape, and add tests: recorded fixture → label/efforts/default and fab order; reserved excluded; `provider`-keyed rows; duplicate ids; tools outside `doc.Tools` ignored and every tool keyed; non-zero exit → fill fallback, no warning; malformed JSON → fallback; stderr warnings → `Warnings`; `Apply` keeps write + discovery warnings; argv is exactly `agent models --json`. Update `app/backend/api/fab_config_test.go` if it asserts the suggestion shape. Run `cd app/backend && go test ./internal/fabsysconfig/ ./api/` <!-- R1 R2 R3 R4 R5 -->

### Phase 2: Frontend

- [x] T005 In `app/frontend/src/api/client.ts`, add `FabModelSuggestion`, retype `modelSuggestions`, and update the `warnings` doc comment <!-- R6 -->
- [x] T006 In `app/frontend/src/components/settings-agents-panel.tsx`, retype `modelOptions`/`isStalePin`/`RoleModelCell`/`RoleRow`/`RoleTable`/`toolChangePatch` to `FabModelSuggestion[]`, carry label/id/default on suggestion options, render native option text per R7 (named constants for the ` · ` separator and `tool default` marker), and update the stale-note doc comment <!-- R7 R9 -->
- [x] T007 In `settings-agents-panel.tsx`, add the searchable model list (a small local component, modeled on `theme-picker-list.tsx`'s collapsible trigger → filter + `role="listbox"` pattern) used when suggestions exceed `SEARCHABLE_MODEL_THRESHOLD = 30`, per R8 (unfiltered on open, label-or-id filter, inherit/Custom… always shown, arrow/Enter/click/Escape, secondary id + default marker, busy-disabled trigger, Custom… → `CustomModelInput`) <!-- R8 -->
- [x] T008 In `settings-agents-panel.tsx`, add pure helpers `toolEfforts(suggestions)` and `modelEfforts(role, suggestions, fallback)` per R10 and use them for the effort select's options; update `toolChangePatch` per R11 <!-- R10 R11 -->
- [x] T009 In `settings-agents-panel.tsx` `SettingsAgentsPanel`, set `warnings` from the GET document on load <!-- R12 -->
- [x] T010 In `app/frontend/src/components/settings-agents-panel.test.tsx`, migrate fixtures to `FabModelSuggestion[]` and add unit tests: label · id text, id-only when no label, default marker, ≤30 stays native select, >30 searchable (opens unfiltered with saved override, filters by label and by id, inherit/Custom… always present, Enter commits id, click commits, Escape closes without POST and dialog stays), effort options from model / tool set / global fallback incl. `ultra`, disabled state kept, tool-change keep/clear by id and new tool's effort set, GET warnings rendered. Run `cd app/frontend && npx vitest run src/components/settings-agents-panel.test.tsx && npx tsc --noEmit` <!-- R7 R8 R9 R10 R11 R12 -->

### Phase 3: e2e

- [x] T011 Update `app/frontend/tests/e2e/_fab-config-stub.ts` to serve object suggestions (labels, efforts, a default) and a >30-suggestion kimi list; update `app/frontend/tests/e2e/settings-agents.spec.ts` (keep the reload regression; add the searchable-list case with a JSDoc Proves/Steps block). Run `just test-e2e "settings-agents"` (or the repo's equivalent e2e recipe) <!-- R13 -->

## Execution Order

- T001 → T002 → T003 → T004 (same file chain)
- T005 blocks T006–T010; T006 blocks T007 and T008
- T011 after T005–T009

## Acceptance

### Functional Completeness

- [x] A-001 R1: `Read` runs `agent models --json` once and fills `ModelSuggestions` as `[]ModelSuggestion` with label/efforts/default, every tool keyed
- [x] A-002 R2: `provider`-keyed rows are read, reserved rows excluded, duplicate ids dropped, fab order kept
- [x] A-003 R3: a failing or malformed discovery falls back to the fill scan with no warning
- [x] A-004 R4: discovery is started concurrently with the config reads and not run when fab is absent
- [x] A-005 R5: discovery warnings appear in `Warnings` on Read; Apply returns write warnings then discovery warnings
- [x] A-006 R6: `FabModelSuggestion` type exists and the SPA type-checks
- [x] A-007 R7: native options show `label · id`, id alone when unlabeled, and ` · tool default` on the default
- [x] A-008 R8: above 30 suggestions the cell is a searchable list meeting R8's open/filter/keyboard/Escape rules
- [x] A-009 R9: stale-pin detection compares ids of the discovered list
- [x] A-010 R10: effort options follow model → tool set → global, with H2's disabled state intact
- [x] A-011 R11: tool-change patch keeps model by id and effort by the new tool's set
- [x] A-012 R12: GET warnings render on load
- [x] A-013 R13: e2e stub and spec cover object suggestions and the searchable list

### Scenario Coverage

- [x] A-014 R8: a unit test opens the searchable list with a saved override and sees every suggestion (the H1 regression, searchable variant)
- [x] A-015 R3: a Go test covers the non-zero-exit fallback and the malformed-JSON fallback

### Edge Cases & Error Handling

- [x] A-016 R2: a tool absent from discovery output still maps to `[]`; rows for unknown tools are ignored
- [x] A-017 R10: an effective model empty (tool default) uses the `default: true` suggestion's efforts

### Code Quality

- [x] A-018 Pattern consistency: new code follows the naming and structural patterns of `fabsysconfig.go` and `settings-agents-panel.tsx`
- [x] A-019 No unnecessary duplication: `warningLines`, `useTextSettingDraft`, `CustomModelInput`, `modelOptions` are reused rather than re-implemented
- [x] A-020: Subprocess calls stay argv-slice `exec.CommandContext` with the `FabTimeout` bound (Runner seam)
- [x] A-021: Magic values are named constants (`SEARCHABLE_MODEL_THRESHOLD`, the separator, the marker, the reserved source)
- [x] A-022: Frontend uses type narrowing rather than `as` casts for the option kinds
- [x] A-023: No comment narration or change IDs in code comments
- [x] A-024: Go tests, `tsc --noEmit`, unit tests and the affected e2e spec pass

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

None — this change adds new functionality without making existing code redundant. The fill scan (`modelSuggestions` in `app/backend/internal/fabsysconfig/fabsysconfig.go`) is still the live fallback for a fab without `agent models`; it becomes deletable only once hexokit stops supporting fab older than the verb's release.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Searchable list is a small local component in `settings-agents-panel.tsx`, patterned on `theme-picker-list.tsx` | `ThemePickerList` is theme-bound (preview lifecycle, THEMES); no generic combobox exists | S:60 R:85 A:70 D:65 |
| 2 | Confident | The fake runner's default for `agent models --json` is exit 1, so existing tests exercise the fallback without edits beyond the shape change | Keeps the old fill-scan expectations meaningful and isolates discovery tests | S:65 R:90 A:80 D:75 |
| 3 | Confident | Inherit and `Custom…` stay visible under any filter | They are the commit paths H1 guarantees; hiding them would strand a user who filtered to nothing | S:60 R:90 A:75 D:70 |
| 4 | Certain | Model change alone does not clear an incompatible effort override | Not in the brief; RoleSelect already shows a stale override and the reset link clears it | S:70 R:90 A:80 D:80 |

4 assumptions (1 certain, 3 confident, 0 tentative).
