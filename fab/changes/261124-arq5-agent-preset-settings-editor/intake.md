# Intake: Settings > Agents — "Use a preset" and "Presets" (agent preset editor)

**Change**: 261124-arq5-agent-preset-settings-editor
**Created**: 2026-11-24

## Origin

> Execute step C2 (Settings > Agents: "Use a preset" and "Presets" sections; create, edit, duplicate, rename and delete presets; Customize grid retired with a leftover-settings path) of the plan at /home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-preset-controls.md. IMPORTANT: your worktree copy of the plan and design study may be stale (revised in #1202 on main). Run `git fetch origin`, read the plan with `git show origin/main:fab/plans/sahil/26-11-24-agent-preset-controls.md` and the study with `git show origin/main:docs/wiki/agent-preset-controls-studies.html`, and treat those as authoritative. Read the whole plan first (Decisions and Rules bind you), then implement only the C2 Brief.
>
> After /fab-new creates the change, run `fab status set-base-branch <new-change> 261124-hsob-agent-preset-card-controls`.

One-shot `/fab-new` from an operator-queued plan step. **Authoritative sources** (read them at apply, from `origin/main`, not the worktree copy):

- Plan: `git show origin/main:fab/plans/sahil/26-11-24-agent-preset-controls.md` — its **Decisions** table and **Rules** bind this change; only the **C2 Brief** is in scope. Where the plan and the design study disagree, the plan wins (plan Rule 7).
- Design study: `git show origin/main:docs/wiki/agent-preset-controls-studies.html` § 3 (clickable Settings mock) and § 4 — the reference for layout and wording.

**Base branch**: this change stacks on C1 (`261124-hsob-agent-preset-card-controls`, plan dependency C1 ── C2). The worktree branch was cut from C1's tip (`2dd68bb1`).

Two questions were asked at intake and answered by the user (see Assumptions #1, #2):

1. **Leftover-settings precedence discrepancy** (found by the `--system` verification below) → **"Disclose and proceed"**: build Move/Clear as planned, correct the wording to fab's real precedence, and when any group or workspace has its own preset, the Move/Clear confirmation names them and says which loose values they stop inheriting.
2. **New preset with a blank description** → **"Require a description"**: the New form refuses an empty description inline; the editor likewise refuses clearing the last remaining field of a preset.

## Why

Agent presets work, but the UI for them is thin (plan § Problem):

- **You cannot make a preset in the UI.** fab ships three (`claude`, `codex-workers`, `codex-review`); anything else means hand-editing `agent_presets` in `~/.fab-kit/config.yaml`.
- **Settings > Agents mixes three ideas.** It picks the machine preset (the Agent preset dropdown), and its **Customize** grid sets loose machine-wide values (`agent.session`, `agent.workers`, `agent.profiles.<role>.*`) that belong to no preset. Those loose values override the machine default and — as verified at this intake — still fill in whatever a group's or workspace's preset leaves unset. That is hard to predict and hard to explain.

If not fixed: users keep hand-editing fab's YAML (risking HexoKit's "never parse or rewrite fab's file" stance only by proxy), and loose values keep silently altering every preset's effective result.

**Approach** (plan Decisions, not reopened): *selecting* a preset is only ever a selection (spawn dialog, group/workspace card chooser from C1, and Settings "Use a preset"); *defining* a preset happens in exactly one place — Settings > Agents "Presets". The Customize grid's role table is retired as a way to set loose values and reborn as the preset editor. Existing loose values get a one-time "Leftover settings" path (move into a preset, or clear) so nobody's behavior changes silently. All writes go through `fab config set|unset --system` (Constitution III/IV).

## What Changes

### 1. Page layout (Settings dialog → Agents tab, `app/frontend/src/components/settings-agents-panel.tsx`)

Separate **boxed sections**, each with a header bar stating its job, in this order (study § 3 `.sec` / `.sec-h` boxes):

1. **Leftover settings** — only while loose machine-wide values exist (§ 6 below). Header text: "Leftover settings" + small "From the old Customize grid. This box goes away once they are moved or cleared."
2. **Use a preset** — header "Use a preset" + small "Pick which preset this machine uses. Nothing here changes what a preset contains." Contains ONLY the existing Agent preset dropdown (`AgentPresetRow`, `data-testid="agent-preset-select"`), relabelled **"Machine default"** with sub-label "used when a workspace or group does not pick its own". Keep its provenance chip, reset link and env-shadow warning exactly as today. Option labels follow the study: `None — fab's defaults` for unset, and `<name> — <description>` per preset (keep the existing `none (opts out of project presets)` reserved option).
3. **Presets** — header "Presets" + small "Create, edit and delete presets. Nothing here changes which preset is in use." + a **"+ New preset"** button in the header (disabled while a name form is open). Body: an **"All presets"** list pane beside an **"Editing <name>"** pane (§ 2).
4. **Dispatch** — unchanged.

Remove: the **Customize** disclosure (Session CLI, Worker CLI, role table as loose-value editors) and the **override note**. The role table components (`RoleTable`, `RoleRow`, `RoleSelect`, `RoleModelCell`, `SearchableModelList`, `CustomModelInput`, `StaleModelNote`, `toolChangePatch`, effort helpers) are **reused** by the editor, re-targeted from `agent.profiles.<role>.*` to `agent_presets.<name>.profiles.<role>.*`.

**Phone layout**: the list and editor are a two-column grid (`220px minmax(0,1fr)` in the study) that **stacks to one column at ≤640px** (list above editor), per the study's `@media (max-width: 640px)` rule; the role table keeps its existing horizontal-scroll wrapper (`role-table-wrap`).

### 2. The Presets list and editor

**List pane** ("All presets", `role="listbox"`, items `role="option"` with `aria-selected`): every **machine-wide** preset from `fab agent presets --json` run with `Dir = $HOME` (as today) — built-ins and the user's (`source: system`; an `env`-source preset is listed read-only). Each item shows the name plus tags: `default` when it is the machine default, and `built-in` or `yours`. Repo-scoped (project) presets are **not** listed (Settings is machine-scoped; editing project presets is a plan non-goal; with `Dir = $HOME` they never appear anyway). Selecting an item opens it in the editor and closes any open name form or delete confirm.

**Editor pane** header: `Editing <b>name</b>` + a tag (`built-in · read-only` or `yours`) + ops buttons **Rename**, **Duplicate**, **Delete** (Rename and Delete disabled for built-ins). Body:

- **Description** (`agent_presets.<name>.description`) — label "Description", sub-label "shown wherever a preset is picked". Text input, written on commit (blur/Enter), like the page's other commit-on-change fields.
- **Session CLI** (`agent_presets.<name>.session`) and **Worker CLI** (`agent_presets.<name>.workers`) — selects over the known tools (`doc.tools`) with an unset `↳ <what applies>` option.
- **Role table** — role · tier · CLI · model · effort for roles `default`, `operator` (session tier) and `doing`, `review`, `hydrate`, `fast` (workers tier), writing `agent_presets.<name>.profiles.<role>.{cli,model,effort}`. Keeps today's model lists (suggestions, searchable list over 30, Custom…, tool-default marker), effort rules (`effortCapable`, per-model efforts), tool-change behavior (`toolChangePatch` drops a model the new CLI doesn't offer), and stale-pin note. **Note the leaf name**: inside a preset fab accepts only `cli` — `profiles.<role>.tool` is refused as an unknown key (verified), unlike `agent.profiles.<role>.tool`.
- **Unset fields** show the value that applies, dimmed with `↳`, as the table does today (§ 3 explains the source).
- **No Save button**: each field change is one write, as today. Built-ins render every control `disabled` with the note "Built-in presets are read-only. Duplicate this one to change it."; yours show "↳ means the field is not set and the value shown is what applies. Each change is saved as you make it."
- **Usage note**: "Used by <the machine default, workspace <server>, group <session>, …>." or "Not used anywhere yet." followed by "A change applies to the next stage dispatched in every tab launched with this preset." Usage = system `agent.preset`, every `@rk_srv_agent_preset` and `@rk_ses_agent_preset` naming it on the servers the daemon covers (the same enumeration rename/delete use, § 5).
- **Last-field guard** (user decision #2): fab deletes a preset whose last leaf is unset (verified). The editor refuses an unset that would leave the preset with no fields, inline: the description cannot be cleared when it is the only field, and the backend rejects such a patch with a 400 naming the reason ("a preset needs at least one setting — delete it instead"). Since New requires a description, a UI-made preset always starts with one.

### 3. Dimmed "what applies" values for the edited preset (plan open decision 1)

Resolve authoritatively through fab rather than reimplementing its resolver (Constitution III): for the preset open in the editor, run `fab agent <role> --preset <name> -o yaml` once per role (six roles; bounded, each under `FabTimeout`, `Dir = $HOME`), and use each result's `cli`, `model`, `effort` as the dimmed `↳` values. Verified to work in fab 2.31.1 (e.g. `fab agent review --preset codex-review -o yaml` → `cli: codex`, `model: gpt-5.6-sol`, `effort: xhigh`, with `source:` per field). This is exactly what a tab launched with that preset gets — including loose values filling unset fields — because `--preset` resolves like `FAB_AGENT_PRESET`.

- A resolution that errors (verified case: a preset naming a CLI with no dispatch capability → `no dispatch mode is available`) leaves that row's dimmed values blank/"unknown" — never fails the panel.
- Session CLI / Worker CLI dimmed values: what applies when the preset leaves the depth knob unset — the explicit env/system `agent.session` / `agent.workers` value when one exists (a non-preset origin), else fab's default `claude` (only one preset applies at a time, so the machine default preset's own knob does NOT show through — verified).
- Transport: fetched on demand for the edited preset only (not for every preset on every read), e.g. `GET /api/fab-config?preset=<name>` adding a `preset_resolved` block, or a sibling GET.

### 4. New, Duplicate, Rename — one inline name form

One inline form (study `.form`) with a name input (`placeholder="name, e.g. night-shift"`, `maxlength=64`, `aria-label="Preset name"`), a description input for New/Duplicate (`aria-label="Preset description"`), a submit button (Create / Duplicate / Rename) and Cancel. Titles: "New preset", "Duplicate <name> as", "Rename <name> to". Enter submits, Escape cancels; the name input is focused and selected on open.

- **Prefill**: Duplicate → name `<name>-copy` (made unique `-copy-2`, …) and the source's description; Rename → the current name; New → empty.
- **Name rules** (checked in the SPA for the inline message AND re-checked by the backend before any exec): the strict identifier rule riff preset names use — `validate.ValidateAgentPresetName` → `ValidateIdentifier` (`^[a-zA-Z0-9_][a-zA-Z0-9_-]*$`, ≤ 64 chars); not `none`; not already taken by any listed preset (built-in or yours). Inline reasons (study wording): "Use letters, digits, - and _ only; no spaces." · `"none" is reserved; it means no preset.` · "A preset named <name> already exists." Note fab itself accepts a leading `-` and mixed case; HexoKit's rule is stricter (leading `-` refused — it would reach argv), mixed case allowed.
- **Description required for New** (user decision #2): an empty description is refused inline — "Add a one-line description; it is shown wherever the preset is picked." Duplicate keeps the copied description (also required non-empty; a source without one must be given one). Rename has no description field.
- **New** writes `agent_presets.<name>.description` (one write).
- **Duplicate** copies every field of the source (description, session, workers, every `profiles.<role>.{cli,model,effort}`) to the new name, from the `fab agent presets --json` entry (which carries full contents — verified). Works from built-ins (the way to change one).
- **Rename** (yours only) is **one backend request**: (1) write every field to the new name; (2) repoint system `agent.preset` if it named the old name; (3) repoint every `@rk_srv_agent_preset` and `@rk_ses_agent_preset` equal to the old name on every server the daemon covers (`tmux.ListServers` → server option + each session option); (4) unset the old preset (`fab config unset agent_presets.<old> --system`). Create-before-remove ordering means a mid-way failure leaves both names rather than neither. When the preset is in use the form shows: "Used by <…>; they follow the new name. Tabs already running under the old name fall back to the default." Submitting a rename to the same name just closes the form.

### 5. Delete

Yours only. Asks first via an inline confirm (`role="alertdialog"`, `aria-label="Delete preset"`): "Delete **<name>**? It is used by <…>. Their choice is cleared, and tabs already running with it fall back to the default." (or the plain question when unused), buttons Delete (danger) / Cancel. On confirm, one backend request: clear system `agent.preset` if it names it; clear every `@rk_srv_agent_preset` / `@rk_ses_agent_preset` naming it on the covered servers; then `fab config unset agent_presets.<name> --system`. After delete the editor selects the first remaining preset.

If `agent.preset` is set in the **daemon's environment** (env origin) it cannot be repointed or cleared by HexoKit — the operation proceeds for the system layer and tmux options and the response carries a warning the panel shows (the existing env-shadow vocabulary).

### 6. Leftover settings (Customize grid retired)

**Loose values** = explicit **system-layer** `agent.session`, `agent.workers` and `agent.profiles.<role>.<leaf>` keys (leaf ∈ `tool`/`cli`/`provider`/`model`/`effort` — the legacy spellings `tool`/`provider` included). The document already distinguishes them: `Field.Origin == "system"` without `Preset`, and `Cell.Override != nil`. Env-origin values are NOT leftovers; they keep the existing env-shadow warning.

While any loose value exists, the box lists them in plain words (e.g. "2 settings are set outside any preset: review CLI = codex, review effort = xhigh.") with two actions:

- **Move into a new preset** — asks for a name (same inline name form and rules, prefilled with a unique default such as `my-overrides`, description prefilled "Moved from loose machine-wide settings"). One backend request: create a preset holding the **current machine default preset's fields overlaid with the loose values** (legacy `tool`/`provider` leaves written as the preset's `cli`), set system `agent.preset` to it, then unset the loose keys. Machine-wide result is unchanged (no group/workspace preset ⇒ same effective values).
- **Clear them** — asks first, then unsets the loose keys.

**Precedence disclosure** (user decision #1). Verified in fab 2.31.1 under an isolated home:

| Situation | What wins |
|---|---|
| Loose system value vs the machine default preset (system `agent.preset`) | the loose value (e.g. loose `agent.workers: codex` beat `p1.workers: claude`) |
| A group/workspace preset (env `FAB_AGENT_PRESET`) vs a loose value, on a field the preset sets | the group/workspace preset |
| …on a field the group/workspace preset leaves unset | the loose value still fills it (codex-review + loose `review.effort: low` → effort `low`) |
| Group/workspace preset vs machine default preset | only one preset applies — the group's replaces the machine default entirely (no stacking) |

So the plan's/study's wording "They override the machine default, but not a group's or workspace's preset" is inaccurate. The box's explanatory line must instead say the real thing, e.g. "They override the machine default, and fill in anything a group's or workspace's preset leaves unset." And because Move/Clear remove that fill-in, **when any group or workspace has its own preset**, the Move/Clear confirmation names those groups/workspaces and lists which loose values they will stop inheriting (only those on fields their preset leaves unset). With no group/workspace presets, no extra disclosure is needed (behavior is unchanged by Move).

The box disappears once no loose values remain.

### 7. Backend — `internal/fabsysconfig` and API

- **Patch path**: extend `validate`/`Apply` to accept `agent_presets.<name>.<field>` leaves — fields `description`, `session`, `workers`, `profiles.<role>.{cli,model,effort}` (roles from fab's closed set `Roles`) — and whole-preset removal (`agent_presets.<name>` → `fab config unset agent_presets.<name> --system`). Validated before any exec: name via `ValidateAgentPresetName`, not `none`, **not a built-in's name** (no writes to `agent_presets.<builtin>.*` — overriding built-ins is a non-goal); values under the existing rules (CLI ∈ known tools — fab itself does NOT validate CLI names inside a preset, verified; model via the existing free-text checks; effort via the existing rule); empty string refused (fab refuses it too) — `null` means unset; the last-field guard (§ 2). Writes stay sequential under `applyMu`.
- **Multi-write operations** — duplicate, rename, delete (with repoint/clear), move-leftovers, clear-leftovers — run server-side as one request each, under the same mutex, in a fixed order. On a failure part-way they return which writes landed and which failed (fab has no multi-key transaction — verified), and the panel re-reads the document so it shows the real state. Route shape (Constitution IX: POST; intent in the path): e.g. `POST /api/fab-config/presets/{duplicate|rename|delete}` and `POST /api/fab-config/leftovers/{move|clear}`, or an op-tagged body on `POST /api/fab-config`.
- **tmux repoint/clear** uses the existing wrappers (`tmux.ListServers`, `SetServerAgentPreset`/`UnsetServerAgentPreset`, `SetSessionAgentPreset`/`UnsetSessionAgentPreset`, readers) — no inline tmux construction. A group whose repo defines a project preset of the same name is repointed too (a system preset of the same name resolves above the project's, so the name referred to this preset).
- **Built-in detection**: `source == "built-in"` from `fab agent presets --json`. Edge (verified): a hand-written system override of a built-in's field flips its `source` to `system`; such a preset then lists as "yours". Accepted edge — HexoKit never creates such overrides.
- `AgentPreset` struct already carries `Session`, `Workers`, `Profiles` — the GET document's `agent_presets` is the editor's data source for set fields.

### 8. Palette and keyboard (Constitution V)

- Everything in the Presets section is keyboard-reachable: list (arrow keys within the listbox, Enter selects), editor fields, ops buttons, the inline form (Enter/Escape), the delete confirm.
- Palette (in `use-global-palette-actions.ts`, beside `Settings: Agent preset…`): **`Settings: Agent presets`** opens Settings > Agents scrolled to the Presets section with focus on the list; **`Settings: New agent preset…`** opens it with the New form open. Because Duplicate/Rename/Delete are UI-control actions, they also get palette entries — `Settings: Duplicate agent preset…`, `Settings: Rename agent preset…`, `Settings: Delete agent preset…` — each with a preset sub-step (Rename/Delete list only yours) that opens the section with that preset selected and the form/confirm pre-opened; the palette never performs the write itself.

### 9. `--system` verification (plan requirement, done at this intake)

Under an isolated `HOME` with fab 2.31.1, `--system` behaves the same as the project-file behavior the plan recorded — **no fab-kit change needed, so no stop**:

- `fab config set --system agent_presets.<name>.<field> <value>` creates a preset one leaf at a time; it appears in `fab agent presets --json` with `source: system` and full contents (`session`, `workers`, `profiles`).
- `fab config unset --system agent_presets.<name>` removes the whole preset; unsetting a non-existent preset is a no-op success ("…is not set; nothing to unset").
- Refused at write time: name `none`; a name with whitespace; an unknown field; an unknown role; `profiles.<role>.tool` (only `cli`); an empty value. Accepted: unknown CLI names, mixed-case names, names with a leading `-`.
- **Additional facts** (not in the plan): unsetting a preset's **last** leaf removes the preset; deleting a preset `agent.preset` still names makes every fab call warn `unknown agent preset "<name>" (agent.preset from system); ignoring it`; and the loose-value precedence table in § 6.

### 10. Tests and evidence

- **Go**: validation (name rule, `none`, built-in name, taken name, closed fields/roles, CLI/model/effort rules, empty value, last-field guard), patch ordering, duplicate, rename and delete of a preset in use (system `agent.preset` + server/session tmux options repointed/cleared via fakes), move of leftover settings (overlay of machine default + loose, legacy `tool` → `cli`, loose keys unset, default repointed), clear leftovers, partial-write reports. Use the exec fakes (`fabsysconfig.New(run)`) and tmux fakes — never the real `~/.fab-kit/config.yaml` (plan Rule 6).
- **Vitest** (`settings-agents-panel.test.tsx`): section layout and headers, list tags, editor read-only for built-ins, dimmed values, write-on-change to `agent_presets.<name>.*`, name form validation messages, description-required, usage note, delete confirm wording, leftover box (presence, wording, disclosure when groups/workspaces have own presets), no Customize disclosure.
- **e2e**: update `app/frontend/tests/e2e/_fab-config-stub.ts` (stateful preset table + new routes) and `settings-agents.spec.ts` (currently exercises the Customize grid; `surface-layout.spec.ts` also matches "Customize" — check it); new tests for create/edit/duplicate/rename/delete and leftovers. Intent comments per the constitution.
- **Demo specs**: update the existing Agents demos that exercise Customize (`agent-preset-dropdown.demo.ts` and any of `agents-settings*.demo.ts`, `agents-model-list.demo.ts`, `agents-effort-capability.demo.ts`, `agents-tool-default.demo.ts` that drive the grid) and add a presets-editor demo; record before/after with `just demo` on desktop and mobile (Constitution § PR Evidence).
- If the shared Control primitive changes, regenerate the control-gallery baselines.

## Affected Memory

- `run-kit/configuration`: (modify) § fab-kit System Config — key set gains `agent_presets.<name>.*` leaves and whole-preset removal; built-ins read-only; name rule; last-field guard; multi-write ops and partial-write reporting; loose values reframed as leftovers with fab's verified precedence; the Customize grid's retirement.
- `run-kit/ui/dialogs-and-state`: (modify) § Agents tab — the four boxed sections, Presets list/editor, name form, delete confirm, leftover box and disclosure, phone stacking, palette entries.
- `run-kit/api-and-sockets`: (modify) new/extended `/api/fab-config` routes and body contracts (preset leaves, whole-preset removal, duplicate/rename/delete, leftovers move/clear, on-demand preset resolution).
- `run-kit/ui/keyboard-and-palette`: (modify) the new `Settings: …agent preset…` palette entries.

## Impact

- **Backend**: `app/backend/internal/fabsysconfig/fabsysconfig.go` (+ tests) — allowlist, validation, new multi-write operations, per-preset resolution; `app/backend/api/fab_config.go` (+ router registration in `router.go`) — new/extended handlers; reuse `app/backend/api/agent_preset.go` helpers and `internal/tmux` agent-preset option wrappers for repoint/clear.
- **Frontend**: `app/frontend/src/components/settings-agents-panel.tsx` (+ test) — major restructure; likely split the presets list/editor/name form/leftovers into sibling components to avoid a god file; `app/frontend/src/api/client.ts` — new calls and types; `app/frontend/src/hooks/use-global-palette-actions.ts` — palette entries and a "focus presets section / open form" seam like `focusAgentPresetSelect`.
- **Tests/demos**: `_fab-config-stub.ts`, `settings-agents.spec.ts`, Agents demo specs.
- **Docs**: memory files above; `docs/specs/api.md` if route shapes are spec'd there.
- **No fab-kit change.** No change to Dispatch settings, the C1 card chooser, or running tabs.

## Open Questions

- Exact route naming for the multi-write operations and the on-demand preset resolution (sub-routes vs op-tagged body; query param vs sibling GET) — apply decides and records in the api spec/memory.
- Whether an `env`-source preset (defined in the daemon's environment) can appear in the machine list at all, and if so its read-only treatment — apply confirms against fab's `source` values (`built-in | system | project | env`).

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Leftovers: build Move/Clear as planned, correct the wording to fab's real precedence, and disclose in the Move/Clear confirmation which groups/workspaces with their own preset stop inheriting which loose values | Asked — user chose "Disclose and proceed" after the intake verified loose values fill unset fields under a group/workspace preset | S:95 R:70 A:90 D:90 |
| 2 | Certain | New requires a non-empty description; the editor and backend refuse clearing a preset's last remaining field | Asked — user chose "Require a description"; fab refuses empty values and deletes a preset whose last leaf is unset (verified) | S:95 R:80 A:90 D:90 |
| 3 | Certain | `--system` behaves as the plan's project-file findings — proceed, no fab-kit change | Verified under an isolated HOME with fab 2.31.1 (create, whole-preset unset, refusals) | S:90 R:85 A:95 D:95 |
| 4 | Certain | Four boxed sections in order Leftover settings → Use a preset → Presets → Dispatch; no Save button; built-ins read-only; Duplicate/Rename name form; rename repoints and delete clears machine default + group/workspace options | Plan Decisions table and C2 Brief, not reopened | S:95 R:70 A:95 D:95 |
| 5 | Certain | All preset writes go through `fab config set`/`unset --system` via `internal/fabsysconfig`, validated before exec, sequential under `applyMu` | Plan Decisions + Constitution III/IV + existing Apply pattern | S:95 R:75 A:95 D:95 |
| 6 | Confident | Dimmed "what applies" values come from `fab agent <role> --preset <name> -o yaml` per role for the edited preset only, fetched on demand; errors degrade to blank | Plan open decision 1; verified the verb works; Constitution III prefers asking fab over re-deriving its resolver | S:70 R:80 A:75 D:65 |
| 7 | Confident | Repo-scoped (project) presets are not listed in Settings | Plan open decision 2; Settings is machine-scoped, daemon runs fab with Dir=$HOME, editing project presets is a non-goal | S:70 R:85 A:80 D:75 |
| 8 | Confident | Palette gets `Settings: Agent presets`, `Settings: New agent preset…`, plus Duplicate/Rename/Delete entries with a preset sub-step that open the form/confirm (never write directly) | Plan open decision 3; Constitution V's complete-registry rule argues for direct entries, but plan only required the open-section entry | S:55 R:80 A:60 D:45 |
| 9 | Certain | Phone: list stacks above the editor at ≤640px; role table keeps its horizontal-scroll wrapper | Plan open decision 4; the study's CSS does exactly this | S:75 R:90 A:80 D:75 |
| 10 | Confident | Multi-write operations (duplicate, rename, delete, move/clear leftovers) are one server-side request each, create-before-remove ordering, returning landed/failed writes; panel re-reads | Plan Brief ("one backend request", "report which writes landed"); ordering chosen so failure never loses both names | S:80 R:70 A:80 D:70 |
| 11 | Confident | Route shape: dedicated POST sub-routes under `/api/fab-config` and a query param on GET for preset resolution | Constitution IX (POST, intent in path) fits; plan names no paths; alternatives are an op-tagged body or sibling GET | S:45 R:75 A:60 D:45 |
| 12 | Confident | Name rule = `ValidateAgentPresetName` (identifier ≤64, no leading `-`), plus not `none`, not taken, not a built-in name | Plan says "the rule riff preset names use"; the validator exists; fab is laxer (leading `-` accepted) so HexoKit stays stricter | S:85 R:85 A:85 D:80 |
| 13 | Confident | Built-in = `source == "built-in"`; a hand-overridden built-in (source flips to `system`) lists as "yours" — accepted edge | Verified fab behavior; HexoKit never writes such overrides; hardcoding fab's built-in names would duplicate fab | S:65 R:85 A:70 D:60 |
| 14 | Certain | Leftovers = explicit system-layer `agent.session`/`agent.workers`/`agent.profiles.*` (incl. legacy `tool`/`provider` leaves, written into the preset as `cli`); env-origin values are not leftovers | Plan Brief definition; fab refuses `tool` inside presets (verified) | S:80 R:80 A:85 D:80 |
| 15 | Confident | Rename/delete repoint/clear covers system `agent.preset` and every server/session tmux option on `tmux.ListServers`; an env-set `agent.preset` cannot be changed and yields a warning | Plan Brief ("servers the daemon covers"); env layer is outside HexoKit's write scope | S:75 R:75 A:75 D:70 |
| 16 | Confident | Usage note and rename/delete wording use the study's exact sentences ("Used by …; they follow the new name. Tabs already running under the old name fall back to the default.") | Plan Rule 7: study is the wording reference | S:85 R:90 A:85 D:85 |

16 assumptions (9 certain, 7 confident, 0 tentative, 0 unresolved).
