# Plan: Offer the Tool-Default Model Value in the Agents Tab

**Change**: 261120-d4ut-offer-tool-default-model-option
**Intake**: `intake.md`

## Requirements

### Backend: fab-kit system config document

#### R1: Reserved rows feed `toolDefaults`
`fabsysconfig.Read` SHALL expose each tool's reserved `fab agent models --json` row (`source: "reserved"`) as `Document.ToolDefaults map[string]ModelSuggestion` (JSON `toolDefaults`, omitted when empty), built from the rows the existing single discovery call already decoded. Only tools in `doc.Tools` get an entry; the first reserved row with a non-empty id per tool wins; the row → `ModelSuggestion` conversion SHALL be the one suggestions use (efforts only when non-empty, label omitted when equal to id). Reserved rows SHALL remain excluded from `ModelSuggestions`. When discovery failed (fill-scan fallback) `ToolDefaults` SHALL be nil.

- **GIVEN** `fab agent models --json` returns `{"cli":"codex","id":"tool-default","label":"tool default (gpt-6.1-sol)","efforts":["low","ultra"],"source":"reserved"}`
- **WHEN** `Read` runs
- **THEN** `doc.ToolDefaults["codex"]` is `{ID:"tool-default", Label:"tool default (gpt-6.1-sol)", Efforts:["low","ultra"]}`
- **AND** `doc.ModelSuggestions["codex"]` contains no `tool-default` entry

- **GIVEN** the verb fails (older fab)
- **WHEN** `Read` runs
- **THEN** `doc.ToolDefaults` is nil and the JSON omits `toolDefaults`

### Frontend: Agents tab model cell

#### R2: Tool-default is the second model option
When the row's effective tool has a `toolDefaults` entry, the model list SHALL offer `↳ <label>` (label from fab, falling back to the id) as the second option, right after `↳ inherit (…)`, and picking it SHALL commit the entry's `id` as the role's model override. With no entry, the option SHALL be absent and the list SHALL be exactly H4's.

- **GIVEN** codex's `toolDefaults` entry `{id:"tool-default", label:"tool default (gpt-6.1-sol)"}`
- **WHEN** the user opens a codex row's model list
- **THEN** option 2 reads `↳ tool default (gpt-6.1-sol)`
- **AND** picking it POSTs `{"agent.profiles.<role>.model": "tool-default"}`

#### R3: A row holding the token displays as tool default
When a row's model override equals its tool's tool-default id, the control SHALL show the tool-default option (native select value or searchable trigger text), SHALL NOT emit a `(not offered)` option, and SHALL NOT render the stale-pin note. Wherever the cell's inherited/effective model is rendered as text (`↳ inherit (…)`, the custom-input placeholder, the stale note's inherit action) and equals the token, it SHALL read `tool default`. When the tool has no entry, the token is an ordinary value (H4 behaviour).

- **GIVEN** `agent.profiles.review.model: tool-default` on a codex row with a `toolDefaults` entry
- **WHEN** the tab renders
- **THEN** the cell reads `↳ tool default (gpt-6.1-sol)` and no stale note is shown

- **GIVEN** a row with no override whose inherited fill is `tool-default`
- **WHEN** the tab renders
- **THEN** the inherit option reads `↳ inherit (tool default)`

#### R4: Searchable list keeps the option reachable
In the >30-suggestion searchable list, the tool-default option SHALL stay visible under any filter (like inherit and `Custom…`) and SHALL NOT be the Enter-after-typing landing target.

- **GIVEN** a kimi row (>30 suggestions) with a `toolDefaults` entry
- **WHEN** the user types a filter matching no model
- **THEN** inherit, tool default and `Custom…` are still listed

#### R5: Effort options for the tool default
When the row's effective model is empty or equals the tool-default id, the effort options SHALL be the `toolDefaults` entry's efforts when non-empty, else H4's chain (the `default: true` suggestion's efforts → the tool's set → the global list).

- **GIVEN** a codex row set to tool default with entry efforts `[low, …, max, ultra]`
- **WHEN** the effort select renders
- **THEN** it offers `ultra`

#### R6: Tool change keeps the token when the new tool offers it
`toolChangePatch` SHALL keep a model override equal to the next tool's tool-default id; when the next tool has no entry, a token override SHALL be cleared like any unoffered model. The effort keep rule SHALL treat the next tool's tool-default efforts as part of its effort set.

- **GIVEN** a row on codex with model override `tool-default` and claude has a `toolDefaults` entry
- **WHEN** the user switches the row's tool to claude
- **THEN** the patch carries only the tool key for the model (no `model: null`)

### Non-Goals

- Hard-coding the `tool-default` string in hexokit — the token always comes from fab's reserved row.
- Changing the H4 default marker (` · tool default`) on the concrete default suggestion.
- Any write-path or validation change — the model leaf is already free text.

### Design Decisions

#### Reserved rows travel in their own `toolDefaults` map
**Decision**: Carry each tool's reserved `fab agent models` row in `Document.ToolDefaults`, separate from `ModelSuggestions`.
**Why**: Suggestions stay "concrete models the tool offers", so the searchable threshold, the stale-pin check, the tool-change keep rule and the default marker keep their meaning; the token and label still come from fab's single discovery call.
**Rejected**: Folding the row into `modelSuggestions` (it would count toward the threshold and be treated as a pin); hard-coding `tool-default` in the SPA (drifts from fab, and would be offered to an older fab that passes it verbatim as `--model tool-default`).
*Introduced by*: 261120-d4ut-offer-tool-default-model-option

## Tasks

### Phase 2: Core Implementation

- [x] T001 `app/backend/internal/fabsysconfig/fabsysconfig.go`: add `Document.ToolDefaults`, factor the row → `ModelSuggestion` conversion, build tool defaults from discovered rows in `Read` (nil on fallback); extend `fabsysconfig_test.go` (fixture reserved rows → entries, label-only default, first wins, tools outside `doc.Tools` ignored, still absent from suggestions, nil on failing verb / malformed JSON, JSON omission) <!-- R1 -->
- [x] T002 `app/frontend/src/api/client.ts`: add `toolDefaults?: Record<string, FabModelSuggestion>` to the installed document type <!-- R1 -->
- [x] T003 `app/frontend/src/components/settings-agents-panel.tsx`: thread `toolDefaults` to rows; `toolDefault` option kind second in `modelOptions`; token-aware `inheritedValue`, `isStalePin`, stale-option skip; searchable filter/landing; `modelEfforts` and `toolChangePatch` token rules <!-- R2 R3 R4 R5 R6 -->

### Phase 3: Integration & Edge Cases

- [x] T004 `app/frontend/src/components/settings-agents-panel.test.tsx`: unit cases for option order/label/commit, absence without entry, token row display (no stale note, no `(not offered)`), inherited token text, searchable visibility and trigger text, effort options from the entry, tool-change keep/clear <!-- R2 R3 R4 R5 R6 -->
- [x] T005 `app/frontend/tests/e2e/_fab-config-stub.ts` + `app/frontend/tests/e2e/settings-agents.spec.ts`: stub serves `toolDefaults`; e2e case picks `↳ tool default (…)`, sees the `tool-default` write, reloads and sees the cell still showing tool default with no stale note (intent comment per constitution) <!-- R2 R3 -->

## Acceptance

### Functional Completeness

- [x] A-001 R1: `Read` populates `ToolDefaults` from reserved rows (first per tool, `doc.Tools` only) and leaves it nil on fallback; reserved rows stay out of `ModelSuggestions`
- [x] A-002 R2: The tool-default option is second, labelled `↳ <fab label>`, commits the fab-reported id, and is absent without an entry
- [x] A-003 R3: A token override shows the tool-default option, no `(not offered)` option and no stale note; inherited token text reads `tool default`
- [x] A-004 R4: The searchable list keeps the option visible under any filter and never lands Enter on it after typing
- [x] A-005 R5: Effort options for an empty/token model come from the entry's efforts first
- [x] A-006 R6: Tool change keeps a token override when the next tool has an entry and clears it otherwise

### Scenario Coverage

- [x] A-007 R1: Go tests cover reserved-row extraction, fallback nil and JSON omission
- [x] A-008 R2: Unit tests cover option order, label and the POSTed token; e2e covers pick → write → reload display

### Edge Cases & Error Handling

- [x] A-009 R3: With no `toolDefaults` entry, a `tool-default` override renders exactly as H4 does (plain stale value)

### Code Quality

- [x] A-010 Pattern consistency: New code follows the surrounding naming, discriminated-union `ModelOption` shape and comment density
- [x] A-011 No unnecessary duplication: Row → `ModelSuggestion` conversion is shared, not copied
- [x] A-012 Type narrowing: frontend uses discriminated-union narrowing on option `kind`, no `as` casts
- [x] A-013 No magic strings: hexokit never hard-codes the `tool-default` token outside test fixtures/stubs
- [x] A-014 Tests: new behaviour covered by Go, unit and e2e tests; e2e test carries a Proves/Steps intent comment
- [x] A-015 Comments state constraints only — no narration or change IDs

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Deletion Candidates

- None — this change adds new functionality without making existing code redundant (the row → `ModelSuggestion` conversion was factored into `modelRow.suggestion()`, not duplicated)

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Inherited/effective token text maps to the existing `INHERIT_FALLBACK` ("tool default") using the row's own tool-default id | Same meaning as an empty effective value; brief asks for "tool default", not the raw string | S:65 R:90 A:80 D:70 |
| 2 | Confident | Tool-change effort keep set is the union of the next tool's suggestion efforts and its tool-default efforts (global list when both empty) | Extends H4's "keep only if X offers it" to the efforts the token would resolve to | S:50 R:90 A:70 D:65 |

2 assumptions (0 certain, 2 confident, 0 tentative).
