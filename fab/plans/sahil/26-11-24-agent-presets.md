# Agent presets — pick who does each role by name, per machine, group and workspace

> Plan doc, written 2026-11-24 from a `/fab-discuss` session in hexokit. Facts below were verified the
> same day against fab-kit `main` (fab 2.31.0: `docs/specs/config.md`, `docs/specs/stage-models.md`,
> `fab agent --help`, `fab config explain`) and hexokit `main` (`internal/riff`, `internal/fabsysconfig`,
> `spawn-agent-dialog.tsx`, `docs/memory/run-kit/configuration.md`). "hexokit" in the step table means
> this repo; "fab-kit" means `/home/sahil/code/sahil87/fab-kit`.

**Your involvement.** One action: release fab-kit after step **F1** merges and update the installed
`fab` (step **R1**). Merging follows whatever queue mode you confirm with the operator.

**Problem.** Choosing which agent runs which role is harder than it should be.

1. **One scope.** The only durable place to choose is the machine-wide file `~/.fab-kit/config.yaml`,
   edited through Settings > Agent. There is no way to say "this group runs on Codex workers" or "this
   workspace is all Claude".
2. **Too many parts for a simple choice.** A choice is spread over two knobs (`agent.session`,
   `agent.workers`), sparse per-role overrides (`agent.profiles.<role>.{cli,model,effort}`), and per-CLI
   fills (`clis.<cli>.profiles.<role>`), resolved across four config layers. Settings > Agent shows this
   as a grid of six roles by three fields.
3. **One-off overrides do not reach every dispatch mode.** `fab agent --cli/--model` binds only the
   native Agent-tool arm. `fab dispatch start` re-resolves from config (`agent.Resolve(cfg, stage)` in
   `cmd/fab/dispatch_start.go`), so a flag never reaches pane or headless workers. Only config does.

Other tools solve the same problem with named presets chosen at launch (vibe-kanban's agent variants,
Codex profiles, Roo Code's per-mode profiles, Amp's dial). This plan adds that to fab-kit first, then
exposes it in HexoKit.

---

## Goal

```
fab-kit      a preset is a NAME for a whole role assignment
             agent.preset: codex-review        one key picks it (env form: FAB_AGENT_PRESET)
             fab agent presets --json          lists built-in and user-defined presets

HexoKit      Settings > Agent                  one dropdown for the machine default; the grid is "Customize"
             group / workspace                 @rk_ses_agent_preset / @rk_srv_agent_preset
             every spawn                       pick in dialog > group > workspace > fab's own cascade
                                               └─ handed to fab as FAB_AGENT_PRESET for that tab
```

- A user who sets nothing sees no change in behavior.
- fab stays usable without HexoKit: presets work from the command line and the config files alone.
- A preset chosen for a group or workspace applies to every agent spawned there afterwards, including
  the ones the operator starts.

---

## Decisions already taken (do not reopen at intake)

| Decision | Choice | Why |
|---|---|---|
| Who owns agent config | fab-kit keeps the schema, the cascade and both config files. HexoKit reads and writes only through the `fab` CLI | fab must work without HexoKit; hexokit's Constitution III/IV already forbid parsing or rewriting fab's file |
| What a preset is | A named, sparse set of the fields fab already has: the two knobs and `profiles.<role>.{cli,model,effort}`. No new role vocabulary, no change to the stage → role mapping | The existing model is close to what other tools have; this area has had three renames (`agent.tiers`, `providers`, `session_command`) and does not need a fourth |
| How one is chosen | One scalar key, `agent.preset`, scope `both`. Its env form `FAB_AGENT_PRESET` comes from fab's existing mechanical env layer | A scalar is settable with `fab config set`; config (unlike a flag) reaches `fab dispatch start` |
| Precedence | Exactly one preset is active: the winner of `agent.preset` across env > system > project. Its values enter at the layer where it was chosen, directly below that layer's own explicit `agent.*` fields. Invocation flags stay on top | A preset chosen for a tab (env) must beat machine-wide customizations, or picking it would silently do nothing. Explicit fields at the same layer still win, so "Customize" works |
| Unknown preset name | At resolve time: a `fab: warning:` and the key is treated as unset. `fab config set agent.preset` rejects a name that is not defined | A group option can outlive the preset it names; a spawn must never fail for that |
| Group and workspace storage | tmux user options `@rk_ses_agent_preset` (group) and `@rk_srv_agent_preset` (workspace), each holding one preset name | Per-entity state lives in `@rk_*` options. tmux environment was rejected before for server state (`docs/memory/run-kit/tmux-sessions.md`, origin decision): only new panes see updates and the value sprays into every child |
| How fab gets the group/workspace choice | HexoKit resolves the name at spawn and passes `FAB_AGENT_PRESET` on the launcher resolution and on the new tab's first pane. fab never reads tmux | Keeps fab ignorant of tmux; no new fab config layer |
| When it applies | At launch. Changing a group or workspace preset affects tabs created afterwards | Matches every tool surveyed; a live cascade was considered and judged too complicated |
| Names in HexoKit | No bare "preset" anywhere. The new concept is the "agent preset"; `rk riff`'s existing presets become "riff presets" on every surface, renamed in H1 | `rk riff` already has "presets" (a name → one skill invocation; the spawn dialog's Preset field, `--preset`). Two different things must not share a label, and H2 puts both in the same dialog and on the same command |
| Key casing | Settings and config keys, JSON fields and tmux options are snake_case in both repos, and the two concepts are spelled the same way: plural for a table of definitions (`riff_presets`, `agent_presets`), singular for a field naming one (`riff_preset`, `agent_preset`, `@rk_ses_agent_preset`). fab's selector is the nested key `agent.preset`. Only CLI flags are kebab-case (`--riff-preset`, `--agent-preset`) | Every existing key in both config files is snake_case (`riff_presets`, `board_order`, `column_width`) and every existing flag is kebab-case; a mixed pair would read as two conventions |

---

## Current state (verified 2026-11-24)

- fab resolves config at one loader seam (`internal/config.LoadPath`) across environment > system >
  project > built-in defaults; env names are `FAB_` + the uppercased key. Field registry:
  `internal/configref`. Built-in values: `src/go/fab/defaults.yaml`. Role resolution: `internal/agent`.
- Fill precedence today (`stage-models.md` § Fill precedence): cli = `--cli` > `agent.profiles.<role>.cli`
  > the role's depth knob > built-in claude; model/effort = flag > `agent.profiles.<role>.<field>` >
  `clis.<p>.profiles.<role>` > `clis.<p>.profiles.default` > empty.
- `fab config set` writes scalar leaves only. Map-valued keys are reachable through dotted leaves
  (`clis.<name>.<field>` is the precedent).
- fab-kit has no "preset" concept today (no match in `src/go/fab`).
- HexoKit spawns every agent through `internal/riff`, from the web UI, `rk riff`, and the operator's
  autopilot. The launcher comes from one `fab agent [role] -o yaml` exec per spawn (`runFabAgent`,
  `Dir` = the target repo). The operator run's launcher uses `ResolveHeadlessAgent`.
- Settings > Agent reads `fab config show --origin --json` and `fab config explain --json`, writes with
  `fab config set|unset --system` (`internal/fabsysconfig`, `api/fab_config.go`,
  `settings-agents-panel.tsx`). E2E and demo specs stub the API with `tests/e2e/_fab-config-stub.ts`.
- Layout snapshots capture a fixed list of `@rk_*` options (`internal/snapshot`); an option not on the
  list is lost on restore.
- `rk riff` presets are already stored under the settings key `riff_presets`
  (`~/.config/hexokit/config.yaml`, `internal/settings`). The bare word "preset" survives on the
  surfaces around it: the `--preset` and `--list-presets` flags (`cmd/rk/riff.go`), the `preset` field
  of the spawn request body (`api/riff.go`), the `preset` argument in the MCP policy table
  (`internal/mcp/policy.go`), the `{session, preset}` payload of macro bindings, the spawn dialog's
  "Preset" label, and the docs. About 90 files mention the word.

---

## Rules for the operator executing this plan

1. **The plan must be on hexokit `main` before you queue anything.** Workers read it by absolute path:
   `/home/sahil/code/sahil87/hexokit/fab/plans/sahil/26-11-24-agent-presets.md`. Use that path in every
   entry's task, including the fab-kit step. If the file is not there, tell the user and stop.
2. Repos: `fab-kit` = `/home/sahil/code/sahil87/fab-kit`, `hexokit` = `/home/sahil/code/sahil87/hexokit`.
   One fab change per code step (F1, H1, H2), started with `/fab-new` in a fresh worktree off `main`.
3. **First `queue` call: F1 only.** H1 and H2 depend on F1 being *released*, which the engine cannot
   verify. Record one `note` item naming R1 ("release fab-kit with F1, update the installed fab") and
   tell the user it waits on them.
4. **Second `queue` call, when the user confirms R1: H1 then H2**, with H2 depending on H1. Before
   queueing, check `fab agent presets --json` succeeds on this machine; if it does not, the release is
   not installed, so say so and do not queue.
5. Merge mode is not set by this plan. Resolve it the usual way (the user's word, then
   `operator.merge_mode`, then the default) and confirm it with the user for each `queue` call.
6. Each step updates the memory and spec files it touches in the same change, and where it changes a CLI
   surface, the help text, skill pages and help-dump fixtures too.
7. PR evidence per hexokit's constitution: H1 and H2 change the web UI, so each carries before/after
   `just demo` recordings on desktop and mobile. F1 is CLI-only.
8. H2 changes the spawn path the autopilot uses. Workers build and test in their own worktrees; the live
   daemons keep the installed `rk` until a normal HexoKit release. No step installs a binary or restarts
   a daemon.

---

## Steps and dependencies

| ID | Repo | Step | Depends on | Size | Gate |
|---|---|---|---|---|---|
| **F1** | fab-kit | Agent presets: definitions table, `agent.preset` key, `fab agent --preset`, `fab agent presets --json`, built-in presets, precedence rule | — | L | — |
| **R1** | — | Release fab-kit with F1 and update the installed `fab` on this machine | F1 merged | S | **user action** |
| **H1** | hexokit | Rename `rk riff`'s presets to "riff presets" on every surface; Settings > Agent: agent-preset dropdown for the machine default, role grid behind "Customize" | F1 released | L | — |
| **H2** | hexokit | Group and workspace agent presets: two tmux options, lookup in the spawn path, spawn-dialog picker, palette actions, snapshots | H1 | L | — |

```
F1 ── R1 (you) ── H1 ── H2
```

---

## Briefs

### F1 — Agent presets (fab-kit)

Add presets to fab's agent configuration without changing the existing keys.

- **Definitions.** A table of named presets under the key `agent_presets`. Each preset is sparse and may set only what the `agent`
  block already allows: `session`, `workers`, and `profiles.<role>.{cli,model,effort}`. Definitions
  merge per key across the config layers like other maps. Ship a small built-in set in `defaults.yaml`
  (names at intake; see Open decisions).
- **Selection.** A scalar key `agent.preset`, scope `both`, default unset, advertised in the reference
  fence. `fab config set [--system] agent.preset <name>` validates the name against the defined presets;
  `unset` restores inheritance. `FAB_AGENT_PRESET` must work through the existing env layer with no
  special case.
- **Resolution.** Implement the precedence decision above in `internal/agent`, at the single resolve
  seam, so `fab agent`, `fab dispatch start` (all three dispatch modes), `fab batch` and the operator
  launcher all see it. A CLI set by a preset re-derives model and effort from that CLI's fills, as a
  `profiles.<role>.cli` override does today. An unknown name warns and resolves as unset.
- **Invocation.** `fab agent [role|stage] --preset <name>` for a one-off. It is a flag, so it carries
  the existing caveat that flags do not reach `fab dispatch start`; say so in the help text.
- **Visibility.**
  - `fab agent presets [--json]` lists every defined preset. The JSON is an array of
    `{name, description, source}` with `source` ∈ `built-in | system | project`, plus the fields the
    preset sets. HexoKit reads this, so document it as a contract.
  - `fab agent <role> -o yaml` reports the active `preset` and names it in `source.*` for each field it
    supplied.
  - `fab config show --origin` shows `agent.preset` like any other key, and each role leaf a preset
    supplied shows the preset as its origin detail.
- **Docs and guards.** Update `docs/specs/config.md`, `docs/specs/stage-models.md` (§ Fill precedence
  gains the preset rung), `fab config explain`, and the deployed `_cli-fab.md`. Extend the existing
  drift guards to the built-in presets.
- **Tests.** Table tests for the precedence rule covering: preset alone; explicit field above it at the
  same layer; env-chosen preset over system explicit fields; project preset shadowed by a system preset;
  unknown name; a CLI swap inside a preset; `dispatch start` picking the preset up from config.
- **Not in this step.** Changing existing keys, the stage → role mapping, or the `clis` table. Storing a
  preset on a change.

### R1 — Release fab-kit (user action)

Release fab-kit with F1 merged (`just release <bump>` in fab-kit) and update the installed `fab` on this
machine. Done when `fab agent presets --json` prints the built-in presets. Tell the operator.

### H1 — Riff-preset rename and the agent-preset dropdown in Settings > Agent (hexokit)

Two parts in one change: free the word "preset", then make the machine-wide agent choice one dropdown.

**Part 1: rename `rk riff`'s presets to "riff presets".** Behavior does not change; only names do.

- The settings key is already `riff_presets` and stays.
- CLI: `--preset` becomes `--riff-preset` and `--list-presets` becomes `--list-riff-presets`. The
  positional form (`rk riff discuss`) is unchanged.
- API: the spawn request body field `preset` becomes `riff_preset`. `GET /api/riff/presets` keeps its
  path (it is already under `/riff/`); its response key becomes `riff_presets`.
- MCP: the `preset` argument in the policy table becomes `riff_preset`.
- UI: the spawn dialog's "Preset" field is labelled "Riff preset"; frontend types and client functions
  follow.
- Go identifiers, error messages (`unknown preset …`), the `rk doctor` row, memory files, specs, site
  docs, skill pages and help-dump fixtures use "riff preset" throughout.
- **Nothing a user has saved may break.** Stored macro bindings carry the old `preset` payload key and
  scripts call `--preset`. Old spellings keep working for at least one release; how (hidden alias,
  dual-read, or a migration) is decided at intake.
- Tests: the existing riff tests under their new names, plus one test per old spelling that is kept.

**Part 2: the agent-preset dropdown.**

- **Backend.** In `internal/fabsysconfig`: add `agent.preset` to the key allowlist and the read model
  (value, origin, and the shadowed system value when env wins, as for other keys). Read the preset list
  with one `fab agent presets --json` call per `Read`. Validate a written value against that list
  before any exec. `GET /api/fab-config` returns the list and the current value; the existing POST
  patch accepts `agent.preset` (`null` unsets).
- **Older fab.** If `fab agent presets` is missing or fails, return no preset list and hide the control;
  everything else on the tab behaves as today. Do not raise the minimum fab version.
- **UI.** In `settings-agents-panel.tsx`: a preset dropdown at the top (with "None"), and the existing
  role grid behind a "Customize" disclosure that shows how many fields are set explicitly. The grid
  keeps showing effective values and where each comes from, so a field supplied by the preset reads as
  such. Add a palette action for setting the preset (Constitution V).
- **Tests and evidence.** Go tests for the read model, validation and the older-fab fallback; Vitest for
  the panel; extend `_fab-config-stub.ts` and `settings-agents.spec.ts`; a new demo spec recorded on
  desktop and mobile. The recordings also show the spawn dialog's renamed "Riff preset" field.
- **Docs.** `docs/memory/run-kit/configuration.md` § fab-kit System Config,
  `ui/dialogs-and-state.md` § Agents tab, `api-and-sockets.md`, and `rk-riff.md` for the rename.

### H2 — Group and workspace agent presets (hexokit)

Let a group or a workspace name an agent preset, and apply it to every spawn there.

- **Options.** `@rk_ses_agent_preset` (session scope) and `@rk_srv_agent_preset` (server scope), each
  one preset name, unset when empty. Add both to the option registry
  (`docs/memory/run-kit/tmux-sessions.md` § Server-Scoped User Options) and to `docs/specs/ui-state.md`.
  Setters go through `internal/tmux`, alongside the session color setters. Validate the name before any
  subprocess (Constitution I): a short allowlisted character set, and a member of fab's preset list.
- **API and state.** POST routes to set and clear each (Constitution IX). The state the UI already
  receives for sessions and servers carries the two values.
- **Lookup at spawn.** In `internal/riff`, resolve one name per spawn: an explicit pick on the request,
  then the target session's option, then the server's option, then nothing. When there is a name:
  - set `FAB_AGENT_PRESET=<name>` on the `fab agent` exec that resolves the launcher (interactive and
    headless), and
  - pass `-e FAB_AGENT_PRESET=<name>` on the tab's `new-window`, so `fab` commands the agent runs in
    that pane resolve the same preset.

  With no name, pass nothing: the argv and environment must be identical to today's.
- **Every caller.** The web UI, `rk riff` (new `--agent-preset` flag, beside H1's `--riff-preset`),
  the autopilot and the operator run's launcher all go through this lookup. The operator
  run lives in `_rk-operator`, so it follows the workspace option.
- **UI.** In `spawn-agent-dialog.tsx`, an "Agent preset" field next to the existing Agent Tier field
  (the dialog's other preset field is "Riff preset" since H1),
  showing the inherited value (for example "Group default: codex-review") and allowing a one-off pick.
  Hide it when fab reports no presets. Palette actions to set and clear the preset for the current
  group and for the workspace, and a visible indication on a group or workspace that has one.
- **Stale names.** If an option names a preset fab no longer defines, the spawn still succeeds (fab
  warns and ignores it). Show the value as unknown in the UI with a way to clear it.
- **Snapshots.** Capture and restore both options in `internal/snapshot`, with a round-trip test.
- **Tests and evidence.** Go tests for the lookup ladder, the unchanged-when-unset guarantee, validation
  and the snapshot round trip; e2e for the dialog field and palette actions; demo recordings on desktop
  and mobile showing a group preset changing what a new tab launches.
- **Docs.** `docs/memory/run-kit/rk-riff.md`, `tmux-sessions.md`, `layout-snapshots.md`, the `rk skill`
  core bundle, one line in the `rk skill operator` topic (a workspace or group preset applies to agents
  the operator spawns), and help-dump fixtures for the new flag.

---

## Open decisions (resolve at each step's intake)

| Step | Question |
|---|---|
| F1 | Whether the `agent_presets` table sits at the top level of the config or nests elsewhere; the name and its casing are fixed by the Key casing decision |
| F1 | Which presets ship built in and their names. A starting set: all Claude (today's defaults), Codex workers, Codex review only |
| F1 | Whether a reserved value means "no preset here, even if a lower layer chose one" |
| F1 | Whether `fab agent presets` is the right verb name, or the list belongs under `fab config` |
| H1 | How the old riff spellings (`--preset`, `--list-presets`, the `preset` body field and macro payload key, the MCP argument) keep working, and for how long |
| H1 | Whether choosing an agent preset should offer to clear the explicit fields that would override it |
| H2 | Where the group and workspace indication sits (row flyout card, server card, or both) |
| H2 | Whether a CLI verb sets the group and workspace options, and under which family |
| H2 | Whether a tab records the preset it was launched with, for display |

## Non-goals

- Moving ownership of agent configuration from fab-kit to HexoKit.
- Changing the preset of a tab that is already running. Storing the preset on the change
  (`.status.yaml`) would make that possible and is a possible follow-up.
- A separate preset for the operator's spawns.
- Per-tab stored overrides beyond the pick made at launch.
- Using tmux environment variables for group or workspace state.
- Changing what `rk riff`'s presets do. H1 renames them and nothing else.
- Releasing HexoKit. H1 and H2 ship with the next normal release.
