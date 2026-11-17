# Plan: Inherit Label Honours profiles.default; Effort Disabled for Tools Without {effort}

**Change**: 261117-26en-inherit-label-effort-capability
**Intake**: `intake.md`

## Requirements

### Backend: Role inheritance (`internal/fabsysconfig`)

#### R1: Inherited fill falls back to the tool's default profile
`buildRole` SHALL compute a model/effort leaf's fill key as `providers.<p>.profiles.<role>.<leaf>` when that row exists, else `providers.<p>.profiles.default.<leaf>` when that row exists, else none. The fill key SHALL feed both `Cell.Inherited` and `cellFor`'s no-row path (`Effective`/`Source`/`Origin` when `fab config show` emitted no `agent.profiles.<role>.<leaf>` row). With neither row present, `Inherited` and the no-row `Effective` SHALL be `""`.

- **GIVEN** the effective tool for `doing` is agy, fab ships only `providers.agy.profiles.default.model: gemini-3.1-pro-high`, and `agent.profiles.doing.model` is overridden at the system tier
- **WHEN** the document is read
- **THEN** `doing.model.inherited` is `gemini-3.1-pro-high`
- **AND** with no `agent.profiles.doing.model` row at all, `doing.model.effective` is `gemini-3.1-pro-high` with `source` `providers.agy.profiles.default.model`

- **GIVEN** agy ships `providers.agy.profiles.fast.model: gemini-3.6-flash-low`
- **WHEN** the `fast` row on agy is read
- **THEN** its role fill wins: `inherited` is `gemini-3.6-flash-low`

- **GIVEN** a role resolves to kimi, which ships no profile fills
- **WHEN** the document is read
- **THEN** the role's model `inherited` and `effective` are `""` (rendered "tool default")

#### R2: Effort capability per tool
`Document` SHALL carry `EffortCapable map[string]bool` (JSON `effortCapable`) with one entry per name in `Providers`: `true` iff the `fab config show` value of `providers.<p>.interactive_command` or `providers.<p>.headless_command` contains the literal `{effort}`; `false` otherwise (including a tool with neither command). It SHALL be derived from the rows already loaded by `Read` — no additional fab exec.

- **GIVEN** kit-default commands (claude and codex carry `{effort}`, agy and kimi do not)
- **WHEN** the document is read
- **THEN** `effortCapable` is `{agy: false, claude: true, codex: true, kimi: false}`

- **GIVEN** a provider with profile rows but no command rows
- **WHEN** the document is read
- **THEN** its `effortCapable` entry is `false`

### Frontend: Agents tab (`settings-agents-panel.tsx`)

#### R3: Effort select disabled for tools without `{effort}`
The role row's effort select SHALL be disabled, with `title="this tool takes no effort setting"`, when `effortCapable[role.provider.effective]` is `false`. A missing entry SHALL count as capable. The Reset link SHALL remain available whenever the row has an override (including a stale effort override) and SHALL still post `{provider: null, model: null, effort: null}`.

- **GIVEN** the `review` row resolves to kimi (`effortCapable.kimi === false`) with an effort override `high`
- **WHEN** the Agents tab renders
- **THEN** the review effort select is disabled with the title, still showing `high`
- **AND** clicking Reset posts the three nulls

- **GIVEN** a document without an `effortCapable` entry for the row's tool
- **WHEN** the tab renders
- **THEN** the effort select is enabled

#### R4: Tool change clears an effort the new tool can't take
`toolChangePatch` SHALL clear the effort override (`effort: null`) when the new effective tool is not effort-capable, even when the value is in `effortSuggestions`; otherwise H1's rules hold unchanged.

- **GIVEN** `review` with `{provider: codex, effort: high}` overrides
- **WHEN** the tool is changed to agy
- **THEN** one POST carries `provider: "agy"`, `model: null`, `effort: null`
- **AND** changing it to claude instead leaves the effort key out of the patch

#### R5: Inherit fallback label reads "tool default"
The label shown when a leaf inherits an empty value SHALL be `tool default` (was `provider default`) everywhere `INHERIT_FALLBACK` is used.

- **GIVEN** a kimi role with no fills
- **WHEN** the model list opens
- **THEN** its first option reads `↳ inherit (tool default)`

#### R6: Client type carries the capability map
`FabConfigDocument`'s installed branch SHALL declare `effortCapable: Record<string, boolean>`.

- **GIVEN** the GET payload
- **WHEN** the panel reads `doc.effortCapable`
- **THEN** it type-checks without casts

### Non-Goals

- Per-model effort lists — H4.
- API write validation of effort for non-capable tools — the UI stops offering it; fab accepts the value.
- Renaming `provider` keys/JSON — H5/N1.

### Design Decisions

#### Read the default-profile rung from `show` rows
**Decision**: `buildRole` extends its fill lookup by the one rung fab has (`profiles.<role>` then `profiles.default`) over the `fab config show --origin --json` rows it already holds; effort capability is derived from the same rows' command leaves.
**Why**: Zero extra execs per GET, and any tool the user adds (with or without `{effort}`) is classified without a hard-coded list.
**Rejected**: per-role `fab agent <role> -o yaml` (six extra execs per GET); a hard-coded capable-tool list (misses user-defined tools and command overrides).
*Introduced by*: 261117-26en-inherit-label-effort-capability

## Tasks

### Phase 2: Core Implementation

- [x] T001 `app/backend/internal/fabsysconfig/fabsysconfig.go`: add a `fillKey` helper (role fill, then `default` fill, else `""`) and use it in `buildRole` for `Inherited` and `cellFor`'s fallback; update the `Cell.Inherited` comment. Tests in `fabsysconfig_test.go` for agy `doing` (override → inherited; no row → effective/source), agy `fast`, kimi empty <!-- R1 -->
- [x] T002 `app/backend/internal/fabsysconfig/fabsysconfig.go`: add `Document.EffortCapable`, constants for the command leaves and `{effort}` token, populate in `Read` from the loaded rows. Tests in `fabsysconfig_test.go` for the kit-default map and a no-command provider <!-- R2 -->
- [x] T003 `app/frontend/src/api/client.ts` + `app/frontend/src/components/settings-agents-panel.tsx`: add `effortCapable` to the type; `RoleSelect` optional `title`; `RoleRow` disables effort select for non-capable effective tool; `toolChangePatch` clears effort for a non-capable new tool; `INHERIT_FALLBACK = "tool default"`. Tests in `settings-agents-panel.test.tsx` for disabled/enabled, missing entry, Reset on stale effort, patch shapes; update `provider default` expectations <!-- R3 R4 R5 R6 -->

### Phase 3: Integration & Edge Cases

- [x] T004 `app/frontend/tests/e2e/_fab-config-stub.ts` + `app/frontend/tests/e2e/settings-agents.spec.ts`: stub gains `effortCapable`; update `provider default` expectations; add an e2e case asserting a non-capable role's effort select is disabled with the title (JSDoc Proves/Steps) <!-- R3 R5 -->
- [x] T005 Run the verification gates: `cd app/backend && go test ./internal/fabsysconfig/ ./api/`, `cd app/frontend && npx tsc --noEmit`, the panel's vitest file, and `just test-e2e "settings-agents"` <!-- R1 R2 R3 R4 R5 R6 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `buildRole` falls back to `providers.<p>.profiles.default.<leaf>` for both `Inherited` and the no-row `Effective`/`Source`
- [ ] A-002 R2: `Document.EffortCapable` exists with one entry per provider, derived from command rows containing `{effort}`
- [ ] A-003 R3: The effort select is disabled with title "this tool takes no effort setting" for non-capable effective tools; a missing entry counts as capable
- [ ] A-004 R4: `toolChangePatch` clears effort when the new tool is non-capable
- [ ] A-005 R5: `INHERIT_FALLBACK` is `"tool default"`
- [ ] A-006 R6: `FabConfigDocument` declares `effortCapable: Record<string, boolean>`

### Behavioral Correctness

- [ ] A-007 R1: agy `doing` with a model override reports `inherited: gemini-3.1-pro-high` (previously `""`)
- [ ] A-008 R3: Reset remains available for a stale effort override on a disabled row and posts the three nulls

### Scenario Coverage

- [ ] A-009 R1: Go tests cover agy `doing` (override and no-row), agy `fast`, and kimi empty
- [ ] A-010 R2: Go tests cover the kit-default map and a provider with no command rows
- [ ] A-011 R3: Unit tests cover disabled, enabled, missing-entry and Reset-on-stale cases; an e2e case covers the disabled select
- [ ] A-012 R4: Unit tests cover the non-capable (cleared) and capable (kept) patch shapes

### Edge Cases & Error Handling

- [ ] A-013 R1: For the `default` role the two candidate keys coincide without error
- [ ] A-014 R2: A provider with neither command reads `false`, not absent

### Code Quality

- [ ] A-015 Pattern consistency: New code follows naming and structural patterns of surrounding code (constants for key fragments, kind-tagged helpers)
- [ ] A-016 No unnecessary duplication: Existing utilities reused where applicable (`cellFor`, `valueString`, `contains`, `toolChangePatch`)
- [ ] A-017 Readability: functions stay short; no god functions added to `Read`/`buildRole`
- [ ] A-018 No magic strings: `{effort}` and the command leaf names are named constants
- [ ] A-019 No comment narration: comments state constraints, not history or change IDs
- [ ] A-020 Tests: every new/changed Playwright `test()` carries a Proves/Steps JSDoc block
- [ ] A-021 Type narrowing over `as` casts in new frontend code

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Light lane (5 tasks) | Task count ≤ 5 per `_pipeline.md` fork rule | S:95 R:90 A:95 D:95 |
| 2 | Confident | Effort capability judged on `role.provider.effective`; for a tool change, on the new tool (or the depth knob's tool for inherit) | Same basis H1 uses for model suggestions | S:65 R:90 A:85 D:80 |
| 3 | Confident | No new Phase 1 setup or Phase 4 polish tasks; memory updates happen at hydrate | Scope is small; hydrate owns docs/memory | S:70 R:90 A:85 D:85 |
| 4 | Confident | `effortCapable` is declared optional (`effortCapable?: Record<string, boolean>`) on the client type | Go's `omitempty` drops an empty map, so a document with no providers omits the key; optional typing forces the `?.` read that keeps R3's missing-entry-is-capable rule safe | S:70 R:90 A:85 D:80 |

4 assumptions (1 certain, 3 confident, 0 tentative).
