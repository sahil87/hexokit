# Plan: Settings > Agents — "Use a preset" and "Presets" (agent preset editor)

**Change**: 261124-arq5-agent-preset-settings-editor
**Intake**: `intake.md`

Authoritative references (read from `origin/main`, not the worktree copy): `git show origin/main:fab/plans/sahil/26-11-24-agent-preset-controls.md` (C2 Brief; Decisions + Rules bind) and `git show origin/main:docs/wiki/agent-preset-controls-studies.html` §§ 3–4 (layout/wording; the plan wins on conflict). The intake records the user's two intake decisions and the `--system` verification facts — read it in full.

## Requirements

### Backend: preset writes through `internal/fabsysconfig`

#### R1: Preset leaf keys in the patch path
`POST /api/fab-config` SHALL accept `agent_presets.<name>.<field>` keys, field ∈ `description`, `session`, `workers`, `profiles.<role>.cli`, `profiles.<role>.model`, `profiles.<role>.effort` (role ∈ `fabsysconfig.Roles`), and the whole-preset key `agent_presets.<name>` with value `null` only (→ `fab config unset agent_presets.<name> --system`). Every such key MUST be validated before any exec: name passes `validate.ValidateAgentPresetName`, is not `none`, and is not a built-in preset's name (`source == "built-in"` in the current `fab agent presets --json` list); session/workers/cli values ∈ the known tools; model/effort pass `checkFreeText`; description passes `checkFreeText` (single line, ≤ max length, not `-`-led, no `#`); an empty string is refused for description and treated as unset for the other leaves (existing profile-leaf convention). Writes stay sequential under `applyMu` and sorted as today. A `profiles.<role>.tool`/`provider` spelling inside a preset key is refused (fab only accepts `cli` inside presets).

- **GIVEN** fab lists `claude` as built-in
- **WHEN** the patch is `{"agent_presets.claude.description": "x"}`
- **THEN** the response is 400 and no fab command runs
- **AND** `{"agent_presets.night-shift.profiles.review.cli": "codex"}` runs exactly `fab config set agent_presets.night-shift.profiles.review.cli codex --system`

#### R2: Last-field guard
A patch whose unsets would leave a user preset with no remaining fields MUST be rejected with 400 ("a preset needs at least one setting — delete it instead"), because fab deletes a preset whose last leaf is unset (verified). The whole-preset `null` key is the only way to remove a preset.

- **GIVEN** preset `night-shift` whose only field is `description`
- **WHEN** the patch is `{"agent_presets.night-shift.description": null}`
- **THEN** the response is 400 and no fab command runs

#### R3: Duplicate
A single POST SHALL duplicate a listed preset (built-in or user) to a new valid, untaken name, writing every field of the source (description, session, workers, every `profiles.<role>.{cli,model,effort}` — taken from the `fab agent presets --json` entry) plus an optional description override; a non-empty description is required in the result. Writes run sequentially under `applyMu`.

- **GIVEN** built-in `codex-review` with `profiles.review.cli: codex`
- **WHEN** duplicating to `codex-review-copy` with description "Review on Codex, mine"
- **THEN** fab receives `set agent_presets.codex-review-copy.description …` and `set agent_presets.codex-review-copy.profiles.review.cli codex` and nothing else

#### R4: Rename (one request)
A single POST SHALL rename a user preset `from` → `to` in this order: (1) write every field of `from` to `to`; (2) if the system-layer `agent.preset` is `from`, set it to `to`; (3) on every server from `tmux.ListServers`, repoint `@rk_srv_agent_preset` and each session's `@rk_ses_agent_preset` equal to `from` to `to`; (4) `fab config unset agent_presets.<from> --system`. `to` must pass the name rules and be untaken; `from` must be a user (non-built-in) preset. Renaming to the same name is a no-op success.

- **GIVEN** `night-shift` is the machine default and group `hexokit` on server `default` names it
- **WHEN** renaming it to `late-shift`
- **THEN** `late-shift` exists with the same fields, `agent.preset` is `late-shift`, the `hexokit` session option is `late-shift`, and `night-shift` is gone

#### R5: Delete (one request)
A single POST SHALL delete a user preset: clear system `agent.preset` if it names the preset; clear every server/session agent-preset option naming it on the covered servers; then unset the whole preset. Built-ins are refused (400).

- **GIVEN** `night-shift` named by workspace option on server `default`
- **WHEN** deleting it
- **THEN** the server option is unset and `fab config unset agent_presets.night-shift --system` ran

#### R6: Partial-write reporting
Every multi-write operation (duplicate, rename, delete, leftovers move/clear) MUST stop at the first failing step and return a non-2xx error whose body names which steps landed and which step failed (fab has no multi-key transaction). Ordering is create-before-remove so a failure never loses both names. An env-origin `agent.preset` (daemon environment) cannot be repointed/cleared; the operation proceeds for the system layer and tmux options and the response carries a warning.

- **GIVEN** the second fab write of a rename fails
- **WHEN** the request returns
- **THEN** the error lists the first write as landed, names the failed write with fab's stderr, and the old preset was not unset

#### R7: Leftover settings move and clear
"Loose values" are explicit system-layer `agent.session`, `agent.workers`, `agent.profiles.<role>.<leaf>` (leaf ∈ tool/cli/provider/model/effort). A single POST `move` SHALL create preset `<name>` (valid, untaken, description required) holding the current machine default preset's fields (if `agent.preset` names a listed preset) overlaid with the loose values (legacy `tool`/`provider` written as `cli`), set system `agent.preset` to `<name>`, then unset each loose key. A single POST `clear` SHALL unset each loose key. Both run under `applyMu`.

- **GIVEN** machine default `codex-workers` (`workers: codex`) and loose `agent.profiles.review.tool: codex`, `agent.profiles.review.effort: xhigh`
- **WHEN** moving into `my-overrides`
- **THEN** `my-overrides` has `workers: codex`, `profiles.review.cli: codex`, `profiles.review.effort: xhigh`; `agent.preset` is `my-overrides`; both loose keys are unset

#### R8: On-demand resolution for the edited preset
The API SHALL return, on demand for one named listed preset, the per-role resolution from `fab agent <role> --preset <name> -o yaml` (each role in `Roles`, `Dir = $HOME`, `FabTimeout` each) as `{role: {cli, model, effort}}`; a role whose resolution errors is returned empty (never failing the request).

- **GIVEN** preset `codex-review`
- **WHEN** the editor opens it
- **THEN** the `review` row reports `cli: codex, model: gpt-5.6-sol, effort: xhigh` from fab

#### R9: Route contract
New endpoints MUST be `POST` (Constitution IX) for writes and `GET` for the resolution read, documented in `docs/specs/api.md` and memory. Chosen shape: `POST /api/fab-config/presets/duplicate` `{from, to, description?}`, `POST /api/fab-config/presets/rename` `{from, to}`, `POST /api/fab-config/presets/delete` `{name}`, `POST /api/fab-config/leftovers/move` `{name, description}`, `POST /api/fab-config/leftovers/clear` `{}`, `GET /api/fab-config/presets/resolve?name=<name>`. Successful writes return the re-read document (same shape as `POST /api/fab-config`) plus warnings. Error mapping reuses `writeFabConfigError` (400 validation, 503 fab absent, 502 fab failure).

- **GIVEN** a rename body with an invalid `to`
- **WHEN** POSTed
- **THEN** 400, no exec

### Frontend: Settings > Agents layout

#### R10: Four boxed sections
When fab lists presets, the Agents tab SHALL render, in order: **Leftover settings** (only while loose values exist), **Use a preset**, **Presets**, **Dispatch** (unchanged), each a bordered box with a header bar carrying the section title and the study's one-line job statement. "Use a preset" contains ONLY the machine default dropdown (existing `AgentPresetRow`, `data-testid="agent-preset-select"`, `id` used by `focusAgentPresetSelect`), relabelled "Machine default" with sub-label "used when a workspace or group does not pick its own", keeping provenance chip, reset link, env-shadow warning, the `none`/unknown options, and with the unset option labelled "None — fab's defaults". The Customize disclosure (`agent-customize`), the override note (`agent-preset-override-note`) and loose-value knob/role editing are removed. When fab cannot list presets (`agent_presets` absent), the panel keeps today's plain knobs + role table (no preset support exists to move into).

- **GIVEN** fab lists presets and no loose values exist
- **WHEN** the Agents tab opens
- **THEN** sections read "Use a preset", "Presets", "Dispatch" in that order and no Customize toggle exists

#### R11: Presets list
The Presets section SHALL show an "All presets" listbox of every machine-wide preset with per-item tags `default` (machine default) and `built-in`/`yours`, and "+ New preset" in the section header (disabled while a name form is open). Selecting an item opens it in the editor and closes any open form/confirm. Arrow keys move within the list. Below 640px the list stacks above the editor.

- **GIVEN** presets `claude`, `codex-review`, `codex-workers`, `night-shift` (system), machine default `night-shift`
- **WHEN** the section renders
- **THEN** `night-shift` carries `default` and `yours`, the others `built-in`

#### R12: Preset editor
The editor pane SHALL show "Editing <name>" with a `built-in · read-only`/`yours` tag and Rename/Duplicate/Delete buttons (Rename/Delete disabled for built-ins), then Description (commit on blur/Enter), Session CLI, Worker CLI, and the role table (role · tier · CLI · model · effort) writing `agent_presets.<name>.*` leaves through `POST /api/fab-config`, reusing today's role-table behavior (model lists incl. searchable list and Custom…, tool-default marker, effort capability and per-model efforts, tool-change model drop, stale-pin note). Unset fields show the applying value dimmed with `↳` — role rows from R8's resolution, depth knobs from the explicit non-preset `agent.session`/`agent.workers` value else `claude`. Built-ins render all controls disabled with "Built-in presets are read-only. Duplicate this one to change it."; user presets show "↳ means the field is not set and the value shown is what applies. Each change is saved as you make it." A usage note shows "Used by <list>." or "Not used anywhere yet." + " A change applies to the next stage dispatched in every tab launched with this preset." The UI MUST NOT offer an unset that would remove the last field (clearing the description when it is the only field is refused inline).

- **GIVEN** user preset `night-shift` open in the editor
- **WHEN** the review CLI is set to `codex`
- **THEN** the panel POSTs `{"agent_presets.night-shift.profiles.review.cli": "codex"}` and re-renders from the returned document

#### R13: Usage
The panel SHALL know where each preset is used: the machine default (`fields["agent.preset"]`), every workspace (server option) and group (session option) naming it — derived from the session/server state the SPA already receives (sessions and servers carry `agent_preset`) for the servers the client knows; usage lists read "the machine default", "workspace <server>", "group <session>".

- **GIVEN** group `hexokit` names `night-shift`
- **WHEN** `night-shift` is opened
- **THEN** the note reads "Used by group hexokit. A change applies …"

#### R14: Name form (New / Duplicate / Rename)
One inline form SHALL serve New ("New preset", Create), Duplicate ("Duplicate <name> as", Duplicate) and Rename ("Rename <name> to", Rename): name input (`aria-label="Preset name"`, placeholder "name, e.g. night-shift", maxlength 64, focused+selected on open), description input for New/Duplicate (`aria-label="Preset description"`), submit + Cancel; Enter submits, Escape cancels. Prefill: Duplicate `<name>-copy` (unique `-copy-2`…) + source description; Rename current name. Inline refusal messages: "Use letters, digits, - and _ only; no spaces." (identifier rule `^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`), `"none" is reserved; it means no preset.`, "A preset named <name> already exists.", and for an empty description on New/Duplicate "Add a one-line description; it is shown wherever the preset is picked." Rename of an in-use preset shows "Used by <list>; they follow the new name. Tabs already running under the old name fall back to the default." Backend errors show inline (`role="alert"`). On success the editor selects the new name.

- **GIVEN** the New form with name `night shift`
- **WHEN** submitted
- **THEN** the inline error "Use letters, digits, - and _ only; no spaces." shows and nothing is POSTed

#### R15: Delete confirm
Delete SHALL open an inline confirm (`role="alertdialog"`, `aria-label="Delete preset"`): "Delete <name>? It is used by <list>. Their choice is cleared, and tabs already running with it fall back to the default." (unused: "Delete <name>?") with Delete/Cancel. Confirm calls R5; afterwards the editor selects the first remaining preset.

- **GIVEN** unused user preset `p1`
- **WHEN** Delete → Delete
- **THEN** `POST /api/fab-config/presets/delete {"name":"p1"}` runs and `p1` leaves the list

#### R16: Leftover settings box
While loose values exist, the box SHALL list them in plain words ("N settings are set outside any preset: review CLI = codex, review effort = xhigh."), explain the real precedence ("They override the machine default, and fill in anything a group's or workspace's preset leaves unset."), and offer **Move into a new preset** (opens the name form prefilled with a unique `my-overrides` and description "Moved from loose machine-wide settings" → R7 move) and **Clear them** (inline confirm → R7 clear). When any group or workspace has its own preset, the Move/Clear confirmation names those groups/workspaces and lists which loose values each will stop inheriting (only loose values on fields that entity's preset leaves unset). The box disappears when no loose values remain. Env-origin values are not listed (they keep the env-shadow warning).

- **GIVEN** loose `review.effort = low` and group `hexokit` on `codex-review` (which sets only `review.cli`)
- **WHEN** Move is chosen
- **THEN** the confirmation names group hexokit and "review effort = low" as the value it stops inheriting

### Frontend: palette and keyboard

#### R17: Palette entries
The palette SHALL gain `Settings: Agent presets` (open Settings > Agents, scroll to the Presets section, focus the list), `Settings: New agent preset…` (same, with the New form open), and `Settings: Duplicate agent preset…`, `Settings: Rename agent preset…`, `Settings: Delete agent preset…` with a preset sub-step (Rename/Delete list user presets only) that open the section with that preset selected and the form/confirm open. Palette entries never write directly. Existing `Settings: Agent preset…` and C1's group/workspace preset actions stay unchanged.

- **GIVEN** the palette
- **WHEN** `Settings: New agent preset…` is chosen
- **THEN** Settings opens on Agents with the New form's name input focused

### Non-Goals

- Editing/overriding built-in presets; editing repo (project) presets; listing project presets in Settings.
- Changing a running tab's preset name or repointing running tabs.
- Any fab-kit change; any Dispatch settings change; any change to the C1 card chooser.

### Design Decisions

#### Preset definitions written only through `fab config --system`
**Decision**: Preset leaves and whole-preset removal are new keys on the existing `fabsysconfig` patch path; multi-write operations are server-side sequences under `applyMu`.
**Why**: Constitution III/IV — HexoKit never parses or rewrites fab's file; one mutex keeps fab's whole-file rewrites from racing.
**Rejected**: Client-side multi-write sequences (cannot report landed writes atomically or repoint tmux options in one request).
*Introduced by*: 261124-arq5-agent-preset-settings-editor

#### Dimmed values resolved by fab per edited preset
**Decision**: `fab agent <role> --preset <name> -o yaml` per role, fetched on demand for the preset open in the editor.
**Why**: Authoritative — matches what a tab launched with that preset gets, including loose values filling unset fields; avoids re-deriving fab's resolver.
**Rejected**: Deriving in TS from the loaded document (duplicates fab's precedence, which the intake found subtler than the plan assumed); resolving every preset on every read (6×N execs).
*Introduced by*: 261124-arq5-agent-preset-settings-editor

#### Loose values reframed as leftovers with honest precedence
**Decision**: The Customize grid is retired; existing loose values surface in a Leftover settings box with Move/Clear, whose confirmation discloses which groups/workspaces with their own preset lose inherited loose values.
**Why**: fab 2.31.1 applies loose values beneath any selected preset's unset fields (verified), so the plan's "lose to a group's preset" was inaccurate; the user chose disclosure over silence.
**Rejected**: Plain Move/Clear without disclosure; stopping C2 to revise the plan.
*Introduced by*: 261124-arq5-agent-preset-settings-editor

#### Description required for UI-created presets
**Decision**: New/Duplicate/Move require a non-empty description; the last remaining field of a preset cannot be unset.
**Why**: fab refuses empty values and deletes a preset whose last leaf is unset; description is the only behavior-neutral field.
**Rejected**: Copying machine default fields or writing a placeholder description.
*Introduced by*: 261124-arq5-agent-preset-settings-editor

### Deprecated Requirements

#### Customize disclosure for loose machine-wide values
**Reason**: Loose values are a third concept that overrides the machine default and leaks under every preset; editing moves to named presets.
**Migration**: Leftover settings box (Move into a new preset / Clear them); the role table lives on as the preset editor. Kept only when the installed fab cannot list presets.

#### Preset override note ("N explicit fields override parts of this preset — see Customize")
**Reason**: Its "see Customize" target is gone; the Leftover settings box replaces it.
**Migration**: Leftover settings box.

## Tasks

### Phase 1: Backend core

- [x] T001 In `app/backend/internal/fabsysconfig/fabsysconfig.go`, add preset-key recognition and validation to `validate`/`validateValue`: `isPresetKey` (name + field parsing incl. `profiles.<role>.<cli|model|effort>`), whole-preset `agent_presets.<name>` accepted only as `null`, name rules (`validate.ValidateAgentPresetName`, not `none`, not built-in), value rules (tools / `checkFreeText` / description non-empty), refusal of `tool`/`provider` inside presets; fetch the preset list under `applyMu` when the patch touches any preset key (extend `patchSetsPreset` gating); keep ops sorted. Named constants for the key prefix and fields. <!-- R1 -->
- [x] T002 In `fabsysconfig.go`, add the last-field guard: before exec, for each user preset touched by unsets, compute remaining fields from the listed preset (+ sets in the same patch) and reject with a ValidationError when none would remain (whole-preset `null` exempt). <!-- R2 -->
- [x] T003 In `fabsysconfig.go` (or a new sibling file `presets.go` in the same package if it keeps files focused), add operation methods `DuplicatePreset`, `RenamePreset`, `DeletePreset`, `MoveLeftovers`, `ClearLeftovers`: each validates fully before exec, holds `applyMu`, runs ordered steps (create-before-remove), and on failure returns a typed `PartialWriteError{Landed []string; Failed string; Stderr string}`; on success re-reads and returns the Document with warnings. Rename/Delete take a tmux repoint/clear callback interface (servers → server option / session options) so the package stays tmux-agnostic and testable; env-origin `agent.preset` yields a warning instead of a write. Leftover detection reuses `Field.Origin == "system"` (no `Preset`) and `Cell.Override`, mapping legacy tool leaves to `cli`. <!-- R3, R4, R5, R6, R7 -->
- [x] T004 In `fabsysconfig.go`, add `ResolvePreset(ctx, name)` running `fab agent <role> --preset <name> -o yaml` per role in `Roles` (`Dir = $HOME`, `FabTimeout` each, through the `Runner` seam), decoding `cli`/`model`/`effort`; per-role errors yield empty entries. <!-- R8 -->
- [x] T005 Go tests in `app/backend/internal/fabsysconfig/fabsysconfig_test.go` (fake `Runner`): preset-key validation table (valid leaves, `none`, built-in name, bad charset, leading `-`, unknown field/role, `tool` leaf in preset, unknown CLI, empty description, whole-preset non-null), exact argv and ordering, last-field guard, duplicate from built-in, rename/delete with machine-default repoint/clear and fake tmux callback, move (overlay + legacy `tool`→`cli` + default repoint + loose unset) and clear, partial-write reports on a failing step, env-origin `agent.preset` warning, resolve decoding + per-role error tolerance. <!-- R1, R2, R3, R4, R5, R6, R7, R8 -->

### Phase 2: API routes

- [x] T006 In `app/backend/api/fab_config.go` add handlers for `POST /api/fab-config/presets/{duplicate,rename,delete}`, `POST /api/fab-config/leftovers/{move,clear}` and `GET /api/fab-config/presets/resolve?name=`; implement the tmux repoint/clear callback with `s.tmux.ListServers` and the existing agent-preset option wrappers (`ListSessions`/session option getters, `SetServerAgentPreset`/`UnsetServerAgentPreset`, `SetSessionAgentPreset`/`UnsetSessionAgentPreset`) — no inline tmux construction; map `PartialWriteError` to 502 with a body listing landed/failed steps; register routes in `app/backend/api/router.go`. Charset-validate names before any subprocess. <!-- R4, R5, R6, R9 -->
- [x] T007 API tests in `app/backend/api/fab_config_test.go` (existing test style, injected `fabSys` + tmux fakes): route registration and verbs, body validation 400s, rename/delete repointing group and workspace options across two fake servers, partial-write 502 body, resolve GET. <!-- R4, R5, R6, R9 -->

### Phase 3: Frontend

- [x] T008 In `app/frontend/src/api/client.ts` add typed calls `duplicateAgentPreset`, `renameAgentPreset`, `deleteAgentPreset`, `moveLeftoverSettings`, `clearLeftoverSettings`, `resolveAgentPreset`, sharing the existing fab-config error handling; types for the resolution and partial-write error. <!-- R9 -->
- [x] T009 Restructure `app/frontend/src/components/settings-agents-panel.tsx` into boxed sections (a small `SettingsSection` box with header title + job line), move `AgentPresetRow` into "Use a preset" relabelled "Machine default" (None label "None — fab's defaults"), delete `CustomizeDisclosure`, `PresetOverrideNote`, `presetOverrideCount`, `explicitCount` usage; keep the no-presets fallback rendering today's knobs + role table. To avoid a god file, put the presets list/editor/name form/leftovers in a new sibling `app/frontend/src/components/settings-agent-presets.tsx` (reusing exported role-table pieces from the panel or a shared module). <!-- R10 -->
- [x] T010 Implement the Presets list (listbox, tags, arrow keys, selection state, "+ New preset" header button) and responsive grid (two columns ≥ 641px, stacked below) in `settings-agent-presets.tsx`. <!-- R11 -->
- [x] T011 Implement the editor pane: header + tag + ops, Description (commit on blur/Enter), Session/Worker CLI selects, role table re-targeted to `agent_presets.<name>.profiles.<role>.{cli,model,effort}` by building `FabRoleCell`-shaped cells from the preset (override = preset value) and the R8 resolution (inherited), read-only for built-ins, the two notes, last-field guard, lazy `resolveAgentPreset` fetch per opened preset (refetched after a write to that preset). <!-- R8, R12 -->
- [x] T012 Implement usage derivation (machine default + server/session `agent_preset` from the SPA's existing session/server state) and the usage note wording. <!-- R13 -->
- [x] T013 Implement the inline name form (New/Duplicate/Rename) with prefill, validation messages, description-required, rename in-use note, backend error display, Enter/Escape, focus+select on open, and success selection. <!-- R14 -->
- [x] T014 Implement the delete confirm with usage wording and post-delete selection. <!-- R15 -->
- [x] T015 Implement the Leftover settings box: loose-value detection from the document (system-origin non-preset fields/cells incl. legacy tool leaves), plain-words list, precedence line, Move (name form prefilled `my-overrides`/"Moved from loose machine-wide settings") and Clear (confirm), and the per-group/workspace disclosure computed from usage + each entity's preset fields (only loose values on fields that preset leaves unset). <!-- R16 -->
- [x] T016 Palette: in `app/frontend/src/hooks/use-global-palette-actions.ts` add the five entries (sub-step for duplicate/rename/delete from the machine preset list, rename/delete user presets only) and a module-level intent seam (like `focusAgentPresetSelect`) the presets section consumes on mount to focus the list / open the form or confirm for a named preset. <!-- R17 -->

### Phase 4: Tests, demos, docs

- [x] T017 Vitest: update `app/frontend/src/components/settings-agents-panel.test.tsx` (remove Customize assertions, add section layout/headers, Machine default relabel, no-presets fallback) and add `settings-agent-presets.test.tsx` covering list tags, editor writes, read-only built-ins, dimmed resolution, last-field guard, name-form messages, description required, rename/delete wording, leftovers + disclosure. Add palette-entry tests next to existing palette tests. <!-- R10, R11, R12, R13, R14, R15, R16, R17 -->
- [x] T018 e2e: update `app/frontend/tests/e2e/_fab-config-stub.ts` (stateful preset table, new routes, resolve, loose values) and `settings-agents.spec.ts` (replace Customize-grid tests; add create/edit/duplicate/rename/delete and leftover move/clear flows, desktop + mobile stacking); check `surface-layout.spec.ts`'s "Customize" match. JSDoc Proves/Steps intent comments per the constitution. <!-- R10, R11, R12, R14, R15, R16 -->
- [x] T019 Demo specs: update Agents demos that drive the Customize grid (`app/frontend/tests/demo/agent-preset-dropdown.demo.ts`, `agents-settings*.demo.ts`, `agents-model-list.demo.ts`, `agents-effort-capability.demo.ts`, `agents-tool-default.demo.ts` — retarget them to the preset editor) and add `agent-presets-editor.demo.ts` showing create → edit → duplicate → rename → delete and leftovers; verify they run under `just demo` (desktop + mobile). <!-- R10, R12, R16 -->
- [x] T020 Spec: document the new routes and body contracts in `docs/specs/api.md` (fab-config section). <!-- R9 -->
- [x] T021 Run the verification gates via `just` recipes (`just test-backend`, `just test-frontend`, frontend type check, relevant `just test-e2e`/`just pw test settings-agents`, `just build`); fix failures. If the shared Control primitive was touched, regenerate control-gallery baselines. <!-- R1, R10 -->

### Phase 5: Review rework (cycle 1)

- [x] T022 Key the editor by preset name in `app/frontend/src/components/settings-agent-presets.tsx` (`<PresetEditor key={current.name} …>`) so description/custom-model drafts and row errors never carry to another preset; add a Vitest test in `settings-agent-presets.test.tsx` that opens a description draft on one preset, selects another, and asserts the second shows its own description and no write targets it. <!-- R12 -->
- [x] T023 Run the create → edit → duplicate → rename → delete e2e flow (`app/frontend/tests/e2e/settings-agents.spec.ts`) at the 375px mobile viewport as well as desktop (parameterise the existing test over both viewports; keep Proves/Steps comments accurate). <!-- R14 -->
- [x] T024 In `app/backend/api/fab_config.go` `tmuxPresetBindings.List`, stop swallowing per-server `GetServerAgentPreset`/`ListSessions` errors: return the error (tolerating only the "server gone" case the tmux wrappers already classify) so rename/delete stop before any write; map a binding-list/tmux failure to 502 consistently with `docs/specs/api.md`. Add API tests. <!-- R4, R5, R6 -->
- [x] T025 In `app/backend/internal/fabsysconfig/presets.go` `checkPresetName` (patch path), refuse writes to a LISTED preset whose source is not `system` (built-in, env, project); unlisted names (New) stay allowed. Also refuse a preset key with an empty field after the dot (`agent_presets.foo.`). Add Go tests. <!-- R1 -->
- [x] T026 Extract one parameterised `ConfirmBar` (label, message, verb, busy/error, Escape, Cancel autofocus) into `app/frontend/src/components/settings-agent-preset-forms.tsx` and use it for both `DeleteConfirm` and the leftovers `ClearConfirm` (`settings-agent-leftovers.tsx`); replace the duplicate `ResolvedRoles` type in `app/frontend/src/lib/agent-presets-editor.ts` with the client's `FabResolvedRoles`. Keep tests green. <!-- R15, R16 -->
- [x] T027 Re-run gates via `just` (`just test-backend`, `just test-frontend`, `npx tsc --noEmit`, `just test-e2e settings-agents`, `just build`). <!-- R1, R10 -->

## Execution Order

- T001–T004 before T006; T006 before T008; T008 before T009–T016.
- T009 (section restructure + new file) precedes T010–T015.
- T017–T019 after the frontend tasks; T021 last among T001–T021.
- Phase 5 (T022–T026) in any order; T027 last.

## Acceptance

### Functional Completeness

- [x] A-001 R1: `agent_presets.<name>.<field>` leaves and whole-preset `null` are accepted, validated before exec, and written via `fab config set|unset … --system`; built-in names, `none`, bad charset, unknown fields/roles, `tool` leaves and empty descriptions are refused with 400.
- [x] A-002 R2: An unset that would empty a user preset is rejected with 400 and no exec.
- [x] A-003 R3: Duplicate copies every field of the source (incl. built-ins) to the new name in one request.
- [x] A-004 R4: Rename writes the new preset, repoints system `agent.preset` and every matching server/session option, then removes the old preset — in that order, in one request.
- [x] A-005 R5: Delete clears the machine default and matching server/session options, then unsets the preset; built-ins refused.
- [x] A-006 R7: Move creates the overlay preset (legacy tool → cli), makes it the machine default, and unsets the loose keys; Clear unsets the loose keys.
- [x] A-007 R8: The resolve endpoint returns per-role cli/model/effort from `fab agent <role> --preset <name> -o yaml`, tolerating per-role errors.
- [x] A-008 R9: The six routes exist with the documented verbs and bodies and are documented in `docs/specs/api.md`.
- [x] A-009 R10: The Agents tab shows Leftover settings (conditional) → Use a preset → Presets → Dispatch as boxed sections with header job lines; no Customize disclosure or override note remains when presets are supported.
- [x] A-010 R11: The list shows every machine preset with `default` and `built-in`/`yours` tags; "+ New preset" sits in the section header.
- [ ] A-011 R12: The editor reads and writes `agent_presets.<name>.*` with no Save button, dims unset fields with `↳` values, and is read-only for built-ins with the study's notes. <!-- review: not met — PresetEditor is not keyed by preset name, so a description (or custom model) draft typed for one preset survives switching to another and can be committed to it (settings-agent-presets.tsx:220) -->
- [x] A-012 R13: The usage note names the machine default, workspaces and groups that use the preset.
- [x] A-013 R14: The name form handles New/Duplicate/Rename with the specified prefill, messages and description requirement.
- [x] A-014 R15: Delete confirms with the usage wording before deleting.
- [x] A-015 R16: The Leftover box lists loose values, states the real precedence, offers Move/Clear, discloses affected groups/workspaces, and disappears when none remain.
- [x] A-016 R17: The five palette entries exist and open the section/form/confirm without writing.

### Behavioral Correctness

- [x] A-017 R10: The machine default dropdown keeps its provenance chip, reset link, env-shadow warning and `none`/unknown options under its new "Machine default" label; `Settings: Agent preset…` still focuses it.
- [x] A-018 R12: Role-table behaviors carried over (model lists, searchable list, Custom…, tool-default marker, effort capability, tool-change model drop, stale-pin note) work against preset leaves.

### Removal Verification

- [x] A-019 R10: `CustomizeDisclosure`, `PresetOverrideNote`, `presetOverrideCount` and the loose-value editing UI are gone (no dead code), except the documented no-presets fallback.

### Scenario Coverage

- [x] A-020 R4: A Go test renames a preset used by the machine default, a workspace and a group across two servers and asserts every repoint.
- [x] A-021 R7: A Go test moves loose values (incl. a legacy `tool` leaf) over a machine default preset and asserts the resulting preset, default and unsets.
- [ ] A-022 R14: e2e covers create → edit → duplicate → rename → delete on desktop and mobile. <!-- review: not met — the flow test runs at the default desktop viewport only; mobile has only the stacking/overflow test -->
- [x] A-023 R16: e2e covers leftover Move and Clear, including the disclosure when a group has its own preset. <!-- review: e2e exercises the disclosure through a workspace's own preset; the group path is covered in settings-agent-presets.test.tsx -->

### Edge Cases & Error Handling

- [x] A-024 R6: A mid-operation fab failure returns 502 naming landed and failed steps, never removes the old preset before the new one exists, and the panel re-reads and shows the error inline.
- [x] A-025 R6: An env-origin `agent.preset` is not written; the response and panel carry a warning.
- [x] A-026 R8: A preset naming a CLI without dispatch capability renders blank dimmed values without breaking the panel.
- [x] A-027 R10: With a fab that cannot list presets, the panel renders the knobs and role table as before.

### Code Quality

- [x] A-028 Pattern consistency: New code follows naming and structural patterns of surrounding code (fabsysconfig validation/op style, panel row/write patterns, palette entry style).
- [x] A-029 No unnecessary duplication: Existing utilities reused — `ValidateAgentPresetName`, `checkFreeText`, tmux agent-preset wrappers, role-table components, `useRowWrite`.
- [x] A-030 Subprocess safety: every new exec uses `exec.CommandContext`/the `Runner` seam with `FabTimeout` and argv slices; names validated before any exec (Constitution I).
- [x] A-031 Durable before acknowledged: every operation's writes reach fab/tmux before the request succeeds; no in-memory-only state (Constitution II).
- [x] A-032 No god functions: new Go and TSX functions stay focused; the presets UI lives in its own component file rather than growing `settings-agents-panel.tsx`.
- [x] A-033 No comment narration or change-ID citations in code comments.
- [x] A-034 Keyboard-first: every new control is keyboard-reachable and registered via the palette entries (Constitution V).
- [x] A-035 Tests: Go, Vitest and e2e cover the new behavior; e2e tests carry Proves/Steps intent comments; tests never touch the real `~/.fab-kit/config.yaml`.

### Security

- [x] A-036 R1: Preset names and values reach fab only as argv elements after validation (no leading `-`, identifier charset), never via shell strings.

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`
- PR evidence (before/after `just demo` recordings, desktop + mobile) is produced at ship, not apply; apply must leave the demo specs runnable.

## Deletion Candidates

- `app/frontend/src/components/settings-agent-leftovers.tsx:39` `ClearConfirm` — near-copy of `DeleteConfirm` (`settings-agent-preset-forms.tsx:136`): same alertdialog shell, Escape handling, busy/error state and Cancel focus; one parameterised confirm bar would replace both.
- `app/frontend/src/lib/agent-presets-editor.ts:139` `ResolvedRoles` — structurally identical to `FabResolvedRoles` in `api/client.ts`; use the client type.

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | Route shape: `POST /api/fab-config/presets/{duplicate,rename,delete}`, `POST /api/fab-config/leftovers/{move,clear}`, `GET /api/fab-config/presets/resolve?name=` | Constitution IX (POST, intent in path); keeps the base `POST /api/fab-config` patch contract unchanged | S:60 R:75 A:70 D:55 |
| 2 | Confident | Usage is derived client-side from session/server `agent_preset` already in the SPA state, while rename/delete repoint server-side over `tmux.ListServers` | The SPA already receives these fields (C1); server-side repoint must cover every server regardless of what the client shows | S:65 R:80 A:70 D:60 |
| 3 | Confident | When fab cannot list presets, the panel keeps today's knobs + role table | No preset support means nothing to move loose values into; retiring the only editor would strand users | S:60 R:85 A:75 D:65 |
| 4 | Confident | Presets UI goes in a new `settings-agent-presets.tsx`, reusing role-table pieces | `settings-agents-panel.tsx` is already 1.4k lines; code-quality anti-pattern on god files | S:70 R:90 A:80 D:70 |
| 5 | Confident | A partial write maps to 502 with landed/failed steps in the body | Mirrors the existing fab-failure mapping (502 carries fab stderr) | S:65 R:85 A:75 D:65 |
| 6 | Confident | Move's preset description is required and prefilled "Moved from loose machine-wide settings"; default name `my-overrides` made unique | Study wording + intake decision #2 (description required) | S:75 R:90 A:80 D:75 |
| 7 | Confident | The editor and backend treat any preset whose `source` is not `system` (built-in or env) as read-only; Duplicate stays available; rename/delete refuse a non-system source with "only presets in your machine config can be changed" | An env-defined preset cannot be edited through `fab config --system`; intake open question 2 | S:70 R:85 A:75 D:70 |
| 8 | Confident | In the editor a set role CLI cell's dimmed `inherited` is the preset's depth knob (else the explicit non-preset knob, else `claude`); a set model/effort cell shows "tool default" for what clearing restores | One resolution per role only reports the winning value; reading the cleared value would need a second fab call per leaf | S:60 R:90 A:70 D:65 |
| 9 | Confident | The last-field guard runs in the editor's write wrapper (inline error on the row, no request) as well as in the backend (400) | Plan R12 "MUST NOT offer an unset that would remove the last field"; backend remains the authority | S:75 R:90 A:85 D:75 |
| 10 | Confident | Usage and the leftover disclosure read the streamed `servers` and `sessionsByServer` the dialog already has, so a group on a server the tab has not attached is not counted; rename/delete still repoint every covered server | Plan assumption 2; attaching every server from Settings would open subscriptions for a note | S:65 R:85 A:70 D:60 |
| 11 | Confident | Disclosure rules: an entity whose preset is `none` loses every loose value; a name fab does not list is ignored (fab ignores it); a group inheriting a workspace's preset is covered by the workspace's entry | fab resolves `none` as no preset and ignores unknown selectors (verified at intake) | S:65 R:85 A:70 D:60 |
| 12 | Confident | Palette Duplicate lists every machine preset; Rename and Delete list only `source: system` presets; sub-step rows load lazily from the cached machine list, which the panel invalidates after every change | Plan R17; keeps the lists honest after an edit | S:70 R:90 A:80 D:70 |
| 13 | Confident | The other Agents demo specs (settings, model list, effort capability, tool default, provenance) keep their no-presets stub and so record the retained plain role table; only `agent-preset-dropdown` (which drove Customize) is rewritten and a presets-editor demo added | Only that demo exercised the retired Customize disclosure; rewriting the rest would break `--before` comparability | S:60 R:85 A:70 D:60 |
| 14 | Confident | The delete confirm and the leftover Clear confirm focus Cancel on open | A destructive Enter should never be the default after a palette hand-off | S:60 R:95 A:75 D:70 |
| 15 | Confident | `GET /api/fab-config/presets/resolve` validates only the name's charset (no list lookup): an unlisted name resolves every role empty | Avoids a second fab call; per-role errors already degrade to blank | S:60 R:90 A:75 D:70 |
| 16 | Confident | Values copied by duplicate/rename/move are re-checked with the free-text rule but not against the tool set | fab does not validate CLI names inside a preset, so a user preset naming an unlisted CLI must still be duplicable | S:65 R:85 A:75 D:65 |
| 17 | Confident | In presets mode the e2e stub starts with no explicit session CLI (it would be a leftover setting) and answers the new routes | Keeps the leftover box out of unrelated presets specs | S:70 R:95 A:80 D:75 |

17 assumptions (0 certain, 17 confident, 0 tentative).
