# Agent preset controls — set a group's or workspace's preset by mouse, and make your own presets

> Plan doc, written 2026-11-24 from a `/fab-discuss` session in hexokit. It follows
> `26-11-24-agent-presets.md`, whose three code steps have landed (fab-kit #711 in v2.31.1; hexokit #1189
> and #1191). Design study: `docs/wiki/agent-preset-controls-studies.html` (a clickable mock of step C1
> and a static sketch of step C2). Facts below were verified the same day against hexokit `main`
> (`7fb53092`) and the installed fab 2.31.1. Every step is in this repo.

**Your involvement.** None beyond merging, under whatever queue mode you confirm with the operator.

**Problem.** Agent presets work, but the UI for them is thin.

1. **A group's or workspace's preset can only be set from the command palette.** The sidebar cards show
   the preset as read-only text, and only when one is set, so a group that inherits shows nothing and
   there is no visible way in.
2. **Nothing shows on the row.** You have to open a card to learn that a group runs on a different preset.
3. **You cannot make a preset in the UI.** fab ships three (`claude`, `codex-workers`, `codex-review`).
   Anything else means hand-editing `agent_presets` in `~/.fab-kit/config.yaml`.

---

## Goal

```
group / workspace card      agent preset: codex-review · set here         always shown, with its source
                            ⚙ Agent preset…                codex-review   new row, opens the chooser

chooser                     ○ inherit        uses codex-workers (workspace)
                            ○ claude         All roles on Claude (today's defaults)
                            ● codex-review   Only the review role on Codex
                            ○ codex-workers  Pipeline workers on Codex; session on Claude
                            ○ none           no preset, even the machine default

sidebar row                 hexokit                          3  [codex-review]   name shown when set here

Settings > Agent            Agent preset [codex-review ▾]  [Save as preset…]  [Manage…]
```

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Where the control lives | An "Agent preset…" row on the group card and the workspace card, next to "Change color…" | The cards already hold every other per-group and per-workspace action; the palette stays as the keyboard path |
| What the chooser shows | Preset name and its one-line description, plus `inherit` and `none`. No per-role breakdown | The chooser only picks a preset; what a preset contains is shown in Settings > Agent |
| Row marker | The preset name, shown on a group or workspace row only when that group or workspace has its own preset | You can see which groups differ without opening a card; inherited values add no marker |
| The preset line on the card | Always present when fab reports presets, showing the preset new tabs will use and where it comes from | Today the line appears only when a preset is set here, so an inheriting group looks like it has none |
| Making presets | In Settings > Agent: "Save as preset…" and "Manage…" (rename, delete). Built-in presets are locked | Settings > Agent is the one surface for fab's machine-wide config (Constitution IV); no new page |
| Who writes the definitions | HexoKit writes `agent_presets.<name>.<field>` only through `fab config set|unset --system` | Constitution III/IV: HexoKit never parses or rewrites fab's file |
| When a choice applies | Unchanged: at launch. Tabs already running keep their preset | Set by the previous plan |

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
- Settings > Agent (`settings-agents-panel.tsx`) has the preset dropdown, the override note and the
  Customize grid. Writes go through `fabsysconfig.Client.Apply`: a key allowlist, validation before any
  exec, then sequential `fab config set|unset --system` under a package mutex. Preset definitions are not
  in the allowlist.

**fab 2.31.1** (tested in a throwaway project, against the project file, not `--system`)

- `fab config set agent_presets.<name>.<field> <value>` creates a preset one leaf at a time. Fields:
  `description`, `session`, `workers`, `profiles.<role>.<cli|model|effort>`. It then appears in
  `fab agent presets --json` with its `source`.
- `fab config unset agent_presets.<name>` removes a whole preset in one call.
- Refused at write time: the name `none`, a name containing whitespace, an unknown field, an unknown role.
  CLI names inside a preset are not validated.
- Deleting a preset that `agent.preset` still names is allowed; fab then warns on every resolve and
  ignores the selector.
- There is no rename and no multi-key transaction: a preset with N fields is N writes, and a failure
  part-way leaves a partial preset.
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
| **C2** | hexokit | Your own presets in Settings > Agent: "Save as preset…", "Manage…" (rename, delete), built-ins locked | C1 | L | — |

```
C1 ── C2
```

---

## Briefs

### C1 — Card controls for the group and workspace agent preset (hexokit)

Frontend only. The routes, the tmux options and the palette actions already exist.

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

### C2 — Your own presets in Settings > Agent (hexokit)

Let the user create, rename and delete presets without editing fab's file.

- **Backend.** In `internal/fabsysconfig`, extend the patch path to accept preset definitions:
  `agent_presets.<name>.<field>` leaves for the fields fab allows, and removal of a whole preset
  (`fab config unset agent_presets.<name> --system`). Validate everything before any exec: the name is a
  strict identifier (the rule riff preset names use), is not `none`, and is not a built-in preset's name;
  roles and fields are from fab's closed sets; values follow the existing model/effort/CLI rules. Writes
  stay sequential under the existing mutex.
- **Save as preset…** A control beside the preset dropdown. It asks for a name and an optional
  description and writes a new preset from the current machine-wide assignment (see Open decisions for
  exactly which fields). Saving over one of your own presets asks first and replaces it whole.
- **Manage…** Lists every machine-wide preset with its source. Built-ins are shown and locked. Your own
  presets can be renamed and deleted.
  - **Delete** asks first and names what still uses the preset: the machine default, and any group or
    workspace in the state the UI already holds. If the machine default names it, clear the selector in
    the same patch, so fab does not warn on every resolve.
  - **Rename** creates the new preset, deletes the old one, and repoints the machine default if it named
    the old one. fab has no rename, so say plainly in the dialog when a failure leaves both names present.
- **Partial writes.** A preset is several writes with no transaction. On a failure, report which fields
  were written, and re-read so the UI shows the real state.
- **Keyboard.** Palette actions for "Save as preset…" and "Manage…" (Constitution V).
- **Verify against a real fab.** The `--system` target was not exercised when this plan was written. At
  intake, confirm create, whole-preset delete and the refusals above with `--system` under an isolated
  home, and record any difference from the project-file behavior.
- **Tests and evidence.** Go tests for validation, the patch ordering, delete-while-selected and the
  partial-write report; Vitest for both dialogs; extend `_fab-config-stub.ts` and
  `settings-agents.spec.ts`; demo recordings on desktop and mobile.
- **Docs.** `docs/memory/run-kit/configuration.md` § fab-kit System Config, `ui/dialogs-and-state.md`
  § Agents tab, `api-and-sockets.md`.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| C1 | Whether the chooser is a popover anchored to the row (like the color picker) or a small dialog, on desktop and on mobile |
| C1 | How the row marker truncates and where it sits relative to the tab count |
| C2 | Exactly which fields "Save as preset…" captures. Suggested: the selected preset's fields overlaid with the explicit machine-wide fields from the Customize grid, and nothing from fab's defaults or a project file |
| C2 | After saving, whether to offer switching the machine default to the new preset and clearing the explicit fields it now covers |
| C2 | On rename, whether to repoint groups and workspaces that name the old preset, or leave them to show as unknown with the existing clear action |
| C2 | Whether presets defined in a repo's own config appear in Manage as read-only rows |

## Non-goals

- A per-role breakdown in the chooser.
- Editing or overriding the built-in presets.
- Changing the preset of a tab that is already running.
- Any fab-kit change. If C2's intake finds `--system` behaves differently, stop and report instead of
  working around it.
- Editing a repo's project-level presets from the UI.
