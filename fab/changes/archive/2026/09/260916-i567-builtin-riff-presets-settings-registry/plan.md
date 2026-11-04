# Plan: Built-in riff presets in the settings registry (`riff_presets`)

**Change**: 260916-i567-builtin-riff-presets-settings-registry
**Intake**: `intake.md`

## Requirements

### Settings: the `riff_presets` registry key

#### R1: `riff_presets` is a registry entry of the existing map kind
`internal/settings` MUST register one `registryEntry` with `key: "riff_presets"`, `kind: "map"`, `category: "behavior"`, `ui: false`, `live: true`, built on the existing `mapSection`/`mapValue` machinery (no new scanner or serializer branch). It MUST be appended last in the registry slice (after `board_order`). Its `def` text MUST be the built-in map as sorted-key JSON: `{"blank":"","discuss":"/fab-discuss","incognito":"/fab-incognito"}`. It MUST have no env form.

- **GIVEN** the registry table
- **WHEN** `Registry()` is listed
- **THEN** `riff_presets` appears last with kind `map`, category `behavior`, `ui: false`, `live: true`, nil options, and the JSON default text above

#### R2: Built-ins are a code tier; the stored map is the user tier only
`Settings.RiffPresets map[string]string` SHALL hold only the user's overrides and additions (nil in `Default()`). The built-ins SHALL live in a package-level ordered table `BuiltinRiffPresets []RiffPreset` — `discuss` → `/fab-discuss`, `incognito` → `/fab-incognito`, `blank` → `""` — where `RiffPreset{Name, Skill string; BuiltIn bool}`. The accessor `RiffPresets(s Settings) []RiffPreset` MUST return built-ins first in canonical order (each carrying the user's value when the user map names it, `BuiltIn: true` either way), followed by user-added names sorted; it is never empty. `LoadRiffPresets()` is `RiffPresets(Load())`. A `RiffPresetMap([]RiffPreset) map[string]string` projection helper MAY be provided for lookups.

- **GIVEN** an empty user map
- **WHEN** `RiffPresets` is called
- **THEN** it returns exactly `[discuss, incognito, blank]` with the built-in skills and `BuiltIn: true`
- **GIVEN** a user map `{"blank":"/fab-discuss","review":"/code-review high"}`
- **WHEN** `RiffPresets` is called
- **THEN** it returns `discuss`, `incognito`, `blank` (skill `/fab-discuss`, `BuiltIn: true`), then `review` (`BuiltIn: false`)

#### R3: Preset names are validated; values are free skill text, empty allowed
A preset name MUST match `^[A-Za-z0-9_][A-Za-z0-9_-]*$` and be ≤ 64 characters (the `validate.ValidateTier` shape — reuse it or extract a shared identifier validator). On the file-parse path a malformed name SHALL be skipped silently; on `ApplyValue` it SHALL be rejected (error → 400). Values are trimmed; the empty string MUST survive the parse path (bare agent). The existing `mapValue` contract that a trimmed-empty POST value unsets the entry is kept unchanged.

- **GIVEN** a settings file containing `riff_presets:\n  review: "/code-review high"\n  blank: ""\n  "bad name": "/x"`
- **WHEN** the file is parsed
- **THEN** `review` and `blank` (empty) are stored and `bad name` is skipped
- **GIVEN** `ApplyValue(s, "riff_presets", {"-bad":"/x"})`
- **WHEN** applied
- **THEN** it returns an error and the map is unchanged

#### R4: Serialization stays byte-stable
A settings file that never mentions `riff_presets` MUST round-trip byte-identically; the section is omitted when the user map is empty. When present it serializes as a nested section with sorted keys and quoted values, matching `server_colors`.

- **GIVEN** the existing byte-stability fixtures
- **WHEN** the registry gains the entry
- **THEN** every existing round-trip test passes unchanged, and a file with two user presets serializes them sorted and quoted

### riff engine: riff-owned preset shape

#### R5: `internal/riff` owns its preset type and pane-kind constants
`PaneKindSkill`/`PaneKindCmd` MUST become riff-owned string constants (`"skill"`, `"cmd"`). A riff-local `Preset{Name, Skill string}` with `Panes() []PaneSpec` (one skill pane) SHALL replace `*fabconfig.Preset` in `ResolveActivePreset`, `ResolveEffectiveSpec`, `composePanes`, and `Spawn`. `internal/riff` MUST NOT import `internal/fabconfig`. `presetPaneToSpec` is deleted.

- **GIVEN** `go list -deps ./internal/riff`
- **WHEN** inspected after the change
- **THEN** `rk/internal/fabconfig` is absent and `rk/internal/settings` is present

#### R6: Resolution semantics keep their contract minus the retired preset fields
`ResolveActivePreset(args, positionalCandidate, presetFlag, available map[string]string)` SHALL keep: positional consumed iff it exactly matches a name; `--preset` always checked; unknown `--preset` → error listing defined names sorted; positional + flag → the mutual-exclusion error. `ResolveEffectiveSpec` SHALL keep rule 1 (CLI panes replace preset panes) and the `DefaultRiffSkill` no-panes fallback; the preset branch uses `preset.Panes()`; the layout rule loses its preset rung (explicit `--layout` else `autoLayout(count)`, single pane forced `""`); the `wt_args` prepend is deleted. `composePanes(task, preset *Preset)` keeps its truth table.

- **GIVEN** `rk riff blank`
- **WHEN** the spec resolves
- **THEN** it has one skill pane with empty value, layout `""`, and the passthrough is exactly the user's `--` args
- **GIVEN** `rk riff --preset nope`
- **WHEN** resolved
- **THEN** the error is `run-kit riff: unknown preset "nope" (defined: blank, discuss, incognito)`

#### R7: `Spawn` resolves presets from settings through a test seam
`Spawn` MUST resolve `opts.Preset` against `settings.LoadRiffPresets()` via a package-level seam `var loadRiffPresets = settings.LoadRiffPresets`; an unknown name → `ValidationErr` listing the defined names. `Options.Preset`'s comment names run-kit's `riff_presets`.

- **GIVEN** a stubbed `loadRiffPresets` returning the built-ins
- **WHEN** `Spawn` runs with `Preset: "blank"`
- **THEN** the pane's shell string is the launcher with no positional and no typed delivery
- **AND** with `Preset: "incognito"` the pane carries `/fab-incognito` rendered through `ApplySkillPrefix`

#### R8: `/fab-discuss` has one source
`riff.DefaultRiffSkill` MUST alias the settings-owned `discuss` literal (settings defines the constant; riff references it), so the bare `rk riff` default and the `discuss` built-in cannot drift.

- **GIVEN** the two symbols
- **WHEN** compared
- **THEN** they are the same constant value `/fab-discuss`

### CLI: `rk riff` and `rk doctor`

#### R9: `--list-presets` prints the merged list with built-in markers
`printPresets(presets []settings.RiffPreset, out io.Writer)` SHALL print each preset as `name:` (suffixed ` (built-in)` for an unmodified built-in, ` (built-in, overridden)` for a user-overridden built-in, nothing for a user addition), then `  panes:` and `    - skill: <value>` (`""` for the empty skill via `quoteIfEmpty`), with one blank line between presets, in `RiffPresets` order. The `layout:`/`wt_args:` lines and the `No presets defined in fab/project/config.yaml` line are deleted. It still short-circuits before preconditions with no subprocess, exit 0.

- **GIVEN** no user config
- **WHEN** `rk riff --list-presets` runs outside tmux
- **THEN** stdout shows `discuss: (built-in)`, `incognito: (built-in)`, `blank: (built-in)` blocks in that order with their skills, exit 0

#### R10: CLI read sites and help text move to the registry
`readPresetsForRepo`/`readPresetsOrderedForRepo` MUST be deleted; the CLI calls `settings.LoadRiffPresets()` once for `--list-presets` and once for resolution (projected to a name→skill map). The `Long` help's intro and **Presets:** paragraph, the `--preset` flag help (`Named preset from run-kit's riff_presets (built-ins: discuss, incognito, blank)`), and the examples (`incognito`, `blank`, `discuss --count 3` replacing `ship`/`investigate`) MUST be rewritten. The `Use:` line is unchanged.

- **GIVEN** `rk riff --help`
- **WHEN** read
- **THEN** it names `~/.config/run-kit/config.yaml` `riff_presets` and the three built-ins and no longer mentions `fab/project/config.yaml`

#### R11: `rk doctor` advises on a stale project `riff:` block
`fabconfig.HasTopLevelKey(repoRoot, key string) bool` SHALL report whether the project config parses and carries `key` at its top-level mapping (best-effort, false on any failure). `riffPresetsBlockCheck(repoRoot string, hasKey func(string, string) bool) (doctorCheck, bool)` in `cmd/rk/doctor.go` SHALL return no row unless cwd is inside a git repo that `IsFabProject` and whose config has a top-level `riff:` key; when it does, the row is `Name: "riff presets"`, `OK: true`, `Note: "fab/project/config.yaml has a riff: block that rk no longer reads — define presets under riff_presets in ~/.config/run-kit/config.yaml"`. It MUST never flip the report verdict.

- **GIVEN** a fab project whose config has `riff:\n  presets: {}`
- **WHEN** `rk doctor` runs there
- **THEN** the `riff presets` row appears OK with the note and `report.OK` is unaffected
- **GIVEN** a fab project without the key, or a non-fab directory
- **WHEN** `rk doctor` runs
- **THEN** no such row is emitted

### API and MCP

#### R12: `GET /api/riff/presets` lists the merged presets with an unchanged shape
`handleRiffPresets` MUST source presets from `settings.LoadRiffPresets()` through a `Server`-level seam (or the same func-var pattern) and keep the response `{"presets":[{"name","layout","paneCount"}],"tiers":[...]}` with `layout: ""` and `paneCount: 1` per preset. The session/repo-root derivation, the non-repo `400`, and the `IsFabProject`-gated `tiers` are unchanged.

- **GIVEN** a repo session and no user presets
- **WHEN** the endpoint is called
- **THEN** `presets` is the three built-ins in canonical order with `layout: ""`, `paneCount: 1`

#### R13: The MCP `riff` tool description names the new source
`riffDescription` and the `preset` arg description in `internal/mcp/policy.go` MUST stop naming `fab/project/config.yaml` and instead say presets come from run-kit's `riff_presets` (built-ins `discuss`, `incognito`, `blank`, plus user additions in `~/.config/run-kit/config.yaml`).

- **GIVEN** the MCP tool schema
- **WHEN** rendered
- **THEN** no `fab/project/config.yaml` text remains in the riff tool's descriptions and `go test ./internal/mcp/...` passes

### fabconfig and frontend

#### R14: `internal/fabconfig` retires the preset reader
`ReadPresets`, `ReadPresetsOrdered`, `Preset`, `PresetEntry`, `PaneSpec`, `PaneKindSkill`, `PaneKindCmd`, `decodePreset`, `decodePanes`, and their tests MUST be deleted. `IsFabProject`, `BuiltinTiers`, `ReadTiers`, `readConfiguredTierNames`, `findMappingValue`, `fabConfigRelPath` stay; `HasTopLevelKey` is added beside `ReadTiers`. The package doc comment MUST describe the remaining scope (fab-file facts: tiers, presence, top-level keys).

- **GIVEN** `go vet ./...`
- **WHEN** run
- **THEN** no reference to the deleted symbols remains anywhere in `app/backend`

#### R15: Frontend and docs adjacent to code are corrected without behaviour change
`app/frontend/src/lib/macros.ts` header and the `spawn-agent-dialog.tsx` preset comment MUST be reworded to name `riff_presets` (the `presets.length > 0` guard stays). `docs/site/workflows.md` § Presets and the `README.md` presets bullet MUST describe the `riff_presets` shape and the built-ins. No TSX logic changes; e2e stubs are untouched.

- **GIVEN** `just test-frontend`, `just test-e2e spawn-agent.spec`, `just test-e2e macro-riff-bindings.spec`
- **WHEN** run after the edits
- **THEN** all pass with no assertion changes

### Non-Goals

- A settings-dialog editor for `riff_presets` (`ui: false` for now)
- Hiding or disabling a built-in name
- Multi-pane, `cmd`, `layout`, or `wt_args` presets in the user tier — rejected on the trust boundary
- Automatic migration of a project `riff:` block — doctor advises only
- Any change to `POST /api/riff` fields, routes, or HTTP verbs

### Design Decisions

#### Presets live in run-kit's settings registry, not in fab-kit's project file
**Decision**: riff presets are a `riff_presets` key in `~/.config/run-kit/config.yaml` behind the `internal/settings` registry; the `riff.presets` layer in `fab/project/config.yaml` is deleted, not merged.
**Why**: the registry is run-kit's one tiered config store (code default < file < env < flag), so built-ins ship with the binary and work with an empty file (Constitution IV, VII); one file, one owner, one precedence rule. A scan of every fab project config on the box found zero `riff:` blocks.
**Rejected**: a `BuiltinPresets` union inside `fabconfig` (rk-owned schema squatting in fab's file, and blind to fab's machine-wide tier); a merged built-in < user < project chain (two files, two schemas, silent shadowing — rejected by the user as confusing); a new root verb `rk raff` (Constitution IV surface cost for a one-constant difference).
*Introduced by*: 260916-i567-builtin-riff-presets-settings-registry

#### Built-ins are a code tier; the stored map holds overrides only
**Decision**: `Settings.RiffPresets` stores only the user's entries (nil default); `BuiltinRiffPresets` is a package-level table; `RiffPresets(Settings)` returns the merged view.
**Why**: keeps omit-when-default and byte-stable round-trip with zero `mapSection` changes — a default-seeded map would serialize three lines into every saved file or need a per-entry omit branch.
**Rejected**: seeding the map in `Default()`.
*Introduced by*: 260916-i567-builtin-riff-presets-settings-registry

#### Presets are skill-only
**Decision**: a preset is one skill string rendering to one skill pane; no `cmd`, `layout`, `wt_args`.
**Why**: the settings file is writable over `POST /api/settings`; skill values reach the launcher shell-quoted (claude) or typed after boot (other providers) via `RenderSkillRef`/`ApplySkillPrefix`, so no raw shell string can enter from that file — the trust-boundary property `cmd`/`wt_args` would have broken.
**Rejected**: carrying the project layer's rich shape into the user tier.
*Introduced by*: 260916-i567-builtin-riff-presets-settings-registry

### Deprecated Requirements

#### `riff.presets.<name>` in `fab/project/config.yaml`
**Reason**: rk-owned schema in fab-kit's file with no code-default tier and zero users.
**Migration**: `riff_presets` in `~/.config/run-kit/config.yaml` (skill-only); `rk doctor` flags a leftover block.

## Tasks

### Phase 1: Settings registry

- [x] T001 In `app/backend/internal/settings/settings.go`: add `RiffPreset` type, `BuiltinRiffPresets` table, the `/fab-discuss` constant (exported for riff), `Settings.RiffPresets` field, `normalizeRiffPresetValue`/`validateRiffPresetValue`, name validation on parse and apply, the `riff_presets` registry entry appended after `board_order`, and the `RiffPresets(Settings)`, `LoadRiffPresets()`, `RiffPresetMap` accessors <!-- R1, R2, R3, R4, R8 -->
- [x] T002 In `app/backend/internal/settings/registry_test.go` + `settings_test.go`: add `riff_presets` to the pinned key-order list and metadata table; tests for default nil, parse (empty value kept, malformed name skipped), serialize sorted+quoted, omit-at-default round-trip, `ApplyValue` merge/unset/override/bad-name/non-object, and `RiffPresets` merge order incl. override keeping `BuiltIn: true` <!-- R1, R2, R3, R4 -->

### Phase 2: Engine, CLI, API

- [x] T003 In `app/backend/internal/riff/riff.go` + `spec.go`: riff-owned `PaneKindSkill`/`PaneKindCmd`, new `Preset{Name, Skill}` + `Panes()`, `ResolveActivePreset` over `map[string]string`, `ResolveEffectiveSpec` without the preset-layout rung and `wt_args` prepend, `composePanes(task, *Preset)`, delete `presetPaneToSpec`; `Spawn` resolves via `var loadRiffPresets = settings.LoadRiffPresets`; `DefaultRiffSkill` aliases the settings constant; update `Options.Preset` comment; remove the `fabconfig` import <!-- R5, R6, R7, R8 -->
- [x] T004 In `app/backend/internal/riff/riff_test.go` (+ `deliver_test.go` fixtures): rebuild `TestResolveActivePreset`, `TestResolveEffectiveSpec` (drop layout/wt_args cases, add empty-skill preset → one bare pane + layout `""`), `TestComposePanes`, `TestSpawn_*` fixtures on `riff.Preset`; add `TestSpawn_PresetFromSettings` (`blank` bare shell string, `incognito` rendered, unknown → `ValidationErr` listing built-ins) <!-- R5, R6, R7 -->
- [x] T005 In `app/backend/cmd/rk/riff.go`: delete `readPresetsForRepo`/`readPresetsOrderedForRepo`; call `settings.LoadRiffPresets()` at Step 1 and Step 6; new `printPresets([]settings.RiffPreset, io.Writer)` with `(built-in)`/`(built-in, overridden)` markers, no layout/wt_args lines, no empty-list line; rewrite `Long` intro + **Presets:** paragraph + examples and the `--preset` flag help; rebuild `TestPrintPresets` in `riff_test.go` <!-- R9, R10 -->
- [x] T006 In `app/backend/api/riff.go` + `riff_test.go`: `handleRiffPresets` sources from `settings.LoadRiffPresets()` via a `Server`-level seam, keeps `{name, layout:"", paneCount:1}` rows and the `tiers` path; rename `TestRiffPresetsEmpty` → `TestRiffPresetsBuiltinsOnly`, assert canonical order, add a user-addition case, keep the unknown-preset 400 (message lists built-ins) <!-- R12 -->
- [x] T007 In `app/backend/internal/fabconfig/fabconfig.go` + `fabconfig_test.go`: delete the preset reader, types, constants, decoders and their tests; add `HasTopLevelKey(repoRoot, key)` reusing `findMappingValue` with tests (present / absent / non-fab / malformed); rewrite the package doc comment <!-- R11, R14 -->

### Phase 3: Doctor, MCP, frontend comments

- [x] T008 In `app/backend/cmd/rk/doctor.go` + `doctor_test.go`: add `riffPresetsBlockCheck(repoRoot, hasKey)` (WARN-shaped, `OK: true` + `Note`) wired after `removedEnvCheck`; tests for row absent (non-fab, key missing), row present with the note, and never-flips-verdict <!-- R11 -->
- [x] T009 [P] In `app/backend/internal/mcp/policy.go`: rewrite `riffDescription` and the `preset` arg description to name `riff_presets` and the built-ins; run `go test ./internal/mcp/...` <!-- R13 -->
- [x] T010 [P] Comment-only edits: `app/frontend/src/lib/macros.ts` header, `app/frontend/src/components/spawn-agent-dialog.tsx` preset comment; docs adjacent to code: `docs/site/workflows.md` § Presets YAML example → `riff_presets` shape + built-ins, `README.md` presets bullet <!-- R15 -->

### Phase 4: Verification

- [x] T011 Gates: `go vet ./...` and confirm `go list -deps ./internal/riff` has no `fabconfig`; `cd app/backend && go test ./...`; `just test-frontend`; `just test-e2e spawn-agent.spec`; `just test-e2e macro-riff-bindings.spec` (single specs only — never the full e2e suite); fix any failures <!-- R5, R14, R15 -->

## Execution Order

- T001 blocks T002 and T003 (the settings symbols must exist before riff imports them)
- T003 blocks T004, T005, T006 (they consume the new riff types)
- T003, T005, T006 block T007 (fabconfig's preset symbols can only be deleted once no caller remains)
- T007 blocks T008 (`HasTopLevelKey`)
- T009, T010 are independent of Phase 2
- T011 runs last

## Acceptance

### Functional Completeness

- [x] A-001 R1: `Registry()` lists `riff_presets` last with kind `map`, category `behavior`, `ui: false`, `live: true`, nil options, JSON default text
- [x] A-002 R2: `RiffPresets` returns the three built-ins in canonical order on an empty user map and merges overrides/additions as specified
- [x] A-003 R3: malformed names are skipped on parse and rejected on apply; empty values survive parse
- [x] A-004 R5: `internal/riff` defines its own `Preset` and pane-kind constants and does not import `internal/fabconfig`
- [x] A-005 R7: `Spawn` resolves `blank`/`incognito` from the settings seam and rejects unknown names with a `ValidationErr` listing defined names
- [x] A-006 R9: `rk riff --list-presets` prints the merged list with `(built-in)` / `(built-in, overridden)` markers and no layout/wt_args lines
- [x] A-007 R11: `rk doctor` emits the WARN-shaped `riff presets` row only when the fab project's config carries a top-level `riff:` key
- [x] A-008 R12: `GET /api/riff/presets` returns the built-ins (plus user additions) with `layout: ""`, `paneCount: 1`, and the unchanged `tiers` behaviour
- [x] A-009 R13: the MCP riff tool descriptions name `riff_presets` and the built-ins
- [x] A-010 R14: `fabconfig` keeps only tiers, `IsFabProject`, `HasTopLevelKey` and helpers; package doc updated

### Behavioral Correctness

- [x] A-011 R6: `ResolveEffectiveSpec` no longer reads a preset layout or `wt_args`; explicit `--layout` else `autoLayout`, single pane forced `""`; passthrough is exactly the user's `--` args
- [x] A-012 R8: `riff.DefaultRiffSkill` and the `discuss` built-in resolve to the same constant
- [x] A-013 R10: `rk riff --help` and the `--preset` flag help name `riff_presets`, the three built-ins, and no longer mention `fab/project/config.yaml`

### Removal Verification

- [x] A-014 R14: no reference to `ReadPresets`, `ReadPresetsOrdered`, `fabconfig.Preset`, `PresetEntry`, `fabconfig.PaneSpec`, `presetPaneToSpec`, `readPresetsForRepo`, `readPresetsOrderedForRepo` remains in `app/backend`
- [x] A-015 R9: the string `No presets defined in fab/project/config.yaml` no longer exists in the codebase (removed from code; the one remaining occurrence is the stale description in `docs/memory/run-kit/rk-riff.md`, which is hydrate's scope per `## Assumptions` row 4)

### Scenario Coverage

- [x] A-016 R7: a test covers `Preset: "blank"` producing a launcher-only shell string with no typed delivery
- [x] A-017 R4: existing byte-stability round-trip tests pass unchanged and a two-entry `riff_presets` section serializes sorted and quoted

### Edge Cases & Error Handling

- [x] A-018 R6: `rk riff --preset nope` errors with the sorted defined-names list, exit 2 / HTTP 400
- [x] A-019 R11: the doctor row never flips `report.OK` (never-flips-verdict test)

### Code Quality

- [x] A-020 Pattern consistency: the new registry entry mirrors `server_colors`/`server_flairs`; the doctor check follows the `removedEnvCheck` two-return shape; seams follow the existing package-level func-var pattern
- [x] A-021 No unnecessary duplication: name validation reuses `validate.ValidateTier` or a shared extracted validator; `HasTopLevelKey` reuses `findMappingValue`
- [x] A-022 Tests accompany every behaviour change (`internal/settings`, `internal/riff`, `cmd/rk`, `api`, `fabconfig`, `doctor`) and the gates in T011 are green
- [x] A-023 Comments state constraints, not narration; no change IDs or PR numbers in code comments
- [x] A-024 All subprocess calls remain `exec.CommandContext` argv slices; no shell-string construction added

### Security

- [x] A-025 R3: no preset value from `~/.config/run-kit/config.yaml` can reach a shell unquoted — presets render only through the skill-pane path (`ApplySkillPrefix` → `shellq.Quote` or typed delivery)

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- Fresh-worktree prerequisites already staged by the orchestrator: `just _ensure-tmux-conf` (Go embed) and `pnpm install --frozen-lockfile` in `app/frontend`
- e2e: run single specs only (`just test-e2e <name>.spec`), never the full suite

## Deletion Candidates

- `app/backend/internal/riff/spec.go` — the `(none)` branch in `joinPresetNames`: the merged preset map is never empty (built-ins always exist), so the empty-map fallback is unreachable dead code kept only as harmlessness (plan acknowledged this).
- `app/backend/cmd/rk/riff.go` — `builtinRiffPresetSkill`: duplicates the built-in-name lookup loop that `internal/settings` keeps private (`isBuiltinRiffPreset`); a `settings.BuiltinRiffPresetSkill(name)` export would give the override-marker check one owner.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | The settings constant for `/fab-discuss` is exported from `internal/settings` and `riff.DefaultRiffSkill` aliases it (riff → settings is the safe import direction) | Import graph checked in the intake: `riff → tmux → settings` already exists; settings imports only `gui`/`validate` | S:80 R:95 A:90 D:85 |
| 2 | Confident | `printPresets` takes the merged slice and an `io.Writer` only; tests pass a hand-built slice, so no disk read is needed in `TestPrintPresets` | The old signature's `repoRoot` parameter existed only for the YAML-order re-read, which the merged slice already encodes | S:60 R:95 A:85 D:75 |
| 3 | Confident | The API handler's seam is a `Server` func field defaulting to `settings.LoadRiffPresets`, mirroring how the test router injects other collaborators | `NewTestRouterWithRiff` already injects an engine; a func field keeps the handler testable without touching `RK_CONFIG_DIR` | S:55 R:90 A:85 D:70 |
| 4 | Confident | `docs/site/workflows.md` and `README.md` edits belong to apply (T010), memory edits to hydrate | They are code-adjacent toolkit-standards surfaces, not `docs/memory`; hydrate owns memory only | S:60 R:95 A:90 D:80 |

4 assumptions (1 certain, 3 confident, 0 tentative).
