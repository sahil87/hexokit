# Plan: Riff-preset rename and the agent-preset dropdown in Settings > Agent

**Change**: 261124-m39n-riff-preset-rename-agent-preset-dropdown
**Intake**: `intake.md`

## Requirements

### rk riff: Riff-preset rename (behavior unchanged)

#### R1: CLI flags are spelled `--riff-preset` / `--list-riff-presets`
`rk riff` SHALL accept `--riff-preset <name>` and `--list-riff-presets` in place of `--preset` / `--list-presets`, with identical resolution and listing behavior. The positional form (`rk riff discuss`) SHALL be unchanged. Help text (`Use:`, Long, flag usage, examples, exit-code text) SHALL say "riff preset". Error messages SHALL read `run-kit riff: unknown riff preset %q (defined: …)` and `run-kit riff: positional riff preset %q and --riff-preset %q are mutually exclusive`.

- **GIVEN** the built-in riff presets
- **WHEN** a user runs `rk riff --riff-preset blank` inside a repo in tmux
- **THEN** the same window as today's `rk riff --preset blank` is spawned
- **AND** `rk riff --list-riff-presets` prints the same list `--list-presets` printed

#### R2: Old CLI spellings are deprecated aliases for one release
`--preset` and `--list-presets` SHALL remain accepted as hidden flags marked deprecated via pflag `MarkDeprecated` (`use --riff-preset` / `use --list-riff-presets`), printing pflag's deprecation line on stderr only. `--preset` SHALL bind a separate variable merged into the riff-preset value; `--preset X --riff-preset Y` with X ≠ Y SHALL be a usage error (exit 2). The positional/flag mutual-exclusion rule SHALL apply to the merged value.

- **GIVEN** a script that calls `rk riff --preset discuss`
- **WHEN** it runs
- **THEN** it spawns exactly as `--riff-preset discuss` would, stdout/`--json` output unchanged
- **AND** stderr carries a deprecation notice naming `--riff-preset`
- **GIVEN** `rk riff --preset a --riff-preset b`
- **WHEN** it runs
- **THEN** it exits 2 with no subprocess started

#### R3: Spawn API body field is `riff_preset`, with legacy `preset` dual-read
`POST /api/riff` SHALL read the riff preset from body field `riff_preset`. When only legacy `preset` is present it SHALL be used. When both are present and differ the handler SHALL return 400 (`riff_preset and preset disagree`) before deriving the repo root or running any subprocess. Equal values SHALL be accepted.

- **GIVEN** body `{"session":"s","preset":"discuss"}`
- **WHEN** POSTed
- **THEN** the spawn behaves as with `{"session":"s","riff_preset":"discuss"}`
- **GIVEN** body `{"session":"s","preset":"a","riff_preset":"b"}`
- **WHEN** POSTed
- **THEN** 400 is returned and nothing is created

#### R4: Riff preset list response key is `riff_presets`
`GET /api/riff/presets` SHALL keep its path and respond `{"riff_presets":[{"name","layout","paneCount"}],"tiers":[...]}`. No legacy `presets` key is emitted.

- **GIVEN** a session in a repo
- **WHEN** the SPA fetches `/api/riff/presets?session=…`
- **THEN** the JSON has `riff_presets` (and `tiers`) and no `presets` key

#### R5: MCP `riff` tool argument is `riff_preset` (straight rename)
The MCP policy row for `riff` SHALL name its positional-1 argument `riff_preset` with a "riff preset" description; `riffDescription` SHALL say "riff preset". The old `preset` argument SHALL NOT be aliased (the schema's `additionalProperties:false` rejects it).

- **GIVEN** an MCP `riff` call with `{"riff_preset":"discuss", …}`
- **WHEN** argv is built
- **THEN** `discuss` is positional 1 of `rk riff`
- **AND** a call with `{"preset":"discuss", …}` fails with `unknown argument "preset"`

#### R6: UI and macros say "riff preset"; legacy macro key is dual-read
The spawn dialog field SHALL be labelled `Riff preset (optional):` with `aria-label="Riff preset"`. The frontend client SHALL send `riff_preset` and read `riff_presets`. Macro targets SHALL be `{type:"riff", riff_preset}`; `parseMacros` SHALL accept legacy `{type:"riff", preset}` and re-project it to `riff_preset`; stored macros containing a legacy entry SHALL be written back once in the new shape on load. The macro command text SHALL read `rk riff --riff-preset <name>`. The shortcuts panel badge SHALL read `missing riff preset`.

- **GIVEN** `localStorage["hexokit-macros"]` holds `[{"actionId":"macro:x","kind":"macro","label":"X","target":{"type":"riff","preset":"discuss"}}]`
- **WHEN** the app loads macros
- **THEN** the macro is present with `target.riff_preset === "discuss"` and still runs
- **AND** the stored JSON is rewritten with `riff_preset` and without `preset`

#### R7: Remaining surfaces say "riff preset"
Go identifiers in `internal/riff`, `cmd/rk/riff.go`, `api/riff.go` SHALL use RiffPreset naming; the settings registry description and name-validation label (`Riff preset name`), the `rk doctor` stale-`riff:` row, the operator prompt (`rk riff --list-riff-presets`, `rk riff [--riff-preset <p>] "<task>"`), docs (`docs/site/workflows.md`, `docs/specs/mcp.md`) SHALL say "riff preset". Unrelated "preset" uses (surface-layout presets, gui presets, code-server port comments) SHALL NOT change.

- **GIVEN** the repo after this change
- **WHEN** grepping riff-related code and docs for a bare `--preset`/`--list-presets`/`"preset"` riff spelling
- **THEN** only the deprecated-alias code, its tests, and the documented deprecation note remain

#### R8: Alias removal is tracked
A backlog entry SHALL be created with `idea` recording removal of the deprecated riff spellings after one minor release, and the rk-riff memory SHALL document the deprecation window.

- **GIVEN** this change merged
- **WHEN** reading `fab/backlog.md`
- **THEN** an entry names dropping `--preset`, `--list-presets`, the `preset` body field and the legacy macro key

### fab-kit system config: agent presets

#### R9: Read model carries `agent.preset` and the preset list
`internal/fabsysconfig` SHALL add `agent.preset` (first) to `ScalarKeys`, so `GET /api/fab-config` returns `fields["agent.preset"]` (value, origin, originDetail, description, systemValue when env wins; absent when unset). `Read` SHALL run exactly one `fab agent presets --json` (argv slice, `FabTimeout`, `Dir=$HOME`, via the `Runner` seam), concurrently with model discovery, and return the decoded list as `agent_presets: [{name, description?, source, session?, workers?, profiles?}]`. Warning lines from that call's stderr SHALL be appended to `warnings`.

- **GIVEN** fab 2.31.1 with no `agent.preset` set
- **WHEN** `GET /api/fab-config`
- **THEN** `agent_presets` lists claude, codex-review, codex-workers and `fields` has no `agent.preset`
- **GIVEN** `FAB_AGENT_PRESET=codex-review` in the daemon env and system `agent.preset: claude`
- **WHEN** read
- **THEN** `fields["agent.preset"]` is `{value:"codex-review", origin:"env", systemValue:"claude"}`

#### R10: Older fab degrades gracefully
If `fab agent presets --json` exits non-zero, times out, or its stdout is not a JSON array, `agent_presets` SHALL be omitted and `Read` SHALL succeed with every other field unchanged. The minimum fab version SHALL NOT be raised.

- **GIVEN** a fab that rejects `agent presets --json`
- **WHEN** `Read` runs
- **THEN** it returns a document without `agent_presets` and no error

#### R11: Preset-supplied values are never overrides
A `fab config show` row whose `origin_detail` starts with `preset ` SHALL set `preset: "<name>"` on the corresponding `Field` or `Cell`, and `cellFor` SHALL NOT set `Cell.Override` for it (even with origin `system`).

- **GIVEN** system `agent.preset: codex-review`
- **WHEN** read
- **THEN** the review role's tool cell is `{effective:"codex", origin:"system", preset:"codex-review", override:null}`
- **GIVEN** system `agent.preset: codex-workers`
- **WHEN** read
- **THEN** `fields["agent.workers"]` has `preset:"codex-workers"`

#### R12: Writes validate `agent.preset` against fab's list before any write
`POST /api/fab-config` SHALL accept `agent.preset`. `null` → `fab config unset agent.preset --system`. A string SHALL be trimmed, pass `checkFreeText`, and be a listed preset name or the reserved `none`; the list SHALL come from a fresh `fab agent presets --json` fetched (only when the patch sets a non-null `agent.preset`) under `applyMu` before any `fab config set|unset`. Unknown → 400 `agent.preset: unknown agent preset "x" (available: …)`; list unreadable → 400 `agent.preset: agent presets are not supported by the installed fab`. No write exec happens on a 400.

- **GIVEN** fab lists claude, codex-review, codex-workers
- **WHEN** POST `{"agent.preset":"bogus"}`
- **THEN** 400 and no `fab config set` exec
- **WHEN** POST `{"agent.preset":"codex-review"}`
- **THEN** `fab config set agent.preset codex-review --system` runs and the re-read document is returned

### Settings > Agent UI

#### R13: Agent preset dropdown
When `doc.agent_presets` is present, the Agents section SHALL render an `Agent preset` row first (above Session/Worker CLI) with a native select (`data-testid="agent-preset-select"`): first option `None` (selecting posts `{"agent.preset": null}`), then one option per preset labelled `name — description`. The current value SHALL be selected (`None` when the field is absent). A current value of `none` SHALL show as `none (opts out of project presets)`; a value not in the list SHALL show as `<name> (unknown)`. The row SHALL carry the provenance chip, modified dot, reset link (system override) and env-shadow warning like other `FabRow`s. When `agent_presets` is absent, no dropdown SHALL render.

- **GIVEN** the panel with presets and no preset set
- **WHEN** the user selects `codex-review`
- **THEN** `{"agent.preset":"codex-review"}` is POSTed and the select shows `codex-review` after the re-read
- **WHEN** the user selects `None`
- **THEN** `{"agent.preset":null}` is POSTed

#### R14: Override note (no clearing offer)
When a preset is selected and N > 0 explicit values (origin system or env, no `preset` marker) exist on keys that preset sets (its `session`, `workers`, and `profiles.<role>.<cli|model|effort>`, `cli` mapping to the role's tool cell), the panel SHALL show `N explicit field(s) override parts of this preset — see Customize`. It SHALL NOT offer a clear button or confirm.

- **GIVEN** system `agent.profiles.review.cli: claude` and the user picks `codex-review`
- **WHEN** the document re-renders
- **THEN** the note reads `1 explicit field overrides parts of this preset — see Customize`

#### R15: Customize disclosure with explicit count
When `agent_presets` is present, Session CLI, Worker CLI and the per-role table SHALL sit inside a keyboard-operable disclosure (`aria-expanded`) whose summary reads `Customize · N set explicitly`, N counting explicit (system-origin or env-shadowing, non-preset) values across both knobs and all role cells. It SHALL be collapsed by default when N = 0 and expanded when N > 0. Without `agent_presets` the knobs and table SHALL render exactly as before, with no disclosure.

- **GIVEN** no explicit system overrides
- **WHEN** the panel loads
- **THEN** the disclosure reads `Customize · 0 set explicitly` and is collapsed
- **GIVEN** one explicit role override
- **THEN** it reads `Customize · 1 set explicitly` and is expanded

#### R16: Preset-supplied values read as such in the grid
A knob or role cell with `preset` set SHALL show its effective value with preset provenance (chip text `preset`, title `preset <name>`), SHALL be treated as inherited (not an override) by its select, and SHALL NOT show a reset link; `hasSystemOverride` and the role row's override check SHALL ignore preset-supplied values.

- **GIVEN** system `agent.preset: codex-workers`
- **WHEN** the Customize grid is open
- **THEN** Worker CLI shows `codex` with a `preset` chip and no reset link

#### R17: Palette action `Settings: Agent preset…`
A command-palette action `Settings: Agent preset…` (id `settings-agent-preset`) SHALL call `openSettings("agents")` and focus `agent-preset-select` once the panel has loaded (falling back to the tab content when no dropdown renders). It SHALL fetch nothing extra and be registered next to `Settings: Open`.

- **GIVEN** the app on any route with the palette
- **WHEN** the user runs `Settings: Agent preset…`
- **THEN** the settings dialog opens on the Agents tab with the preset dropdown focused

### Non-Goals

- H2 scope — tmux `@rk_ses_agent_preset`/`@rk_srv_agent_preset`, spawn-path `FAB_AGENT_PRESET`, spawn-dialog agent-preset picker, `--agent-preset`, snapshots
- Renaming other spawn body fields (`worktreeName`, `tier`) or the `riff_presets` settings key
- An MCP alias for the old `preset` argument
- A clear-overrides action when choosing a preset
- Raising the minimum fab version

### Design Decisions

#### Preset provenance is read from fab's origin detail
**Decision**: A row whose `origin_detail` starts with `preset ` is marked `preset: <name>` and never treated as an override.
**Why**: fab 2.31.1 reports preset-supplied leaves at the choosing layer's origin (e.g. `system`); without the marker a machine-wide preset renders as explicit overrides whose reset unsets nothing.
**Rejected**: Re-deriving preset coverage in HexoKit from the preset list — duplicates fab's cascade (Constitution III).
*Introduced by*: 261124-m39n-riff-preset-rename-agent-preset-dropdown

#### Deprecated riff spellings live one release; MCP renames outright
**Decision**: Hidden `MarkDeprecated` flags, API dual-read, macro dual-read with write-back; MCP argument renamed without alias; removal tracked in the backlog.
**Why**: Nothing a user saved breaks for a release; MCP clients re-list tools each session and the strict schema fails loudly.
**Rejected**: Silent indefinite aliases (two spellings forever); an MCP policy-table alias mechanism (new machinery for a transient need).
*Introduced by*: 261124-m39n-riff-preset-rename-agent-preset-dropdown

#### Palette opens the Agents tab rather than listing presets
**Decision**: One `Settings: Agent preset…` entry that opens the tab and focuses the dropdown.
**Why**: Reading the preset list via `GET /api/fab-config` runs model discovery; opening the tab costs nothing and satisfies Constitution V.
**Rejected**: One palette entry per preset — needs a fetch on palette open or a new lighter route.
*Introduced by*: 261124-m39n-riff-preset-rename-agent-preset-dropdown

## Tasks

### Phase 1: Riff-preset rename — backend

- [x] T001 Rename riff-preset Go identifiers and messages in `app/backend/internal/riff/spec.go` and `app/backend/internal/riff/riff.go` (`Preset`→`RiffPreset`, `ResolveActivePreset`→`ResolveActiveRiffPreset`, `Options.Preset`→`Options.RiffPreset`, helpers, error text "unknown riff preset", "positional riff preset … --riff-preset"); update `internal/riff/riff_test.go` names/assertions <!-- R1 -->
- [x] T002 In `app/backend/cmd/rk/riff.go` add `--riff-preset` / `--list-riff-presets`, keep `--preset` / `--list-presets` as hidden `MarkDeprecated` flags on separate vars merged with conflict → usage error (exit 2); reset all vars in the reset helper; update Use/Long/examples/usage/exit-code text and rename `printPresets`→`printRiffPresets`; update `cmd/rk/riff_test.go` and add tests: `--preset` ≡ `--riff-preset` with stderr deprecation, `--list-presets` ≡ `--list-riff-presets`, conflicting pair exits 2 <!-- R1 R2 -->
- [x] T003 In `app/backend/api/riff.go` read body `riff_preset` with legacy `preset` dual-read (400 `riff_preset and preset disagree` before repo derivation when both present and differ); respond `riff_presets` from `GET /api/riff/presets`; update doc comments and `api/riff_test.go` (rename assertions + legacy-body test + disagreement 400 with nothing created) <!-- R3 R4 -->
- [x] T004 [P] In `app/backend/internal/mcp/policy.go` rename the `riff` row's positional arg to `riff_preset` with a riff-preset description and update `riffDescription`; update `internal/mcp/exec_test.go` (and any schema test) to assert `riff_preset` maps to positional 1 and `preset` is rejected as unknown <!-- R5 -->
- [x] T005 [P] Update wording in `app/backend/internal/settings/settings.go` (registry desc `Riff preset name → …`, `validateRiffPresetName` label `Riff preset name`, comments), `app/backend/cmd/rk/doctor.go` (stale-`riff:` row text), and `app/backend/api/operator.go` operator prompt (`rk riff --list-riff-presets   # list the defined riff presets`, `rk riff [--riff-preset <p>] "<task>"`); update `settings_test.go`, `registry_test.go`, `doctor_test.go`, `api/operator_test.go` assertions that pin the old text <!-- R7 -->

### Phase 2: Riff-preset rename — frontend

- [x] T006 In `app/frontend/src/api/client.ts` make `spawnRiff` take `riffPreset?` sent as body `riff_preset`, and `getRiffPresets` read `riff_presets`; update `app/frontend/src/components/spawn-agent-dialog.tsx` (label `Riff preset (optional):`, `aria-label="Riff preset"`, state names, header comment) and `spawn-agent-dialog.test.tsx` <!-- R6 -->
- [x] T007 In `app/frontend/src/lib/macros.ts` change `MacroTarget` riff arm to `{type:"riff"; riff_preset}`, dual-read legacy `preset` in `parseMacros`, report whether a legacy entry was seen so the loader can write back; command text `rk riff --riff-preset …`; in `app/frontend/src/hooks/use-macros.ts` write back once on load when legacy entries were parsed; update `app/frontend/src/app.tsx` macro runner and `app/frontend/src/components/settings-shortcuts-panel.tsx` (`missing riff preset` badge/title, target construction); update `macros.test.ts` (legacy-key test), `use-macros.test.ts`, `settings-shortcuts-panel.test.tsx` <!-- R6 -->
- [x] T008 Update Playwright specs `app/frontend/tests/e2e/spawn-agent.spec.ts` (stub `{riff_presets, tiers}`, `Riff preset` selectors) and `app/frontend/tests/e2e/macro-riff-bindings.spec.ts` (new key/body; legacy localStorage macro still runs), keeping JSDoc Proves/Steps blocks current <!-- R6 -->

### Phase 3: Agent preset — backend

- [x] T009 In `app/backend/internal/fabsysconfig/fabsysconfig.go` add `KeyAgentPreset` first in `ScalarKeys`, the `AgentPreset` type, `Document.AgentPresets` (`json:"agent_presets,omitempty"`), and a `presets(ctx)` helper running `fab agent presets --json` (Runner, timeout, Dir=$HOME) that returns nil on non-zero/timeout/non-array plus warning lines; run it concurrently with discovery in `Read` <!-- R9 R10 -->
- [x] T010 In `fabsysconfig.go` add `Preset` (`json:"preset,omitempty"`) to `Field` and `Cell`, parse it from `origin_detail` with a named `"preset "` prefix constant, and stop `cellFor` from setting `Override` on preset-supplied rows <!-- R11 -->
- [x] T011 In `fabsysconfig.go` extend `validate`/`validateValue`/`write` for `agent.preset`: null → unset; string trimmed + `checkFreeText` + membership in a fresh preset list or `none`; fetch list only when needed, under `applyMu`, before any write; the two ValidationError messages; update `app/backend/api/fab_config.go` doc comments with an `agent.preset` example <!-- R12 -->
- [x] T012 Go tests in `app/backend/internal/fabsysconfig/fabsysconfig_test.go` (unset/system/env read model, list decode, older-fab fallback for non-zero and non-JSON, preset-supplied row → `Preset` set and no `Override`, validation: known/none/null/unknown/no-list with no write exec) and `app/backend/api/fab_config_test.go` (GET carries `agent_presets`; POST bogus → 400) <!-- R9 R10 R11 R12 -->

### Phase 4: Agent preset — frontend

- [x] T013 In `app/frontend/src/api/client.ts` add `FabAgentPreset`, `agent_presets?` on the installed document, and `preset?` on `FabField`/`FabRoleCell` <!-- R9 R11 -->
- [x] T014 In `app/frontend/src/components/settings-agents-panel.tsx` add the `AgentPresetRow` (select with None / presets / `none` / unknown handling, `data-testid="agent-preset-select"`, FabRow affordances) and the override note <!-- R13 R14 -->
- [x] T015 In `settings-agents-panel.tsx` wrap Session CLI, Worker CLI and `RoleTable` in the `Customize · N set explicitly` disclosure (only when `agent_presets` present; default open iff N>0); make `hasSystemOverride`, the role row's override check, selects and provenance chip treat `preset`-marked values as inherited with a `preset` chip and no reset link <!-- R15 R16 -->
- [x] T016 Register `Settings: Agent preset…` (`settings-agent-preset`) beside `settings-open` in `app/frontend/src/hooks/use-global-palette-actions.ts`, calling `openSettings("agents")` and focusing `agent-preset-select` after the panel loads (focus fallback to tab content); add a unit test in `use-global-palette-actions.test.tsx` <!-- R17 -->
- [x] T017 Vitest in `app/frontend/src/components/settings-agents-panel.test.tsx`: dropdown render/select/None posts, hidden without `agent_presets`, `none`/unknown values, override note count, Customize count + default expansion, preset-supplied cells with `preset` chip and no reset link <!-- R13 R14 R15 R16 -->

### Phase 5: E2E, demo, docs

- [x] T018 Extend `app/frontend/tests/e2e/_fab-config-stub.ts` (stateful `agent.preset`, `agent_presets` = three built-ins, preset fields applied below explicit system overrides with `originDetail: "preset <name>"`, `preset`, no override) and `app/frontend/tests/e2e/settings-agents.spec.ts` (choose preset → grid reflects it under Customize → back to None; palette action focuses the dropdown) with JSDoc Proves/Steps <!-- R13 R15 R16 R17 -->
- [x] T019 Add demo spec `app/frontend/tests/demo/agent-preset-dropdown.demo.ts` showing the dropdown, Customize, picking a preset, and the spawn dialog's `Riff preset` field (pattern from `agents-settings.demo.ts` + `_fab-config-stub.ts`) <!-- R13 R6 -->
- [x] T020 Update docs: `docs/site/workflows.md`, `docs/specs/mcp.md` (riff argument), any `app/backend/cmd/rk/skill/*.md` or help-topics assertion naming riff preset flags; create the backlog entry via `idea add "Drop deprecated riff spellings after one release: rk riff --preset/--list-presets, POST /api/riff preset body field, legacy macro target.preset key"` <!-- R7 R8 -->

## Execution Order

- T001 blocks T002, T003 (renamed riff identifiers)
- T006 blocks T008; T007 blocks T008
- T009 → T010 → T011 → T012 (same file)
- T013 blocks T014–T017; T014–T015 block T018–T019

## Acceptance

### Functional Completeness

- [ ] A-001 R1: `rk riff --riff-preset <name>` and `--list-riff-presets` work identically to the old flags; help and errors say "riff preset"
- [ ] A-002 R2: `--preset`/`--list-presets` are hidden, deprecated (stderr notice), functional; a conflicting `--preset`/`--riff-preset` pair exits 2
- [ ] A-003 R3: `POST /api/riff` uses `riff_preset`, falls back to `preset`, and 400s on disagreement before any subprocess
- [ ] A-004 R4: `GET /api/riff/presets` returns `riff_presets` (no `presets` key) and the SPA consumes it
- [ ] A-005 R5: MCP `riff` tool exposes `riff_preset` at positional 1; `preset` is rejected as unknown
- [ ] A-006 R6: Spawn dialog shows `Riff preset (optional):`; macros use `riff_preset`, legacy entries load, run and are written back
- [ ] A-007 R7: Settings registry text, doctor row, operator prompt and docs use "riff preset"; unrelated presets untouched
- [ ] A-008 R8: A backlog entry tracks removal of the deprecated spellings; rk-riff memory documents the window
- [ ] A-009 R9: `GET /api/fab-config` returns `agent_presets` and `fields["agent.preset"]` with env-shadow `systemValue`
- [ ] A-010 R10: A failing/old `fab agent presets` omits `agent_presets` without failing the read
- [ ] A-011 R11: Preset-supplied rows carry `preset` and never `override`
- [ ] A-012 R12: `agent.preset` writes are validated against fab's list (or `none`) before any write; null unsets
- [ ] A-013 R13: The Agent preset dropdown renders with None/presets/`none`/unknown handling and posts set/null
- [ ] A-014 R14: The override note shows the correct count and offers no clearing action
- [ ] A-015 R15: The Customize disclosure shows the explicit count and defaults open iff count > 0; absent on older fab
- [ ] A-016 R16: Preset-supplied knobs/cells show a `preset` chip, inherited styling and no reset link
- [ ] A-017 R17: `Settings: Agent preset…` opens Settings > Agents with the dropdown focused

### Scenario Coverage

- [ ] A-018 R2: Go tests cover each kept CLI spelling (`--preset`, `--list-presets`) and the conflict case
- [ ] A-019 R3: Go tests cover legacy-body spawn and the disagreement 400 with nothing created
- [ ] A-020 R6: Vitest covers legacy macro parse/re-projection and write-back
- [ ] A-021 R12: Go tests cover known/none/null/unknown/no-list validation with no write exec on rejection
- [ ] A-022 R13: Playwright `settings-agents.spec.ts` exercises choose preset → Customize reflects it → None, and the palette action

### Edge Cases & Error Handling

- [ ] A-023 R10: Non-JSON and non-zero `fab agent presets` outputs both fall back without error (tested)
- [ ] A-024 R13: A stale system `agent.preset` naming an undefined preset renders as `<name> (unknown)` and can be set to None

### Code Quality

- [ ] A-025 Pattern consistency: New code follows naming and structural patterns of surrounding code (fabsysconfig helpers, FabRow affordances, palette builders)
- [ ] A-026 No unnecessary duplication: Existing utilities reused (`checkFreeText`, `warningLines`, `ProvenanceChip`, `FabRow`, `openSettings`)
- [ ] A-027 Subprocess discipline: every new fab exec uses `exec.CommandContext` with a timeout via the Runner seam, argv slices only
- [ ] A-028 Frontend type narrowing: no new `as` casts where an `if` guard or discriminated union works
- [ ] A-029 Tests included: every added/changed behavior has Go, Vitest or Playwright coverage; Playwright tests carry JSDoc Proves/Steps
- [ ] A-030 No comment narration: comments state constraints, never change IDs or reviewer-addressed narration
- [ ] A-031 No god functions: new functions stay focused (< ~50 lines without reason)

### Security

- [ ] A-032 R12: `agent.preset` values are validated (free-text guard + list membership) before reaching any `fab config set` argv
- [ ] A-033 R3: The legacy/disagreement checks happen before repo derivation or any subprocess

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- PR evidence (plan Rule 7): `just demo agent-preset-dropdown --before` on desktop + mobile — produced at ship, not by apply

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Requirements mirror the intake's What Changes verbatim, including the three user-decided items (aliases, note-only, palette opens tab) | Intake is authoritative; decisions were asked | S:95 R:80 A:90 D:90 |
| 2 | Confident | `parseMacros` keeps its signature for callers and a sibling helper (or a returned flag) tells the loader a legacy entry was seen | Minimal disturbance to existing callers while enabling one-time write-back | S:65 R:85 A:70 D:65 |
| 3 | Confident | The palette action lives in `use-global-palette-actions.ts` beside `settings-open` and focuses by `data-testid`/id after the panel's fetch resolves | That hook owns `Settings: Open`; focus must wait for the async document | S:70 R:85 A:70 D:70 |
| 4 | Confident | Override-note keys are derived from the preset definition in `agent_presets` matched against explicit fields/cells in the document | The only source of "what the preset sets" available to the SPA | S:70 R:85 A:75 D:70 |
| 5 | Confident | The demo recording itself is produced at ship (PR evidence), apply only writes the demo spec | Recording needs the PR; apply verifies the spec compiles/runs | S:70 R:90 A:75 D:75 |
| 6 | Confident | The legacy-macro write-back is `hasLegacyRiffMacro(raw)` + `migrateLegacyMacros()` in `lib/macros.ts`, called once from `useMacros`' mount effect; `parseMacros` keeps its signature | Realises assumption 2's "sibling helper" and keeps the storage side effect out of render and out of the pure parser | S:70 R:85 A:75 D:70 |
| 7 | Confident | A preset-supplied leaf (Field or Cell) never triggers the `fab config show <key>` stack read for `systemValue`, and the SPA shows no env-shadow warning on it | The env/system layer chose the preset, not the leaf; the read is display-only and the warning would name the wrong variable | S:65 R:90 A:70 D:65 |
| 8 | Confident | "Explicit" for the Customize count and the override note is origin `system` or `env` with no `preset` marker (a cell also when it has an override), so an env-set leaf counts although no system value is shadowed | R15 would otherwise collapse the grid over a value the environment sets; reset links still key off system overrides only | S:60 R:85 A:65 D:60 |
| 9 | Confident | The e2e stub serves `agent_presets` only with `presets: true`; existing specs and demos keep the no-preset-support shape | Their role-table assertions would otherwise sit behind a collapsed Customize; no-preset-support is also the older-fab path that must stay covered | S:75 R:90 A:80 D:75 |
| 10 | Confident | Palette focus is a bounded DOM wait (`lib/agent-preset-focus.ts`, MutationObserver, 8s) on `#agent-preset-select`; once the Agents panel settles with no dropdown it focuses the panel's first control, else the tab | The dialog mounts the panel and fetches fab asynchronously; no extra fetch or new context state, per the decision that the action fetches nothing | S:70 R:85 A:70 D:65 |
| 11 | Confident | Setting `agent.preset` is rejected with "agent presets are not supported by the installed fab" whenever the list is unreadable, including for `none`; an empty-but-valid list omits `agent_presets` | An fab without `agent presets` does not know the key either; an empty list leaves nothing to choose | S:70 R:85 A:75 D:70 |
| 12 | Confident | Warning lines from `fab agent presets --json` are appended to `warnings` without repeating a line discovery already reported | fab repeats config-level warnings (an unknown FAB_AGENT_PRESET) on every call it makes | S:65 R:95 A:75 D:70 |
| 13 | Confident | `getRiffPresets` returns `{ riffPresets, tiers }` and the Shortcuts tab's fetch in `settings-dialog.tsx` follows | The intake allowed either shape; `riffPresets` matches the key casing used everywhere else | S:75 R:90 A:80 D:75 |
| 14 | Confident | The PR-evidence demo spec also types `Riff preset` into the spawn dialog by stubbing the riff-presets preflight, so it needs no tmux or repo | Matches the demo convention of fully stubbed browser backends | S:70 R:90 A:80 D:75 |

14 assumptions (1 certain, 13 confident, 0 tentative).
