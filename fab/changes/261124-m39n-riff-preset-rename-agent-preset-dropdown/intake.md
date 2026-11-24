# Intake: Riff-preset rename and the agent-preset dropdown in Settings > Agent

**Change**: 261124-m39n-riff-preset-rename-agent-preset-dropdown
**Created**: 2026-11-24

## Origin

> Execute step H1 (Riff-preset rename and the agent-preset dropdown in Settings > Agent) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-presets.md. Read the whole plan first (Decisions and Rules bind you), then implement only the H1 Brief.

The request is step **H1** of the plan `fab/plans/sahil/26-11-24-agent-presets.md` (also in this worktree at the same relative path). It was started with `/fab-new` and the operator dispatched it. The plan's **Decisions already taken** table and its **Rules** bind this change and are not reopened here. **H2** (group/workspace presets, `@rk_ses_agent_preset` / `@rk_srv_agent_preset`, the spawn-dialog "Agent preset" picker, `--agent-preset`) is **out of scope** and must not be started.

Prerequisites, verified at intake on 2026-11-24:

- **F1 and R1 are done.** The installed `fab` is 2.31.1. `fab agent presets --json` succeeds and prints:
  ```json
  [{"name":"claude","description":"All roles on Claude (today's defaults)","source":"built-in","session":"claude","workers":"claude"},
   {"name":"codex-review","description":"Only the review role on Codex","source":"built-in","profiles":{"review":{"cli":"codex"}}},
   {"name":"codex-workers","description":"Pipeline workers on Codex; session on Claude","source":"built-in","workers":"codex"}]
  ```
- `fab agent presets --help` describes the contract: an array of `{name, description, source, session?, workers?, profiles?}`. `source` is one of `built-in | system | project | env`, sorted by name. **The reserved name `none` is never listed.** Fields a preset does not set are omitted. It accepts `--repo` (default: the current repo).
- `fab config set agent.preset <name> --system` accepts any defined name, and also `none`. An undefined name fails with exit 1 and this stderr:
  `ERROR: invalid value "nope" for agent.preset — not a defined agent preset (defined: claude, codex-review, codex-workers; or "none" to select no preset)`.
- How `fab config show --origin --json` represents presets (probed with a throwaway HOME):
  - When `agent.preset` is **unset**, its row is **absent**.
  - When set in the system file: `{"key":"agent.preset","value":"codex-workers","origin":"system","origin_detail":"/…/.fab-kit/config.yaml"}`.
  - When set via env: `{"key":"agent.preset","value":"codex-review","origin":"env","origin_detail":"FAB_AGENT_PRESET"}`.
  - **A leaf the preset supplied keeps the layer that chose the preset as its `origin`, and has `origin_detail: "preset <name>"`.** Examples: `{"key":"agent.workers","value":"codex","origin":"system","origin_detail":"preset codex-workers"}`, and under env `{"key":"agent.profiles.review.cli","value":"codex","origin":"env","origin_detail":"preset codex-review"}`.
  - An unknown env name makes every fab call print `fab: warning: unknown agent preset "bogus" (agent.preset from env); ignoring it` on stderr.

Decisions made in the intake conversation (asked via SRAD; the user picked the recommended option each time):

1. **Old riff spellings** become deprecated aliases for one minor release (detail in § Part 1 › Back-compat).
2. **Picking a preset never offers to clear overrides.** A note shows how many explicit fields override parts of it. The existing per-row reset links remain the way to clear them.
3. **Palette action:** a single `Settings: Agent preset…` entry that opens Settings on the Agents tab with the preset dropdown focused. It fetches nothing extra.

## Why

1. **Problem.** H2 will put two different "preset" concepts in the same spawn dialog and on the same `rk riff` command. `rk riff`'s existing presets (a name → one skill invocation) and fab's new agent presets (a name → a whole role assignment) both use the bare label "preset" today: the dialog's "Preset" field, `--preset`, `--list-presets`, the `preset` body field, the MCP `preset` argument and the macro payload. The plan's **Names in HexoKit** decision rules this out: "no bare 'preset' anywhere". Separately, Settings > Agent offers no way to pick fab's new presets. The only way to choose a role assignment on a machine is the six-role × three-field grid, which is the "too many parts for a simple choice" problem in the plan.
2. **Consequence of not doing it.** H2 cannot land without a label collision. The fab-kit preset feature (F1, already released) would have no HexoKit surface, and users would keep hand-editing a 6×3 grid to express "Codex workers".
3. **Why this approach.** fab owns the schema, the cascade and the file (plan decision "Who owns agent config"; Constitution III/IV). HexoKit therefore reads presets only through `fab agent presets --json` and writes only `fab config set|unset agent.preset --system`, through the existing `internal/fabsysconfig` wrapper. The rename keeps the existing settings key `riff_presets` and changes only labels and wire names. Behavior is unchanged (non-goal: "Changing what `rk riff`'s presets do").

## What Changes

### Part 1 — Rename `rk riff`'s presets to "riff presets" (behavior unchanged)

The settings key `riff_presets` (`~/.config/hexokit/config.yaml`, `internal/settings`) **stays as is**. Only the names around it change. Key casing follows the plan's **Key casing** decision: snake_case for JSON fields and keys (`riff_preset` singular for a field naming one, `riff_presets` plural for a list), kebab-case only for CLI flags.

#### CLI — `app/backend/cmd/rk/riff.go`

- `--preset <name>` → **`--riff-preset <name>`**. `--list-presets` → **`--list-riff-presets`**.
- The positional form (`rk riff discuss`, `rk riff incognito "task"`) is **unchanged**.
- Update the `Use:` line, Long help (the `Presets:` section becomes `Riff presets:`; examples `run-kit riff --riff-preset blank`, `run-kit riff --list-riff-presets`) and flag usage strings, e.g. `Named riff preset from run-kit's riff_presets (built-ins: discuss, incognito, blank)` and `List defined riff presets and exit`.
- Exit-code text becomes `unknown/conflicting riff preset`.
- Rename the Go identifiers: `riffPresetFlag`, `riffListPresetsFlg` → e.g. `riffRiffPresetFlag`/`riffListRiffPresetsFlag`, or clearer names; `printPresets` → `printRiffPresets`.
- `internal/riff/spec.go`: `Preset` → `RiffPreset`, `ResolveActivePreset` → `ResolveActiveRiffPreset`, `hasPreset`/`joinPresetNames` follow.
- `internal/riff/riff.go`: `Options.Preset` → `Options.RiffPreset`.
- Error messages: `run-kit riff: unknown preset %q (defined: …)` → `run-kit riff: unknown riff preset %q (defined: …)`. `positional preset %q and --preset %q are mutually exclusive` → `positional riff preset %q and --riff-preset %q are mutually exclusive`.

#### API — `app/backend/api/riff.go`

- `POST /api/riff` body field `preset` → **`riff_preset`**. The struct field becomes `RiffPreset string \`json:"riff_preset"\``. The other body fields (`task`, `session`, `where`, `worktreeName`, `tier`) are untouched; renaming them is out of scope.
- `GET /api/riff/presets` **keeps its path** (it is already under `/riff/`). Its response key `presets` → **`riff_presets`**: `{"riff_presets":[{"name","layout","paneCount"}], "tiers":[...]}`. The row shape is unchanged. The SPA in the same binary is the only consumer, so there is no dual key.
- Rename `riffPresetSummary` as needed, and update the doc comments and the 400 text (`no riff presets available.` already says "riff").

#### MCP — `app/backend/internal/mcp/policy.go`

- In the `riff` row, the arg `{Name: "preset", Positional: 1, …}` → **`{Name: "riff_preset", Positional: 1, …}`** with description `Named riff preset from run-kit's riff_presets (…)`.
- `riffDescription`: "optionally a named riff preset".
- Update `docs/specs/mcp.md` and `docs/memory/run-kit/mcp.md` where they name the argument.

#### UI — frontend

- `app/frontend/src/components/spawn-agent-dialog.tsx`: the field label `Preset (optional):` → **`Riff preset (optional):`**, `aria-label="Preset"` → `aria-label="Riff preset"`. Rename state vars (`riffPreset`, `riffPresets`) and update the header doc comment.
- `app/frontend/src/api/client.ts`: `RiffPreset` type stays (already prefixed). `getRiffPresets` reads `data.riff_presets` and returns `{ riffPresets, tiers }` (or keeps the property name; pick one and update callers). `spawnRiff` opts `preset?` → `riffPreset?`, sent as body `riff_preset`. Update doc comments.
- `app/frontend/src/lib/macros.ts`: `MacroTarget` `{ type: "riff"; preset: string }` → **`{ type: "riff"; riff_preset: string }`**. Display text `rk riff --preset ${…}` → `rk riff --riff-preset ${…}`.
- `app/frontend/src/components/settings-shortcuts-panel.tsx`: the badge `missing preset` → `missing riff preset`, plus its title text and the `riffPresetNames` usage. Labels already reading "riff preset" stay.
- `app/frontend/src/app.tsx` (macro runner ~L5221–5250): `spawnRiff(server, sessionName, { riffPreset: macro.target.riff_preset })`.

#### Other surfaces using "riff preset" throughout

- `app/backend/internal/settings/settings.go`:
  - registry desc: `Riff preset name → skill invocation for rk riff <name>; …`
  - `validateRiffPresetName` label `"Preset name"` → `"Riff preset name"`
  - comments
- `app/backend/cmd/rk/doctor.go`: the stale-`riff:`-block row text and `riffPresetsBlockCheck` wording say "riff presets".
- `app/backend/api/operator.go` (~L291–293): the operator prompt text becomes `rk riff --list-riff-presets   # list the defined riff presets` and `rk riff [--riff-preset <p>] "<task>"`. Matching assertions in `api/operator_test.go` change too.
- Docs: `docs/site/workflows.md`, the memory files under § Affected Memory, `docs/specs/mcp.md`, and any `rk skill` bundle page under `app/backend/cmd/rk/skill/` that names riff preset flags (none found at intake; re-grep). Update help-dump tests or fixtures that assert riff flags (`cmd/rk/help_dump_test.go`, `tests/e2e/help-topics.spec.ts`) if they mention them.
- Do **not** rename unrelated "preset" uses: surface-layout presets, gui geometry/quality presets, the code-server port "preset" comments, `tab layout`.

#### Back-compat: old spellings stay working for one minor release (decided at intake)

| Old spelling | Mechanism | Notes |
|---|---|---|
| `rk riff --preset <name>` | Hidden flag via pflag `MarkDeprecated("preset", "use --riff-preset")`. It is hidden from help, and on use prints the pflag deprecation line on **stderr** (stdout and `--json` receipts unchanged). It binds a **separate** variable merged into the riff-preset value. If `--preset` and `--riff-preset` are both given with different values → usage error (exit 2) | Positional/flag mutual exclusion applies to the merged value |
| `rk riff --list-presets` | Hidden flag via `MarkDeprecated("list-presets", "use --list-riff-presets")`, same short-circuit behavior | |
| `POST /api/riff` body `preset` | Dual-read: decode both `riff_preset` and `preset`. If only `preset` is present, use it. If both are present and differ → **400** before any subprocess (`riff_preset and preset disagree`). If both are equal, accept | Validation happens before deriving the repo root (Constitution I: nothing created on a 400) |
| Macro payload `{type:"riff", preset}` in `localStorage["hexokit-macros"]` | `parseMacros` accepts either `riff_preset` or legacy `preset`, and re-projects to `{type:"riff", riff_preset}`. When the hook loads stored macros containing a legacy entry, it writes back once in the new shape. The next `writeStoredMacros` always writes only `riff_preset` | Never drop a legacy macro |
| MCP `riff` arg `preset` | **Straight rename, no alias.** MCP clients re-list tools each session, and the schema has `additionalProperties: false`, so an old-name call fails loudly with `unknown argument "preset"` rather than silently misbehaving | No policy-table alias machinery is added |

Removal: the aliases are removed one minor release later. Record a backlog item through `idea` (Constitution III; e.g. `idea add "Drop deprecated riff spellings: --preset, --list-presets, POST /api/riff preset, legacy macro preset key"`) in this change. Mention the deprecation in the rk-riff memory file.

#### Tests (Part 1)

- Existing riff tests are updated under their new names: `TestResolveActivePreset` → `TestResolveActiveRiffPreset`, `cmd/rk/riff_test.go`, `api/riff_test.go`, `internal/mcp/exec_test.go`, `api/operator_test.go`, `macros.test.ts`, `settings-shortcuts-panel.test.tsx`, `spawn-agent-dialog.test.tsx`, `use-macros.test.ts`.
- Playwright: `tests/e2e/spawn-agent.spec.ts` stub returns `{riff_presets, tiers}` and the selectors use `Riff preset`; `tests/e2e/macro-riff-bindings.spec.ts`. Update the Test Intent JSDoc comments per the constitution.
- **One new test per kept old spelling:**
  - Go (`cmd/rk/riff_test.go`): `--preset` resolves exactly like `--riff-preset`, and its use prints a deprecation notice on stderr.
  - Go (`cmd/rk/riff_test.go`): `--list-presets` lists like `--list-riff-presets`.
  - Go (`cmd/rk/riff_test.go`): `--preset X --riff-preset Y` → exit 2.
  - Go (`api/riff_test.go`): body `{"preset":"discuss"}` spawns the same as `{"riff_preset":"discuss"}`.
  - Go (`api/riff_test.go`): disagreeing `preset`/`riff_preset` → 400 with nothing created.
  - Vitest (`macros.test.ts`): a stored legacy `{type:"riff",preset:"discuss"}` parses to `{type:"riff",riff_preset:"discuss"}`.
  - MCP (`internal/mcp`): `riff_preset` maps to positional 1, and `preset` is rejected as an unknown argument.

### Part 2 — The agent-preset dropdown in Settings > Agent

#### Backend — `app/backend/internal/fabsysconfig/fabsysconfig.go`

1. **Key allowlist + read model.** Add `KeyAgentPreset = "agent.preset"` to the constants and to `ScalarKeys`, first in display order. `Read` then fills `doc.Fields["agent.preset"]` like the other scalars: value, origin, origin detail, description from `fab config explain`, and `SystemValue` when env wins (via `systemValue`, which runs `fab config show agent.preset --origin --json`). When unset, fab emits no row, so the field is **absent** and means "None".
2. **Preset list.** `Read` runs **one** `fab agent presets --json` per call, as an argv-slice `exec.CommandContext` with `FabTimeout` and `Dir=$HOME`, through the existing `Runner` seam. It runs concurrently with the existing model discovery, alongside the `discovered` goroutine. Decode the documented contract into:
   ```go
   type AgentPreset struct {
       Name        string                       `json:"name"`
       Description string                       `json:"description,omitempty"`
       Source      string                       `json:"source"`            // built-in | system | project | env
       Session     string                       `json:"session,omitempty"`
       Workers     string                       `json:"workers,omitempty"`
       Profiles    map[string]map[string]string `json:"profiles,omitempty"` // role → {cli, model, effort}
   }
   ```
   Add to `Document`: `AgentPresets []AgentPreset \`json:"agent_presets,omitempty"\``. The snake_case name follows the plan's Key casing decision, even though older sibling fields are camelCase. Collect stderr warning lines from this call into `doc.Warnings`, like discovery's.
3. **Older fab fallback.** If `fab agent presets` exits non-zero, times out, or prints anything that does not decode as a JSON array, then `AgentPresets` is **nil (omitted)** and `Read` still succeeds. Examples: a pre-2.31 fab treats `presets` as a role or rejects `--json`. Everything else in the document is unchanged. **Do not raise the minimum fab version.** The SPA hides the dropdown when `agent_presets` is absent.
4. **Preset-supplied provenance.** A leaf supplied by a preset carries `origin` = the layer that chose the preset, plus `origin_detail` = `"preset <name>"`. Add `Preset string \`json:"preset,omitempty"\`` to both `Field` and `Cell`, set from an `origin_detail` with the `"preset "` prefix (a named constant). Then:
   - `cellFor` must **not** set `Cell.Override` for a preset-supplied row. Today it sets `Override` whenever `row.Origin == "system"`. With a system-chosen `codex-review`, that would show the review CLI as an explicit override whose reset unsets nothing.
   - The same applies to depth-knob `Field`s (`agent.session`/`agent.workers` supplied by a system preset). The SPA's `hasSystemOverride` must treat a preset-supplied field as not overridden (see UI).
5. **Write validation.** `validate` accepts `agent.preset` as a scalar key.
   - `null` → `fab config unset agent.preset --system`.
   - A string value is trimmed, must pass `checkFreeText`, and must be a member of the preset names from a fresh `fab agent presets --json`, **or** the reserved `none`.
   - `write()` fetches the list only when the patch contains a non-null `agent.preset`. This happens under `applyMu` and before any `fab config set|unset` exec.
   - If the list cannot be read (older fab) and the patch sets `agent.preset` → `ValidationError` `agent.preset: agent presets are not supported by the installed fab` (HTTP 400, no write).
   - An unknown name → `ValidationError` `agent.preset: unknown agent preset "x" (available: claude, codex-review, codex-workers)`.
   - The whole patch is still validated before any write exec.
6. **API.** No new route. `GET /api/fab-config` returns `agent_presets` plus `fields["agent.preset"]`. The existing `POST /api/fab-config` partial-merge patch accepts `{"agent.preset": "codex-review"}` and `{"agent.preset": null}` (Constitution IX). Update the doc comments in `api/fab_config.go` with an example.

#### Frontend types — `app/frontend/src/api/client.ts`

Add `FabAgentPreset` (mirroring the Go struct) and `agent_presets?: FabAgentPreset[]` on the installed `FabConfigDocument`. Add `preset?: string` on `FabField` and `FabRoleCell`.

#### UI — `app/frontend/src/components/settings-agents-panel.tsx`

- **Preset dropdown at the top** of the "Agents" section, above Session CLI / Worker CLI. It renders only when `doc.agent_presets` is present.
  - Label: `Agent preset`. Sublabel, e.g. `One named role assignment for this machine`.
  - Native `<select>` with first option **`None`** (value `""` → POST `{"agent.preset": null}`), then one option per preset showing `name — description`.
  - Current value = `fields["agent.preset"].value`. If the field is absent, `None` is selected.
  - If the current value is `none` (set from a shell), show it as an extra option `none (opts out of project presets)`.
  - If the current value names a preset not in the list (a stale system value), show it as `<name> (unknown)` so it stays visible and clearable.
  - Reuse the row affordances `FabRow` already provides: provenance chip, modified dot, reset link when a system override exists, and `EnvShadowWarning` when `FAB_AGENT_PRESET` in the daemon's env shadows the saved value.
  - Give it a stable `id`/test id (e.g. `data-testid="agent-preset-select"`) so the palette action can focus it.
- **Override note (decided: note only, no offer).** When a preset is selected and N > 0 explicit fields at the same or a higher layer set a key that preset also sets, show a one-line note under the dropdown: `N explicit field(s) override parts of this preset — see Customize`. Explicit means origin `system`/`env` with no `preset` marker. "Keys the preset sets" come from its `session`, `workers` and `profiles.<role>.<leaf>` (the `cli` leaf maps to the role's tool cell). No button and no confirm.
- **"Customize" disclosure.** Wrap the Session CLI, Worker CLI and the per-role grid (`RoleTable`) in a disclosure. Use a `<details>`/button-toggled region that is keyboard operable, with `aria-expanded`. Its summary reads `Customize · N set explicitly`, where N counts explicit system-tier (or env-shadowing) values across the two knobs and every role cell, and excludes preset-supplied ones. The disclosure is **collapsed by default when N = 0 and expanded when N > 0**, so existing overrides are never hidden. When `agent_presets` is absent (older fab), render the knobs and grid exactly as today, with no disclosure.
- **Effective values stay visible, with preset provenance.** The grid keeps showing effective values and their origin. A cell or knob with `preset` set reads as supplied by the preset: the provenance chip shows e.g. `preset` with title `preset codex-review`, or similar wording in the inherited-value text. Its selects show it as the inherited value, not as an override. `hasSystemOverride(field)` and the role row's "has override" check must ignore preset-supplied values, so no reset link appears for them.
- The Dispatch section is unchanged.

#### Palette action (Constitution V; decided: open Settings)

Register one command-palette action, **`Settings: Agent preset…`** (id e.g. `settings-agent-preset`). It calls `openSettings("agents")` (from `contexts/settings-dialog-context.tsx`; `SettingsTab` already has `"agents"`) and focuses the preset dropdown once the panel has loaded. It fetches nothing extra. Register it next to the existing `Settings: Open` entry (`settings-open`, `hooks/use-global-palette-actions.ts`) so it is available on every route that has the palette. If the installed fab has no presets, the action still opens the Agents tab; focus falls back to the tab content.

#### Tests and evidence (Part 2)

- **Go (`internal/fabsysconfig/fabsysconfig_test.go`, fake `Runner`):**
  - Read model with `agent.preset` unset (field absent), set at system, and set via env (Origin env + SystemValue).
  - `agent_presets` decoded from the contract JSON.
  - Older-fab fallback: presets exec failing or printing non-JSON gives nil `AgentPresets`, `Read` succeeds, and the other fields are intact.
  - A preset-supplied system row yields `Preset` set and **no** `Override`.
  - Validation: a known name produces a set op; `none` is accepted; `null` produces an unset op; an unknown name gives `ValidationError` with no write exec; on an older fab, setting `agent.preset` gives `ValidationError`.
- **Go (`api/fab_config_test.go`):** GET carries `agent_presets`; POST `{"agent.preset":"bogus"}` → 400.
- **Vitest (`settings-agents-panel.test.tsx`):**
  - The dropdown renders with None plus the presets; selecting posts `{"agent.preset":"codex-review"}`; None posts `null`.
  - The dropdown and disclosure are hidden when `agent_presets` is absent.
  - Customize count and default expansion.
  - Preset-supplied cells show preset provenance and no reset link.
  - The override note appears with the right N.
  - Unknown/`none` current values render.
- **Palette:** a unit test that the `Settings: Agent preset…` action calls `openSettings("agents")`.
- **Playwright:**
  - Extend `tests/e2e/_fab-config-stub.ts`. Add stateful `agent.preset` and an `agent_presets` list mirroring the three built-ins. When the stub's system tier sets `agent.preset`, apply that preset's fields as rows with `originDetail: "preset <name>"`, `preset: "<name>"` and no override, below explicit system overrides.
  - Extend `tests/e2e/settings-agents.spec.ts`: choose a preset, see the grid reflect it under Customize, reset to None, and invoke the palette action. Each new `test()` needs its JSDoc Proves/Steps block.
- **Demo:** a new `app/frontend/tests/demo/agent-preset-dropdown.demo.ts`, recorded with `just demo agent-preset-dropdown --before` on desktop and mobile. It shows the dropdown, Customize, picking a preset, and the spawn dialog's renamed **Riff preset** field. Attach it to the PR with `gh pr edit --attach` per Constitution § PR Evidence and plan Rule 7.

### Constraints that bind both parts

- All subprocess calls use `exec.CommandContext` with a timeout and argv slices (Constitution I and Process Execution).
- Inputs are validated before any exec.
- HexoKit never parses or rewrites `~/.fab-kit/config.yaml` (Constitution III/IV).
- No new HTTP routes and no new settings surface (Constitution IV).
- Mutations stay `POST` (IX).
- This step installs no binary and restarts no daemon (plan Rule 8).

## Affected Memory

- `run-kit/configuration`: (modify) § fab-kit System Config — `agent.preset` in the read model and allowlist, the `agent_presets` list from `fab agent presets --json`, the older-fab fallback, preset-supplied provenance (`origin_detail "preset <name>"` → `preset`, never an override), and write validation against the list or `none`. Also update the riff_presets registry desc wording.
- `run-kit/ui/dialogs-and-state`: (modify) § Agents tab (dropdown, None/none/unknown values, override note, Customize disclosure and count, preset provenance in the grid) and § Spawn-Agent Dialog (the "Riff preset" label).
- `run-kit/api-and-sockets`: (modify) `POST /api/riff` body `riff_preset` with legacy `preset` dual-read; `GET /api/riff/presets` response key `riff_presets`; `GET/POST /api/fab-config` `agent_presets` + `agent.preset`.
- `run-kit/rk-riff`: (modify) the riff-preset rename (`--riff-preset`, `--list-riff-presets`), the deprecated aliases and their removal window, renamed error messages.
- `run-kit/mcp`: (modify) the `riff` tool's `riff_preset` argument.
- `run-kit/ui/keyboard-and-palette`: (modify) macro target `{type:"riff", riff_preset}` with legacy read; the `rk riff --riff-preset` chip text; the `Settings: Agent preset…` palette action.
- `run-kit/operator-actuation`: (modify) the operator prompt's `rk riff --list-riff-presets` / `--riff-preset` lines.
- `run-kit/architecture/cli`: (modify) riff flag names.
- `run-kit/tmux-sessions`: (modify) only if its `--preset` mentions are riff-preset flags; re-check at apply.

## Impact

- **Backend (Go):**
  - `cmd/rk/riff.go`, `cmd/rk/doctor.go`
  - `internal/riff/{spec,riff}.go`
  - `api/riff.go`, `api/operator.go`, `api/fab_config.go`
  - `internal/mcp/policy.go`
  - `internal/settings/settings.go`
  - `internal/fabsysconfig/fabsysconfig.go`
  - tests alongside each
- **Frontend:**
  - `src/api/client.ts`
  - `src/components/{spawn-agent-dialog,settings-agents-panel,settings-shortcuts-panel}.tsx`
  - `src/lib/macros.ts`, `src/hooks/use-macros.ts`
  - `src/app.tsx`
  - `src/hooks/use-global-palette-actions.ts`, or wherever `settings-open` is registered
  - Vitest files alongside each
  - `tests/e2e/{_fab-config-stub.ts,settings-agents.spec.ts,spawn-agent.spec.ts,macro-riff-bindings.spec.ts}`
  - a new demo spec
- **Docs:** the memory files above, `docs/specs/mcp.md`, `docs/site/workflows.md`.
- **External contracts:**
  - The rk CLI flags keep their old spellings for one release.
  - POST /api/riff keeps the old body key for one release.
  - The MCP `riff` tool's argument rename is a breaking change for any saved MCP call. This is accepted: clients re-list tools.
  - Depends on fab ≥ 2.31.1 for the dropdown. It degrades gracefully on older fab.
- **Out of scope (H2):** tmux options, spawn-path `FAB_AGENT_PRESET`, the spawn-dialog agent-preset picker, `--agent-preset`, snapshots.

## Open Questions

- None blocking. The three plan-level open questions for H1 were asked and resolved (see Origin). Details left to apply are recorded as graded assumptions below (#11–#13 are the softest).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Scope is the H1 Brief only. H2 (tmux options, spawn-path env, agent-preset picker, `--agent-preset`, snapshots) is excluded | Plan step table + user instruction "implement only the H1 Brief" | S:95 R:85 A:95 D:95 |
| 2 | Certain | `riff_presets` settings key unchanged; `GET /api/riff/presets` path unchanged, response key → `riff_presets`; body field → `riff_preset`; CLI → `--riff-preset`/`--list-riff-presets`; MCP arg → `riff_preset`; dialog label "Riff preset" | Spelled out verbatim in the H1 Brief and the Key casing decision | S:95 R:75 A:95 D:95 |
| 3 | Certain | HexoKit reads presets only via `fab agent presets --json` and writes only `fab config set`/`unset agent.preset --system` through `internal/fabsysconfig`; no new routes | Plan decision "Who owns agent config"; Constitution III/IV/IX | S:95 R:80 A:95 D:95 |
| 4 | Certain | Old riff spellings become deprecated aliases for one minor release: hidden `MarkDeprecated` flags with a stderr notice, API dual-read (400 on disagreement), macro dual-read with re-projection to `riff_preset`, MCP straight rename (no alias), removal tracked by a backlog item | Asked — user chose "Deprecated aliases, 1 release (Recommended)" | S:95 R:75 A:90 D:95 |
| 5 | Certain | Choosing a preset never offers to clear overrides; a note shows how many explicit fields override parts of it; per-row reset links remain the way to clear | Asked — user chose "Note only, no offer (Recommended)" | S:95 R:85 A:90 D:95 |
| 6 | Certain | Palette action is a single `Settings: Agent preset…` entry that opens Settings on the Agents tab and focuses the dropdown; no extra fetch | Asked — user chose "Open Settings > Agent (Recommended)" | S:95 R:90 A:90 D:95 |
| 7 | Certain | Older or failing `fab agent presets` (non-zero exit, timeout, non-array JSON) means `agent_presets` is omitted, the dropdown and disclosure are hidden, and everything else on the tab is unchanged; setting `agent.preset` then gives a 400; the minimum fab version is not raised | H1 Brief "Older fab" bullet; the 400-on-write detail follows from "validate against that list before any exec" | S:85 R:80 A:85 D:80 |
| 8 | Certain | Preset-supplied leaves are detected by an `origin_detail` with the `"preset "` prefix, exposed as `preset` on Field/Cell, and never treated as an override (no `Override`, no reset link) | Verified against fab 2.31.1 output at intake; without this a system-chosen preset would render as explicit overrides whose reset unsets nothing | S:80 R:75 A:85 D:80 |
| 9 | Confident | New document field is snake_case `agent_presets` although older siblings are camelCase (`systemPath`, `modelSuggestions`) | Plan Key casing decision fixes JSON field casing as snake_case and is not to be reopened | S:75 R:70 A:75 D:70 |
| 10 | Confident | Dropdown "None" maps to `null` (unset → inherit); write validation accepts listed names plus fab's reserved `none` | Brief: "with None", "`null` unsets"; fab accepts `none` on set (probed) | S:75 R:85 A:80 D:70 |
| 11 | Confident | A current value of `none` (set from a shell) shows as an extra option `none (opts out of project presets)`; a stale name shows as `<name> (unknown)`; the dropdown never offers `none` otherwise | Keeps externally set values visible and clearable without adding a confusing second "no preset" choice | S:50 R:85 A:60 D:50 |
| 12 | Confident | Customize is collapsed by default when 0 fields are set explicitly and expanded when >0; its count includes both depth knobs and every role cell (system or env-shadowing, excluding preset-supplied) | Brief asks for the count but not the default state; expanding when overrides exist avoids hiding them | S:55 R:90 A:60 D:55 |
| 13 | Confident | The old-key macro migration writes back once on load in the new shape (`riff_preset`), rather than only on the next user edit | Either works with dual-read; writing back shortens the window the legacy reader must live | S:50 R:85 A:65 D:55 |
| 14 | Certain | `fab agent presets --json` runs concurrently with model discovery in `Read`, once per Read and once per write that sets `agent.preset`, with `Dir=$HOME` (machine-wide view, no project definitions) | Brief: "one `fab agent presets --json` call per Read"; existing wrapper's Dir=$HOME rule | S:80 R:85 A:80 D:75 |
| 15 | Confident | Old-spelling removal is tracked by an `idea` backlog entry created in this change | Needed to honor "for at least one release" without losing the cleanup; Constitution III says to use `idea` | S:65 R:90 A:75 D:70 |

15 assumptions (9 certain, 6 confident, 0 tentative, 0 unresolved).
