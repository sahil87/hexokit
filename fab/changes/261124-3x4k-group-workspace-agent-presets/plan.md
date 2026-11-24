# Plan: Group and workspace agent presets

**Change**: 261124-3x4k-group-workspace-agent-presets
**Intake**: `intake.md`

## Requirements

### tmux: Group and workspace preset options

#### R1: Option keys and setters
HexoKit SHALL store a group's agent preset in the session-scoped tmux user option `@rk_ses_agent_preset` and a workspace's in the server-scoped option `@rk_srv_agent_preset` (set with `set-option -s`), each holding one preset name, empty/absent meaning unset. Set/unset helpers MUST live in `internal/tmux` beside the session color setters, use `exec.CommandContext` with `TmuxTimeout` and argv slices, and be exposed through the `api` `TmuxOps` seam.

- **GIVEN** a session `proj` on server `s1`
- **WHEN** `SetSessionAgentPreset("proj", "codex-review", "s1")` runs
- **THEN** `tmux -L s1 show-options -t proj @rk_ses_agent_preset` reads `codex-review`
- **AND** `UnsetSessionAgentPreset` removes it, and the server pair does the same with `-s`

#### R2: State carries both values
The session list format shared by `parseSessions` and `buildSessionFacts` SHALL gain `#{@rk_ses_agent_preset}` so each `SessionInfo` carries `agent_preset` (omitted when empty) on the sessions SSE payload. `ReadServerMarks` SHALL parse `@rk_srv_agent_preset` from its existing single `show-options -s` dump (no extra exec), and `GET /api/servers` SHALL carry `agent_preset` per server (omitted when empty).

- **GIVEN** a session with `@rk_ses_agent_preset codex-review` and a server with `@rk_srv_agent_preset claude`
- **WHEN** the UI receives sessions SSE and `GET /api/servers`
- **THEN** that session object has `"agent_preset":"codex-review"` and that server object has `"agent_preset":"claude"`
- **AND** sessions/servers without the option carry no `agent_preset` key

### API: Set and clear routes

#### R3: Name validation before any subprocess
`internal/validate` SHALL provide `ValidateAgentPresetName(name)` delegating to `ValidateIdentifier(name, "Agent preset name")`. Every surface that accepts a preset name (setter routes, `POST /api/riff`, `rk riff --agent-preset`) MUST run it before any subprocess. Membership MUST then be checked against fab's preset list (`fab agent presets --json`), or the name must equal the reserved `none`.

- **GIVEN** a request naming `--x` or `a;b`
- **WHEN** any setter or spawn surface receives it
- **THEN** it is rejected (HTTP 400 / exit 2) and no tmux or fab subprocess runs

#### R4: Repo-scoped preset list reader
A reusable reader for `fab agent presets --json` rooted at a directory SHALL be extracted from H1's `fabsysconfig.listPresets` decoding (no duplicated decode logic), returning the decoded presets or an error when fab fails, times out, or prints non-array JSON. The machine-wide view uses `Dir=$HOME`; a repo view uses `Dir=<repoRoot>`.

- **GIVEN** fab 2.31.1 inside a repo with a project-defined preset `team`
- **WHEN** the reader runs with `Dir=<repoRoot>`
- **THEN** the result includes `team` plus the three built-ins
- **AND** with an older fab the reader returns an error and callers treat presets as unsupported

#### R5: Setter routes
`POST /api/sessions/{session}/agent-preset?server=<s>` with body `{"agent_preset": "<name>"}` SHALL set the group option; `null` or `""` SHALL clear it. `POST /api/servers/agent-preset` with body `{"name": "<server>", "agent_preset": "<name>" | null}` SHALL set/clear the workspace option. Membership for a group is checked against the list resolved in the session's derived repo root (machine list when the session has no repo); for a workspace against the machine list. Unknown → 400 `unknown agent preset "x" (available: …)`; unsupported fab with a non-null value → 400 `agent presets are not supported by the installed fab`; nothing is written on any 400. Success writes tmux before responding `{"ok": true}` and wakes the SSE hub for that server. Clearing never requires fab.

- **GIVEN** a group in a repo where `codex-review` is defined
- **WHEN** the client POSTs `{"agent_preset":"codex-review"}` then `{"agent_preset":null}`
- **THEN** the option is set, then unset, each returning 200 `{"ok":true}`
- **AND** POSTing `{"agent_preset":"nope"}` returns 400 and the option is unchanged

### Spawn: Lookup and handoff

#### R6: One name per spawn via the ladder
The riff engine SHALL resolve at most one preset name per spawn: (1) the explicit pick `Options.AgentPreset`, else (2) the target session's `@rk_ses_agent_preset`, else (3) the server's `@rk_srv_agent_preset`, else nothing. An option value failing `ValidateAgentPresetName` SHALL be skipped with a `slog.Warn` and the ladder continues. Option values SHALL NOT be membership-checked at spawn (a stale name still spawns; fab warns and ignores it). A failed tmux read degrades to "no value" and never fails the spawn.

- **GIVEN** session option `codex-review` and server option `claude`
- **WHEN** a spawn with no explicit pick runs
- **THEN** the resolved name is `codex-review`
- **AND** with an explicit pick `claude` the resolved name is `claude`; with neither option set and no pick, there is no name

#### R7: Handoff to fab
When a name resolves, the `fab agent … -o yaml` exec (interactive `ResolveAgent`, including its legacy `--print` retry, and headless `ResolveHeadlessAgent`) SHALL run with `FAB_AGENT_PRESET=<name>` appended to `os.Environ()`, and the tab's `new-window` and every `split-window` of the same spawn SHALL carry `-e FAB_AGENT_PRESET=<name>` before the shell command.

- **GIVEN** a resolved name `codex-workers`
- **WHEN** the engine spawns a one-pane tab
- **THEN** the fab exec's env contains `FAB_AGENT_PRESET=codex-workers` and the `new-window` argv contains `-e`, `FAB_AGENT_PRESET=codex-workers`

#### R8: Unchanged when unset
With no resolved name, the fab exec MUST leave `cmd.Env` nil (inherit) and every tmux argv MUST be byte-identical to today's.

- **GIVEN** no explicit pick and neither option set
- **WHEN** any spawn runs
- **THEN** golden-argv tests for `fab agent` and `new-window`/`split-window`/headless run-window builders pass unchanged and `cmd.Env` is nil

#### R9: Resume and fork are excluded
When `Options.ResumeSessionRef != ""` (fork `api/fork.go`, closed-tab restore `api/closed.go`, cron session respawn `cmd/rk/cron_respawn_session.go`) the ladder SHALL NOT run and nothing is passed.

- **GIVEN** a group preset `codex-workers` and a closed Claude tab
- **WHEN** the tab is restored
- **THEN** the launcher is resolved exactly as today, with no `FAB_AGENT_PRESET` on the exec or the window

#### R10: Every fresh-spawn caller uses the lookup
The web UI spawn (`POST /api/riff`, explicit pick from body `agent_preset`), `rk riff` (new `--agent-preset` flag; ladder on the caller's current session and server), the autopilot (`RiffSpawner.Spawn` with the item's group session; `buildPrompt`'s skill-prefix resolution uses the same name), the operator run (`operatorloop.openRunWindow`: ladder with session `_rk-operator`, `FAB_AGENT_PRESET` on `ResolveHeadlessAgent` and `-e` on `LaunchOperatorRunWindow`'s `new-window`), and the `rk operator` chat window (same ladder on `_rk-operator`) SHALL all go through it. `rk tutorial` is unchanged.

- **GIVEN** a workspace preset `codex-review` on server `s1`
- **WHEN** the operator loop opens a run window on `s1`
- **THEN** the headless resolver receives `codex-review` and the run window's `new-window` carries `-e FAB_AGENT_PRESET=codex-review`

#### R11: Explicit pick on POST /api/riff and rk riff
`POST /api/riff` SHALL accept optional body `agent_preset`; `rk riff` SHALL accept `--agent-preset <name>`. Both validate charset, then membership in the repo-scoped list or `none`, before creating anything (400 / exit 2 `unknown agent preset …`; unsupported fab with a pick → 400 / exit 2). Absent → ladder from options.

- **GIVEN** `POST /api/riff` with `{"session":"proj","agent_preset":"bogus"}`
- **WHEN** the handler runs
- **THEN** it returns 400 and no worktree or window is created

#### R12: Dialog preflight data
`GET /api/riff/presets` SHALL additionally return `agent_presets` (repo-scoped list; omitted when fab fails/is older) and `agent_preset_inherited` `{name, from: "group"|"workspace"}` (what the ladder would pick with no explicit pick; omitted when nothing is set).

- **GIVEN** a group with no option on a workspace with `@rk_srv_agent_preset claude`
- **WHEN** the dialog fetches `GET /api/riff/presets?session=proj`
- **THEN** the response includes `"agent_preset_inherited":{"name":"claude","from":"workspace"}` and the three built-in presets

### UI: Dialog, cards, palette

#### R13: Spawn dialog field
`spawn-agent-dialog.tsx` SHALL show an "Agent preset" native select (`aria-label="Agent preset"`) next to the Agent Tier field: first option inherit (value `""`, label `Group default: <name>` / `Workspace default: <name>` from `agentPresetInherited`, else `Default (machine setting)`), then one option per preset (`name — description`), then `none — no preset, even the machine default`. The field is hidden when `agentPresets` is absent. `agent_preset` is sent only when the selection is not inherit.

- **GIVEN** a group default `codex-review`
- **WHEN** the dialog opens
- **THEN** the field's selected option reads `Group default: codex-review` and submitting without a change sends no `agent_preset`

#### R14: Card indication
The session-row flyout card SHALL show a facts line `agent preset: <name>` when the group has one; `ServerCardContent` (sidebar server flyout + Server page tile) SHALL show `agent preset: <name>` when the workspace has one. A name absent from the preset list the UI holds for that scope renders `<name> (unknown)` with a "Clear agent preset" action row; `none` renders `none (no preset)`; with no list available the raw name renders without a marker. No row glyph is added.

- **GIVEN** a workspace option `old-preset` not in fab's list
- **WHEN** the server card renders
- **THEN** it reads `agent preset: old-preset (unknown)` and offers "Clear agent preset", which POSTs `null`

#### R15: Palette actions
The command palette SHALL register `Group: Set Agent Preset…`, `Group: Clear Agent Preset` (only when the current group has one), `Workspace: Set Agent Preset…`, and `Workspace: Clear Agent Preset` (only when the workspace has one). The Set actions open a chooser listing the presets plus `none`, using the palette's existing sub-list/chooser pattern, and POST the matching route. Set actions are hidden when fab reports no presets.

- **GIVEN** the current group `proj`
- **WHEN** the user runs `Group: Set Agent Preset…` and chooses `codex-review`
- **THEN** `POST /api/sessions/proj/agent-preset` is sent with `{"agent_preset":"codex-review"}`

### Snapshots

#### R16: Capture and restore
`internal/snapshot` SHALL capture the group option per `Session` (`agentPreset`) and the workspace option on the `Snapshot` (`serverAgentPreset`), both best-effort, and restore SHALL re-apply them (session option after the session is recreated; server option beside `setServerRank`), turning failures into report notes. Old snapshots without the fields restore unchanged.

- **GIVEN** a server with both options set
- **WHEN** it is captured, serialized, and restored onto a fresh server
- **THEN** both options are set again with the same values

### Docs

#### R17: Documentation and fixtures
Memory files (`rk-riff`, `tmux-sessions` registry, `layout-snapshots`, `api-and-sockets`, `ui/dialogs-and-state`, `ui/sidebar`, `ui/keyboard-and-palette`, `operator-loop`, `operator-autopilot`) are updated at hydrate; in apply, `docs/specs/ui-state.md` gains both options, the `rk skill` bundle documents `--agent-preset`, the `rk skill operator` topic gains one line (a workspace or group agent preset applies to agents the operator spawns), and help-dump fixtures/tests reflect the new flag.

- **GIVEN** `rk riff --help`
- **WHEN** the help-dump test runs
- **THEN** `--agent-preset` appears with its usage string and the fixture matches

### Non-Goals

- A CLI verb to set/clear the options — decided at intake (raw `tmux set-option` still works).
- A per-tab record of the launch preset (`@rk_win_agent_preset`) — decided at intake.
- Changing a running tab's preset, storing the preset on the change, tmux environment variables, a separate operator preset — plan non-goals.
- Applying the preset to resume/fork spawns — decided at intake.

### Design Decisions

#### Env handoff on both the resolver and the pane
**Decision**: Pass `FAB_AGENT_PRESET` on the `fab agent` exec that resolves the launcher AND via `-e` on every pane of the new tab.
**Why**: `fab agent --preset` is resolution-only and never reaches `fab dispatch start`; the env layer does, so the agent's own fab calls in that pane resolve the same preset as its launcher.
**Rejected**: The `--preset` flag (does not reach dispatched workers); tmux session environment (only new panes see updates and it sprays into every child — the plan's storage decision).
*Introduced by*: 261124-3x4k-group-workspace-agent-presets

#### Resume and fork skip the lookup
**Decision**: Spawns with `ResumeSessionRef` set resolve the launcher exactly as before and pass no preset.
**Why**: A resumed conversation is pinned to its provider; a group preset that moves the session CLI to Codex would otherwise fail a Claude resume's provider check.
**Rejected**: Applying the preset to every spawn (introduces a new failure on restore).
*Introduced by*: 261124-3x4k-group-workspace-agent-presets

#### Validation scope per option
**Decision**: Group setter checks membership against the list fab resolves in the session's repo; workspace setter against the machine-wide list. Spawn-time option values are charset-checked only.
**Why**: Project-defined presets exist only inside a repo; a workspace spans repos; a spawn must never fail for a stale name (fab warns and ignores it).
**Rejected**: Machine-wide list for both (rejects valid project presets); membership at spawn (a removed preset would break every spawn in the group).
*Introduced by*: 261124-3x4k-group-workspace-agent-presets

## Tasks

### Phase 1: Setup

- [x] T001 [P] Add `ValidateAgentPresetName` to `app/backend/internal/validate/validate.go` (delegating to `ValidateIdentifier(name, "Agent preset name")`) with table tests in `validate_test.go` <!-- R3 -->
- [x] T002 [P] Extract a repo-scoped preset reader from `listPresets` in `app/backend/internal/fabsysconfig/fabsysconfig.go` — e.g. exported `ListAgentPresets(ctx, dir string) ([]AgentPreset, error)` used by both the existing `Client` path (`Dir=$HOME`) and new callers, plus a `PresetNames`/membership helper that accepts reserved `none`; keep H1 behavior and tests green; add tests for dir-scoped decode and older-fab error <!-- R4 -->
- [x] T003 Add `SessionAgentPresetOption`/`ServerAgentPresetOption` constants and `SetSessionAgentPreset`/`UnsetSessionAgentPreset`/`SetServerAgentPreset`/`UnsetServerAgentPreset` plus a spawn-time getter (reading both values for a server+session, CLI path supported via the caller's `$TMUX`) in `app/backend/internal/tmux/tmux.go`; unit tests for argv builders <!-- R1 -->

### Phase 2: Core Implementation

- [x] T004 Extend `sessionListFormat()` with `#{@rk_ses_agent_preset}` (10 fields) and update `parseSessions`, `buildSessionFacts` (`internal/tmux/session_facts.go`), `SessionInfo.AgentPreset` (`json:"agent_preset,omitempty"`), and every field-count test; add `ServerMarks.AgentPreset` parsed in `parseServerMarks`; surface `agent_preset` on `serverInfo` in `app/backend/api/servers.go` <!-- R2 -->
- [x] T005 Add the ladder to `app/backend/internal/riff/riff.go`: `Options.AgentPreset`, a pure `resolveAgentPresetName(explicit, sessionOpt, serverOpt string) string` (charset-skip with `slog.Warn`) plus the tmux read seam (var for tests); skip when `ResumeSessionRef != ""`; carry the name on `EffectiveSpec` (e.g. `AgentPreset string`) <!-- R6, R9 -->
- [x] T006 Thread the name into fab resolution: `runFabAgent` env param (nil when no name), `ResolveAgent`/`ResolveLauncher`/`ResolveHeadlessAgent` take the preset; update all callers (`riff.SpawnObserved`, `cmd/rk/riff.go`, `cmd/rk/operator.go`, `cmd/rk/tutorial.go` passing `""`, `internal/autopilot/spawn.go`, `internal/operatorloop/runner.go`) and their test seams <!-- R7, R8 -->
- [x] T007 Add `-e FAB_AGENT_PRESET=<name>` to `buildSpawnArgvs` (new-window + each split-window) and `buildNewWindowCaptureArgs` in `app/backend/internal/riff/shell.go` only when `spec.AgentPreset != ""`; golden-argv tests for both with and without a name <!-- R7, R8 -->
- [x] T008 Setter routes: `POST /api/sessions/{session}/agent-preset` (via `handleSessionStringOption` + membership check against the session repo list or machine list) in `app/backend/api/sessions.go`, `POST /api/servers/agent-preset` (mirroring `handleServerProtect`, machine list) in `app/backend/api/servers.go`; register in `api/router.go`; extend `TmuxOps`/`prodTmuxOps`/`mockTmuxOps`; preset-list seam injectable for tests; handler tests (set, clear without fab, charset 400, unknown 400, unsupported 400, nothing written on 400, SSE wake) <!-- R3, R5 -->
- [x] T009 `POST /api/riff` body `agent_preset` validated (charset, then repo-scoped membership or `none`) before any spawn and passed as `riff.Options.AgentPreset`; `GET /api/riff/presets` adds `agent_presets` (omitted on fab failure) and `agent_preset_inherited`; tests in `app/backend/api/riff_test.go` <!-- R11, R12 -->

### Phase 3: Integration & Edge Cases

- [x] T010 `rk riff --agent-preset <name>` in `app/backend/cmd/rk/riff.go`: validate (exit 2), ladder against the caller's current session/server via restored `$TMUX`, pass to `ResolveAgent` and `riff.Run`'s spec; tests in `cmd/rk/riff_test.go` <!-- R10, R11 -->
- [x] T011 Autopilot: `RiffSpawner.Spawn` (`internal/autopilot/riffspawn.go`) relies on the engine ladder with `req.Session`; `buildPrompt` (`internal/autopilot/spawn.go`) resolves the skill prefix with the same ladder-resolved name (shared helper exported from `internal/riff`); tests <!-- R10 -->
- [x] T012 Operator: `internal/operatorloop/runner.go` `openRunWindow` resolves the ladder for `_rk-operator` on the server, passes it to `resolveLauncherFn`, and `tmux.LaunchOperatorRunWindow`/`buildRunWindowArgs` (`internal/tmux/operator_run.go`) gain an env list emitting `-e` only when non-empty; `cmd/rk/operator.go` chat window does the same; tests including unchanged-when-unset for `buildRunWindowArgs` <!-- R8, R10 -->
- [x] T013 Snapshots: `Session.AgentPreset` (`json:"agentPreset,omitempty"`) via the layout session read (`tmux.ListLayoutSessions` format/`LayoutSession`), `Snapshot.ServerAgentPreset` read best-effort, restore re-applies both via new `restoreOps` setters with report notes on failure; round-trip and old-snapshot tests in `internal/snapshot` <!-- R16 -->
- [x] T014 Frontend API/types: `src/types.ts` `ProjectSession.agentPreset` mapped from `agent_preset` (follow `sessionColor`/`flair` mapping), `ServerInfo.agent_preset`, `getRiffPresets` returning `agentPresets`/`agentPresetInherited`, `spawnRiff` `agentPreset` → body `agent_preset`, `setSessionAgentPreset`/`setServerAgentPreset` in `src/api/client.ts`; client tests <!-- R2, R5, R12 -->
- [x] T015 Spawn dialog "Agent preset" field in `src/components/spawn-agent-dialog.tsx` with Vitest coverage (inherit labels, hidden without presets, sends only on explicit pick, `none` option) <!-- R13 -->
- [x] T016 Card lines in `src/components/sidebar/row-flyout-card.tsx` (session card) and `src/components/sidebar/server-card.tsx` (`ServerCardContent`), unknown marker + "Clear agent preset" action row, `none (no preset)`; Vitest coverage <!-- R14 -->
- [x] T017 Palette actions `Group: Set/Clear Agent Preset` and `Workspace: Set/Clear Agent Preset` in `src/app.tsx` / `src/hooks/use-global-palette-actions.ts` using the existing chooser pattern; Vitest coverage <!-- R15 -->

### Phase 4: Polish

- [x] T018 Playwright: extend `tests/e2e/spawn-agent.spec.ts` (stub `agent_presets` + `agent_preset_inherited`; field and inherit label; submitted body) and add palette set/clear coverage (new or existing spec), each `test()` with JSDoc Proves/Steps and file header per Constitution <!-- R13, R15 -->
- [x] T019 Demo spec `app/frontend/tests/demo/group-agent-preset.demo.ts`: set a group preset via palette, show the card line, open the spawn dialog showing `Group default: …`; run it once via `just demo group-agent-preset --desktop-only` to confirm it records (full `--before` desktop+mobile recording happens at ship) <!-- R13, R14, R15 -->
- [x] T020 Docs in apply: `docs/specs/ui-state.md` option inventory; `rk skill` bundle (`app/backend/cmd/rk/skill/*.md` page documenting `rk riff`) `--agent-preset`; one line in `app/backend/cmd/rk/skill/operator.md`; help-dump fixtures/tests (`cmd/rk/help_dump_test.go`, `app/frontend/tests/e2e/help-topics.spec.ts` if covering `rk riff`) <!-- R17 -->
- [x] T021 Run gates: `just test-backend`, `just test-frontend`, `cd app/frontend && npx tsc --noEmit`, the touched e2e specs via `just test-e2e "<spec>"`, and `just build`; fix failures <!-- R8 -->

## Execution Order

- T001–T003 precede everything; T004 needs T003.
- T005 → T006 → T007 (engine); T008/T009 need T001, T002, T003.
- T010–T012 need T005–T007; T013 needs T003.
- T014 precedes T015–T017; T018/T019 need T015–T017.
- T021 last.

## Acceptance

### Functional Completeness

- [ ] A-001 R1: Both option constants exist with set/unset helpers in `internal/tmux`, wired through `TmuxOps`
- [ ] A-002 R2: Sessions SSE carries `agent_preset` per session and `GET /api/servers` carries `agent_preset` per server, both omitted when unset, with no extra tmux exec for servers
- [ ] A-003 R3: `ValidateAgentPresetName` exists and runs before any subprocess on every surface that accepts a name
- [ ] A-004 R4: One shared decoder for `fab agent presets --json` serves both the machine-wide and repo-scoped reads
- [ ] A-005 R5: Both POST routes set/clear their option, validate membership in the right scope, accept `none`, and write nothing on 400
- [ ] A-006 R6: The engine resolves explicit > session option > server option > nothing, once per spawn
- [ ] A-007 R7: With a name, the fab exec env carries `FAB_AGENT_PRESET=<name>` and `new-window` plus each `split-window` carry `-e FAB_AGENT_PRESET=<name>`
- [ ] A-008 R10: Web UI, `rk riff`, autopilot (incl. skill prefix), operator run and `rk operator` chat all use the ladder
- [ ] A-009 R11: `POST /api/riff` `agent_preset` and `rk riff --agent-preset` validate charset and membership before creating anything
- [ ] A-010 R12: `GET /api/riff/presets` returns `agent_presets` (omitted on fab failure) and `agent_preset_inherited`
- [ ] A-011 R13: The dialog's Agent preset field shows the inherit label, preset options and `none`, hides without presets, and sends `agent_preset` only on explicit pick
- [ ] A-012 R14: Session flyout and server card show the preset line, `(unknown)` with a clear action, and `none (no preset)`
- [ ] A-013 R15: The four palette actions exist, with Clear shown only when set and Set hidden without presets
- [ ] A-014 R16: Snapshots capture and restore both options
- [ ] A-015 R17: `ui-state.md`, the `rk skill` pages, and help-dump fixtures document the options and `--agent-preset`

### Behavioral Correctness

- [ ] A-016 R8: With no resolved name, `cmd.Env` is nil and every spawn argv (riff new-window/split-window, run window) is byte-identical to the base branch — asserted by golden tests
- [ ] A-017 R9: Fork, closed restore and cron session respawn pass no preset even when a group/workspace preset is set

### Scenario Coverage

- [ ] A-018 R6: A Go table test covers explicit/session/server/none precedence and the garbage-option skip
- [ ] A-019 R16: A snapshot round-trip test re-sets both options; an old snapshot without the fields restores unchanged
- [ ] A-020 R13: Playwright covers the dialog field and the palette set/clear actions with intent comments

### Edge Cases & Error Handling

- [ ] A-021 R6: A stale option name still spawns (no membership check at spawn), and a failed option read never fails the spawn
- [ ] A-022 R5: On an older/failing fab, setting a preset returns 400 while clearing still works; the dialog field and Set palette actions are hidden

### Code Quality

- [ ] A-023 Pattern consistency: New handlers, setters and UI follow the color/flair/protect patterns and existing palette/card structure
- [ ] A-024 No unnecessary duplication: The preset-list decoder and validator are shared, not copied
- [ ] A-025: All subprocess calls use `exec.CommandContext` with timeouts and argv slices; all tmux interaction goes through `internal/tmux` (no inline tmux construction)
- [ ] A-026: No magic strings — option names, the env var name and the `none` value are named constants
- [ ] A-027: No client polling — UI updates arrive via SSE / the existing servers refresh
- [ ] A-028: New functions stay under ~50 lines without clear reason; comments state constraints, not narration or change IDs

### Security

- [ ] A-029 R3: Preset names reach tmux/fab argv or env only after passing the identifier allowlist; option-sourced garbage is skipped, not passed

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Confident | The engine carries the resolved name on `EffectiveSpec.AgentPreset` so both the daemon `Spawn` path and the CLI `Run` path emit `-e` from one place | Single seam for argv builders; mirrors how `Launcher`/`SkillPrefix` travel | S:65 R:85 A:80 D:70 |
| 2 | Confident | `ResolveAgent`/`ResolveHeadlessAgent` gain a trailing `preset string` parameter rather than an options struct | Smallest signature change; few callers; `tutorial.go` passes `""` | S:60 R:90 A:75 D:60 |
| 3 | Confident | Clearing an option never runs fab (only set validates membership) | Clearing must work on older fab and for stale names (Brief "a way to clear it") | S:70 R:90 A:85 D:80 |
| 4 | Confident | The demo is run once desktop-only in apply to prove it records; the `--before` desktop+mobile recordings are produced at ship for the PR body | Recording both lanes is evidence for the PR, which ship attaches | S:60 R:90 A:70 D:65 |
| 5 | Confident | The new session-list field is inserted before `session_path`, keeping the path the last field | The path is free-form and is safest as the trailing field; preset names cannot contain the delimiter | S:55 R:85 A:70 D:55 |
| 6 | Confident | `ProjectSession` carries the group preset under its wire key `agent_preset` (no camelCase mapping) | The frontend has no sessions-payload mapping layer — ProjectSession fields are the raw JSON keys — so a mapped `agentPreset` would add a layer for one field | S:65 R:85 A:80 D:60 |
| 7 | Confident | The card judges a stored preset against the group's repo-scoped list when its spawn dialog already loaded one, else the machine list from `GET /api/fab-config`; the list is read lazily, only while a card showing a preset is open | Avoids a fab-config fetch per SSE tick or sidebar row; a project preset is not falsely marked unknown after the dialog loaded its repo list | S:55 R:85 A:70 D:55 |
| 8 | Confident | The `Clear agent preset` row is offered only for an unknown name (a valid preset is changed from the palette) | Brief: the clear action exists for stale values; the palette's Clear covers valid ones | S:60 R:90 A:75 D:65 |
| 9 | Confident | The palette Set actions are gated on the machine preset list (one cached `fab-config` read on mount, 30s cache) and the group chooser loads its repo-scoped list lazily on entry, falling back to the machine list | The palette needs a static availability signal; the single-select sub-list supports lazy rows, so project presets are offered without an eager per-group fetch | S:60 R:85 A:70 D:55 |
| 10 | Confident | The demo skips the flyout-card step on the mobile project (the sidebar is a drawer there); palette and spawn-dialog steps run on both | The card is not reachable on mobile without the drawer; the recording still shows the group default in the dialog | S:55 R:90 A:70 D:60 |
| 11 | Confident | The group/workspace option reads on the CLI path run through `tmux.ReadAgentPresetOptions` with the caller's `$TMUX`, and an explicit pick skips them | Keeps the CLI on the caller's own server/session without a new tmux construction site outside `internal/tmux` | S:65 R:85 A:75 D:65 |
| 12 | Confident | `rk operator`'s run window and chat window resolve the ladder with `_rk-operator`; `LaunchOperatorRunWindow` and `createMarkedOperatorWindow` take an env list rendered as `-e` only when non-empty | Same unchanged-when-unset rule as the riff argv builders | S:65 R:85 A:75 D:70 |
| 13 | Confident | `sessions.ProjectSession`/`SessionInfo` report the group option verbatim (no charset filter); only spawn-time reads skip invalid values | A hand-set garbage name must stay visible so the UI can offer to clear it | S:60 R:85 A:70 D:60 |
| 14 | Confident | The `rk skill` core page gets a new `rk riff` capability line (no page documented riff's flags) and both embedded copies are mirrored to `docs/site/` for the drift test | `TestSkillTopicsMatchCanonical` requires byte equality | S:70 R:90 A:85 D:75 |

14 assumptions (0 certain, 14 confident, 0 tentative).
