# Intake: Built-in riff presets in the settings registry (`riff_presets`)

**Change**: 260916-i567-builtin-riff-presets-settings-registry
**Created**: 2026-09-16

## Origin

Promptless dispatch from a design conversation (team lead → intake worker, `/fab-proceed`-style create-new dispatch with `{questioning-mode} = promptless-defer`). The synthesized description handed over:

> Built-in riff presets in run-kit's settings registry (`riff_presets`), retiring `riff.presets` from `fab/project/config.yaml`.
>
> `rk riff` with no arguments spawns a worktree + tmux window + agent and hands it `/fab-discuss`. The team wants two more one-word spawns that work immediately after `rk update` with zero configuration: `rk riff incognito` (agent running `/fab-incognito`) and `rk riff blank` (agent launched bare, nothing typed into it). Today the only preset mechanism is `riff.presets.<name>` inside the PROJECT file `fab/project/config.yaml`, parsed by `internal/fabconfig`. That layer has no code-default tier, so nothing can ship as a built-in, and it makes rk read an rk-owned key out of fab-kit's file. A scan of all 15 fab project configs on the user's machine (including run-kit's own) found ZERO `riff:` blocks — the project-level preset layer has never been used.
>
> Decision: riff presets become a key in run-kit's own tiered settings registry (`~/.config/run-kit/config.yaml`, precedence code default < config.yaml < env < CLI flag — presets get NO env form). The project-file layer is retired outright, not merged: one file, one owner, one precedence rule. The user explicitly rejected merging rk config with fab config as confusing.

Key decisions carried from the conversation (all recorded as Certain/Confident rows in § Assumptions):

- Registry key `riff_presets`, kind `map[string]string` (preset name → skill string), implemented with the existing `mapSection` machinery like `server_colors`/`server_flairs`; category `behavior`, `ui: false`, `live: true`, no env form.
- Three built-ins: `discuss` → `/fab-discuss`, `incognito` → `/fab-incognito`, `blank` → `""` (bare launcher). A user key with a built-in's name overrides it; other user keys are additions.
- Presets are **skill-only**: one skill string → one skill pane. No `cmd` panes, no `layout`, no `wt_args` in the user tier (trust boundary: the settings HTTP API can write the file, and skill values never enter a shell unquoted).
- `internal/fabconfig` loses every preset type and reader; it keeps `IsFabProject`, `BuiltinTiers`/`ReadTiers`.
- `rk doctor` gains a WARN-shaped advisory row when the current repo's `fab/project/config.yaml` still carries a top-level `riff:` key. No automatic migration.
- MCP `riff` tool description stops pointing at `fab/project/config.yaml`.
- Alternatives rejected: a new root verb `rk raff`; a dotfiles shell alias; project-level built-ins inside `fabconfig`; a merged built-in < rk config < project fab config chain; a generic tiered reader over fab's config.

## Why

**The pain.** `rk riff` is the one-word "give me a fresh agent in a fresh worktree" verb, but it can only ever hand the agent `/fab-discuss`. Two more spawn shapes are wanted daily — a `/fab-incognito` session for fab-process redesign discussions, and a bare agent with nothing typed — and neither is reachable without typing `rk riff --skill /fab-incognito` or `rk riff --skill ""` (the bare `--skill` form) every time. The existing preset mechanism cannot help: it lives in the project's `fab/project/config.yaml`, which (a) has no code-default tier so a built-in cannot be shipped, and (b) is fab-kit's file, so rk squatting an rk-owned `riff:` schema in it means the value is neither shared machine-wide nor owned by the tool that reads it. The scan of every fab project config on the box found zero `riff:` blocks: the layer has cost (a yaml.v3 reader, four types, a test file, a docs section, a help paragraph) and no users.

**If we do nothing.** Every team member either types the long form, or adds a private shell alias that does not travel with `rk update` and is invisible to the web UI's spawn dialog and macro bindings (both of which list presets from the backend). The preset layer keeps documenting a schema nobody uses, and `internal/riff` keeps importing `internal/fabconfig` for a type alias.

**Why this approach.** run-kit already has exactly one tiered, registry-driven configuration store (`internal/settings`, Constitution IV's single carve-out) with a proven map-kind (`server_colors`, `server_flairs`): a hand-rolled byte-stable serializer, omit-when-default, per-entry merge over `POST /api/settings`. Adding `riff_presets` there gives built-ins for free (the code-default tier), a user override/addition tier in the file the user already owns, and one precedence rule. Retiring the project layer instead of merging keeps one file, one owner, one rule — the user explicitly rejected a two-file merge as confusing, and with zero configs on record there is nothing to migrate. Skill-only presets keep the trust boundary intact: a skill value is rendered through the existing `RenderSkillRef`/`ApplySkillPrefix` path and reaches the launcher as a shell-quoted positional (claude) or typed-after-boot text (other providers), so a file the settings HTTP API can write never contributes a raw shell string — the property `cmd`/`wt_args` presets would have broken.

A new root verb (`rk raff`) was rejected on Constitution IV (minimal surface) and toolkit-standards cost (help-dump snapshot, README, docs/site) for a one-constant difference that does not scale to the next skill.

## What Changes

### 1. `internal/settings`: the `riff_presets` registry entry

Add one `registryEntry` to the registry slice, appended **after `board_order`** (last — nested sections follow scalars; a file without the section serializes byte-identically regardless of position):

```go
{
    key: "riff_presets", kind: "map", def: riffPresetsDefaultText,
    desc:     "Preset name → skill invocation for rk riff <name>; a name matching a built-in (discuss, incognito, blank) overrides it, any other name is an addition. Empty value = bare agent.",
    category: "behavior", ui: false, live: true,
    section: mapSection("riff_presets", func(s *Settings) *map[string]string { return &s.RiffPresets }, normalizeRiffPresetValue),
    read:    func(s *Settings) any { return s.RiffPresets },   // the USER tier as stored (nil → JSON null, like the other maps at default)
    apply: mapValue(func(s *Settings) *map[string]string { return &s.RiffPresets },
        validateRiffPresetValue, normalizeRiffPresetValue),
},
```

- **Storage model (user tier only).** `Settings.RiffPresets map[string]string` holds ONLY the user's overrides/additions; `Default()` leaves it nil. The built-ins live in a package-level ordered table, not in the stored map. This is what keeps the existing constraints intact with **no scanner/serializer change**: `mapSection` already omits an empty section, so a settings file that never mentions `riff_presets` round-trips byte-identically and the key is "omitted at default" by construction. (The alternative — seeding the map with the built-ins in `Default()` — would either serialize three lines into every saved file or require a per-entry omit-when-default branch in `mapSection`; rejected.)
- **Built-in table** (settings owns defaults, so the literal lives here; `riff.DefaultRiffSkill` becomes an alias of the `discuss` value so `/fab-discuss` has one source):

```go
// BuiltinRiffPresets is the code-default preset tier, in canonical display order.
var BuiltinRiffPresets = []RiffPreset{
    {Name: "discuss",   Skill: "/fab-discuss",   BuiltIn: true},
    {Name: "incognito", Skill: "/fab-incognito", BuiltIn: true},
    {Name: "blank",     Skill: "",               BuiltIn: true}, // empty skill = bare launcher
}

type RiffPreset struct {
    Name    string
    Skill   string
    BuiltIn bool // the name is a built-in (the value may still be a user override)
}
```

- **`def` text** for GET `/api/settings`: the built-in map as JSON with sorted keys, `{"blank":"","discuss":"/fab-discuss","incognito":"/fab-incognito"}` (`riffPresetsDefaultText`, a const).
- **Value normalization/validation** (`normalizeRiffPresetValue`, `validateRiffPresetValue`): trim whitespace; **accept the empty string** (bare agent) on the file-parse path; reject nothing else (any skill text is later shell-quoted or typed — the same latitude `--skill` already has). Note the `mapValue` apply hook treats a trimmed-empty POST value as "unset this entry" (the folded-endpoint contract), so **over HTTP an override to bare is not expressible; in the file `blank: ""`/`discuss: ""` is**. Accepted for this change (`ui: false`, no editor yet).
- **Name validation** (parse and apply paths): a preset name must match the identifier rule `^[A-Za-z0-9_][A-Za-z0-9_-]*$`, ≤ 64 chars (the `validate.ValidateTier` shape — reuse it or extract a shared identifier validator). A name never enters argv, but it is a line-scanner map key (a `:` would split the line) and a positional token (`rk riff <name>` — a leading `-` would read as a flag). Malformed names are skipped on parse and a 400 on apply, matching the other map keys' tolerant-read / strict-write split.
- **Accessor** (the ONE merged view every read site uses):

```go
// RiffPresets returns the effective preset list: built-ins in canonical order
// (discuss, incognito, blank), each carrying a user override when the user map
// names it, followed by user-added names sorted. Never empty.
func RiffPresets(s Settings) []RiffPreset
// LoadRiffPresets is RiffPresets(Load()).
func LoadRiffPresets() []RiffPreset
```

  Tests pass a `Settings` value directly (no disk); production call sites use `LoadRiffPresets()`. A `map[string]string` projection for lookups is a one-liner at the call site or a tiny helper (`RiffPresetMap`).

- **Registry tests** (`registry_test.go`, `settings_test.go`): add `riff_presets` to the pinned key-order list and the metadata table (`map`, def text, `behavior`, ui `false`, live `true`, nil options); `ReadValue` default is `map[string]string(nil)`; parse `riff_presets:\n  review: "/code-review high"\n  blank: ""` (empty value survives; malformed name skipped); serialize sorted + quoted; **omit-at-default and byte-identical round-trip of a file without the section** (the existing byte-stability tests must stay green untouched); `ApplyValue` per-entry merge (add `review`, null-unset `review`, override `blank` with a value, reject `"not an object"`, reject a bad name); `RiffPresets()` merge order — built-ins first in canonical order with `BuiltIn: true`, an override keeps `BuiltIn: true` with the user's value, additions sorted after.

### 2. `internal/riff`: riff-owned preset shape, no `fabconfig` import

- `PaneKindSkill`/`PaneKindCmd` become riff-owned string constants (`"skill"`, `"cmd"`) — they are currently aliased from `fabconfig`.
- New riff-local type replacing `*fabconfig.Preset` everywhere in the engine:

```go
// Preset is one resolved riff preset: a name and the single skill it renders
// into one skill pane. An empty Skill is the bare launcher.
type Preset struct {
    Name  string
    Skill string
}
func (p Preset) Panes() []PaneSpec { return []PaneSpec{{Kind: PaneKindSkill, Value: p.Skill}} }
```

- `ResolveActivePreset(args []string, positionalCandidate, presetFlag string, available map[string]string) (*Preset, []string, error)` — same semantics: positional consumed iff it exactly matches a name; `--preset` always checked; unknown `--preset` → error listing defined names (sorted — `joinPresetNames` over the map keys; the `(none)` branch becomes unreachable but stays harmless); positional + flag together → the existing mutual-exclusion error.
- `ResolveEffectiveSpec(cliPanes, layoutExplicit, layoutCanonical, cliCount, preset *Preset, passthrough)` — rule 1 (CLI panes replace preset panes) unchanged; the preset branch now uses `preset.Panes()`; the no-panes-anywhere fallback stays `DefaultRiffSkill`. **Layout rule loses its preset rung** (presets carry no layout): explicit `--layout` else `autoLayout(count)`; single pane still forces `""`. **`wt_args` prepend is deleted** (presets carry none). `presetPaneToSpec` is deleted.
- `composePanes(task string, preset *Preset)` — identical truth table: task → task pane; no preset → one bare pane; preset → nil (fall through to `preset.Panes()`).
- `Spawn`: replace the `fabconfig.ReadPresets(opts.RepoRoot)` block with the settings-backed lookup. `internal/riff` **imports `internal/settings` directly** — the dependency direction is safe today (`riff → tmux → settings`; `settings` imports only `gui` and `validate`, neither of which imports `riff`). Keep a package-level seam `var loadRiffPresets = settings.LoadRiffPresets` so `TestSpawn_*` can inject a fixed table without touching the config root (the existing `RK_CONFIG_DIR` test override also works, but a func seam is cheaper). `Options.Preset`'s doc comment changes from "from the repo's fab/project/config.yaml" to "a name from run-kit's `riff_presets` (built-ins + user)".
- `DefaultRiffSkill` = the built-in `discuss` value (alias of the settings constant, or the settings table looks it up by name in an `init`-free way — pick the direction that keeps `settings` a leaf: `settings` defines the literal, `riff` aliases it).
- Tests: `TestResolveActivePreset`, `TestResolveEffectiveSpec` (drop the preset-layout/`wt_args` cases; add "preset with empty skill yields one bare pane and layout `""`"), `TestComposePanes` (same table, new type), `TestSpawn_*` fixtures that build `fabconfig.Preset` values → `riff.Preset`; a new `TestSpawn_PresetFromSettings` covering `blank` (shell string = launcher only, no positional) and `incognito` (`/fab-incognito` rendered through `ApplySkillPrefix`), plus unknown preset → `ValidationErr` listing the built-in names.

### 3. `cmd/rk/riff.go`: CLI read sites and `--list-presets`

- `readPresetsForRepo`/`readPresetsOrderedForRepo` are deleted; the CLI calls `settings.LoadRiffPresets()` once (Step 1 for `--list-presets`, Step 6 for resolution). Presets are no longer repo-scoped, so the repo-root walk is not needed for them (it stays for `wt create`/`fab agent`).
- `printPresets(presets []settings.RiffPreset, out io.Writer)` prints the merged list in the same indented plain-text shape, minus the retired `layout:`/`wt_args:` lines, marking built-ins:

```
discuss: (built-in)
  panes:
    - skill: /fab-discuss

incognito: (built-in)
  panes:
    - skill: /fab-incognito

blank: (built-in)
  panes:
    - skill: ""

review:
  panes:
    - skill: /code-review high
```

  A user override of a built-in name prints the user's value and the marker `(built-in, overridden)`. The `No presets defined in fab/project/config.yaml` line is deleted (the list is never empty). `quoteIfEmpty` stays for the bare skill line. Still short-circuits before preconditions, still no subprocess, exit 0.
- Flag help: `--preset` → `Named preset from run-kit's riff_presets (built-ins: discuss, incognito, blank)`. `Use:` line unchanged.
- `Long` help: the intro sentence ("presets defined in fab/project/config.yaml") and the **Presets:** paragraph are rewritten to: presets come from `~/.config/run-kit/config.yaml` `riff_presets` with the three built-ins; each preset is one skill; CLI `--skill/--cmd` replace the preset pane; `--list-presets` shows the merged list. The examples replace `ship`/`investigate` with `incognito`, `blank`, and a `--count` example on `discuss` (`run-kit riff discuss --count 3`). This is a CLI-surface change: check `shll standards` (help-dump snapshot) and regenerate the pinned help dump if the repo carries one.
- **Positional behaviour change (documented, intended):** bare positionals `discuss`, `incognito`, `blank` before `--` are now consumed as preset names instead of falling through to `args`. Nothing legitimately used those tokens as passthrough (passthrough is after `--`).
- Tests: `TestPrintPresets` rebuilt on the new signature (built-in marker, overridden marker, sorted additions, bare `""` rendering, never-empty).

### 4. `api/riff.go`: `GET /api/riff/presets`

- `handleRiffPresets` calls `settings.LoadRiffPresets()` (via the same seam pattern as the engine, or a `Server`-level func field for tests) instead of `fabconfig.ReadPresetsOrdered(repoRoot)`. **Response shape is kept**: `{"presets":[{"name","layout","paneCount"}], "tiers":[...]}` with `layout: ""` and `paneCount: 1` for every preset. Rationale (checked against the consumers): the spawn dialog renders `layout`/`paneCount` as optional decoration (`p.layout ? … : ""`, `paneCount > 0 ? … : ""`), the Shortcuts panel and macros use `name` only, and both e2e stubs (`spawn-agent.spec.ts`, `macro-riff-bindings.spec.ts`) fabricate the three-field rows — keeping the shape means zero frontend type/stub churn. The `repoRoot`/session derivation stays because `tiers` (fab-owned, repo-scoped) still rides this response and the non-repo `400` contract is unchanged.
- Handler doc comment: presets come from run-kit's config (built-ins + user), tiers stay repo-derived and `IsFabProject`-gated.
- Tests: `TestRiffPresetsSuccess`/`TestRiffPresetsEmpty` → assert the three built-ins in canonical order (there is no empty case any more — `TestRiffPresetsEmpty` becomes `TestRiffPresetsBuiltinsOnly`), plus a user-addition case through the seam; `TestRiffPresetsTiers`, `TestRiffPresetsNonFabRepoTiersEmpty`, `TestRiffPresetsNonRepoCwd`, `TestRiffSpawnUnknownPreset` keep their contracts (unknown preset message now lists the built-ins).

### 5. `internal/fabconfig`: retire the preset reader

Delete `ReadPresets`, `ReadPresetsOrdered`, `Preset`, `PresetEntry`, `PaneSpec`, `PaneKindSkill`, `PaneKindCmd`, `decodePreset`, `decodePanes`, and the tests `TestReadPresets`, `TestReadPresets_EmptyRoot`, `TestReadPresetsOrdered_PreservesOrder`. Keep `IsFabProject`, `BuiltinTiers`, `ReadTiers`, `readConfiguredTierNames`, `findMappingValue`, `fabConfigRelPath`. Rewrite the package doc comment (it currently opens with "reads the riff presets"). Add one small presence probe for the doctor row:

```go
// HasTopLevelKey reports whether <repoRoot>/fab/project/config.yaml parses and
// carries key at its top-level mapping. Best-effort: false on any failure.
func HasTopLevelKey(repoRoot, key string) bool
```

It is a fab-file fact (which keys the project config carries), so it belongs beside `ReadTiers`; it reuses `findMappingValue`.

### 6. `cmd/rk/doctor.go`: stale `riff:` block advisory

New `riffPresetsBlockCheck(repoRoot string, hasKey func(string, string) bool) (doctorCheck, bool)` following the `removedEnvCheck` "second return false → no row" pattern but **WARN-shaped** (`OK: true` with a `Note`), never flipping the verdict — a third-party repo's stale config must not fail `rk doctor`:

- `repoRoot` = `config.FindGitRoot(os.Getwd())`; no row when not in a git repo, when `!fabconfig.IsFabProject(repoRoot)`, or when `!fabconfig.HasTopLevelKey(repoRoot, "riff")`.
- Row: `Name: "riff presets"`, `OK: true`, `Note: "fab/project/config.yaml has a riff: block that rk no longer reads — define presets under riff_presets in ~/.config/run-kit/config.yaml"`.
- Tests (`doctor_test.go`): row absent for a non-fab dir / a fab config without `riff:`; row present and OK with the hint when the key exists; the row never flips `report.OK` (the existing `*NeverFlipsVerdict` pattern).

### 7. `internal/mcp/policy.go`: description text

`riffDescription` drops "(optionally a named preset from the repo's fab/project/config.yaml)" for "(optionally a named preset — run-kit's `riff_presets`: built-ins `discuss`, `incognito`, `blank`, plus user additions in ~/.config/run-kit/config.yaml)"; the `preset` arg description becomes "Named preset from run-kit's riff_presets (built-ins: discuss, incognito, blank)". `schema_test.go` does not pin the text (checked: only `exec_test.go` uses `"preset": "ship"` as an opaque argv value) — verify `go test ./internal/mcp/...` and any golden schema fixture.

### 8. Frontend (comments and one doc-comment only — no behaviour change)

- `app/frontend/src/lib/macros.ts` header: "pane commands/arguments live in the preset definition inside `fab/project/config.yaml`" → "the skill lives in the preset definition under `riff_presets` in run-kit's `~/.config/run-kit/config.yaml` (built-ins ship in the binary)".
- `app/frontend/src/components/spawn-agent-dialog.tsx`: the comment "Preset — only shown when the repo defines presets" is now misleading (the list is never empty against a live backend); keep the `presets.length > 0` guard (it still covers the preflight-failed path) and reword the comment. No TSX logic change, so no Vitest churn expected; run `just test-frontend` anyway as the gate.
- e2e: `spawn-agent.spec.ts` and `macro-riff-bindings.spec.ts` stub the endpoint with the unchanged shape — no assertion changes; run both as regression gates.

### 9. Docs and memory (hydrate stage — listed here so the plan carries them)

- `docs/memory/run-kit/rk-riff.md`: § Presets (schema → `riff_presets`, built-ins, skill-only, override/addition rule, `--list-presets` new output), § Resolution Order (layout loses its preset rung, `wt_args` gone), § Endpoint Pane Composition (type rename), § `internal/fabconfig/` Package (tiers + `IsFabProject` + `HasTopLevelKey` only), § Security / Trust Boundary (the file is now `~/.config/run-kit/config.yaml`, writable by `POST /api/settings`; skill-only is what preserves the boundary; preset NAME still a map-key lookup), § Tests, § Related Files, § Design Decisions (new entry: registry over project file; rejected alternatives).
- `docs/memory/run-kit/configuration.md`: 16-key → 17-key inventory row for `riff_presets` (map, default = built-ins, behavior, ui no, live yes, "user tier only; merged view via `RiffPresets`"), accessor surface line, a Design Decision "Built-ins as a code tier, user map stores overrides only".
- `docs/memory/run-kit/architecture/cli.md`: `riff` row (presets source, built-ins, positional consumption), `doctor` row (new advisory).
- `docs/memory/run-kit/api-and-sockets.md`: `/api/riff/presets` row and the `getRiffPresets` client row (source of presets; shape unchanged).
- `docs/memory/run-kit/ui/dialogs-and-state.md` § Spawn-Agent Dialog (preset field now always populated); `docs/memory/run-kit/ui/keyboard-and-palette.md` § Macro bindings (trust-boundary sentence names the new file).
- `docs/memory/run-kit/tmux-sessions.md` lines naming `fabconfig.ReadPresets` in its related-files list.
- `docs/memory/run-kit/mcp.md` if it quotes `riffDescription`.
- Outside memory: `docs/site/workflows.md` § Presets (toolkit-standards docs/site surface — rewrite the YAML example to the `riff_presets` shape), `README.md` line "Presets: common pane/layout combos live in fab/project/config.yaml…", `docs/specs/mcp.md` needs no change (it lists arg names only). `fab/project/context.md` does not mention riff presets (checked).

### Non-goals

- A settings-dialog editor for `riff_presets` (`ui: false` now; a later change).
- Hiding/disabling a built-in name (no mechanism; a user can override its value).
- Multi-pane, `cmd`, `layout`, or `wt_args` presets in the user tier (rejected on the trust boundary).
- Any automatic migration of a `riff:` block (none exist; doctor advises only).
- Any change to `POST /api/riff` body fields, routes, or HTTP verbs (Constitution IX).

## Affected Memory

- `run-kit/rk-riff`: (modify) § Presets, § Resolution Order, § Endpoint Pane Composition, § `--list-presets`, § `internal/fabconfig/` Package, § Security / Trust Boundary, § Tests, § Related Files, § Design Decisions
- `run-kit/configuration`: (modify) 17-key registry inventory, accessor surface, new Design Decision on the code-tier built-ins
- `run-kit/architecture/cli`: (modify) `riff` and `doctor` rows
- `run-kit/api-and-sockets`: (modify) `GET /api/riff/presets` row + `getRiffPresets` client row
- `run-kit/ui/dialogs-and-state`: (modify) Spawn-Agent Dialog preset field
- `run-kit/ui/keyboard-and-palette`: (modify) Macro bindings trust-boundary sentence
- `run-kit/tmux-sessions`: (modify) related-files line naming `fabconfig.ReadPresets`
- `run-kit/mcp`: (modify) only if the riff tool description is quoted

## Impact

**Backend (Go)** — `internal/settings/settings.go` (+entry, +type, +table, +accessor, +normalizers), `internal/settings/registry_test.go`, `internal/settings/settings_test.go`; `internal/riff/riff.go` (constants, `Preset`, `Spawn`, seam), `internal/riff/spec.go` (`ResolveActivePreset`, `ResolveEffectiveSpec`, `composePanes`, delete `presetPaneToSpec`), `internal/riff/riff_test.go`; `cmd/rk/riff.go` (help, flag help, `printPresets`, read sites), `cmd/rk/riff_test.go`; `api/riff.go`, `api/riff_test.go`; `internal/fabconfig/fabconfig.go` (−presets, +`HasTopLevelKey`), `internal/fabconfig/fabconfig_test.go`; `cmd/rk/doctor.go`, `cmd/rk/doctor_test.go`; `internal/mcp/policy.go`. `go vet` must show `internal/riff` no longer importing `internal/fabconfig`; `cmd/rk` and `api` still import it for tiers/`IsFabProject`.

**Frontend** — two comment edits (`lib/macros.ts`, `components/spawn-agent-dialog.tsx`); no runtime change; `RiffPreset` type unchanged.

**API contract** — `GET /api/riff/presets` shape unchanged; content now never empty. `POST /api/settings` accepts a new key `riff_presets` (object, per-entry merge). `POST /api/riff` unchanged.

**CLI surface** — `rk riff` help text and `--preset` flag help change (toolkit standards: help-dump check); `rk riff --list-presets` output shape changes (layout/wt_args lines gone, built-in marker added); `rk doctor` gains a conditional row.

**Behaviour deltas to call out in the PR** — `discuss`/`incognito`/`blank` positionals now resolve as presets; a `riff:` block in any `fab/project/config.yaml` is ignored (and flagged by doctor); `--list-presets` never prints the "no presets" line.

**Verification** — `just _ensure-tmux-conf` then `cd app/backend && go test ./...`; `pnpm install --frozen-lockfile` in `app/frontend` (fresh worktree) then `just test-frontend`; `just test-e2e spawn-agent.spec` and `just test-e2e macro-riff-bindings.spec` (single specs). Manual: `rk riff --list-presets` shows the three built-ins with no config; `rk riff incognito` spawns `/fab-incognito`; `rk riff blank` spawns a bare agent (shell string = launcher, no positional, no typed delivery); a `riff_presets: { review: "/code-review high", blank: "/fab-discuss" }` file adds `review` and overrides `blank`; `curl GET /api/riff/presets` lists the built-ins; a repo whose `fab/project/config.yaml` has `riff:` is ignored at spawn and flagged by `rk doctor`.

## Open Questions

- None blocking. Assumption rows 6, 7 and 13 (`def` text form, the HTTP empty-value-unsets carry-over, `(built-in, overridden)` wording) are the softest Confident calls if `/fab-clarify` wants to confirm anything.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Presets move to the `internal/settings` registry key `riff_presets`; the `fab/project/config.yaml` `riff.presets` layer is deleted, not merged | Discussed — user rejected the two-file merge as confusing; zero configs on record use the project layer; Constitution IV names the registry as the one settings carve-out | S:95 R:70 A:95 D:95 |
| 2 | Certain | Three built-ins in canonical order: `discuss` → `/fab-discuss`, `incognito` → `/fab-incognito`, `blank` → `""` (bare launcher); bare `rk riff` still means `/fab-discuss` | Discussed — the exact names and values were agreed; the engine already treats an empty skill pane as a bare launcher | S:95 R:90 A:95 D:95 |
| 3 | Certain | Presets are skill-only (one skill string → one skill pane); no `cmd`, `layout`, `wt_args` in the user tier | Discussed — trust boundary: the settings file is writable over `POST /api/settings`; skill values are shell-quoted or typed, never raw shell | S:95 R:75 A:95 D:95 |
| 4 | Certain | `riff_presets` uses the existing `mapSection`/`mapValue` machinery, kind `map`, category `behavior`, `ui: false`, `live: true`, no env form | Discussed — mirrors `server_colors`/`server_flairs`; Constitution IV limits env forms to the bootstrap keys | S:95 R:90 A:95 D:95 |
| 5 | Confident | Storage model: `Settings.RiffPresets` holds the USER tier only (nil default); built-ins live in a package-level ordered table; `RiffPresets(Settings)` returns the merged list | The description's "baked into the entry" + "omitted when equal to default" + "no new scanner branch" are jointly satisfiable only this way — a default-seeded map would either serialize into every saved file or need a per-entry omit branch in `mapSection` | S:60 R:85 A:85 D:70 |
| 6 | Confident | Registry `def` text is the built-in map as sorted-key JSON; the `read` hook returns the stored user map (nil at default), like the other map keys | No precedent for a non-empty map default in the registry; `ui: false` makes it display metadata for now; easy to flip when the editor change lands | S:45 R:90 A:60 D:45 |
| 7 | Confident | `mapValue`'s trimmed-empty-unsets contract is kept for `riff_presets`, so an override to bare is file-only (`discuss: ""`), not expressible over HTTP | Reusing the hook is the stated goal; the HTTP path has no UI consumer yet; a dedicated bare affordance belongs to the later editor change | S:40 R:85 A:65 D:45 |
| 8 | Confident | Preset names must match the `ValidateTier`-shaped identifier rule (`^[A-Za-z0-9_][A-Za-z0-9_-]*$`, ≤64); malformed names are skipped on parse, 400 on apply | A name is a line-scanner map key and a CLI positional; the rule already exists for the same argv-adjacent reason; built-in names conform | S:55 R:85 A:85 D:75 |
| 9 | Certain | `internal/riff` imports `internal/settings` directly (no reader seam needed for the cycle); a `loadRiffPresets` func var is kept for test injection | Checked the import graph: `riff → tmux → settings` already exists; `settings` imports only `gui`/`validate`, neither imports `riff` | S:80 R:90 A:95 D:90 |
| 10 | Certain | `riff.Preset{Name, Skill}` with `Panes()` replaces `*fabconfig.Preset` in `ResolveActivePreset`/`ResolveEffectiveSpec`/`composePanes`; `PaneKind*` become riff-owned constants; `presetPaneToSpec` and the preset-layout/`wt_args` rungs are deleted | The description fixes the shape (name → skill) and the deletions; a small struct keeps the nil-pointer "no preset" convention the resolvers already use | S:80 R:85 A:90 D:80 |
| 11 | Certain | `GET /api/riff/presets` keeps `{name, layout, paneCount}` rows with `layout: ""`, `paneCount: 1`; `repoRoot` derivation stays for `tiers` | Checked consumers: dialog renders both fields as optional decoration, Shortcuts panel/macros use `name` only, both e2e stubs fabricate the 3-field rows — dropping `layout` buys nothing and costs frontend + stub churn | S:75 R:90 A:90 D:80 |
| 12 | Certain | `--list-presets` prints the merged list in today's indented shape minus `layout:`/`wt_args:` lines, `name: (built-in)` for built-ins, never the empty-map line | Description specifies the shape and the marker; the removed lines describe fields presets no longer have | S:80 R:95 A:90 D:85 |
| 13 | Confident | An overridden built-in prints `(built-in, overridden)` and the user's value | Minimal extension of the required `(built-in)` marker; wording is a guess | S:40 R:95 A:70 D:50 |
| 14 | Confident | Doctor row is WARN-shaped (`OK: true` + `Note`), present only when cwd's repo is a fab project whose config carries a top-level `riff:` key; a new `fabconfig.HasTopLevelKey(repoRoot, key)` probe backs it | "Advisory/warn" in the description; a FAIL row would make `rk doctor` exit 1 inside any third-party repo with a stale block; presence-of-key is a fab-file fact so the probe belongs in `fabconfig` beside `ReadTiers` | S:70 R:90 A:80 D:70 |
| 15 | Certain | `riffDescription` and the `preset` arg description in `internal/mcp/policy.go` stop naming `fab/project/config.yaml` and name the built-ins; no pinned test text (checked `schema_test.go`/`exec_test.go`) | Description item 9; grep confirmed only an opaque `"preset": "ship"` argv value in tests | S:90 R:95 A:95 D:95 |
| 16 | Certain | Frontend changes are comment-only (`lib/macros.ts`, `spawn-agent-dialog.tsx`); e2e stubs unchanged; `just test-frontend` + the two riff e2e specs are the gates | Response shape unchanged (row 11); the `presets.length > 0` guard still covers preflight failure | S:85 R:95 A:95 D:90 |
| 17 | Certain | Positionals `discuss`/`incognito`/`blank` before `--` are now consumed as presets (documented behaviour change) | Direct consequence of built-ins + the existing positional rule; passthrough lives after `--` | S:90 R:85 A:95 D:95 |
| 18 | Certain | `riff.DefaultRiffSkill` aliases the settings-owned `discuss` literal so `/fab-discuss` has one source | Settings owns registry defaults and must stay a leaf; `riff` already imports it (row 9) | S:65 R:95 A:90 D:80 |
| 19 | Certain | The `riff_presets` entry is appended last in the registry slice (after `board_order`) | Serialization order only matters for files that contain the section; last = least churn in the pinned key-order test | S:50 R:95 A:90 D:75 |
| 20 | Certain | Docs outside memory in scope for hydrate: `docs/site/workflows.md` § Presets, `README.md` presets bullet, `rk riff` `Long` help; `docs/specs/mcp.md` and `fab/project/context.md` need no change | Grep of `riff.presets`/`list-presets`/`fabconfig` across docs; toolkit standards bind docs/site + README on a CLI-surface change | S:80 R:95 A:90 D:85 |

20 assumptions (14 certain, 6 confident, 0 tentative, 0 unresolved).
