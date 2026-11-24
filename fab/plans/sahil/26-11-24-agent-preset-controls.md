# Agent preset controls — set a group's or workspace's preset by mouse, and make your own presets

> Plan doc, written 2026-11-24 from a `/fab-discuss` session in hexokit, and revised the same day after
> the Settings page was redesigned in the mock (step C2 below replaces the earlier "Save as preset…" /
> "Manage…" version). It follows `26-11-24-agent-presets.md`, whose three code steps have landed (fab-kit
> #711 in v2.31.1; hexokit #1189 and #1191). Design study:
> `docs/wiki/agent-preset-controls-studies.html` (a clickable mock of both steps). Facts below were
> verified against hexokit `main` and the installed fab 2.31.1. Every step is in this repo.

**Your involvement.** None beyond merging, under whatever queue mode you confirm with the operator.

**Problem.** Agent presets work, but the UI for them is thin.

1. **A group's or workspace's preset can only be set from the command palette.** The sidebar cards show
   the preset as read-only text, and only when one is set, so a group that inherits shows nothing and
   there is no visible way in.
2. **Nothing shows on the row.** You have to open a card to learn that a group runs on a different preset.
3. **You cannot make a preset in the UI.** fab ships three (`claude`, `codex-workers`, `codex-review`).
   Anything else means hand-editing `agent_presets` in `~/.fab-kit/config.yaml`.
4. **Settings > Agents mixes three ideas.** It picks the machine preset, and its Customize grid sets loose
   machine-wide values that belong to no preset. Those override the machine default but lose to a group's
   or workspace's preset, which is hard to predict.

---

## Goal

Using a preset is only ever a selection. Creating, editing, renaming and deleting presets happens in one
place.

```
SELECT (four places, same list)
  one new tab        spawn dialog                              exists
  group / workspace  sidebar card → "Agent preset…" → chooser  step C1
  machine            Settings > Agents → "Use a preset"        step C2 (moves the existing dropdown)

EDIT (one place)
  Settings > Agents → "Presets"                                step C2
    all presets │ Editing night-shift   [Rename] [Duplicate] [Delete]
    claude      │ description, Session CLI, Worker CLI
    codex-review│ role table: CLI · model · effort per role
    night-shift │
```

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Selecting is separate from editing | A preset is picked in the spawn dialog, on a group or workspace card, or in Settings > Agents "Use a preset". What a preset contains is edited only in Settings > Agents "Presets" | One mental model: pick by name everywhere, define in one place |
| Where the group and workspace control lives | An "Agent preset…" row on the group card and the workspace card, next to "Change color…" | The cards already hold every other per-group and per-workspace action; the palette stays as the keyboard path |
| What the chooser shows | Preset name and its one-line description, plus `inherit` and `none`. No per-role breakdown | The chooser only picks; contents are shown in Settings |
| Row marker | The preset name, on a group or workspace row only when that entity has its own preset | You can see which groups differ without opening a card |
| The preset line on the card | Always present when fab reports presets, showing the preset new tabs will use and where it comes from | Today an inheriting group looks like it has none |
| Settings page layout | Separate boxed sections, each with a header stating its job: "Use a preset" (the machine default dropdown only), "Presets" (list + editor), "Dispatch" (unchanged) | The first mock ran the sections together and it was unclear where one ended |
| The Customize grid | Retired as a way to set loose machine-wide values. The same role table becomes the preset editor | Removes the third idea in Problem 4 |
| Loose values that already exist | Shown in a "Leftover settings" box that offers to move them into a new preset or clear them; the box disappears once none remain | Nobody's current behavior changes silently |
| Saving | No Save button. Each field is written when it changes, as the page does today. A new preset exists as soon as it has a name | Matches fab's one-leaf-per-write model and the page's existing commit-on-change behavior |
| Built-in presets | Read-only. "Duplicate" makes an editable copy | Keeps the shipped names meaning the same thing on every machine |
| Naming | "New" and "Duplicate" ask for the name before creating. "Rename" exists for your own presets | A copy must not be stuck with a generated name |
| Rename and delete of a preset in use | Rename repoints the machine default and every group and workspace that names it. Delete clears them. Both say that tabs already running under the old name fall back to the default | Running tabs hold the name in their environment and cannot be repointed |
| Who writes the definitions | HexoKit writes `agent_presets.<name>.<field>` only through `fab config set|unset --system` | Constitution III/IV: HexoKit never parses or rewrites fab's file |
| When a choice applies | Unchanged: the preset *name* is fixed at launch. The preset's *definition* is read by fab at each stage dispatch, so editing a preset affects the next stage in every tab launched with it | The editor shows where a preset is used for this reason |

---

## Current state (verified 2026-11-24)

**HexoKit**

- The group card (`components/sidebar/session-row.tsx`) and workspace card (`server-card.tsx`) render
  `AgentPresetFact` only when the entity has its own preset, and `AgentPresetClearRow` only when that name
  is unknown to fab (`components/sidebar/agent-preset-card.tsx`). Action rows are `CardActionRow`
  (`row-flyout-card.tsx`). "Change color…" closes the card before opening its popover.
- Setting a preset is palette-only: `lib/palette/agent-preset.ts` builds "Group: Set Agent Preset…" and
  "Workspace: Set Agent Preset…" as a single-select sub-step, with `none` as an option.
- Routes exist: `POST /api/sessions/{session}/agent-preset` and `POST /api/servers/agent-preset`. Sessions
  and servers carry `agent_preset` in the state the UI receives.
- Preset lists: `useMachineAgentPresets()` (machine-wide) and `useAgentPresetList(server, session)` (the
  group's repo-scoped list once its spawn dialog has loaded one, else machine-wide).
- Settings > Agents (`settings-agents-panel.tsx`) has, top to bottom: the Agent preset dropdown, an
  override note, a Customize disclosure (Session CLI, Worker CLI, and the per-role table of CLI, model and
  effort, each writing `agent.session`, `agent.workers` or `agent.profiles.<role>.*` at the system
  layer), then Dispatch. Writes go through `fabsysconfig.Client.Apply`: a key allowlist, validation before
  any exec, then sequential `fab config set|unset --system` under a package mutex. Preset definitions are
  not in the allowlist.

**fab 2.31.1** (tested in a throwaway project, against the project file, not `--system`)

- `fab config set agent_presets.<name>.<field> <value>` creates a preset one leaf at a time. Fields:
  `description`, `session`, `workers`, `profiles.<role>.<cli|model|effort>`. It then appears in
  `fab agent presets --json` with its `source`.
- `fab config unset agent_presets.<name>` removes a whole preset in one call.
- Refused at write time: the name `none`, a name containing whitespace, an unknown field, an unknown role.
  CLI names inside a preset are not validated.
- Deleting a preset that `agent.preset` still names is allowed; fab then warns on every resolve and
  ignores the selector.
- There is no rename and no multi-key transaction: copying or renaming a preset with N fields is N
  writes, and a failure part-way leaves a partial preset.
- A system file may override single fields of a built-in preset. This plan does not use that.

---

## Rules for the operator executing this plan

1. Both steps are in **hexokit** (`/home/sahil/code/sahil87/hexokit`). One fab change per step, started
   with `/fab-new` in a fresh worktree off `main`, using the step's Brief plus this file's absolute path:
   `/home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-preset-controls.md`. The plan and the
   design study must be on `main` first; if they are not, tell the user and stop.
2. Queue C1 then C2, with C2 depending on C1. They touch different areas but share `api/client.ts` and
   the palette wiring, so they do not run in parallel.
3. Merge mode is not set by this plan. Resolve it the usual way and confirm it with the user.
4. Each step updates the memory and spec files it touches in the same change.
5. PR evidence per the constitution: both steps change the web UI, so each carries before/after
   `just demo` recordings on desktop and mobile.
6. No step writes to the real `~/.fab-kit/config.yaml` while building or testing. Tests use the exec fakes
   and the `_fab-config-stub.ts` API stub; any check against a real `fab` uses an isolated home.
7. The design study is the reference for layout and wording. Where it and this plan disagree, the plan wins.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **C1** | hexokit | Card controls: always-present preset line, "Agent preset…" row and chooser on the group and workspace cards, preset name on the row | — | M | — |
| **C2** | hexokit | Settings > Agents rebuilt as separate "Use a preset" and "Presets" sections: create, edit, duplicate, rename and delete presets; Customize grid retired with a leftover-settings path | C1 | L | — |

```
C1 ── C2
```

---

## Briefs

### C1 — Card controls for the group and workspace agent preset (hexokit)

Frontend only. The routes, the tmux options and the palette actions already exist. Reference: section 1
of the design study.

- **Preset line.** On the group card and the workspace card, show `agent preset: <name> · <source>`
  whenever fab reports presets, not only when the entity has its own. The source reads "set here", "from
  workspace", "machine default", or "fab's defaults" when nothing is set anywhere. Keep the existing
  unknown-name and `none` wording. Hide the line when fab reports no presets.
- **Action row.** A `CardActionRow` labelled "Agent preset…" on both cards, placed after "Change color…",
  with the effective preset name as its hint. Hidden when fab reports no presets.
- **Chooser.** Clicking the row closes the card and opens a chooser, the same way "Change color…" opens
  its popover. It lists `inherit` (with what that resolves to, as its description), each preset with its
  description, and `none`. The current choice is marked. Picking an entry calls the existing route
  (`inherit` clears the option) and closes. For a group, offer the group's repo-scoped list when it is
  available, as the palette does.
- **Keyboard.** Arrow keys move, Enter picks, Escape closes; focus starts on the current choice. The
  palette actions stay and are unchanged.
- **Row marker.** On a group row and a workspace row, show the preset name when that entity has its own
  preset. Truncate long names. It must not break the row's existing layout rules at narrow widths or on
  touch (see `row-minimalism.spec.ts`).
- **Clear row.** The existing "Clear agent preset" row for an unknown name stays; the chooser's `inherit`
  covers clearing a valid one.
- **Mobile.** The same row and chooser work on coarse pointers, where the card opens from the rail.
- **Tests and evidence.** Vitest for the source wording and the chooser list; e2e covering set, inherit
  and `none` on a group and on a workspace, and the row marker; demo recordings on desktop and mobile. If
  the work touches the shared Control primitive, regenerate the control-gallery baselines.
- **Docs.** `docs/memory/run-kit/ui/sidebar.md` and `ui/dialogs-and-state.md`.

### C2 — Settings > Agents: "Use a preset" and "Presets" (hexokit)

Rebuild the Agents tab so picking and editing are visibly separate, and presets can be made in the UI.
Reference: section 3 of the design study, which is clickable.

- **Layout.** Separate boxed sections, each with a header bar naming its job, in this order:
  1. **Leftover settings**, only while loose machine-wide values exist (see below).
  2. **Use a preset**: the existing Agent preset dropdown, relabelled "Machine default". Nothing else. Keep
     its provenance chip, reset link and env-shadow warning.
  3. **Presets**: a list of every machine-wide preset (built-in and yours, with a marker on the machine
     default) beside an "Editing <name>" pane. "+ New preset" sits in the section header.
  4. **Dispatch**: unchanged.
- **The editor.** The pane shows the selected preset's description, Session CLI, Worker CLI, and the role
  table (role · tier · CLI · model · effort) that Customize has today, including its model lists, effort
  rules, tool-change behavior and stale-pin note. It reads and writes that preset's
  `agent_presets.<name>.*` leaves. An unset field shows the value that applies, dimmed with `↳`, as the
  table does today. Each change is written when made; there is no Save button. The pane says where the
  preset is used (machine default, groups, workspaces) and that a change reaches the next stage in every
  tab launched with it.
- **Built-ins.** Read-only in the editor. "Duplicate" is the way to change one.
- **New, Duplicate, Rename.** One inline form asks for the name (Duplicate prefills `<name>-copy` and the
  description; Rename prefills the current name). Names are strict identifiers (the rule riff preset
  names use), not `none`, and not already taken; show the reason inline when refused.
  - *New* writes the description, or the smallest write that makes the preset exist when there is none.
  - *Duplicate* copies every field to the new name.
  - *Rename* is one backend request: write the new preset, remove the old one, repoint the machine
    default if it named the old one, and repoint every group and workspace option that names it on the
    servers the daemon covers. When the preset is in use, the form says tabs already running under the old
    name fall back to the default.
- **Delete.** Asks first and names what uses the preset. On confirm: remove it, clear the machine default
  if it named it, and clear the group and workspace options that name it.
- **Leftover settings.** Loose values are the explicit system-layer `agent.session`, `agent.workers` and
  `agent.profiles.*` keys. While any exist, show a box listing them with two actions. "Move into a new
  preset" asks for a name, creates a preset holding the current machine default's fields overlaid with
  the loose values, makes it the machine default, and unsets the loose keys, so the machine-wide result is
  unchanged. "Clear them" unsets the keys. Remove the Customize disclosure and the override note; values
  set through the daemon's environment keep the existing env-shadow warning.
- **Backend.** In `internal/fabsysconfig`, extend the patch path to accept `agent_presets.<name>.<field>`
  leaves and whole-preset removal (`fab config unset agent_presets.<name> --system`), validated before
  any exec: name rule above and not a built-in's name; roles and fields from fab's closed sets; values
  under the existing model, effort and CLI rules. Writes stay sequential under the existing mutex.
  Multi-write operations (duplicate, rename, move) report which writes landed when one fails, and the
  panel re-reads so it shows the real state.
- **Keyboard.** Everything in the section is reachable by keyboard, and the palette gains a way to open
  Settings > Agents at the Presets section, alongside the existing "Settings: Agent preset…" action.
- **Verify against a real fab.** The `--system` target was not exercised when this plan was written. At
  intake, confirm create, whole-preset delete and the refusals above with `--system` under an isolated
  home, and record any difference from the project-file behavior.
- **Tests and evidence.** Go tests for validation, patch ordering, rename and delete of a preset in use,
  the move of leftover settings, and partial-write reports; Vitest for the panel; update
  `_fab-config-stub.ts`, `settings-agents.spec.ts` and the existing Agents demo specs, which exercise the
  Customize grid; demo recordings on desktop and mobile.
- **Docs.** `docs/memory/run-kit/configuration.md` § fab-kit System Config, `ui/dialogs-and-state.md`
  § Agents tab, `api-and-sockets.md`.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| C1 | Whether the chooser is a popover anchored to the row (like the color picker) or a small dialog, on desktop and on mobile |
| C1 | How the row marker truncates and where it sits relative to the tab count |
| C2 | How the editor gets the dimmed "what applies" values for a preset that is not the active one (for example one `fab agent <role> --preset <name> -o yaml` per role, or derived from the document the panel already loads) |
| C2 | Whether presets defined in a repo's own config appear in the list as read-only rows |
| C2 | Whether the palette also gets direct actions for New, Duplicate, Rename and Delete, or only the entry that opens the section |
| C2 | How the list and editor stack on a phone |

## Non-goals

- A per-role breakdown in the chooser.
- Editing or overriding the built-in presets.
- Changing the preset *name* of a tab that is already running, or repointing running tabs on rename.
- Any fab-kit change. If C2's intake finds `--system` behaves differently, stop and report instead of
  working around it.
- Editing a repo's project-level presets from the UI.
- Changing the Dispatch settings.
